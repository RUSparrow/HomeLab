#!/usr/bin/python3

import ipaddress
import os
import sqlite3
import subprocess
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

DB_PATH = "/var/lib/fail2ban/fail2ban.sqlite3"
JAILS = ["sshd"]
# Адрес задаёт юнит (Environment=F2B_EXPORTER_HOST) — на новом ПК он другой
HOST = os.environ.get("F2B_EXPORTER_HOST", "192.168.0.176")
PORT = int(os.environ.get("F2B_EXPORTER_PORT", "9192"))


def get_banned_ips(jail):
    result = subprocess.run(
        ["fail2ban-client", "status", jail],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )

    for line in result.stdout.splitlines():
        if "Banned IP list:" in line:
            value = line.split("Banned IP list:", 1)[1]
            ips = set()
            for token in value.split():
                try:
                    ips.add(str(ipaddress.ip_address(token)))
                except ValueError:
                    continue
            return ips

    raise RuntimeError(f"Could not find Banned IP list for jail {jail}")


def collect_metrics():
    lines = [
        "# HELP fail2ban_detail_up Whether detailed metrics were collected successfully.",
        "# TYPE fail2ban_detail_up gauge",
        "# HELP fail2ban_banned_ip Whether an IP is currently banned.",
        "# TYPE fail2ban_banned_ip gauge",
        "# HELP fail2ban_ban_remaining_seconds Seconds remaining until the recorded ban expires.",
        "# TYPE fail2ban_ban_remaining_seconds gauge",
        "# HELP fail2ban_ban_expires_timestamp_seconds Recorded ban expiry time as Unix timestamp.",
        "# TYPE fail2ban_ban_expires_timestamp_seconds gauge",
    ]

    try:
        now = time.time()

        with sqlite3.connect(
            f"file:{DB_PATH}?mode=ro", uri=True, timeout=3
        ) as db:
            for jail in JAILS:
                for ip in sorted(get_banned_ips(jail)):
                    labels = f'jail="{jail}",ip="{ip}"'
                    lines.append(f"fail2ban_banned_ip{{{labels}}} 1")

                    row = db.execute(
                        """
                        SELECT timeofban, bantime
                        FROM bans
                        WHERE jail = ? AND ip = ?
                        ORDER BY timeofban DESC
                        LIMIT 1
                        """,
                        (jail, ip),
                    ).fetchone()

                    # If the DB has no matching record, do not invent a remaining time.
                    if row is None or row[0] is None or row[1] is None:
                        continue

                    expiry = float(row[0]) + float(row[1])
                    remaining = max(0.0, expiry - now)

                    lines.append(
                        f"fail2ban_ban_remaining_seconds{{{labels}}} {remaining:.3f}"
                    )
                    lines.append(
                        f"fail2ban_ban_expires_timestamp_seconds{{{labels}}} {expiry:.3f}"
                    )

        lines.insert(2, "fail2ban_detail_up 1")

    except Exception as exc:
        print(f"Metrics collection failed: {exc}", flush=True)
        lines.insert(2, "fail2ban_detail_up 0")

    return "\n".join(lines) + "\n"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/metrics":
            self.send_error(404)
            return

        body = collect_metrics().encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}", flush=True)


print(f"Fail2ban detail exporter listening on {HOST}:{PORT}", flush=True)
HTTPServer((HOST, PORT), Handler).serve_forever()
