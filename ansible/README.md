# Ansible: HomeLab на новом компьютере

Два плейбука, общие настройки — в `group_vars/all.yml`.

| Плейбук | Что делает |
|---|---|
| `install-homelab.yml` | Ставит всё, что есть на сервере сейчас: пакеты, Docker, Plex, PostgreSQL для PriceFinder, Samba, fail2ban и его экспортёр, таймер ClamAV, все Docker-сервисы в правильном порядке, uv/bun/Claude Code/graphify и службы автозапуска. Повторный запуск безопасен. |
| `update-server.yml` | Скачивает новые образы и пересоздаёт изменившиеся контейнеры по тому же списку проектов. |

## Установка на новый ПК

```bash
# 1. Ubuntu Server 24.04+, пользователь sparrow. Ansible целиком (с коллекциями):
sudo apt install -y git ansible

# 2. Репозиторий
git clone https://github.com/rusparrow/homelab.git ~/HomeLab
cd ~/HomeLab

# 3. Секреты — их нет в git. Скопируйте примеры и заполните:
cp vpn/duckdns/.env.example vpn/duckdns/.env
cp tools/autodealfinder/.env.example tools/autodealfinder/.env
cp web/pricefinder/.env.example web/pricefinder/.env   # придумать пароль базы
#    плюс из бэкапа: web/business-card/profile.json

# 4. Диски медиатеки: UUID дисков (lsblk -f) — в ansible/group_vars/all.yml → data_disks

# 5. Установка
cd ansible
ansible-playbook install-homelab.yml -K
```

В конце плейбук печатает, что осталось сделать руками:

1. **VPN Amnezia** — ставится приложением AmneziaVPN по SSH. Манифест VPN, файрвол и SSH
   не трогает: ошибка там отрезает доступ к серверу (правила — в `~/.claude/CLAUDE.md`).
2. **Claude Code** — войти (`claude`) и поставить плагины `frontend-design` и `telegram`.
3. **Telegram-бот Claude** — токен в `~/.claude/channels/telegram/.env`, привязка `/telegram:access`.
4. **Plex** — привязать к аккаунту, библиотеку восстановить из бэкапа `/var/lib/plexmediaserver`.
5. **Данные из бэкапа** — мир Minecraft, Syncthing, база PriceFinder (по желанию: она пересобирается поиском).

## Частичный запуск

Теги: `base`, `docker`, `plex`, `storage`, `samba`, `security`, `postgres`, `clamav`, `apps`, `user`.

```bash
ansible-playbook install-homelab.yml -K --tags apps          # только Docker-сервисы
ansible-playbook install-homelab.yml -K --check --diff       # что изменится, ничего не меняя
```

## Что важно знать

- **Порядок сервисов** — `compose_projects`. Сервисы мониторинга и Server Monitor подключаются к
  сети `monitoring`, веб-шлюз — к сетям Server Monitor, PriceFinder и проверки текста, поэтому
  сети создаются заранее, а шлюз стартует последним.
- **Сеть `price-watcher_default`** создаётся с подсетью `172.30.0.0/16`: API PriceFinder слушает
  `172.30.0.1:8003`, а nginx-шлюз ходит туда.
- **Владельцы папок данных** — пользователи контейнеров (Grafana 472, Loki 10001, Prometheus 65534,
  ClamAV 100). Если поменять на `sparrow`, эти сервисы перестанут писать данные.
- **Docker** ставится из репозитория Ubuntu (`docker.io`, `docker-compose-v2`) — как на сервере.

Проверено пробным прогоном (`--check`) на рабочем сервере 2026-11-28: манифест описывает его
полностью, лишних изменений нет.
