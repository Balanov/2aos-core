# Локальный host client

## Что делает

После разрешения инвентаризирует указанные корни, читает разрешённые форматы, классифицирует бизнес-процессы, создаёт RAG-документы и versioned business objects, формирует рекомендации директора и отслеживает изменения файлов.

Это не «загрузка документа в чат». Полный путь:

```text
approved roots → snapshot/diff → evidence + RAG + business map
              → director recommendations → quote/approval
              → installed agents → durable jobs/pools → measured results
```

## Включение

По умолчанию host scanning выключен. Разрешите корни явно:

```dotenv
A2OS_HOST_ALLOWED_ROOTS=C:\\Users\\Admin\\Documents
A2OS_HOST_ROOTS=C:\\Users\\Admin\\Documents
A2OS_HOST_SCAN_INTERVAL_MS=5000
```

Linux пример: `A2OS_HOST_ALLOWED_ROOTS=/home/user/documents`.

Допускается `C:\` или `/`, но широкий доступ должен быть отдельным осознанным решением владельца. Клиент не повышает привилегии сам: фактический доступ определяется пользователем ОС. Для admin-сценариев запускайте сервис с соответствующими правами и отдельной политикой.

## Границы чтения

- symlink не следуются по умолчанию;
- `.git`, `node_modules`, `.2aos`, корзины и `__pycache__` пропускаются;
- `.env`, ключи, `.pem`, `.pfx`, `id_rsa`, credentials/secrets не читаются;
- допустимы ограничения глубины, количества файлов и размера;
- ошибки доступа сохраняются в snapshot и не останавливают остальное сканирование;
- snapshot API не возвращает содержимое файлов;
- host snapshots не экспортируются в рынок автоматически. Для сигналов нужен отдельный opt-in и privacy gateway.

## Запуск

```http
POST /v1/host/discover
Authorization: Bearer OPERATOR_KEY
Content-Type: application/json

{"roots":["C:\\Users\\Admin\\Documents"],"policy":{"maxFiles":100000,"maxDepth":32}}
```

Ответ содержит snapshot metadata, ошибки, индексированные документы и рекомендации. Текущее состояние: `GET /v1/host/inventory`.

Watcher:

```http
POST /v1/host/watch/start
POST /v1/host/watch/stop
GET  /v1/host/changes
```

Нативные `fs.watch` события используются при наличии ОС-поддержки, polling/diff работает как кросс-платформенный fallback. Добавление/изменение создаёт новую версию источника, удаление удаляет его из RAG и оставляет `host-file-deleted` provenance.

## Системные профили

Read-only: `system.info`, `disk.list`, `process.list`, `network.list`, `service.list`, `privileges.current`. Предусмотрены отдельные команды для Windows, Linux и macOS.

```http
POST /v1/host/system/process.list
{}
```

Профили выполняются без `shell: true`, с timeout и ограничением вывода. Exit code 0 сам по себе не считается доказательством результата.

### Пользовательский mutating profile

Владелец регистрирует точный executable и args через `POST /v1/host/profiles`:

```json
{
  "name": "backup.business",
  "executable": "/usr/local/bin/node",
  "args": ["/opt/2aos/scripts/backup.mjs", "/srv/business"],
  "mutation": true,
  "timeoutMs": 30000,
  "maxOutputBytes": 2000000
}
```

Настройте integration:

```http
POST /v1/integrations
{"kind":"host-shell","name":"host-shell","config":{"profile":"backup.business"}}
```

Затем создайте действие:

```http
POST /v1/host/effects
{
  "profile":"backup.business",
  "input":"{}",
  "idempotencyKey":"backup-2026-11-05"
}
```

Выполнение произойдёт только после `POST /v1/approvals/{id}/approve` с точным digest. До него outbox остаётся `draft`. Повторный `idempotencyKey` не должен дублировать действие.

## Безопасность эксплуатации

- Не передавайте произвольную shell-строку от модели. Профиль задаёт владелец.
- Не храните секреты в args: они попадут в admin audit metadata.
- Ограничьте сервисную учётную запись и рабочие каталоги ОС.
- Для недоверенного кода используйте отдельную VM/container, а не host-shell.
- Autonomous mode допускается только осознанной политикой пула. По умолчанию mutating actions требуют approval.
