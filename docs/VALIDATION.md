# Проверки публикации

Дата локальной проверки: 5 ноября 2026 года, Node.js 24.21.0, Windows.

## Выполнено

```text
npm ci --ignore-scripts --offline    успешно, 0 уязвимостей npm audit
npm run check                        35 модулей, 26 агентов, 3 пакета
npm test                             44/44 passed
npm run test:coverage                85,58 % строк, 64,22 % веток, 85,04 % функций
npm run smoke                        установка → OCR → артефакт → аудит
```

## Сквозные сценарии

- HTTP: анализ бизнеса, quote, неверный/верный approval digest, установка, idempotent job, артефакт, счёт, оплата, партнёрская комиссия, аудит.
- Пулы: последовательные jobs, сообщения пользователя и двух агентов, идемпотентность eventId, запрет чтения чужого tenant.
- Runtime: custom ZIP, модерация, установка, выполнение, invoice, developer revenue.
- Надёжность: transient retry, dead-letter, lease heartbeat, late completion rejection по epoch.
- Privacy: запрет raw field, четыре tenant недостаточно, пять tenant дают только агрегат без ID.
- Безопасность пакетов: traversal, Ed25519 tampering, DOCX extraction.
- SMTP: multiline EHLO, AUTH LOGIN, DATA, dot stuffing, List-Unsubscribe на локальном сервере.
- Scheduler: одобренная будущая публикация остаётся pending и отправляется только после наступления времени.
- RAG: локальные цитаты и явное отсутствие доказательств; VLM/BIM только как draft для специалиста.

## Не входит в доказательство

- Качество OCR/LLM/VLM на отраслевых датасетах.
- Реальные SIP, 1С, CRM, банк, госреестры, MIS/BIM, платёжные и банковские выплаты.
- Долгий soak-test 24/7, отказоустойчивость кластера, нагрузочные значения с сайта.
- Визуальная проверка PPTX в PowerPoint и соответствие фирменному стилю.
- Публичный TLS/proxy и Docker image build на всех целевых платформах.

Для production-приёмки необходимы реальные учётные данные владельца, независимые smoke-тесты каждого внешнего адаптера и измерение качества на согласованных эталонных наборах.
