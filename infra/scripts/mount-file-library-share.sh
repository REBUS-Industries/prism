#!/usr/bin/env bash
# Mount the REBUS parent fileserver share on VM 212 for Prism File Library.
#
# Share (UNC):  \\fs.ad.rebus.industries\REBUS
# Host path:    /mnt/fileserver/rebus
# Container:    bind-mounted at the same path (see docker-compose.dev.yml)
#
# Idempotent. Safe to re-run from the mount-file-library workflow.
#
# Credentials (first match wins):
#   1. Env FILESERVER_SMB_USERNAME + FILESERVER_SMB_PASSWORD (workflow secrets)
#   2. Existing /etc/prism/smb-rebus.credentials on the host
#
# Usage (on VM 212 as a user with passwordless sudo):
#   FILESERVER_SMB_USERNAME=... FILESERVER_SMB_PASSWORD=... bash mount-file-library-share.sh
#   # or, credentials file already present:
#   bash mount-file-library-share.sh

set -euo pipefail

SHARE="${FILE_LIBRARY_SMB_SHARE:-//fs.ad.rebus.industries/REBUS}"
MOUNT_POINT="${FILE_LIBRARY_HOST_PATH:-/mnt/fileserver/rebus}"
CRED_FILE="${FILE_LIBRARY_SMB_CRED_FILE:-/etc/prism/smb-rebus.credentials}"
UNIT_NAME="mnt-fileserver-rebus.mount"
COMPOSE_DIR="${PRISM_COMPOSE_DIR:-/opt/prism}"
CONTAINER_ROOT="${FILE_LIBRARY_ROOT:-/mnt/fileserver/rebus}"

log() { echo "[file-library-mount] $*"; }
die() { echo "[file-library-mount] ERROR: $*" >&2; exit 1; }

need_sudo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

# docker compose must run as the deploy user (member of docker group), not root.
run_compose() {
  if [[ "$(id -u)" -eq 0 ]]; then
    if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
      sudo -u "$SUDO_USER" -H "$@"
    else
      "$@"
    fi
  else
    "$@"
  fi
}

ensure_cifs_utils() {
  if mount.cifs -V >/dev/null 2>&1; then
    return 0
  fi
  log "installing cifs-utils"
  need_sudo apt-get update -qq
  need_sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cifs-utils
}

write_credentials_if_provided() {
  if [[ -z "${FILESERVER_SMB_USERNAME:-}" || -z "${FILESERVER_SMB_PASSWORD:-}" ]]; then
    [[ -f "$CRED_FILE" ]] || die "no SMB credentials: set FILESERVER_SMB_USERNAME/PASSWORD or create $CRED_FILE"
    log "using existing credentials file $CRED_FILE"
    return 0
  fi
  log "writing credentials to $CRED_FILE"
  need_sudo mkdir -p "$(dirname "$CRED_FILE")"
  local tmp
  tmp="$(mktemp)"
  {
    echo "username=${FILESERVER_SMB_USERNAME}"
    echo "password=${FILESERVER_SMB_PASSWORD}"
    if [[ -n "${FILESERVER_SMB_DOMAIN:-}" ]]; then
      echo "domain=${FILESERVER_SMB_DOMAIN}"
    fi
  } >"$tmp"
  need_sudo install -m 600 -o root -g root "$tmp" "$CRED_FILE"
  rm -f "$tmp"
}

is_mounted() {
  findmnt -n -T "$MOUNT_POINT" 2>/dev/null | grep -q " ${SHARE} " \
    || findmnt -n "$MOUNT_POINT" 2>/dev/null | grep -q cifs \
    || mountpoint -q "$MOUNT_POINT" 2>/dev/null
}

mount_now() {
  need_sudo mkdir -p "$MOUNT_POINT"
  if is_mounted; then
    log "already mounted: $MOUNT_POINT"
    return 0
  fi
  # Docker may have created an empty bind-source dir — mount over that.
  # Refuse only if it already has local files (would hide them under CIFS).
  if [[ -d "$MOUNT_POINT" ]] && ! mountpoint -q "$MOUNT_POINT"; then
    if [[ -n "$(ls -A "$MOUNT_POINT" 2>/dev/null || true)" ]]; then
      die "$MOUNT_POINT is non-empty and not a mount — refuse to overlay (move aside first)"
    fi
  fi
  log "mounting $SHARE -> $MOUNT_POINT"
  need_sudo mount -t cifs "$SHARE" "$MOUNT_POINT" \
    -o "credentials=${CRED_FILE},uid=1000,gid=1000,file_mode=0664,dir_mode=0775,iocharset=utf8,noperm,serverino,_netdev"
  mountpoint -q "$MOUNT_POINT" || die "mount failed"
  log "mount ok"
}

install_systemd_mount() {
  local unit_path="/etc/systemd/system/${UNIT_NAME}"
  log "installing systemd unit $unit_path (mount on boot)"
  need_sudo tee "$unit_path" >/dev/null <<EOF
[Unit]
Description=REBUS fileserver share for Prism File Library
Documentation=file:///opt/prism
After=network-online.target
Wants=network-online.target

[Mount]
What=${SHARE}
Where=${MOUNT_POINT}
Type=cifs
Options=credentials=${CRED_FILE},uid=1000,gid=1000,file_mode=0664,dir_mode=0775,iocharset=utf8,noperm,serverino,nofail,_netdev
TimeoutSec=30

[Install]
WantedBy=multi-user.target
EOF
  need_sudo systemctl daemon-reload
  need_sudo systemctl enable "$UNIT_NAME"
  # Prefer the unit for future boots; current session already mounted above.
  if ! systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null; then
    # If manual mount is active, systemd may refuse — remount via unit.
    if mountpoint -q "$MOUNT_POINT"; then
      need_sudo umount "$MOUNT_POINT" || true
    fi
    need_sudo systemctl start "$UNIT_NAME" || {
      log "WARN: systemctl start ${UNIT_NAME} failed — leaving manual mount if present"
      if ! mountpoint -q "$MOUNT_POINT"; then
        mount_now
      fi
    }
  fi
  systemctl is-enabled "$UNIT_NAME" >/dev/null
  log "systemd mount enabled for boot"
}

upsert_env() {
  local key="$1" value="$2" file="$3"
  if [[ -f "$file" ]] && grep -q "^${key}=" "$file"; then
    need_sudo sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" | need_sudo tee -a "$file" >/dev/null
  fi
}

update_prism_env() {
  local env_file="${COMPOSE_DIR}/.env"
  [[ -d "$COMPOSE_DIR" ]] || die "compose dir missing: $COMPOSE_DIR"
  if [[ ! -f "$env_file" ]]; then
    log "WARN: $env_file missing — creating with File Library keys only"
    need_sudo touch "$env_file"
  fi
  log "updating $env_file File Library paths"
  upsert_env "FILE_LIBRARY_HOST_PATH" "$MOUNT_POINT" "$env_file"
  upsert_env "FILE_LIBRARY_ROOT" "$CONTAINER_ROOT" "$env_file"
  upsert_env "FILE_LIBRARY_SMB_SHARE" "$SHARE" "$env_file"
}

recreate_prism_server() {
  if [[ "${FILE_LIBRARY_SKIP_RECREATE:-0}" == "1" ]]; then
    log "skip recreate (FILE_LIBRARY_SKIP_RECREATE=1)"
    return 0
  fi
  if [[ ! -f "${COMPOSE_DIR}/docker-compose.yml" && ! -f "${COMPOSE_DIR}/docker-compose.dev.yml" ]]; then
    log "WARN: no compose file in $COMPOSE_DIR — skip container recreate"
    return 0
  fi
  cd "$COMPOSE_DIR"
  if [[ -f docker-compose.dev.yml ]]; then
    cp docker-compose.dev.yml docker-compose.yml
  fi
  log "recreating prism-server with File Library bind mount"
  # Mount must exist before recreate so Docker does not create an empty host dir.
  mountpoint -q "$MOUNT_POINT" || die "mount point not mounted before compose recreate"
  run_compose docker compose up -d --force-recreate --no-deps --pull never prism-server
  run_compose docker compose ps prism-server
}

verify() {
  log "verify host mount"
  findmnt "$MOUNT_POINT" || die "findmnt failed"
  ls -la "$MOUNT_POINT" | head -20 || die "cannot list $MOUNT_POINT"
  if run_compose docker inspect prism-server >/dev/null 2>&1; then
    log "verify bind inside prism-server"
    run_compose docker exec prism-server sh -c "ls -la '${CONTAINER_ROOT}' | head -20" \
      || die "container cannot see ${CONTAINER_ROOT} — compose bind missing?"
  else
    log "WARN: prism-server not running — skip in-container check"
  fi
  log "OK — File Library parent share ready"
  log "  host:      $MOUNT_POINT"
  log "  container: $CONTAINER_ROOT"
  log "  Settings → File Library root should be: $CONTAINER_ROOT"
  log "  Per-project folders are relative paths under that root (folder picker)."
}

main() {
  ensure_cifs_utils
  write_credentials_if_provided
  mount_now
  install_systemd_mount
  update_prism_env
  recreate_prism_server
  verify
}

main "$@"
