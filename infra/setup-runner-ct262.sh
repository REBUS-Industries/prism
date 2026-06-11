#!/usr/bin/env bash
# Run this script on the NEW CT 262 machine to register it as a second
# GitHub Actions runner for PRISM deploys.
#
# Prerequisites on the new CT/VM:
#   - Ubuntu 22.04 or 24.04
#   - Docker installed (apt install docker.io + usermod -aG docker $USER)
#   - SSH access to prism-dev (10.0.200.212) configured at ~/.ssh/config
#     with the same key as CT 261 uses
#   - curl, tar installed
#
# Run as: bash setup-runner-ct262.sh

set -euo pipefail

RUNNER_VERSION="2.325.0"
RUNNER_USER="${RUNNER_USER:-rebus}"
RUNNER_HOME="/home/${RUNNER_USER}/actions-runner"
REPO="REBUS-Industries/prism"
# Registration token (expires in 1 hour — regenerate with:
#   gh api repos/REBUS-Industries/prism/actions/runners/registration-token --method POST --jq '.token'
# if this one has expired)
REG_TOKEN="AST3KYVOHILDRAI3UWFZR6DKFLOOA"
RUNNER_LABELS="self-hosted,Linux,X64,prism-deploy"
RUNNER_NAME="RB-DA2-Runner2"

echo "=== Setting up GitHub Actions runner ${RUNNER_NAME} ==="

# Create runner directory
mkdir -p "${RUNNER_HOME}"
cd "${RUNNER_HOME}"

# Download runner
curl -sL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
  | tar xz

# Configure
./config.sh \
  --url "https://github.com/${REPO}" \
  --token "${REG_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "${RUNNER_LABELS}" \
  --work "_work" \
  --unattended \
  --replace

# Install as a systemd service so it starts on reboot
sudo ./svc.sh install "${RUNNER_USER}"
sudo ./svc.sh start

echo ""
echo "=== Runner registered and started ==="
echo "Status:"
sudo ./svc.sh status

echo ""
echo "=== Configuring daily disk cleanup cron ==="
(crontab -l 2>/dev/null; echo "0 3 * * * rm -rf ${RUNNER_HOME}/_work/* 2>/dev/null; docker system prune -af --filter 'until=24h' 2>/dev/null || true") | crontab -
echo "Cron added: daily cleanup at 3am"

echo ""
echo "Done. Runner ${RUNNER_NAME} is registered with label 'prism-deploy'."
echo "GitHub will now distribute deploy jobs across CT 261 and CT 262."
