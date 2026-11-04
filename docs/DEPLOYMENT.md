# Развёртывание и эксплуатация

## Локальный Windows/Linux

1. Установите Node.js 24.
2. Скопируйте `.env.example` в собственное защищённое хранилище конфигурации; файл `.env` не коммитьте.
3. Выполните `npm ci --ignore-scripts --offline`.
4. Задайте `A2OS_MASTER_KEY` как base64 32 случайных байтов или позвольте ядру создать `.2aos/.master-key` с правами owner-only.
5. Запустите `npm start` и сохраните bootstrap API key.

Потеря master key делает зашифрованные integration/payout настройки нечитаемыми. Резервное копирование включает SQLite **и ключ отдельно**.

## Docker Compose

```bash
export A2OS_MASTER_KEY='BASE64_32_BYTES'
docker compose up --build
```

Порт публикуется только на `127.0.0.1:8787`. Данные — в volume `2aos-data`. Dockerfile предоставлен для стандартного Node 24 Alpine; локальная сборка образа не входила в 44 теста, поэтому перед production выполните собственную проверку образа.

## Публичный контур

- Используйте TLS reverse proxy и ограничение доступа по сети; встроенный HTTP не заменяет TLS.
- Не публикуйте `/v1/jobs/drain` и административные ключи общего назначения; создайте отдельные ключи с минимальной ролью.
- `A2OS_ALLOWED_ENDPOINTS` должен содержать только необходимые origins. Не используйте wildcard.
- `A2OS_DEVELOPMENT_PACKAGES=false` и настроенный `A2OS_REGISTRY_PUBLIC_KEY` обязательны для подписанного production-реестра.
- Проверьте backup/restore SQLite на выключенном процессе или SQLite snapshot. WAL не заменяет резервную копию.
- Выполните soak-test очереди, моделей, дискового пространства и восстановления после аварии.

## Модели и OCR

Ollama по умолчанию: `http://127.0.0.1:11434`. Разрешите его origin в `A2OS_ALLOWED_ENDPOINTS`. Включайте `A2OS_MODEL_ENABLED=true` только после установки модели. Для vision задайте отдельную `A2OS_VISION_MODEL`.

PDF требует локальный `pdftotext`; изображения — `tesseract` с `rus+eng` или VLM. Эти бинарные зависимости не входят в нулевой npm-пакет и проверяются отдельно.

## Обновления

Перед обновлением: backup, чтение changelog, миграция на staging, проверка подписей пакетов и `npm run smoke`. SQLite schema migration выполняется при старте; добавление `outbox.available_at` поддерживается для баз ранней версии.

## Проверка работоспособности

- `GET /health/live` — процесс отвечает.
- `GET /health/ready` — SQLite и модель. `model.available=false` не мешает deterministic agents, но языковые/VLM jobs обязаны завершаться ошибкой конфигурации.
- `GET /v1/audit/verify` — hash-chain tenant.
- `npm run smoke` — установка, OCR-счёт, артефакт и аудит на временной базе.
