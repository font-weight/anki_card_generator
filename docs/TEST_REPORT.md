# Проверки English Reader for Anki

Дата: 2026-10-20. Это журнал доказательств, а не заявление о готовности продукта.

## Среда и обозначения

- Автоматические проверки выполнялись в Linux, Node/Vitest. Это **не** Windows Chrome.
- `passed`: команда действительно завершилась успешно; указывается область.
- `failed`: наблюдалась ошибка продукта или проверки, требующая разбора.
- `not_run`: проверка не выполнялась; реализация или mock не заменяет её.
- Реальный ключ OpenAI и разрешение платного live-теста не предоставлены этому исполнителю.
- В этом Linux-исполнителе нет настоящего Anki/Windows. Отдельный Windows-исполнитель подтвердил наличие Chrome 154 и Node 24, но результаты browser/Anki acceptance для текущего R2 ещё не получены; статус остаётся `not_run`/pending.

## Выполненные независимые security-тесты

Команда из корня: `npx vitest run tests/security`. Offscreen host-тест явно подменяет storage; canonical service-тест использует настоящий модуль storage с fake-indexeddb. Это не проверка браузерного IndexedDB.

Результат: **58 passed / 0 failed**, 7 файлов, 2026-10-20.

| Файл | Область | Результат |
|---|---|---|
| `tests/security/confirmations.test.ts` | Exact trusted sender/nonce/type, одноразовое подтверждение, 35s expiry, window failure | 4 passed |
| `tests/security/playback.test.ts` | Дедупликация создания offscreen document, отказ до отправки при create failure | 2 passed |
| `tests/security/offscreen.test.ts` | Запрет content callers, границы данных, local-only voice, respond-once, bounded no-voice failure, storage/playback failure cleanup, запрет cloud voiceURI | 7 passed |
| `tests/security/service-boundary.test.ts` | Canonical privileged frame guard, secret projection/consent, unsafe endpoints, prompt allowlist, isolated 18765 routing без fallback | 13 passed |
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


## Итоговая проверка R2 (2026-10-20)

| Проверка | Фактический результат | Ограничение доказательства |
|---|---|---|
| `npm run typecheck` | passed | Компиляция, не browser runtime |
| `npm run test:unit` | **142 passed**, 15 файлов, 0 failed/skip/expected-fail | Linux Vitest; включает 58 security-тестов, не добавлять их повторно к итогу |
| `node --test tests/*.test.ts` / service runner | **211 passed**, 0 failed/skip | Mock network, fake IndexedDB; не настоящий OpenAI/Anki |
| Production build | passed, `dist/english-reader/` | Лог root `reader-build-final-r2.log`; browser execution pending |
| Isolated test build | passed, `dist/english-reader-test/` | Лог root `reader-build-test-final-r2.log`; browser execution pending |
| `node tests/security/artifact-isolation.mjs` | passed для обеих сборок | Проверка manifest CSP, не фактическая сеть |
| Windows Chrome/Anki R2 | **not_run / pending** | Старый source checkpoint `334aec` не доказывает текущий R2 |
| Live OpenAI / cloud TTS | **not_run** | Нет безопасно предоставленного ключа и бюджета/opt-in |
| Latency targets / p95 | **not_run** | Нет измерений целевой машины и live провайдера |

Команды unit/services проверяют разные наборы: итого 353 автоматических теста для этого checkpoint. После следующих изменений totals должны пересчитываться, а не переноситься автоматически.

### Закрытые дефекты

- Nested extension-frame privileged mutation: первоначальный независимый regression действительно падал; R2 canonical classifier и root bridge теперь отклоняют frameId>0, повторный тест passed.
- OPEN-7 hyphen word-budget mismatch: исправлен и больше не помечен expected-fail в полном unit run.
- Offscreen content-caller bypass, двойной response, storage-open failure и URL cleanup после play rejection: исправлены, регрессии passed.
- Confirmation deadline теперь 35 секунд, меньше 45-секундного RPC ожидания; malformed sender URL обрабатывается fail-closed.
- Durable queue watchdog до внешней мутации и восстановление uncertain operation покрыты R2 service-тестами; реальный browser/process crash ещё не проверен.

### Изолированная Anki-валидация

Только compile-time host flag `VITE_ISOLATED_ANKI_TEST=1`; RPC не может включить его. Runtime получает литерал через общий Vite define, поэтому `.env` не может разойтись с решением build script. Isolated build пишет отдельную БД `english-reader-isolated-anki-test-v1`, принимает только `127.0.0.1:18765`, не подставляет персональный Anki key и не разрешает менять endpoint/Anki key через настройки. Test CSP не разрешает production port 8765; обычная сборка не разрешает 18765. Ошибка 18765 не вызывает fallback на 8765. Это подтверждено mock transport и manifest checks, без реальных сетевых вызовов.

Изоляция относится к Anki target/DB. Не следует интерпретировать её как разрешение платных OpenAI запросов: для проверки используются свежий профиль и отсутствие реальных API-ключей. Raw `AnkiClient` при ручной инъекции `getApiKey` не заменяет защиту service factory; в приложении factory задаёт null для isolated Anki.

Проверены фиксированный OpenAI endpoint, `store:false`, `redirect:error`, `credentials:omit`, явная проекция prompt без source metadata, точный Anki loopback allowlist, TRUSTED_CONTEXTS для session/local и safe public status без секрета. Непроверенные реальные платформенные условия остаются в матрице выше; общий pass не превращает их в passed.

## R3 popup event provenance hardening

After R2, the reading popup gained a production-only native `Event.isTrusted` gate for clicks, keyboard submission and edits. Open Shadow DOM is not a security boundary. The production-predicate regression rejects synthetic Add/refine/enrich/play/Enter/sense/edit actions. Other jsdom behavior tests explicitly mock this internal predicate and are not real-browser trusted-input evidence. The public PopupOptions interface has no bypass.

R3 aggregate local rerun: `npm run typecheck` passed; `npm run test:unit` 143 passed; standalone service tests 211 passed. Both production and isolated builds and post-build CSP isolation checks passed. Actual Chrome trusted click versus hostile synthetic dispatch remains part of pending Windows validation.

## Windows finding and R4 candidate

Actual Windows Chrome 154.0.8037.95 rejected R2 during unpacked load: `Insecure CSP value "blob:" in directive 'worker-src'`. No settings/readers/Anki browser checks ran on that failed load. Earlier build/static success did not establish manifest validity.

R4 removes the blob worker source and explicitly constructs a bundled local module worker for PDF.js, bypassing its opaque-origin CDN/blob wrapper. Worker teardown is owned by the viewer. Static regression now requires exactly `worker-src 'self'`. This is a candidate fix until repeated Windows extension-load and reader tests establish runtime success. No user profile or personal Anki collection was used.

## Actual Windows R4 checkpoint and R5 corrections

On Windows Chrome 154.0.8037.95, commit b6f6b794f20617d63ecba6d194e6280d266eb0d6 loaded successfully. Settings, empty queue/library, PDF text/no-text handling, hostile EPUB sanitization/navigation and library persistence passed. Real isolated Anki 26.09.3/AnkiConnect 6 on 127.0.0.1:18765 passed model/deck creation, recognition/cloze fields and single-card counts, double-add/duplicate cases, local synthetic audio/media and automatic restart recovery. Test collection ended at 5 notes / 5 cards. This is not live OpenAI/TTS or translation-quality evidence.

The same checkpoint failed HTML popup startup: content.js retained process.env.NODE_ENV and threw ReferenceError. R5 explicitly replaces that expression with production in every build and adds an artifact regression. Chrome also ignored the IPv6 CSP source; R5 narrows the supported production endpoints instead of weakening CSP.

Paid providers, manual retry/lost-response runtime recovery and previous-Stable Chrome 153 were not run at that checkpoint. Initial 153 launch was denied before execution; a fresh specific authorization transcript was supplied for one permitted retry. Owned test processes were closed and personal browser/Anki data untouched. Chrome background DNS/DoH bypassed the deny proxy, so complete browser network isolation is NOT claimed; no OpenAI/dictionary/8765 requests were observed.

R5 also removes private deck names from webpage popup DOM, restricts anki.decks to extension-owned pages, and refreshes unsaved destination state after the trusted settings handoff. Real browser rerun of final changes remains required.


## Final local checkpoint and external blocker

R5 source commit: 6eff002ae5451a7ba049177d08eebbe30d81ffbf. Final local checks: TypeScript passed, 155 Vitest tests passed, 211 standalone service tests passed, both builds and post-build CSP/browser-environment checks passed. Runtime ZIP is a candidate, not a certified production release.

The Windows executor's next turn failed with a Codex usage-limit error before a final R5 validation report. The computer remained connected. No new task/account/runtime was used to bypass the limit. R4 results above are retained but do not prove that final R5 popup changes work in the browser. Chrome 153 retry and subsequent test-process cleanup have no final confirmed report; do not infer they ran or completed. Live OpenAI/TTS quality/cost/latency tests remain unrun without a safely supplied key; no live-test spending occurred.

Next required validation: load final R5 in isolated Chrome 154 and previous Stable, exercise trusted Shift/click versus synthetic events, verify private deck DOM absence/settings return, rerun affected PDF/EPUB/Anki smoke, and test manual retry/lost-response reconciliation. Use only the isolated Anki build and test profile for automated mutations.

## Final local recovery candidate (2026-10-20)

TypeScript passed. Aggregate: 191 Vitest and 221 standalone service tests passed, including 33 recovery/quarantine regressions. Invalid saved settings fail closed until explicit repair; preserved old intents cannot replay at a new destination. Narrow safe local cancellation uses bounded CAS and preserves quarantine. Final Windows runtime and paid-model validation remain blocked as documented above.

## Multilingual 0.2 review checkpoint (2026-10-20)

The new revision adds 17 explicit source/target languages, same-language study, CEFR targets, up to three optional contextual examples, versioned neutral Anki drafts/models, shared grapheme-safe extraction, and source-language audio handling. No live translation/learning-quality claim follows from these additions.

Independent mocked integration found and fixed an adapter dropping the v2 reconciliation model-version argument. Regression now exercises the actual service factory and durable storage close/reopen after lost Anki replies, for both old and new draft versions. Additional review fixed hydration/stale-example races, uncertain-save draft mutation and stale pending local speech overtaking a newer language.

Latest completed aggregate before a wording-only UI label change: 272 Vitest + 279 standalone Node tests passed. TypeScript and builds passed. V1 model definitions (including fields, CSS and templates) compare unchanged; 70 original-v1 audio snapshot/cache-key differential cases pass. The structural matrix covers 17×17 language pairs at six CEFR targets, not measured linguistic quality. Production dependency audit reported zero known vulnerabilities at this check, not proof of absence of vulnerabilities.

One additional worker aggregate invocation was denied for possible npm registry access; state inspection showed 272 passing unit tests but only partial service output and no remaining process. That invocation is not counted as a completed aggregate. A parent offline-configured verification is separately recorded after completion. No quota bypass, paid provider calls or new live browser/Anki validation occurred. Historical R4 runtime evidence does not verify this 0.2 candidate.

Frozen-tree parent verification: npm explicitly configured offline with audit/funding/update-notifier disabled completed successfully: 272 Vitest + 279 standalone Node tests, zero failures. This is the final local aggregate for the review checkpoint.
