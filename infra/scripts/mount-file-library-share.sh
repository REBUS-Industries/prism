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
# AD DNS — prism-prod's default resolver does not know ad.rebus.industries (NXDOMAIN).
AD_DNS_SERVERS="${FILE_LIBRARY_AD_DNS:-10.0.10.151 10.0.10.152}"
SHARE_HOST="$(printf '%s' "$SHARE" | sed -E 's|^//([^/]+)/.*|\1|')"

log() { echo "[file-library-share] $*" >&2; }
die() { echo "[file-library-share] ERROR: $*" >&2; exit 1; }

# Set by resolve_share_host — never pass IPs through $(…) capture.
SHARE_IP=""

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
  log "ensuring cifs-utils / keyutils / libkeyutils1 / smbclient"
  need_sudo apt-get update -qq
  need_sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    cifs-utils keyutils libkeyutils1 samba-common-bin
  if ! lsmod | grep -q '^cifs\>'; then
    log "loading cifs kernel module"
    need_sudo modprobe cifs || die "modprobe cifs failed — check dmesg (kernel may lack cifs)"
  fi
  lsmod | grep -q '^cifs\>' || die "cifs module not loaded"
  # error(79) ELIBACC with cifs already loaded → missing kernel crypto algs for SMB3.
  local mod
  for mod in hmac md4 md5 sha256 sha512 cmac aes ecb cbc des_generic gcm ccm aead; do
    need_sudo modprobe "$mod" 2>/dev/null || true
  done
  if command -v ldd >/dev/null 2>&1 && [[ -x /sbin/mount.cifs ]]; then
    if ldd /sbin/mount.cifs 2>/dev/null | grep -q 'not found'; then
      log "WARN: mount.cifs missing shared libs:"
      ldd /sbin/mount.cifs >&2 || true
    fi
  fi
}

ensure_dns_tools() {
  if command -v dig >/dev/null 2>&1 || command -v host >/dev/null 2>&1; then
    return 0
  fi
  log "installing dnsutils (dig)"
  need_sudo apt-get update -qq
  need_sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq dnsutils
}

# Resolve SHARE_HOST via AD DNS; sets global SHARE_IP.
resolve_share_host() {
  local ip="" dns
  SHARE_IP=""
  if getent hosts "$SHARE_HOST" >/dev/null 2>&1; then
    ip="$(getent hosts "$SHARE_HOST" | awk '/^[0-9]+\./ {print $1; exit}')"
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      log "SHARE_HOST $SHARE_HOST already resolves to $ip"
      SHARE_IP="$ip"
      return 0
    fi
  fi
  ensure_dns_tools
  for dns in $AD_DNS_SERVERS; do
    log "resolving $SHARE_HOST via AD DNS $dns"
    if command -v dig >/dev/null 2>&1; then
      ip="$(dig +short "$SHARE_HOST" "@$dns" A | awk '/^[0-9.]+$/ {print; exit}')"
    else
      ip="$(host -t A "$SHARE_HOST" "$dns" 2>/dev/null | awk '/has address/ {print $4; exit}')"
    fi
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      log "resolved $SHARE_HOST -> $ip (via $dns)"
      SHARE_IP="$ip"
      return 0
    fi
  done
  die "could not resolve $SHARE_HOST via AD DNS ($AD_DNS_SERVERS). Check name or DNS IPs."
}

ensure_hosts_entry() {
  [[ "$SHARE_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "SHARE_IP unset/invalid"
  local marker="# prism-file-library"
  local line="${SHARE_IP} ${SHARE_HOST} ${marker}"
  log "pinning /etc/hosts: $line"
  # Drop any prior lines for this hostname, then append one clean mapping.
  need_sudo sed -i -E "/[[:space:]]${SHARE_HOST}([[:space:]]|\$)/d" /etc/hosts
  echo "$line" | need_sudo tee -a /etc/hosts >/dev/null
  getent hosts "$SHARE_HOST" >/dev/null || die "/etc/hosts entry for $SHARE_HOST did not take effect"
}

# Route ad.rebus.industries queries to AD DNS via systemd-resolved (best-effort).
configure_resolved_ad_dns() {
  local drop_in_dir="/etc/systemd/resolved.conf.d"
  local drop_in="${drop_in_dir}/ad-rebus.conf"
  if ! command -v resolvectl >/dev/null 2>&1 && ! systemctl list-unit-files systemd-resolved.service >/dev/null 2>&1; then
    log "systemd-resolved not present — skip AD DNS routing drop-in"
    return 0
  fi
  log "configuring systemd-resolved AD DNS for ad.rebus.industries ($AD_DNS_SERVERS)"
  need_sudo mkdir -p "$drop_in_dir"
  need_sudo tee "$drop_in" >/dev/null <<EOF
# Managed by prism mount-file-library-share.sh — AD DNS for fileserver
[Resolve]
DNS=${AD_DNS_SERVERS}
Domains=~ad.rebus.industries
EOF
  need_sudo systemctl restart systemd-resolved || log "WARN: could not restart systemd-resolved"
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

probe_smb_share() {
  [[ -n "$SHARE_IP" ]] || return 0
  if ! command -v smbclient >/dev/null 2>&1; then
    return 0
  fi
  log "probing SMB with smbclient //${SHARE_IP}/REBUS"
  if smbclient "//${SHARE_IP}/REBUS" -A "$CRED_FILE" -c 'ls' >/tmp/prism-smbclient.out 2>/tmp/prism-smbclient.err; then
    log "smbclient OK"
    head -5 /tmp/prism-smbclient.out >&2 || true
  else
    log "WARN: smbclient failed (share name / credentials / firewall?):"
    cat /tmp/prism-smbclient.err >&2 || true
  fi
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

  # Mount by IP — avoids DNS/SPN surprises. Share name from SHARE path.
  local share_name
  share_name="$(printf '%s' "$SHARE" | sed -E 's|^//[^/]+/||')"
  [[ -n "$share_name" ]] || share_name="REBUS"
  local target="//${SHARE_IP}/${share_name}"
  [[ "$SHARE_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || target="$SHARE"

  probe_smb_share

  local base="credentials=${CRED_FILE},uid=1000,gid=1000,file_mode=0664,dir_mode=0775,iocharset=utf8,noperm,_netdev"
  local attempt opts
  # Ordered fallbacks: SMB3 crypto → SMB2.1 → NTLMSSP explicit → no serverino
  local attempts=(
    "${base},vers=3.0,sec=ntlmssp"
    "${base},vers=3.1.1,sec=ntlmssp"
    "${base},vers=2.1,sec=ntlmssp"
    "${base},vers=3.0,sec=ntlmssp,noserverino"
    "${base},vers=2.0,sec=ntlmssp"
    "${base},vers=1.0,sec=ntlm"
  )

  for opts in "${attempts[@]}"; do
    log "mounting $target -> $MOUNT_POINT ($opts)"
    if need_sudo mount -t cifs "$target" "$MOUNT_POINT" -o "$opts"; then
      mountpoint -q "$MOUNT_POINT" || die "mount reported ok but mountpoint check failed"
      # Keep SHARE pointing at hostname path for systemd documentation; unit uses IP target.
      SHARE="$target"
      log "mount ok"
      return 0
    fi
  done

  log "all mount attempts failed — diagnostics:"
  log "dmesg (last 40):"
  dmesg 2>/dev/null | tail -40 >&2 || true
  log "ldd /sbin/mount.cifs:"
  ldd /sbin/mount.cifs >&2 2>/dev/null || true
  die "mount failed with error(79) or similar. Paste dmesg + smbclient output."
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
  resolve_share_host
  ensure_hosts_entry
  configure_resolved_ad_dns
  mount_now
  install_systemd_mount
  update_prism_env
  recreate_prism_server
  verify
}

main "$@"
