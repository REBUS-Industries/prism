#!/bin/bash
# Add merge-bot.prism-dev.rebus.industries to Caddy if missing.
set -euo pipefail
CADDY=/etc/caddy/Caddyfile
if grep -q 'merge-bot.prism-dev.rebus.industries' "$CADDY"; then
  echo "merge-bot block already present"
else
  cat >> "$CADDY" << 'EOF'

merge-bot.prism-dev.rebus.industries {
    reverse_proxy http://10.0.200.71:3456
    log {
        output file /var/log/caddy/merge-bot.log {
            roll_size 10mb
            roll_keep 5
        }
        format json
    }
}
EOF
  echo "merge-bot block appended"
fi
caddy validate --config "$CADDY"
systemctl reload caddy
echo "Caddy reloaded"

