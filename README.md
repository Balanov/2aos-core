# 2AOS Core

**Локальная инженерная сборка ИИ-директора, оркестратора бизнес-агентов, маркетплейса, биллинга и приватного рынка требований.**

[![GitHub stars](https://img.shields.io/github/stars/Balanov/2aos-core?style=social)](https://github.com/Balanov/2aos-core/stargazers)
[![CI](https://github.com/Balanov/2aos-core/actions/workflows/ci.yml/badge.svg)](https://github.com/Balanov/2aos-core/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm--Noncommercial-4453E1)](LICENSE)

Это не копия лендинга и не набор заглушек. Сборка реализует полный программный цикл:

**наблюдение → baseline → рекомендация → точная цена → approval → установка → DAG/пулы → артефакты и KPI → usage/invoice/ledger → приватный рыночный агрегат.**

Node.js 24, SQLite через `node:sqlite`, **ноль обязательных npm-зависимостей**, никакой телеметрии.

## Что реализовано

- **26 встроенных типов агентов:** все 24 типа из публичного каталога BAIagent, Email-маркетолог и презентации. Реальные возможности и границы: [docs/AGENT_CATALOG.md](docs/AGENT_CATALOG.md).
- **ИИ-директор:** доказательные наблюдения, текущая стоимость процесса, рекомендации, метрика пилота и stop condition. Не выдумывает проблему без входных данных.
- **Совместная работа:** durable jobs, зависимости DAG, bounded concurrency, retry, lease, dead-letter, epoch stop, shared business objects, versioned artifacts и групповые сообщения.
- **Контроль действий:** автономный или approval-режим, SHA-256 дайджест точного действия, idempotent outbox, отложенная отправка и provider receipts.
- **Марктеплейс:** загрузка ZIP, модерация, версии, JSON Schema, декларативный runtime, Ed25519-подпись, установка по одобренной цене.
- **Экономика:** пакеты, trial, subscriptions, monthly/per-unit usage, invoices, разработчики, партнёрские комиссии, payout ledger. Нет скрытого списания денег: факт оплаты требует внешнего receipt.
- **Приватный рынок:** opt-in, default deny, запрет сырого текста/ID, независимая группа от пяти tenant, округление и экспортный аудит.
- **Интеграции:** generic signed webhook, SMTP, Telegram, WhatsApp Cloud API, local Ollama/OpenAI-compatible model, RAG с цитатами.
- **API:** REST/JSON, bearer keys, RBAC, tenant isolation, OpenAPI, зашифрованные настройки интеграций и hash-chain аудит.

## Быстрый старт

Требуется **Node.js 24+**. Ничего скачивать из npm не нужно после получения репозитория.

```bash
git clone https://github.com/Balanov/2aos-core.git
cd 2aos-core
npm ci --ignore-scripts --offline
npm start
```

Сервер слушает `127.0.0.1:8787`. При первом запуске один раз выводится bootstrap API key — сохраните его. Проверка:

```bash
curl http://127.0.0.1:8787/health/ready
curl http://127.0.0.1:8787/openapi.json
curl -H "Authorization: Bearer ВАШ_КЛЮЧ" http://127.0.0.1:8787/v1/catalog
```

Полный пример «анализ → подключение → выполнение» — в [docs/API.md](docs/API.md), развёртывание — в [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Проверка сборки

```bash
npm run check
npm test
npm run smoke
npm run test:coverage
```

На момент публикации: **44/44 теста**, включая реальные HTTP-циклы, SMTP с локальным тестовым сервером, ZIP traversal, Ed25519, retry, epoch stop, tenant isolation и приватный k-порог. Измеренное покрытие: **85,58 % строк**. Подробности: [docs/VALIDATION.md](docs/VALIDATION.md).

## Подключение локальной модели

Детерминированные агенты работают без модели. Для перевода, генерации текста, VLM и синтеза RAG включите локальный Ollama или OpenAI-compatible endpoint:

```dotenv
A2OS_MODEL_ENABLED=true
A2OS_MODEL_KIND=ollama
A2OS_MODEL_URL=http://127.0.0.1:11434
A2OS_MODEL_NAME=qwen3:4b
A2OS_VISION_MODEL=ваша-локальная-vision-модель
A2OS_ALLOWED_ENDPOINTS=http://127.0.0.1:11434
```

Модель не считается доступной, пока health check не нашёл её имя. OCR: TXT/CSV/JSON/DOCX напрямую, PDF через локальный `pdftotext`, изображения через локальный Tesseract или VLM. Отсутствие зависимости возвращает явную ошибку, а не фиктивный результат.

## Сторонний агент

Минимальный пакет: [examples/declarative-agent](examples/declarative-agent). Он не исполняет чужой JavaScript в доверенном процессе.

```bash
node bin/2aos.mjs pack examples/declarative-agent process-summary.zip
```

Далее: `POST /v1/packages/upload` → модерация → installation quote → approval → запуск через общий jobs API. Для production-реестра поддержана Ed25519-подпись манифеста. Нативный сторонний код допускается только в отдельной OS/VM sandbox, которую администратор подключает как внешний worker.

## Границы, которые важно понимать

- Сборка **не подтверждает** маркетинговые «99 %», «0 ошибок», «85 % звонков», доход или окупаемость без эталонных данных и боевых smoke-тестов.
- Для телефонии, 1С, CRM, банков, государственных реестров, платформ отзывов, MIS/BIM, платежей и выплат нужны учётные данные и соответствующий адаптер. Generic signed webhook уже задаёт общий контракт.
- Full-duplex голос, анализ эмоций, медицинская диагностика изображений и автоматическая сертификация строительства не выдаются за готовые без специализированного проверенного контура.
- K-анонимность снижает риск, но не доказывает невозможность реидентификации. Сырые бизнес-данные экспортировать запрещено.
- API по умолчанию локальный. Для публичного доступа нужны TLS reverse proxy, резервное копирование и эксплуатационный soak-test.

Полный список критериев: [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md). Архитектура: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Приватность: [docs/PRIVACY.md](docs/PRIVACY.md).

## Лицензия

**PolyForm Noncommercial 1.0.0** — бесплатно для разрешённого некоммерческого использования, исследований и экспериментов. Внутреннее тестирование компанией до 30 дней без production — бесплатно. Коммерческое production/OEM/SaaS/white-label использование — по согласованию с автором.

См. [LICENSE](LICENSE) и [COMMERCIAL.md](COMMERCIAL.md). Это source-available лицензия, а не заявление об OSI-approved open source.
