#!/usr/bin/env bash
# Сессия Claude Code, которая слушает Telegram-бота (плагин telegram, канал).
# Запускается в tmux-сессии "telegram" службой claude-telegram.service.
# Remote Control не умеет --channels, поэтому это отдельная сессия.
cd "$HOME/HomeLab" || exit 1
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"   # плагин запускается через bun
# Ждём сеть и DNS (VPN, DuckDNS могут подниматься дольше)
for _ in $(seq 60); do getent hosts api.telegram.org >/dev/null && getent hosts api.anthropic.com >/dev/null && break; sleep 5; done
while true; do
  claude --channels plugin:telegram@claude-plugins-official --permission-mode bypassPermissions
  echo "claude (telegram) exited ($?), restarting in 15s..."
  sleep 15
done
