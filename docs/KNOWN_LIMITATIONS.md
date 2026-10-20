# Известные ограничения и непроверенные условия

## Границы первой версии

- Английский → русский; интерфейс русский. Windows 10/11, Chrome Stable и предыдущий Stable — целевая поддержка, **не подтверждённая здесь реальная проверка**.
- Нет OCR, DRM/Kindle, fixed-layout EPUB, Firefox/мобильных браузеров, массового перевода книг, собственной синхронизации или произвольного field mapping.
- Системные страницы Chrome, встроенный Chrome PDF viewer, закрытые Shadow DOM и недоступные frames нельзя считать поддерживаемыми. PDF нужно открыть в собственном viewer.
- PDF.js работает с `useWasm:false` без ослабления CSP; локальные JS fallback-декодеры упакованы. ICC/QCMS преобразование цвета без WASM недоступно, поэтому цвета могут отличаться. Реальная проверка кодеков в браузере не выполнена.
- Извлечённый PDF-текст может иметь неправильный порядок, пробелы или переносы. Для скана требуется другой источник с текстовым слоем; OCR не выполняется.
- Reflowable EPUB не имеет постоянных номеров страниц. Источник — глава и CFI.
- Безопасный EPUB-рендеринг намеренно удаляет CSS книги, SVG, скрипты, формы и встроенные шрифты. Это может существенно менять верстку и скрывать SVG-иллюстрации; системный шрифт заменяет обфусцированный.
- Системный английский голос может отсутствовать. Browser speech synthesis не создаёт экспортируемый audio file.
- Перевод модели может ошибаться; IPA с source=generated не является словарно проверенной.
- Локальная книга и её ссылка не гарантированно доступны на другом устройстве. Uninstall/очистка профиля браузера может удалить локальные книги, очередь и прогресс.
- Постоянно сохранённый API-ключ не следует считать криптографически защищённым хранилищем.

## Открытые verification gates

См. `TEST_REPORT.md`: Windows smoke, настоящий Anki в изолированном профиле, платные live OpenAI/TTS и performance targets пока `not_run`. Модульные security-тесты не доказывают сетевую изоляцию browser iframe и не заменяют реальный тест восстановления после аварии.

В сборке не должно быть скрытого переключения на mock. Если сервисная интеграция не подключена или недоступна, UI обязан сообщить об этом; mock-ответ не является доказательством рабочего OpenAI/Anki.


## Проверенный checkpoint R2

TypeScript, 142 unit-теста и 211 service-тестов прошли; обе сборки сформированы. Ранее найденные frame-privilege, offscreen response/cleanup и word-budget дефекты закрыты повторными тестами. Это не означает готовность live интеграции: Windows Chrome, настоящий тестовый профиль Anki, реальные audio files и измерения latency ещё ожидают проверки текущего R2.

Изолированная сборка `english-reader-test` предназначена только для отдельного тестового Anki на `127.0.0.1:18765` и отдельной БД; обычная сборка использует 8765. Она не должна заменять production extension или работать с личной коллекцией. Изоляция Anki не предоставляет разрешения на платный OpenAI/TTS тест.

- IPv6-only AnkiConnect is not supported in the current Chrome build. Use IPv4 loopback 127.0.0.1:8765; localhost is canonicalized to that address. The isolated validation build is pinned to 127.0.0.1:18765 and a separate database.
- Private deck names are selected in the trusted extension settings, not inside an ordinary webpage's DOM. The webpage popup shows generic destination status and refreshes unsaved destination preferences after returning from settings.

### Multilingual 0.2 candidate

- The 17-language registry and all language-pair/CEFR schema combinations are tested structurally; no live translation accuracy score is claimed for any pair. Same-language output is definition/paraphrase study, not a translation into another language.
- CEFR is an approximate generation target. Generated examples/IPA/TTS require human linguistic review; dictionary attribution is available only for English-source entries when separately enabled.
- Chinese defaults to simplified Mandarin and Arabic to Modern Standard Arabic. A generic language option does not cover every script convention, dialect or regional variety. Portuguese currently defaults to Brazilian Portuguese; regional variants outside the registry are not silently substituted.
- CJK word counts follow browser Intl/ICU lexical segmentation, which may differ between runtime versions and human intuitions. Partial graphemes are rejected; source strings and UTF-16 ranges are not normalized or reversed.
- V2 uses separate Anki models; previously installed v1 models are not edited. New en→ru notes still search legacy lexical duplicates, but old and new template content are intentionally distinguished.
- Final 0.2 Windows/browser interaction, real multilingual Anki export, live OpenAI/TTS and learning outcomes remain unverified under the existing runtime/key blockers. Local unit/mocked integration tests are not substitutes for those checks.
