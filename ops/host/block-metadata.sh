#!/usr/bin/env bash
# Block cloud instance metadata (169.254.169.254) for sandboxes. Run as root at boot.
#   Docker runner: drop container traffic to IMDS in the DOCKER-USER chain.
#   Host runner:   drop traffic from the ccrunner user.
set -euo pipefail
IMDS=169.254.169.254
if iptables -L DOCKER-USER >/dev/null 2>&1; then
  iptables -C DOCKER-USER -d "$IMDS" -j DROP 2>/dev/null || iptables -I DOCKER-USER -d "$IMDS" -j DROP
fi
if id ccrunner >/dev/null 2>&1; then
  iptables -C OUTPUT -d "$IMDS" -m owner --uid-owner ccrunner -j DROP 2>/dev/null \
    || iptables -I OUTPUT -d "$IMDS" -m owner --uid-owner ccrunner -j DROP
fi
echo "metadata endpoint blocked for sandboxes"
