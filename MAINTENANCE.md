# Чек-лист изменений HomeLab

Git — источник правды: сервер должен собираться из репозитория манифестом `ansible/install-homelab.yml`.
Если что-то есть на сервере, но не в git и не в манифесте, на новом ПК этого не будет.

## После любого изменения

- [ ] Закоммитить и запушить (`git push`). Ничего не оставлять только на сервере.
- [ ] Секретов в git нет: токены и пароли — в `.env` (они в `.gitignore`), рядом — `.env.example` с пустыми ключами.
- [ ] Пересобрать граф: `graphify update . --force && cp graphify-out/graph.html graph.html`.
      Сторонний код (vendored JS, данные) — в `.graphifyignore`.

## Новый Docker-сервис

- [ ] Папка `<раздел>/<имя>/` с `docker-compose.yml`.
- [ ] `ansible/group_vars/all.yml` → `compose_projects` (в нужном месте: `web/gateway` всегда последний)
      или `compose_create_only`, если сервис не должен стартовать сам.
- [ ] Нужен секрет → `.env.example` + запись в `required_secrets`.
- [ ] Папки данных с особым владельцем (пользователь контейнера) → задача «папки данных» в манифесте.
- [ ] Внешняя Docker-сеть → `docker_networks`.
- [ ] Описание контейнера для Server Monitor → `DOCKER_DESCRIPTIONS` в `web/server-monitor/backend/app/settings.py`.

## Новый сайт

- [ ] `server` в `web/gateway/nginx.conf` и порт в `web/gateway/docker-compose.yml`.
- [ ] Порт и название в `SITES` (`web/server-monitor/backend/app/insights.py`).
- [ ] Стиль — палитра Amnezia (графит + янтарь).

## Изменение на самом хосте (не в Docker)

Пакет, служба systemd, конфиг в `/etc`, cron/таймер:

- [ ] Скопировать конфиг или unit в репозиторий (`security/`, `media/`, `monitoring/`, `tools/`).
- [ ] Добавить задачу в `ansible/install-homelab.yml` (пакет — в список `base`).
- [ ] Службы `systemd --user` → `user_units` в `group_vars/all.yml`.
- [ ] Ручной шаг, который нельзя автоматизировать → финальное сообщение манифеста и `ansible/README.md`.

## Проверить манифест

```bash
cd ansible && ansible-playbook install-homelab.yml -K --check --diff
```

На рабочем сервере ожидается `failed=0` и почти никаких `changed`. Каждый `changed` — расхождение
между сервером и git: либо поправить манифест, либо привести сервер к нему.

## Не трогать без подтверждения владельца

VPN `amnezia-awg2`, DNS, ufw/iptables, SSH, сети и интерфейсы — ошибка отрезает доступ к серверу.
Манифест их намеренно не настраивает.
