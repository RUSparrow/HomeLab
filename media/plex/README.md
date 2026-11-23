# Plex Media Server

Plex работает **нативно** (apt-пакет `plexmediaserver`, служба systemd), а не в Docker:

- данные и библиотека: `/var/lib/plexmediaserver/Library/Application Support/Plex Media Server`
- медиа: `/mnt/media`
- веб-интерфейс: http://192.168.0.176:32400/web
- управление: `sudo systemctl restart plexmediaserver`

Раньше здесь был ещё и Docker-контейнер `lscr.io/linuxserver/plex` с `network_mode: host`.
Он не мог занять порт 32400 (его держит нативный Plex) и был удалён 2026-11-24.
Его старые настройки лежат в `./config` (не в git) — их можно удалить, если не нужны.
