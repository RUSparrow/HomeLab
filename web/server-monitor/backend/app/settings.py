"""Названия клиентов и сетевые настройки Server Monitor."""

# LAN-адрес сервера. Фронтенд подменяет его на адрес, по которому
# открыта панель, поэтому ссылки работают и через VPN.
SERVER_IP = "192.168.0.176"

DUCKDNS_DOMAIN = "rusparrow.duckdns.org"
GAME_SERVER_ADDRESS = f"{DUCKDNS_DOMAIN}:55555"

AMNEZIA_CLIENT_NAMES = {
    "10.8.1.1": "Ubuntu Admin",
    "10.8.1.2": "Pasha",
    "10.8.1.3": "Windows Admin",
    "10.8.1.4": "OnePlus",
    "10.8.1.5": "Legion",
    "10.8.1.6": "Karina",
    "10.8.1.7": "Jano4ka",
}

DOCKER_DESCRIPTIONS = {
    "alloy": "Сбор логов и телеметрии",
    "autodealfinder": "Выгодные авто с ss.com → Telegram",
    "amnezia-awg2": "VPN-сервер Amnezia",
    "clamav": "Антивирусная проверка файлов",
    "deploy-agent": "Агент развертывания",
    "duckdns": "Обновление домена DuckDNS",
    "fail2ban-exporter": "Метрики Fail2ban",
    "grafana": "Панели мониторинга",
    "languagetool": "Проверка орфографии и грамматики",
    "loki": "Хранение и поиск логов",
    "minecraft": "Игровой сервер Minecraft",
    "minecraft-backup": "Резервные копии Minecraft",
    "node-exporter": "Метрики системы",
    "plex": "Медиасервер Plex",
    "portainer": "Управление Docker",
    "pricefinder-api": "API мониторинга цен",
    "pricefinder-web": "Веб-интерфейс PriceFinder",
    "prometheus": "Сбор и хранение метрик",
    "server-monitor": "Панель мониторинга сервера",
    "smartctl-exporter": "Метрики состояния дисков",
    "syncthing": "Синхронизация файлов",
    "textcheck-api": "Формы слов для проверки текста",
    "website": "Веб-сайт",
    "websites": "Веб-шлюз для сайтов",
}

# Порты контейнеров с network_mode: host — Docker их не показывает.
HOST_NETWORK_PORTS = {
    "amnezia-awg2": ["45180/udp"],
    "plex": ["32400/tcp"],
}

# Явные ссылки для сервисов, у которых их нельзя надёжно угадать по портам.
# {ip} заменяется на SERVER_IP. Пустая строка — ссылки нет, только подпись.
LINK_OVERRIDES = {
    "portainer": ("https://{ip}:9443", None),
    "plex": ("http://{ip}:32400/web", None),
    "server-monitor": ("http://{ip}:8080", None),
    "languagetool": ("http://{ip}:8084", None),
    "minecraft": ("", GAME_SERVER_ADDRESS),
    "duckdns": ("", DUCKDNS_DOMAIN),
}
