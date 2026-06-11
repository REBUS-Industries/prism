#!/usr/bin/env bash
# Bootstrap CT 263 as second prism-deploy runner. Run on SRV03 as root:
#   REG_TOKEN=$(gh api repos/REBUS-Industries/prism/actions/runners/registration-token --method POST --jq .token)
#   REG_TOKEN=$REG_TOKEN bash bootstrap-runner-ct263.sh
set -euo pipefail

REG_TOKEN="${REG_TOKEN:?Set REG_TOKEN from gh api repos/.../registration-token}"
RUNNER_VERSION="${RUNNER_VERSION:-2.325.0}"
CT_SRC=261
CT_DST=263

pct exec "$CT_DST" -- bash -c '
  id runner &>/dev/null || useradd -m -s /bin/bash runner
  echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner
  chmod 440 /etc/sudoers.d/runner
'

pct exec "$CT_SRC" -- tar -C /home/runner -cf - .ssh | pct exec "$CT_DST" -- tar -C /home/runner -xf -
pct exec "$CT_DST" -- chown -R runner:runner /home/runner/.ssh
pct exec "$CT_DST" -- chmod 700 /home/runner/.ssh
pct exec "$CT_DST" -- chmod 600 /home/runner/.ssh/prism_deploy_ed25519

pct exec "$CT_DST" -- bash -c "
  set -euo pipefail
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl tar openssh-client git ca-certificates sudo
  mkdir -p /home/runner/actions-runner
  chown -R runner:runner /home/runner/actions-runner
  cd /home/runner/actions-runner
  curl -sL https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz | tar xz
  chown -R runner:runner /home/runner/actions-runner
"

pct exec "$CT_DST" -- bash -c "
  set -euo pipefail
  cd /home/runner/actions-runner
  sudo -u runner ./config.sh \
    --url https://github.com/REBUS-Industries/prism \
    --token ${REG_TOKEN} \
    --name RB-DA2-Runner2 \
    --labels self-hosted,Linux,X64,prism-deploy \
    --work _work \
    --unattended \
    --replace
  ./svc.sh install runner
  ./svc.sh start
"

pct exec "$CT_DST" -- bash -c '
  mkdir -p /home/runner/actions-runner/_work/prism/prism
  chown -R runner:runner /home/runner/actions-runner/_work
  cat > /usr/local/bin/prism-runner-watchdog.sh << "EOF"
#!/bin/bash
set -euo pipefail
UNIT="actions.runner.REBUS-Industries-prism.RB-DA2-Runner2.service"
if ! systemctl is-active --quiet "$UNIT"; then
  logger -t prism-runner-watchdog "Runner service inactive — restarting"
  systemctl restart "$UNIT"
  exit 0
fi
if ! pgrep -f "Runner.Listener run --startuptype" >/dev/null; then
  logger -t prism-runner-watchdog "Runner.Listener process missing — restarting"
  systemctl restart "$UNIT"
  exit 0
fi
EOF
  chmod +x /usr/local/bin/prism-runner-watchdog.sh
  printf "%s\n" \
    "*/10 * * * * /usr/local/bin/prism-runner-watchdog.sh" \
    "0 3 * * * find /home/runner/actions-runner/_work -mindepth 2 -maxdepth 2 -not -name prism -exec rm -rf {} + 2>/dev/null; docker system prune -af --filter until=24h 2>/dev/null || true" \
    "0 */6 * * * find /home/runner/actions-runner/_diag -type f -name Runner_*.log -mmin +360 -delete 2>/dev/null" \
    | crontab -
'

pct exec "$CT_DST" -- bash -c 'sudo -u runner ssh -o BatchMode=yes -o ConnectTimeout=10 prism-dev echo deploy-ssh-ok'
pct exec "$CT_DST" -- systemctl is-active "actions.runner.REBUS-Industries-prism.RB-DA2-Runner2.service"
echo "CT 263 RB-DA2-Runner2 online"
