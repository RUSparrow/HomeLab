"""Метрики панели в формате Prometheus (/metrics).

Prometheus забирает их раз в 30 секунд, а Grafana строит по ним графики:
состояние каждого сервиса, VPN-клиенты, игроки Minecraft, ClamAV.
"""

LEVELS = {"ok": 0, "idle": 1, "warn": 2, "bad": 3}


def _esc(value) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


class _Writer:
    """Собирает метрики, группируя строки одной метрики вместе — так требует формат."""

    def __init__(self):
        self.families: dict[str, tuple[str, str, list[str]]] = {}

    def add(self, name: str, value, help_text: str, labels: dict | None = None, kind: str = "gauge"):
        if value is None:
            return
        family = self.families.setdefault(name, (help_text, kind, []))
        label_str = ""
        if labels:
            label_str = "{" + ",".join(f'{k}="{_esc(v)}"' for k, v in labels.items()) + "}"
        family[2].append(f"{name}{label_str} {float(value)}")

    def text(self) -> str:
        out = []
        for name, (help_text, kind, samples) in self.families.items():
            out += [f"# HELP {name} {help_text}", f"# TYPE {name} {kind}", *samples]
        return "\n".join(out) + "\n"


def render(data: dict) -> str:
    w = _Writer()
    insights = data.get("insights", {})

    for service, info in insights.items():
        w.add("homelab_service_status", LEVELS.get(info.get("level"), 3),
              "Состояние сервиса: 0 ok, 1 ожидание, 2 внимание, 3 проблема", {"service": service})

    for c in (data.get("docker") or {}).get("containers", []):
        labels = {"container": c["name"]}
        w.add("homelab_container_running", 1 if c["status"] == "running" else 0, "Контейнер запущен", labels)
        w.add("homelab_container_restarts", c.get("restart_count") or 0, "Перезапуски контейнера", labels)

    vpn = data.get("amnezia") or {}
    w.add("homelab_vpn_up", 1 if vpn.get("available") else 0, "AmneziaWG работает")
    for peer in vpn.get("peers", []):
        labels = {"peer": peer.get("name") or peer.get("ip")}
        w.add("homelab_vpn_peer_online", 1 if peer.get("online") else 0, "Клиент VPN на связи", labels)
        w.add("homelab_vpn_peer_received_bytes", peer.get("received_bytes"), "Получено от клиента", labels, "counter")
        w.add("homelab_vpn_peer_sent_bytes", peer.get("sent_bytes"), "Отправлено клиенту", labels, "counter")
    w.add("homelab_vpn_peers_online", vpn.get("online_count"), "Клиентов VPN на связи")

    plex = data.get("plex") or {}
    w.add("homelab_plex_up", 1 if (plex.get("web") or {}).get("available") else 0, "Plex отвечает")

    clam = (insights.get("clamav") or {}).get("values") or {}
    w.add("homelab_clamav_infected_files", clam.get("infected"), "Заражённых файлов в последней проверке")
    w.add("homelab_clamav_last_scan_timestamp_seconds", clam.get("last_scan"), "Время последней проверки ClamAV")
    w.add("homelab_clamav_scanned_files", clam.get("scanned"), "Проверено файлов в последней проверке")

    mc = insights.get("minecraft")
    if mc:
        w.add("homelab_minecraft_up", 1 if mc.get("level") == "ok" else 0, "Сервер Minecraft отвечает")
        w.add("homelab_minecraft_players", ((mc.get("values") or {}).get("players")) or 0, "Игроков онлайн")

    temp = data.get("temperature") or {}
    w.add("homelab_cpu_temperature_celsius", temp.get("celsius"), "Температура процессора (пакет)")
    return w.text()
