#!/usr/bin/env bash
# Keeps Claude Code Remote Control running; restarts it if it exits.
# Started inside tmux session "claude" by claude-rc.service (systemd --user).
cd "$HOME/HomeLab" || exit 1
# Wait up to 5 min for DNS/network (VPN, DuckDNS etc. may still be coming up)
for _ in $(seq 60); do getent hosts api.anthropic.com >/dev/null && break; sleep 5; done
while true; do
  "$HOME/.local/bin/claude" remote-control --spawn same-dir --permission-mode bypassPermissions
  echo "claude remote-control exited ($?), restarting in 15s..."
  sleep 15
done
