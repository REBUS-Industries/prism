#!/usr/bin/env python3
"""Replace prism-dev.rebus.industries vhost with 301 redirect to prod."""
import re
from pathlib import Path

CADDY = Path("/etc/caddy/Caddyfile")
text = CADDY.read_text()
replacement = """prism-dev.rebus.industries {
    redir https://prism.rebus.industries{uri} permanent
}
"""
pattern = r"prism-dev\.rebus\.industries \{.*?\n\}"
new_text, n = re.subn(pattern, replacement.strip() + "\n", text, count=1, flags=re.DOTALL)
if n == 0:
    raise SystemExit("prism-dev block not found")
CADDY.write_text(new_text)
print("prism-dev redirect installed")
