# Developer Exchange

## Полный цикл

```text
5+ независимых tenant → privacy-approved aggregate → developer brief
→ scaffold/custom implementation → safe ZIP/signature → moderation
→ director accept → business installation approval → jobs/usage
→ invoice/payment receipt → developer ledger
```

Brief не содержит tenant IDs, документы, переписку, пути или «анонимизированный» свободный текст. Только разрешённые агрегаты: ниша, companyCount, observationCount, округлённые стоимость/срочность/сложность и число агентов.

## Обнаружение API

- `GET /.well-known/2aos.json` — команды, методы, роли и полный flow.
- `GET /llms.txt` — короткие инструкции для coding agent.
- `GET /openapi.json` — HTTP API.

## Получить задачи

```bash
export A2OS_SERVER=http://127.0.0.1:8787
export A2OS_API_KEY=DEVELOPER_KEY

node bin/2aos-developer.mjs opportunities
node bin/2aos-developer.mjs brief invoice
```

Или через API:

```http
GET /v1/developer/opportunities
GET /v1/developer/briefs/invoice
```

Brief содержит JSON Schemas observation/result, допустимые runtime, критерии приёмки и последовательность команд. Если приватной когорты недостаточно, brief отсутствует — система не выдумывает спрос.

## Создать и проверить пакет

```bash
node bin/2aos-developer.mjs scaffold invoice --dir ./invoice-agent
# Настройте логику manifest в соответствии с brief.
node bin/2aos-developer.mjs pack ./invoice-agent ./invoice-agent.zip
node bin/2aos-developer.mjs validate ./invoice-agent.zip
node bin/2aos-developer.mjs submit ./invoice-agent.zip
```

`submit` возвращает `id` и `status: moderation`. Проверка: `status [versionId]`.

Для production registry используйте `A2OS_REGISTRY_PUBLIC_KEY`; без него допускаются только development packages. Нативный сторонний код запускается не в основном процессе, а через отдельную OS/VM sandbox.

## Принятие директором

Список: `GET /v1/director/submissions`.

```http
POST /v1/director/submissions/VERSION_ID/accept
{"trialDays":7}
```

Accept активирует версию и создаёт точную installation quote. Бизнес подтверждает её через `/v1/approvals/{id}/approve`. Затем агент запускается обычным `/v1/jobs`, включая DAG и пулы.

## Палитра

```bash
npm run developer
# или: node bin/2aos-developer.mjs palette
```

Поддерживаются номер команды, имя, `commands`, `flow`, `hints <command>`, `quit` и Tab completion. Палитра показывает подсказки, не выполняет mutating actions автоматически.

Основные команды: `opportunities`, `brief`, `scaffold`, `pack`, `validate`, `submit`, `status`, `dashboard`, `commands`, `hints`.

## Вознаграждение

`GET /v1/developer/dashboard` показывает версии, фактические подключения, доход и конверсию. Начисление происходит только после invoice со статусом `paid` и внешнего payment receipt. Доля по умолчанию `developerBps=7000`, партнёрская комиссия задаётся отдельно. Вывод средств выполняет отдельный банковский/платёжный адаптер, а не запись в dashboard.
