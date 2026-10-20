# Проверки English Reader for Anki

Дата: 2026-10-20. Это журнал доказательств, а не заявление о готовности продукта.

## Среда и обозначения

- Автоматические проверки выполнялись в Linux, Node/Vitest. Это **не** Windows Chrome.
- `passed`: команда действительно завершилась успешно; указывается область.
- `failed`: наблюдалась ошибка продукта или проверки, требующая разбора.
- `not_run`: проверка не выполнялась; реализация или mock не заменяет её.
- Реальный ключ OpenAI и разрешение платного live-теста не предоставлены этому исполнителю.
- Отдельный тестовый профиль настоящего Anki и Windows 10/11 недоступны этому исполнителю.

## Выполненные независимые security-тесты

Команда из корня: `npx vitest run --config tests/security/vitest-host.config.ts`. Конфигурация явно подменяет только storage для изолированного offscreen host-теста; это не проверка настоящего IndexedDB.

Результат: **44 passed / 0 failed**, 6 файлов, 2026-10-20.

| Файл | Область | Результат |
|---|---|---|
| `tests/security/confirmations.test.ts` | Exact trusted sender/nonce/type, одноразовое подтверждение, 35s expiry, window failure | 4 passed |
| `tests/security/playback.test.ts` | Дедупликация создания offscreen document, отказ до отправки при create failure | 2 passed |
| `tests/security/offscreen.test.ts` | Запрет content callers, границы данных, local-only voice, respond-once, bounded no-voice failure, storage/playback failure cleanup | 6 passed |
| `tests/security/sender.test.ts` | Trusted URL allowlist, absent/zero frameId, content identity without admin authority, nested/untrusted/malformed senders | 11 passed |
| `tests/security/archive-adversarial.test.ts` | Относительный traversal, абсолютный/Windows путь, обратный слеш, control characters; совпадения имён без учёта регистра и после NFC; фактическая распаковка с высоким ratio; пустой архив; кириллица и пробелы | 14 passed |
| `tests/security/epub-adversarial.test.ts` | Удаление script/style/SVG/iframe/object/form, inline handlers, remote image/srcset, javascript-link/top target; локальная blob-картинка; инертная внешняя ссылка; разрешение внутренних путей | 7 passed |

Эти тесты проверяют модули, **не** сетевое поведение настоящего EPUB iframe, полный лимит 500 MiB, browser crash recovery или реальный Windows filesystem. Генератор ZIP запускается в Node, чтобы исключить межконтекстный `Uint8Array instanceof` артефакт jsdom.

## Приёмочная матрица

Все строки ниже требуют интеграционных доказательств; `not_run` не означает, что соответствующего кода нет.

| ID | Сценарий и точный критерий | Статус |
|---|---|---|
| H01 | Двигать мышью 10 секунд: ноль запросов провайдерам; один настоящий Shift вызывает один lookup | not_run |
| H02 | `bank` в `She sat on the river bank.` и `She opened a bank account.`: выбранные значения различаются; исходное предложение неизменно | not_run (live OpenAI opt-in) |
| H03 | `put up with` выделяется как одна фраза; 6 слов дают понятный отказ | not_run |
| H04 | `can't`, `mother-in-law`, слово через span, второй `bank` в одном предложении: slice совпадает с expression | not_run (browser) |
| H05 | Input/password/textarea/contenteditable, IME, repeat, Ctrl/Alt/Meta, synthetic Shift: ноль lookup | not_run (browser) |
| H06 | Запрос A медленный, B быстрый: A не заменяет B; Escape/внешний клик закрывают; Shift-up не закрывает | not_run |
| H07 | Enter добавляет один раз; Ctrl+Enter сохраняет редактор; Tab не заперт; labels/фокус/контраст, zoom 200% | not_run |
| H08 | Popup остаётся в viewport, меняет позицию при scroll, незакреплённый исчезает при уходе anchor | not_run |
| P01 | Текстовый PDF: текстовый слой, Shift, переход страницы, восстановление страницы/scroll после reload | not_run |
| P02 | Скан без текстового слоя: «OCR не поддерживается», нет платного lookup из пустого текста | not_run |
| P03 | PDF JavaScript/launch/external action не исполняются автоматически; worker/fonts локальны | not_run |
| E01 | EPUB2/3, главы/оглавление, CFI после reload и изменения шрифта; источник chapter+CFI | not_run |
| E02 | Враждебный EPUB: script не запускается, внешний HTTP(S) не запрашивается; sandbox без allow-scripts/top-navigation | not_run (browser); sanitizer module passed |
| E03 | ZIP >100 MiB, отдельный файл >50 MiB, >10000 entries, >500 MiB total; worker прерывает до превышения лимита | not_run (full boundaries); ratio/traversal passed |
| E04 | DRM отклоняется; font obfuscation не ошибочно объявляется DRM; fixed-layout отклоняется | not_run |
| L01 | `Книга с пробелами.pdf/epub` импортируется Windows file-picker и drag/drop | not_run (Windows); ZIP names passed |
| L02 | Quota failure предлагает session-only; cache clear не удаляет книги/очередь/required media | not_run |
| A01 | Создание двух моделей только с согласием; существующая несовместимая модель не изменяется | not_run (real Anki) |
| A02 | Add, двойной Add, потерянный ответ, restart browser, retry: одна заметка на OperationId | not_run (real Anki) |
| A03 | Offline Anki => queued, online => added; UI не выдаёт queued за added; cancel не отправляет | not_run (real Anki) |
| A04 | Возможный дубль => review; add_new только явное подтверждение; одна выбранная заметка => одна карточка | not_run (real Anki) |
| A05 | Cloze скрывает только выбранное вхождение c1; фронт не содержит ответ/answer audio; preview совпадает с note fields | not_run (real Anki) |
| A06 | Реальный mp3 в Anki media и `[sound:...]` воспроизводится; ошибка аудио видна отдельно | not_run (paid opt-in + real Anki) |
| S01 | Секрет не доступен content script, DOM страницы, public RPC, sync, URL или логам; admin RPC от content sender запрещены | not_run (integrated browser) |
| S02 | Модель получает только expression/контекст до 1500 UTF-16, без URL/title/local path; dictionary/TTS до согласия не вызываются | not_run (network interception) |
| S03 | Нет remote JS/eval/CDN/analytics; hostile note fields escaped; URL tokens очищены | not_run (aggregate build review) |
| Q01 | Popup shell <=100ms; cache <=150ms; uncached p95 <=4s; finite timeout без вечного loading | not_run (measurements) |

## Windows Chrome + настоящий Anki: воспроизводимый smoke checklist

Заполнять отдельно для Windows 10/11 и актуального/предыдущего Chrome Stable. Записать Windows build, Chrome version, Anki version, AnkiConnect version, extension commit/ZIP SHA256, дату и результат каждого шага. Использовать **новый тестовый профиль Anki**, никогда личную коллекцию.

1. Установить AnkiConnect из официальной страницы дополнения, перезапустить Anki. Создать/выбрать тестовый профиль и тестовую колоду, убедиться в пустой коллекции.
2. Распаковать ZIP, открыть `chrome://extensions`, режим разработчика → «Загрузить распакованное» → каталог с `manifest.json`. Проверить отсутствие ошибок service worker и remote-script CSP.
3. Открыть настройки расширения. Проверить disclosure отдельной оплаты OpenAI API. Не вводить ключ на веб-странице. По умолчанию session key; после закрытия браузера проверить, что он не сохранился. Persistent key проверять только отдельным opt-in.
4. Выполнить диагностику Anki. Разрешить точный origin расширения при необходимости; не использовать wildcard. Явно согласиться на создание двух моделей. Проверить OperationId первым полем и отсутствие reverse-card.
5. На локальной HTML-fixture проверить H01/H03/H04/H05/H06/H07/H08. В DevTools сохранить обезличенный network summary, не HAR с секретами.
6. Только при разрешённом платном тесте ввести тестовый ключ, проверить H02. Выбрать одно значение, изменить перевод и сравнить preview с реальной заметкой.
7. Recognition Add дважды: одна заметка. Cloze для второго одинакового слова: один c1 именно на втором вхождении, одна карточка, без ответа спереди.
8. Выключить Anki, нажать Add: получить «Сохранено в очередь». Перезапустить Chrome, открыть очередь, включить Anki, retry. Найти ровно одну заметку по OperationId. Повторить с прерыванием соединения сразу после server acceptance; retry не создаёт вторую.
9. Импортировать текстовый PDF и скан с кириллицей/пробелами в имени. Проверить P01/P02, позицию после restart и источник с 1-based page.
10. Импортировать EPUB с двумя главами. Проверить E01, изменение размера шрифта, ширины, line-height, темы, CFI после перезапуска. Проверить hostile EPUB с блокируемыми script/remote resource, подсчитывая сеть.
11. Без opt-in dictionary/TTS сетевых запросов нет. Затем отдельно согласиться на cloud audio и сохранить заметку: проверить настоящий файл в Anki media и воспроизведение. Отключить сеть и подтвердить честный audio error, не «аудио добавлено».
12. Очистить только cache: книги, прогресс и очередь сохраняются. Удалить тестовую книгу отдельно, убедиться в ожидаемом удалении. Не удалять рабочий browser profile.

## Метод измерения производительности

Измерять `performance.now()` от trusted Shift до первого paint оболочки и до завершённого результата. Указать машину, Chrome, размер страницы/книги, сеть, модель и cache hit/miss. Для p95 провести минимум 30 разрешённых uncached запросов, не создавать платную нагрузку без согласия; отсортировать значения, взять nearest-rank `ceil(0.95*n)`. Timeout/error samples перечислить отдельно, не исключать молча. Не сравнивать latency mock с целевым OpenAI p95.

## Безопасные условия live-тестов

Ключ вводит владелец только в доверенные настройки. Не помещать его в shell history, fixture, screenshot или отчёт. Согласование live-теста должно назвать модель, максимальное число запросов и допустимые расходы. Для Anki делать backup тестовой коллекции перед fault-injection. Любые доказательства должны исключать секреты и личный текст.

## Browser runner: фактический блокер

2026-10-20 предпринят локальный capability probe Playwright → `/usr/bin/chromium` с изолированным временным профилем. Chromium завершился **до создания страницы**, SIGABRT: `process_singleton_posix.cc: socket() failed: Operation not permitted`; также выведена ошибка crashpad database. Это ограничение среды запуска, не прошедший/упавший assertion продукта. Обход запрета и повтор запуска не выполнялись.

Подготовлены `playwright.config.ts` и четыре сценария `tests/e2e/extension.spec.ts`: настройки, очередь/библиотека, PDF text/no-text и hostile EPUB. Их статус **not_run**. Нужен разрешённый runtime Chromium с локальным IPC; после сборки запуск `npm run test:e2e`. Ожидаемые screenshots в `test-results/` пока не созданы, и не заявляются как артефакты. Fixture no-text.pdf — PDF без текстовых операторов, **не настоящий скан**.


## Canonical service review (после получения пакетов dot b)

2026-10-20: `node --test tests/*.test.ts` — **196 passed, 0 failed**. Это standalone service/storage/template tests с mock network и fake IndexedDB, не live OpenAI/Anki. `npx vitest run tests/security` до добавления отдельного canonical boundary regression — **44 passed**.

Проверены фиксированный OpenAI endpoint, `store:false`, `redirect:error`, `credentials:omit`, явная проекция prompt без source metadata; точный Anki loopback allowlist; restrict session/local TRUSTED_CONTEXTS; безопасные public status без ключа; явное подтверждение dictionary/cloud audio.

Независимый `tests/security/service-boundary.test.ts` первоначально: **9 passed / 1 failed**. Выявлен допуск `frameId:4` к privileged secret mutation при прямом вызове canonical service classifier. Root добавил отсекающий guard в background bridge; исправление canonical слоя требуется как defense-in-depth. Этот результат не следует маскировать общим baseline pass; статус будет обновлён после фактического rerun.
