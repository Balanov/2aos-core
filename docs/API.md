# REST API и подключение фронта

Базовый URL: `http://127.0.0.1:8787`. Машинный индекс: `GET /openapi.json`. Все защищённые запросы требуют `Authorization: Bearer API_KEY`. Денежные значения передаются в минорных единицах: 100 = 1 ₽.

## 1. Наблюдение и рекомендация директора

```http
POST /v1/director/analyze
Content-Type: application/json
Authorization: Bearer API_KEY

{
  "observations": [{
    "processCode": "invoice-manual",
    "description": "Ручной ввод счетов",
    "monthlyCostMinor": 18500000,
    "manualMinutesPerMonth": 7200,
    "errorRate": 0.03,
    "evidence": { "source": "erp-report-2026-10", "observedAt": "2026-11-01T00:00:00Z" }
  }]
}
```

Ответ содержит findings и рекомендации `invoice-ocr`, `accounting`. Baseline — входной наблюдаемый факт, а не обещанная экономия.

Для версиируемого бизнес-объекта используйте `POST /v1/objects` с `kind`, `externalId`, `data`, `provenance.source`, `provenance.observedAt`.

## 2. Точная цена и установка

```http
POST /v1/installations/quote

{"agentSlug":"invoice-ocr","trialDays":7}
```

Сохраните `approvalId` и `digest`. Установка выполняется только после подтверждения точного предложения:

```http
POST /v1/approvals/APPROVAL_ID/approve

{"digest":"sha256-..."}
```

Отклонение: `POST /v1/approvals/APPROVAL_ID/reject` с `reason`. Пакет подключается аналогично через `POST /v1/packages/quote` с `packageSlug: "micro"`.

## 3. Запуск агента

```http
POST /v1/jobs

{
  "agentSlug": "invoice-ocr",
  "idempotencyKey": "erp-invoice-2026-11-00042",
  "payload": {
    "text": "Счет № 42 от 04.11.2026\nИНН 7707083893\nБез НДС: 100,00\nНДС: 20,00\nИтого: 120,00"
  }
}
```

Повтор с тем же ключом возвращает существующий job. Состояние: `GET /v1/jobs/JOB_ID`. Рабочий процесс запущен в `npm start`; для ручного drain в разработке доступен `POST /v1/jobs/drain` администратору.

Артефакты: `GET /v1/artifacts`, затем `GET /v1/artifacts/ARTIFACT_ID`. Бинарный PPTX возвращается в `content.base64`.

## 4. Групповой чат и цепочка

Создание пула:

```http
POST /v1/pools

{
  "name": "Финансы и логистика",
  "mode": "approval",
  "members": [
    {"agentSlug":"invoice-ocr","role":"worker"},
    {"agentSlug":"accounting","role":"worker"}
  ]
}
```

Сообщение с разными входами участников:

```http
POST /v1/pools/POOL_ID/messages

{
  "body": "Закрыть документы по маршруту",
  "eventId": "route-4587-close",
  "inputs": {
    "invoice-ocr": {"text":"Счет № 4587\nИНН 7707083893\nИтого: 120,00"},
    "accounting": {"transactions":[]}
  }
}
```

Повтор `eventId` не дублирует сообщение. Jobs участников связаны последовательно; результаты зависимых jobs доступны следующему шагу в `context.dependencies`, а не подмешиваются к строгой input schema агента. Сообщения: `GET /v1/conversations/CONVERSATION_ID/messages`.

Для собственного DAG передайте `dependsOn: ["job_..."]` при создании job.

## 5. Внешние действия

Агент возвращает только предложение effect. В approval-режиме создаётся outbox и approval. До подтверждения провайдер не вызывается.

Настройка памяти для разработки:

```http
POST /v1/integrations

{"kind":"memory","name":"smtp","config":{}}
```

Для production используйте `smtp`, `telegram`, `whatsapp` или `webhook`. Пример webhook:

```json
{
  "kind": "webhook",
  "name": "crm",
  "config": {
    "baseUrl": "https://crm.example.com/2aos/events",
    "secret": "HMAC_SECRET"
  }
}
```

Origin должен быть заранее разрешён в `A2OS_ALLOWED_ENDPOINTS`. Настройки хранятся AES-256-GCM. Webhook получает `operation`, `payload`, `idempotencyKey`, `eventId`, `sentAt` и заголовок `x-2aos-signature: sha256=HMAC_SHA256(canonical_json_body)`.

`content.schedule` с будущим `publishAt` после approval остаётся `pending`, пока не наступит время. Немедленной отправки не происходит.

## 6. Загрузка стороннего агента

1. Подготовьте `manifest.json` по примеру `examples/declarative-agent`.
2. Упакуйте `node bin/2aos.mjs pack examples/declarative-agent agent.zip`.
3. `POST /v1/packages/upload` с `{"zipBase64":"..."}`.
4. Администратор: `POST /v1/agent-versions/VERSION_ID/moderate` с `{"status":"active"}`.
5. Установите через обычный quote/approval.
6. Запускайте через `/v1/jobs`.

`POST /v1/packages/import` принимает прямой ZIP URL только с allowlisted origin. ZIP с path traversal, symlink, шифрованием, ZIP64, избыточным размером или без `manifest.json` отклоняется. Произвольный JS не исполняется.

## 7. Счета, партнёры и разработчики

- `POST /v1/invoices/invoice-ocr` — выставить счёт за текущий месяц или указать `period: "2026-11"`.
- `POST /v1/invoices/INVOICE_ID/paid` с `externalReceipt` — зарегистрировать подтверждённую оплату.
- `POST /v1/partners` — партнёр, код, commissionBps и опционально referredTenantId.
- `GET /v1/partners/PARTNER_ID/dashboard` — рефералы и начисления.
- `GET /v1/developer/dashboard` — версии, подключения, доход и конверсия по фактическим записям.

`externalReceipt` не выполняет платёж; он регистрирует результат внешней платёжной системы. Выплаты требуют отдельного адаптера.

## 8. Приватный рынок

```http
POST /v1/privacy/consent
{"enabled":true}

POST /v1/privacy/signals
{
  "niche":"invoice",
  "payload":{
    "processCode":"invoice",
    "observationCount":12,
    "monthlyCostMinor":18500000,
    "manualMinutesPerMonth":7200,
    "urgency":4,
    "complexity":3
  }
}

POST /v1/market/export
{"niche":"invoice"}
```

До пяти независимых tenant экспорт возвращает `insufficient_independent_cohort`. После агрегации доступен `GET /v1/market/overview`. Поля вне allowlist отклоняются. Сетевую отправку агрегата должен выполнить отдельно настроенный реестр; ядро её не делает скрытно.

## 9. База знаний и модель

- `POST /v1/knowledge/documents`: `title`, `sourceUri`, `text`.
- `POST /v1/knowledge/query`: `query`, опционально `useModel`.
- `GET /health/ready`: состояние SQLite и доступности локальной модели.

Без модели RAG возвращает найденные фрагменты и цитаты. При отсутствии подтверждения прямо сообщает об этом.

## Коды состояний для фронта

- `draft`, `moderation`, `active`, `rejected`, `disabled` — версии агентов.
- `trial`, `active`, `paused`, `disabled` — установки.
- `queued`, `leased`, `waiting_dependencies`, `waiting_approval`, `succeeded`, `dead_letter`, `cancelled` — jobs.
- `pending`, `approved`, `rejected`, `consumed` — approvals.
- `draft`, `pending`, `sent`, `failed`, `cancelled` — outbox.

Provider receipt подтверждает ответ провайдера, но не независимое физическое выполнение. Для критичных действий фронт должен запрашивать повторную проверку авторитетного состояния.
