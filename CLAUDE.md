<!-- OPENWIKI:START -->

## OpenWiki

See [AGENTS.md](AGENTS.md) for OpenWiki agent instructions.

## Граф проекта (graphify)

Перед широким поиском по репозиторию сначала смотри граф, а не читай файлы подряд: это экономит токены.
- `graphify-out/GRAPH_REPORT.md`: хабы, сообщества, связи.
- `graphify query "<вопрос>"`, `graphify explain "<узел>"`, `graphify path "A" "B"`, `graphify affected "<узел>"`: точечные ответы по `graphify-out/graph.json`.

После изменений кода пересобери граф (только AST, без LLM) и обнови страницу на :8083:
`graphify update . --force && cp graphify-out/graph.html graph.html`. `graph.html` и `graphify-out/` в git не хранятся.

<!-- OPENWIKI:END -->

## Чек-лист изменений

После любого изменения сервера пройди [MAINTENANCE.md](MAINTENANCE.md): git, манифест Ansible, `.env.example`, списки Server Monitor, граф.

## Карта проекта (читать в начале каждой сессии)

Сервер ProDesk (Ubuntu, LAN 192.168.0.176). Claude — единственный, кто его ведёт: git — источник правды,
каждое изменение коммитится и пушится. Пользователь пишет по-русски и часто с телефона.

| Папка | Что там | Где смотреть |
|---|---|---|
| `web/gateway` | nginx: все сайты на портах 8080–8087 | `nginx.conf` |
| `web/server-monitor` | панель :8080 (FastAPI + JS), спидтест, экспорт в Prometheus | `backend/app/*.py`, `frontend/js/app.js` |
| `web/business-card` | визитка :8081 (данные в `profile.json`, не в git) | |
| `web/pricefinder` | поисковик цен :8082, API на 172.30.0.1:8003, база PostgreSQL на хосте | `bot.py`, `stores.py`, `api/main.py` |
| `web/graph` | 3D-граф проекта :8083 | |
| `web/textcheck` | проверка текста :8084 (LanguageTool) | |
| `web/cargo` | сайты грузоперевозок :8085–8087, общий 3D-планировщик | `shared/` |
| `monitoring/` | Prometheus :9090, Grafana :3000, Loki, Alloy, экспортёры | дашборды: `grafana/dashboards/build.py` → JSON |
| `tools/autodealfinder` | выгодные авто с ss.com → Telegram-группа | |
| `tools/claude-rc`, `claude-telegram`, `graphify-watch` | службы `systemd --user`: Remote Control, Telegram-бот, автообновление графа | |
| `tools/portainer` :9443, `tools/syncthing` :8384 | | |
| `vpn/amnezia`, `vpn/duckdns` | VPN — путь пользователя к серверу | **не трогать без подтверждения** |
| `security/` | fail2ban, ClamAV (ночной таймер) | |
| `media/` | Plex (нативный, не Docker), Samba | |
| `games/minecraft` | :55555, запускается вручную | |
| `ansible/` | манифест: установка всего сервера на новый ПК | `README.md`, `group_vars/all.yml` |

С чего начинать:
- Где что лежит в коде — сначала граф: `graphify query "…"` или `graphify-out/GRAPH_REPORT.md`, а не чтение файлов подряд.
- Как живой сервер: `docker ps`, `curl -s localhost:8080/api/metrics`, логи — `docker logs <имя>`.
- Сайт поменял — посмотри результат сам: скриншот через Playwright (см. память `browser-screenshots`).
- Закончил изменение — пройди [MAINTENANCE.md](MAINTENANCE.md).
- Пароль sudo — в `~/.config/homelab/credentials`; секреты — только в `.env` (репозиторий публичный).
- Готово или нужен ответ — короткое push-уведомление на телефон.
