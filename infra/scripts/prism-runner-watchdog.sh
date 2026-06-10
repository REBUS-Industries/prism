#!/bin/bash
# Watchdog for GitHub Actions self-hosted runner on CT 261 (RB-DA2-Runner1).
# Restarts the listener when the service is down or idle too long with no job activity.
set -euo pipefail

UNIT="actions.runner.REBUS-Industries-prism.RB-DA2-Runner1.service"

if ! systemctl is-active --quiet "$UNIT"; then
  logger -t prism-runner-watchdog "Runner service inactive — restarting"
  systemctl restart "$UNIT"
  exit 0
fi

if ! pgrep -f 'Runner.Listener run' >/dev/null; then
  logger -t prism-runner-watchdog "Runner.Listener process missing — restarting"
  systemctl restart "$UNIT"
  exit 0
fi

# Long-poll can drop while systemd still reports active; restart if no jobs/listen in 20 min.
RECENT_LISTEN=$(journalctl -u "$UNIT" --since "20 min ago" --no-pager | grep -c "Listening for Jobs" || true)
RECENT_JOBS=$(journalctl -u "$UNIT" --since "20 min ago" --no-pager | grep -c "Running job" || true)
if [ "$RECENT_LISTEN" -eq 0 ] && [ "$RECENT_JOBS" -eq 0 ]; then
  if journalctl -u "$UNIT" --since "20 min ago" --no-pager | grep -q "Connected to GitHub"; then
    logger -t prism-runner-watchdog "No listener/job activity in 20 min — restarting"
    systemctl restart "$UNIT"
  fi
fi
