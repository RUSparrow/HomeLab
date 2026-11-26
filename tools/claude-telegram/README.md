# claude-telegram

Отдельная сессия Claude Code, которая слушает Telegram-бота (@sparrow_homelab_bot)
через канал плагина `telegram@claude-plugins-official`. Remote Control не умеет
`--channels`, поэтому это вторая сессия рядом с `claude-rc`.

- Запуск: `systemctl --user start claude-telegram` (tmux-сессия `telegram`, `tmux attach -t telegram`).
- Плагин работает на bun (`~/.bun/bin`), скрипт добавляет его в `PATH`.
- Токен бота — `~/.claude/channels/telegram/.env` (chmod 600, **не в git**).
- Кто может писать боту — `~/.claude/channels/telegram/access.json`; держим `allowlist`.
