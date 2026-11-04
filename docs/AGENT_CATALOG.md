# 26 агентов: реальная реализация и границы

«Ядро» означает исполняемый локальный обработчик. «Модель» — нужен явно включённый локальный LLM/VLM. «Адаптер» — нужен внешний API/учётные данные. Численные маркетинговые обещания не включены в результаты как факты.

| Slug | Локальная реализация | Требуется для полного отраслевого сценария |
|---|---|---|
| `chat-voice` | Намерение, контакт, лид, уточнение, handoff с историей, appointment effect | SIP/STT/TTS/full-duplex и CRM/calendar адаптер |
| `reputation` | Тональность, темы, сводка, ответы-черновики, эскалация, согласование публикации | API площадок отзывов |
| `application-scoring` | ИНН, реестровые stop-факторы, финансовые правила, объяснимый score | Реестры и утверждённая скоринговая политика |
| `content-generation` | Детерминированные шаблоны или локальный LLM, каналы, approval и отложенная публикация | Модель для генерации, image endpoint и API каналов |
| `driver-logistics` | Nearest neighbor + 2-opt, ёмкость, окна, РТО, стоимость, waybill draft | Пробки, камеры, GPS и fleet API |
| `invoice-ocr` | TXT/DOCX/PDF/image ingestion, поля, ИНН, НДС/итог, anomalies, normalized artifact | pdftotext/Tesseract/VLM; 1С/ERP адаптер |
| `rpa` | Сверка двух реестров, missing/conflicts, payment draft effect | 1С/банк/склад adapters |
| `knowledge-rag` | Локальный chunked BM25, версии документов, ответы с цитатами | Локальная модель для синтеза; коннекторы баз знаний |
| `accounting` | Дубликаты, подозрительные операции, предлагаемые проводки | 1С/банк адаптер и учётная политика |
| `translator` | Защита глоссария/placeholder, структурированный перевод | Локальная языковая модель; CI adapter для deploy |
| `forecasting` | Holt, holdout backtest, baseline MAE, прогнозный интервал | Исторические данные; закупочный адаптер |
| `reporting` | Агрегаты, топ-5, средний чек, рост, evidence-linked summary | ERP/CRM и доставка руководителям |
| `security` | Новые устройства/IP, объёмы, часы, brute-force, quarantine effect | Реальные логи и SIEM/DLP adapter |
| `financial-monitoring` | ИНН, суды/долги/банкротство по переданным данным, транзакционные правила | Официальные реестры и банк adapter |
| `compliance` | Forbidden/required phrases, цитаты и даты, audit artifact | Корпоративные регламенты и источники |
| `moderation` | Спам, токсичность, правовой риск, review/hide effect | Платформа и VLM для изображений/видео |
| `vision-quality` | Structured VLM findings, confidence, draft quality report | Локальная VLM, видеопоток, PLC и эталоны дефектов |
| `warehouse` | Остатки, reorder drafts, ABC/XYZ, dead stock, discrepancies | WMS/ТСД/закупки adapters |
| `predictive-maintenance` | Z-score, тренд, пороги, приоритизированный work-order draft | Датчики, EAM, осмотр и эталонные отказы |
| `construction-bim` | VLM-сверка изображений с BIM reference, draft inspection | VLM/BIM, геометрия и технадзор |
| `recruiting` | Взвешенные навыки, ранжирование, вопросы, исключение protected criteria | HH/календарь; speech/emotion не заявлены как готовые |
| `tutoring` | Рубрики, баллы, feedback и персональный следующий трек | LMS и модель для свободного эссе |
| `clinic` | Административная запись, слоты, экстренная эскалация, без диагноза | MIS и медицинский VLM/DICOM отдельно |
| `legal` | Правила рисков, точные excerpts, рекомендации, обязательный review | Юридическая база и юрист; не заключение |
| `email-marketing` | Consent/opt-out, сегменты, шаблоны, идемпотентные эффекты | SMTP и система отписок |
| `presentation` | Слайды, бренд-цвет, редактируемый PPTX и HTML | Figma через отдельный адаптер; визуальная приёмка бренда |

## Общий контракт

Каждый handler возвращает:

- `output` — типизированный результат;
- `artifacts` — сохраняемые бизнес-артефакты;
- `effects` — предлагаемые внешние действия, а не выполненные факты;
- `usage` — единица и количество для фактической тарификации.

Внешний эффект проходит integration/outbox и approval/autonomous policy. Результат LLM валидируется JSON Schema. Для медицины, права, финансов, физических действий и строительства человеческая проверка обязательна независимо от уверенности модели.
