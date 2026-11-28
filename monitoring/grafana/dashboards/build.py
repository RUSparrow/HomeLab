#!/usr/bin/env python3
"""Генератор дашбордов Grafana для HomeLab.

Дашборды хранятся в git как JSON и подхватываются Grafana автоматически
(provisioning). Править нужно этот файл, затем запустить:

    python3 monitoring/grafana/dashboards/build.py

Grafana перечитывает файлы раз в минуту. id панелей постоянные — по ним
Server Monitor встраивает отдельные графики (d-solo).
"""

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent
PROM = {"type": "prometheus", "uid": "dfx33msjmzjlsa"}
LOKI = {"type": "loki", "uid": "ffx32zjnaoq2oa"}

DISK_NAMES = {"sdc": "Системный (sdc)", "sda": "disk1 (sda)", "sdb": "disk2 (sdb)"}
MOUNT_NAMES = {"/": "Системный", "/mnt/disk1": "disk1", "/mnt/disk2": "disk2"}

STATUS_MAPPING = [{
    "type": "value",
    "options": {
        "0": {"text": "OK", "color": "green", "index": 0},
        "1": {"text": "ожидание", "color": "blue", "index": 1},
        "2": {"text": "внимание", "color": "yellow", "index": 2},
        "3": {"text": "проблема", "color": "red", "index": 3},
    },
}]
ONLINE_MAPPING = [{
    "type": "value",
    "options": {
        "0": {"text": "нет", "color": "#2c3038", "index": 0},
        "1": {"text": "на связи", "color": "green", "index": 1},
    },
}]


def target(expr, legend="", ds=PROM, ref="A", **extra):
    return {"datasource": ds, "expr": expr, "legendFormat": legend, "refId": ref, **extra}


def rename(mapping):
    return [{"matcher": {"id": "byName", "options": k},
             "properties": [{"id": "displayName", "value": v}]} for k, v in mapping.items()]


def thresholds(*steps):
    """steps: (value, color) — первое значение None."""
    return {"mode": "absolute", "steps": [{"value": v, "color": c} for v, c in steps]}


def timeseries(pid, title, targets, unit="short", *, x, y, w=12, h=8, min_=None, max_=None,
               stack=False, fill=12, overrides=None, description="", draw="line", decimals=None,
               thresholds_=None, legend_calcs=("mean", "max")):
    custom = {"drawStyle": draw, "lineWidth": 2, "fillOpacity": fill, "gradientMode": "opacity",
              "showPoints": "never", "spanNulls": 120000, "axisSoftMin": 0,
              "stacking": {"mode": "normal" if stack else "none", "group": "A"}}
    if thresholds_:
        custom["thresholdsStyle"] = {"mode": "dashed"}
    defaults = {"unit": unit, "custom": custom, "color": {"mode": "palette-classic"}}
    if min_ is not None:
        defaults["min"] = min_
    if max_ is not None:
        defaults["max"] = max_
    if decimals is not None:
        defaults["decimals"] = decimals
    if thresholds_:
        defaults["thresholds"] = thresholds_
    return {
        "id": pid, "type": "timeseries", "title": title, "description": description,
        "gridPos": {"x": x, "y": y, "w": w, "h": h}, "datasource": PROM, "targets": targets,
        "fieldConfig": {"defaults": defaults, "overrides": overrides or []},
        "options": {"legend": {"displayMode": "table", "placement": "bottom",
                               "calcs": list(legend_calcs)},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
    }


def stat(pid, title, targets, unit="short", *, x, y, w=4, h=4, thresholds_=None, mappings=None,
         description="", color_mode="value", graph=True, decimals=None):
    defaults = {"unit": unit, "color": {"mode": "thresholds"},
                "thresholds": thresholds_ or thresholds((None, "green")), "mappings": mappings or []}
    if decimals is not None:
        defaults["decimals"] = decimals
    return {
        "id": pid, "type": "stat", "title": title, "description": description,
        "gridPos": {"x": x, "y": y, "w": w, "h": h}, "datasource": PROM, "targets": targets,
        "fieldConfig": {"defaults": defaults, "overrides": []},
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                    "colorMode": color_mode, "graphMode": "area" if graph else "none",
                    "textMode": "auto", "justifyMode": "center", "wideLayout": True},
    }


def bargauge(pid, title, targets, unit="percent", *, x, y, w=12, h=6, overrides=None, max_=100):
    return {
        "id": pid, "type": "bargauge", "title": title,
        "gridPos": {"x": x, "y": y, "w": w, "h": h}, "datasource": PROM, "targets": targets,
        "fieldConfig": {"defaults": {"unit": unit, "min": 0, "max": max_, "color": {"mode": "thresholds"},
                                     "thresholds": thresholds((None, "green"), (75, "yellow"), (90, "red"))},
                        "overrides": overrides or []},
        "options": {"orientation": "horizontal", "displayMode": "gradient", "showUnfilled": True,
                    "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                    "namePlacement": "left", "valueMode": "color"},
    }


def state_timeline(pid, title, targets, mappings, *, x, y, w=24, h=8, description="", steps=None):
    return {
        "id": pid, "type": "state-timeline", "title": title, "description": description,
        "gridPos": {"x": x, "y": y, "w": w, "h": h}, "datasource": PROM, "targets": targets,
        "fieldConfig": {"defaults": {"mappings": mappings, "color": {"mode": "thresholds"},
                                     "thresholds": thresholds(*steps),
                                     "custom": {"fillOpacity": 80, "lineWidth": 0}},
                        "overrides": []},
        "options": {"showValue": "never", "mergeValues": True, "alignValue": "left", "rowHeight": 0.85,
                    "legend": {"showLegend": False}, "tooltip": {"mode": "single"}},
    }


def dashboard(uid, title, panels, *, time_from="now-6h", refresh="1m", templating=None, tags=()):
    return {
        "uid": uid, "title": title, "tags": ["homelab", *tags], "timezone": "browser",
        "editable": False, "graphTooltip": 1, "refresh": refresh, "schemaVersion": 39, "version": 1,
        "time": {"from": time_from, "to": "now"},
        "timepicker": {"refresh_intervals": ["30s", "1m", "5m", "15m"]},
        "templating": {"list": templating or []}, "annotations": {"list": []}, "links": [
            {"title": "Все дашборды HomeLab", "type": "dashboards", "tags": ["homelab"], "asDropdown": True,
             "includeVars": False, "keepTime": True}],
        "panels": panels,
    }


# ------------------------------------------------------------------ Сервер

CPU = '100 * (1 - avg(rate(node_cpu_seconds_total{job="node",instance="node-exporter:9100",mode="idle"}[$__rate_interval])))'
RAM = '100 * (1 - node_memory_MemAvailable_bytes{job="node",instance="node-exporter:9100"} / node_memory_MemTotal_bytes{job="node",instance="node-exporter:9100"})'
TEMP = ('node_hwmon_temp_celsius{instance="node-exporter:9100",chip="platform_coretemp_0"} '
        '* on(instance, chip, sensor) group_left(label) node_hwmon_sensor_label{instance="node-exporter:9100",chip="platform_coretemp_0"}')
NET_IF = 'device="eno1",instance="node-exporter:9100"'
NET_DESC = "Сетевая карта eno1 — весь трафик сервера: интернет, домашняя сеть и VPN вместе. Входящий — данные, пришедшие в сервер, исходящий — ушедшие из него. Это текущая нагрузка, а не скорость интернета (её никто не замеряет)."
VPN_RX = "sum(rate(homelab_vpn_peer_received_bytes[$__rate_interval]))"
VPN_TX = "sum(rate(homelab_vpn_peer_sent_bytes[$__rate_interval]))"
FS = 'instance="node-exporter:9100",mountpoint=~"/|/mnt/disk1|/mnt/disk2",fstype!~"tmpfs|overlay"'

server = dashboard("homelab-server", "HomeLab · Сервер", [
    stat(1, "Процессор", [target(CPU)], "percent", x=0, y=0, decimals=0,
         thresholds_=thresholds((None, "green"), (70, "yellow"), (90, "red"))),
    stat(2, "Память", [target(RAM)], "percent", x=4, y=0, decimals=0,
         thresholds_=thresholds((None, "green"), (80, "yellow"), (92, "red"))),
    stat(3, "Температура CPU", [target('max(node_hwmon_temp_celsius{instance="node-exporter:9100",chip="platform_coretemp_0",sensor="temp1"})')],
         "celsius", x=8, y=0, decimals=0,
         thresholds_=thresholds((None, "green"), (70, "yellow"), (85, "red"))),
    stat(4, "Сервер ↓ принимает", [target(f'rate(node_network_receive_bytes_total{{{NET_IF}}}[$__rate_interval])')],
         "Bps", x=12, y=0, description=NET_DESC),
    stat(5, "Сервер ↑ отдаёт", [target(f'rate(node_network_transmit_bytes_total{{{NET_IF}}}[$__rate_interval])')],
         "Bps", x=16, y=0, description=NET_DESC),
    stat(6, "Аптайм", [target('time() - node_boot_time_seconds{job="node",instance="node-exporter:9100"}')], "s", x=20, y=0, graph=False,
         decimals=0),

    timeseries(10, "Загрузка процессора", [
        target(CPU, "Всего"),
        target('100 * sum by (mode) (rate(node_cpu_seconds_total{job="node",instance="node-exporter:9100",mode=~"iowait|system"}[$__rate_interval])) / scalar(count(node_cpu_seconds_total{job="node",instance="node-exporter:9100",mode="idle"}))',
               "{{mode}}", ref="B"),
    ], "percent", x=0, y=4, min_=0, max_=100,
        overrides=rename({"iowait": "Ожидание диска (iowait)", "system": "Ядро системы"}),
        description="Сколько процентов процессора занято. iowait — процессор ждёт диски."),
    timeseries(11, "Средняя нагрузка (load average)", [
        target('node_load1{job="node",instance="node-exporter:9100"}', "1 мин"), target('node_load5{job="node",instance="node-exporter:9100"}', "5 мин", ref="B"),
        target('node_load15{job="node",instance="node-exporter:9100"}', "15 мин", ref="C"),
    ], x=12, y=4, decimals=2,
        thresholds_=thresholds((None, "green"), (8, "red")),
        description="Очередь задач процессора. У i7-4770 8 потоков: до 8 — норма."),

    timeseries(12, "Память", [
        target('node_memory_MemTotal_bytes{job="node",instance="node-exporter:9100"} - node_memory_MemAvailable_bytes{job="node",instance="node-exporter:9100"}', "Занято"),
        target('node_memory_Cached_bytes{job="node",instance="node-exporter:9100"} + node_memory_Buffers_bytes{job="node",instance="node-exporter:9100"}', "Кэш (освобождается сам)", ref="B"),
        target('node_memory_SwapTotal_bytes{job="node",instance="node-exporter:9100"} - node_memory_SwapFree_bytes{job="node",instance="node-exporter:9100"}', "Swap", ref="C"),
    ], "bytes", x=0, y=12, min_=0),
    timeseries(13, "Температура процессора", [target(TEMP, "{{label}}")], "celsius", x=12, y=12, fill=0,
               thresholds_=thresholds((None, "transparent"), (85, "red")),
               overrides=[{"matcher": {"id": "byRegexp", "options": "Package.*"},
                           "properties": [{"id": "displayName", "value": "Весь процессор"},
                                          {"id": "custom.lineWidth", "value": 3}]}]),

    timeseries(14, "Трафик сервера (сетевая карта eno1) и доля VPN", [
        target(f'rate(node_network_receive_bytes_total{{{NET_IF}}}[$__rate_interval])', "Весь ↓ в сервер"),
        target(f'-rate(node_network_transmit_bytes_total{{{NET_IF}}}[$__rate_interval])', "Весь ↑ из сервера", ref="B"),
        target(VPN_RX, "VPN ↓ от клиентов", ref="C"),
        target(f"-{VPN_TX}", "VPN ↑ клиентам", ref="D"),
    ], "Bps", x=0, y=20, description=NET_DESC + " VPN — часть общего трафика: то, что прошло через "
                                    "AmneziaWG от твоих устройств и к ним. Исходящий показан вниз от нуля."),
    timeseries(15, "Диски: чтение и запись", [
        target('sum by (device) (rate(node_disk_read_bytes_total{instance="node-exporter:9100",device=~"sd[a-z]"}[$__rate_interval]))', "{{device}} чтение"),
        target('-sum by (device) (rate(node_disk_written_bytes_total{instance="node-exporter:9100",device=~"sd[a-z]"}[$__rate_interval]))', "{{device}} запись", ref="B"),
    ], "Bps", x=12, y=20, fill=0, description="Запись показана вниз от нуля."),

    bargauge(16, "Заполненность дисков", [
        target(f'100 * (1 - node_filesystem_avail_bytes{{{FS}}} / node_filesystem_size_bytes{{{FS}}})', "{{mountpoint}}", instant=True),
    ], x=0, y=28, overrides=rename(MOUNT_NAMES)),
    timeseries(17, "Температура дисков (SMART)", [
        target('smartctl_device_temperature{temperature_type="current"}', "{{device}}"),
    ], "celsius", x=12, y=28, h=6, fill=0, overrides=rename(DISK_NAMES),
        thresholds_=thresholds((None, "transparent"), (50, "red"))),
    timeseries(18, "Свободное место", [
        target(f'node_filesystem_avail_bytes{{{FS}}}', "{{mountpoint}}"),
    ], "bytes", x=0, y=34, w=24, h=7, fill=0, overrides=rename(MOUNT_NAMES), legend_calcs=("lastNotNull", "min")),
], tags=("server",))

# -------------------------------------------------------------- Контейнеры

C = 'name!="",name!~"cadvisor"'
containers = dashboard("homelab-containers", "HomeLab · Контейнеры", [
    timeseries(1, "Процессор по контейнерам", [
        target(f'100 * sum by (name) (rate(container_cpu_usage_seconds_total{{{C}}}[$__rate_interval]))', "{{name}}"),
    ], "percent", x=0, y=0, h=10, fill=0,
        description="100% = одно ядро целиком. У сервера 8 потоков, максимум 800%."),
    timeseries(2, "Память по контейнерам", [
        target(f'sum by (name) (container_memory_working_set_bytes{{{C}}})', "{{name}}"),
    ], "bytes", x=12, y=0, h=10, stack=True, fill=40, legend_calcs=("lastNotNull", "max")),
    timeseries(3, "Контейнеры: входящий трафик", [
        target(f'sum by (name) (rate(container_network_receive_bytes_total{{{C}}}[$__rate_interval]))', "{{name}}"),
    ], "Bps", x=0, y=10, fill=0,
        description="Что каждый контейнер получает через свою Docker-сеть: и из интернета, и от других "
                    "контейнеров (например, шлюз ↔ сайты). Контейнеры с сетью хоста (node-exporter, PriceFinder API) здесь не видны."),
    timeseries(4, "Контейнеры: исходящий трафик", [
        target(f'sum by (name) (rate(container_network_transmit_bytes_total{{{C}}}[$__rate_interval]))', "{{name}}"),
    ], "Bps", x=12, y=10, fill=0,
        description="Что каждый контейнер отдаёт через свою Docker-сеть: в интернет и другим контейнерам."),
    timeseries(5, "Диск: запись по контейнерам", [
        target(f'sum by (name) (rate(container_fs_writes_bytes_total{{{C}}}[$__rate_interval]))', "{{name}}"),
    ], "Bps", x=0, y=18, fill=0),
    {
        "id": 6, "type": "table", "title": "Сводка (сейчас)", "gridPos": {"x": 12, "y": 18, "w": 12, "h": 8},
        "datasource": PROM,
        "targets": [
            target(f'100 * sum by (name) (rate(container_cpu_usage_seconds_total{{{C}}}[5m]))', ref="A", instant=True, format="table"),
            target(f'sum by (name) (container_memory_working_set_bytes{{{C}}})', ref="B", instant=True, format="table"),
            target('max by (name) (label_replace(homelab_container_restarts, "name", "$1", "container", "(.*)"))',
                   ref="C", instant=True, format="table"),
        ],
        "transformations": [
            {"id": "merge", "options": {}},
            {"id": "organize", "options": {"excludeByName": {"Time": True},
                                           "renameByName": {"name": "Контейнер", "Value #A": "CPU",
                                                            "Value #B": "Память", "Value #C": "Перезапуски"}}},
            {"id": "sortBy", "options": {"sort": [{"field": "Память", "desc": True}]}},
        ],
        "fieldConfig": {"defaults": {}, "overrides": [
            {"matcher": {"id": "byName", "options": "CPU"}, "properties": [
                {"id": "unit", "value": "percent"}, {"id": "decimals", "value": 1}]},
            {"matcher": {"id": "byName", "options": "Память"}, "properties": [
                {"id": "unit", "value": "bytes"},
                {"id": "color", "value": {"mode": "continuous-GrYlRd"}},
                {"id": "custom.cellOptions", "value": {"type": "gauge", "mode": "basic"}},
                {"id": "max", "value": 1024 ** 3}]},
        ]},
        "options": {"showHeader": True, "cellHeight": "sm"},
    },
], tags=("containers",))

# -------------------------------------------------- Сервисы и безопасность

services = dashboard("homelab-services", "HomeLab · Сервисы и безопасность", [
    state_timeline(1, "Состояние сервисов", [target("max by (service) (homelab_service_status)", "{{service}}")],
                   STATUS_MAPPING, x=0, y=0, h=10,
                   steps=[(None, "green"), (1, "blue"), (2, "yellow"), (3, "red")],
                   description="Та же оценка, что в карточках Server Monitor: зелёный — всё хорошо, синий — "
                               "выключен по плану, жёлтый — внимание, красный — проблема."),
    state_timeline(2, "VPN-клиенты на связи", [target("max by (peer) (homelab_vpn_peer_online)", "{{peer}}")],
                   ONLINE_MAPPING, x=0, y=10, h=7, steps=[(None, "#2c3038"), (1, "green")]),
    timeseries(3, "Трафик VPN по клиентам", [
        target("sum by (peer) (rate(homelab_vpn_peer_sent_bytes[$__rate_interval]) "
               "+ rate(homelab_vpn_peer_received_bytes[$__rate_interval])) > 0", "{{peer}}"),
    ], "Bps", x=0, y=17, h=8, fill=0,
        description="Сумма в обе стороны для каждого устройства, подключённого к AmneziaWG: "
                    "сколько трафика оно гоняет через сервер в интернет и обратно."),
    timeseries(4, "Fail2ban: неудачные входы по SSH", [
        target('sum(increase(f2b_jail_failed_total{jail="sshd"}[$__interval]))', "Попытки", interval="15m"),
    ], x=12, y=17, h=8, draw="bars", fill=70, legend_calcs=("sum", "max"),
        description="Боты из интернета перебирают пароли. Каждый столбик — 15 минут."),
    stat(5, "Забанено сейчас", [target('sum(f2b_jail_banned_current{jail="sshd"})')], x=0, y=25,
         thresholds_=thresholds((None, "green"), (10, "yellow"))),
    stat(6, "Банов за сутки", [target('sum(increase(f2b_jail_banned_total{jail="sshd"}[24h]))')], x=4, y=25,
         decimals=0, graph=False),
    stat(7, "ClamAV: вирусов", [target("homelab_clamav_infected_files")], x=8, y=25, graph=False,
         thresholds_=thresholds((None, "green"), (1, "red")), color_mode="background"),
    stat(8, "ClamAV: проверка была", [target("homelab_clamav_last_scan_timestamp_seconds * 1000")],
         "dateTimeFromNow", x=12, y=25, graph=False),
    stat(9, "Игроков Minecraft", [target("max(homelab_minecraft_players) or vector(0)")], x=16, y=25),
    stat(10, "Plex", [target("homelab_plex_up")], x=20, y=25, graph=False, color_mode="background",
         mappings=[{"type": "value", "options": {"0": {"text": "недоступен", "color": "red"},
                                                 "1": {"text": "работает", "color": "green"}}}],
         thresholds_=thresholds((None, "red"), (1, "green"))),
], time_from="now-24h", tags=("services",))

# -------------------------------------------------------------------- Логи

LOG_SEL = '{service_name=~"$service"}'
# Служебный шум: панель опрашивает API каждые несколько секунд, Grafana пишет каждый запрос.
LOG_NOISE = '!~ "GET /api/metrics|GET /metrics|Plugin Request Completed|Request Completed|flag evaluation"'
logs = dashboard("homelab-logs", "HomeLab · Логи", [
    {
        "id": 1, "type": "timeseries", "title": "Ошибки в логах по сервисам",
        "gridPos": {"x": 0, "y": 0, "w": 24, "h": 7}, "datasource": LOKI,
        "targets": [{"datasource": LOKI, "refId": "A", "legendFormat": "{{service_name}}",
                     "expr": f'sum by (service_name) (count_over_time({LOG_SEL} {LOG_NOISE} |~ "(?i)(error|fatal|panic|exception|failed)" [$__auto]))'}],
        "fieldConfig": {"defaults": {"custom": {"drawStyle": "bars", "fillOpacity": 70, "stacking": {"mode": "normal"}},
                                     "color": {"mode": "palette-classic"}}, "overrides": []},
        "options": {"legend": {"displayMode": "list", "placement": "right"}, "tooltip": {"mode": "multi"}},
    },
    {
        "id": 2, "type": "logs", "title": "Журнал", "gridPos": {"x": 0, "y": 7, "w": 24, "h": 18},
        "datasource": LOKI,
        "targets": [{"datasource": LOKI, "refId": "A", "expr": f'{LOG_SEL} {LOG_NOISE} |~ "(?i)$search"'}],
        "options": {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending",
                    "enableLogDetails": True, "dedupStrategy": "none", "showLabels": False,
                    "prettifyLogMessage": False},
    },
], time_from="now-3h", refresh="30s", tags=("logs",), templating=[
    {"name": "service", "label": "Сервис", "type": "query", "datasource": LOKI,
     "query": {"label": "service_name", "refId": "LokiVariableQueryEditor-VariableQuery", "stream": "", "type": 1},
     "multi": True, "includeAll": True, "current": {"text": "All", "value": "$__all"}, "refresh": 2, "sort": 1},
    {"name": "search", "label": "Поиск", "type": "textbox", "query": "", "current": {"text": "", "value": ""}},
])

for name, data in {"server": server, "containers": containers, "services": services, "logs": logs}.items():
    (OUT / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"{name}.json: {len(data['panels'])} panels")
