## Кандидат 0.7.7 RC4.3

- Вопрос «Когда откроется ближайшая библиотека?» обрабатывается в расширении без обращения к OpenAI. Если в предложении упоминается библиотека, можно спросить о роли слова *library*, форме глагола или порядке событий.
- Если текущему окну больше недоступен контекст разбора, в чате остаются видны история и набранный вопрос. Текст можно скопировать и вернуться к разбору. Возврат не отправляет запрос в OpenAI.

## Кандидат 0.7.7 RC4.2

- В открытом разборе по Alt можно своими словами попросить правило целиком, проверить своё понимание или спросить о грамматической роли другого слова из того же предложения. После уточнения или отказа можно продолжить разговор.
- Если Chrome заново запускает фоновый процесс расширения, тот же открытый разбор сохраняет свой контекст. При прерывании отправки решение о повторе остаётся за читателем.
- Обычный клик или тап по тексту книги сворачивает левую панель. Выделение текста оставляет панель открытой. Значки навигации позволяют сразу вернуть нужную панель.
- В окне Shift строка словарной транскрипции показывает только IPA. Уведомление «Настройки сохранены» занимает ширину сообщения и закрывается примерно через две секунды.

## Кандидат 0.7.7 RC4.1

- В разборе *Before they moved, Mara had dreamed of the sea* можно спросить «А had здесь можно опустить?» или «Does ‘before’ already tell us which event happened first?». Чат учитывает выделенную форму и её связь со словами исходного предложения.
- После ответа можно попросить объяснить проще или показать вариант этого же предложения. Кнопка подсказки подставляет вопрос в поле. Его можно отредактировать и отправить отдельно.
- Если формулировке не хватает связи с предложением, подсказка появляется локально. Если OpenAI получил вопрос, но ответил с ошибкой или не дал надёжного объяснения, панель сообщает об этом отдельно. Повторный запрос запускает читатель.

## Кандидат 0.7.7 RC4

- В окне разбора по левому Alt рядом с «Предпросмотр» появился вопрос о грамматике текущего предложения. Например, выделив *had dreamed*, можно спросить «Почему не Past Simple?». До отправки видны предложение, конструкция и предупреждение о стоимости.
- Счётчик «Страница X из Y» находится справа вверху. Стрелки по краям текста и клавиши перелистывают книгу. У EPUB и FB2 нумерация сквозная по тексту, у PDF она соответствует страницам файла.
- В редакторе цитаты поле «Ваша заметка» занимает всю доступную ширину. Для удаления сохранённой цитаты вместе с её выделением и комментарием требуется отдельное подтверждение.
- Для EPUB и FB2 оформление издателя изначально включено. Если вы уже выбирали оформление, сохранится ваш выбор.
- Окно перевода по Shift обозначает приблизительную транскрипцию знаком ≈. Успешное уведомление о сохранении настроек закрывается примерно через четыре секунды. Сообщение об ошибке можно закрыть вручную.

## Кандидат 0.7.7 RC3

- Счётчик EPUB и FB2 охватывает всю книгу, а стрелки верхней строки и клавиши продолжают перелистывать по одному окну. В PDF отображается номер физической страницы.
- На отдельной вкладке левой панели доступны закладки. Клик по сохранённому выделению в EPUB, FB2 или PDF открывает комментарий ко всему фрагменту.
- Библиотека показывает проверенную встроенную растровую обложку EPUB или FB2, когда она доступна. В режиме оформления издателя начальный заголовочный блок старых EPUB получает компактную иерархию.
- В подсказках читалки видно состояние левого Alt. В окне Shift кнопка системного произношения слова расположена рядом с закрытием. Исправлены отступы меню расширения, фон тёмных настроек и выравнивание флажков.
- Тестовые книги генерируются при запуске `npm test` из чистого архива исходников.

## Кандидат 0.7.7 RC2

- Для PDF и EPUB без автора библиотека сохраняет заголовок из книги.
- В EPUB и FB2 переход на середину короткой книги попадает в середину текста. Ползунок поддерживает последовательные нажатия стрелок, Home и End. В PDF стрелки перемещают на одну физическую страницу.
- Выбранное совпадение поиска подсвечивается в самой книге. Одинаковые совпадения на одной странице различаются. Подсветка поиска существует отдельно от сохранённых цитат.
- На обороте новых словарных и грамматических карточек показано читаемое место в источнике. Точный адрес чтения остаётся в данных расширения.
- «Разбор предложения по левому Alt» поясняет стоимость запуска. Краткий ответ описывает функцию конструкции в предложении, в подробном ответе запрашивается близкий пример или контраст.

## Кандидат 0.7.7 RC1

- В читалке появились регулируемая левая панель, три темы, цитаты с комментариями и ползунок перехода по книге.
- Словарное окно Shift показывает языковую пару и использует шаблон карточки Anki в предпросмотре. «База слов» показывает статус записи и позволяет убрать подтверждённую запись из локального списка.
- Разбор грамматики по левому Alt включается отдельно. В окне показаны выделенная конструкция, её смысл и причина выбора формы.

## 0.7.6 — English usage estimates and reading marker

- English lookups show estimated CEFR, current register and conversational frequency in the popup only. No extra lookup or new Anki fields.
- Shift leaves a local reading marker on the selected text in the current document.

## 0.7.5 — sentence translation and language diagnostics
- Full original-sentence translation in the same explicit lookup, displayed on the answer side for recognition and cloze cards.
- Exact-range underline supports selected phrases and repeated occurrences; no translation-word alignment is guessed.
- Existing Anki v2 fields/templates and old queued drafts retained; no retroactive translation or automatic provider repair.
- Request-specific definition-language guidance and clearer diagnostic wording for the reported `bound on` failure; live response unavailable.
- See docs/V0_7_5_TEST_REPORT.md for verification and limitations.

# 0.7.4-reconstructed (2026-10-23)

- Preserve full sentence context across inline source wrapping, while keeping exact original text, offsets, structural paragraph boundaries and length limits.
- Fix valid single-message multipart JSON, exact uppercase acronym equivalents with target-language explanations, and harmless known-candidate lemma casing/spacing.
- Generate candidate choices before dependent fields and senses before recommendation IDs; invalidate the older lookup cache.
- Separate API request rejection from malformed output and expose bounded stage/reason diagnostics without provider text, keys or request IDs.
- Display actual requested language settings during failures; never repeat paid requests automatically or invite a blind unchanged-parameter retry.
- Preserve all 0.7.3 grammar-model, immutable-save, reader-keyboard and popup fixes.

Real provider responses for the three reported failures were unavailable. All feature tests are offline; no real-browser/provider/personal-Anki verification or installation is claimed. See `docs/V0_7_4_TEST_REPORT.md`.

# 0.7.3-reconstructed (2026-10-23)

Continues the delivered 0.7.2 source and local Git history, not a fresh 0.5 baseline.

- Redesign the reading lookup panel around its word/lemma, result, loading and failure states. Provide one explicit retry with a possible-cost notice, safe expandable error code and contextual unsaved/pending-save notices.
- Align the outbound lookup schema/prompt with the strict local sense-ID, count and IPA-dialect contract; preserve exact selected spans and phrasal candidate identity. Remove hidden vocabulary transport retries.
- Recover grammar model incompatibility through explicit non-destructive v2 setup, while reusing compatible v1 models and preserving cross-version save reconciliation and immutable operation identity.
- Route active-book paging from the outer library document as well as current EPUB/FB2 frames without requiring a first text click or forcing focus. Keep editable controls, popups, IME and stale frames guarded.
- Preserve the 0.7.2 extension-icon menu sizing, existing vocabulary cards, audio, queue and book state.

All provider/Anki feature checks remain offline. The actual provider payload and installed Anki model fields from the reported failures were not available; real-browser verification is still outstanding. See `docs/V0_7_3_TEST_REPORT.md`.

# 0.7.2-reconstructed (2026-10-22)

- Correct the collapsed extension-icon popup reported in a real user screenshot: size the document roots independently of the initial popup viewport instead of capping only the inner menu with `100vw`.
- Keep the menu comfortably wide with readable button/footer layout; preserve all actions and the 0.7.1 verb base-form feature.
- Replace the earlier inadequate width assertion with document-sizing regressions and verify the compiled action stylesheet.

Real-browser rerun/screenshots remain unperformed under the existing execution restriction. See `docs/V0_7_2_TEST_REPORT.md`.

# 0.7.1-reconstructed (2026-10-22)

Continues the verified 0.7.0 reconstruction at `144f26cf246dad502c8d543e9021f1bd73380f39`; it is not the recovered original 0.6.1 source.

- Show the existing verb lemma prominently as “Инфинитив” or the language-appropriate “Начальная форма”, without an additional provider request or an invented English “to”.
- Keep the inflected source expression, exact sentence/range, cache, refinement, examples, pronunciation/audio and Anki draft semantics intact. Do not label nouns or guessed/mixed POS as infinitives.
- Redesign only the extension-icon menu with a calm compact layout, current-tab context, explicit primary action, button navigation, keyboard focus and light/dark/forced-color styling.
- Opening the menu reads tab metadata only. Own-library, restricted-page, unavailable-tab and navigation/error states do not trigger content injection or model calls.
- Preserve grammar opt-in, Shift/Alt behavior, bounded phrasal candidates, queue, search, bookmarks, appearance and existing cards.

See `docs/V0_7_1_TEST_REPORT.md` for verification and limits. No installed extension/profile was changed; no public push or release was made.

# 0.7.0-reconstructed (2026-10-22)

New reconstruction from the verified published 0.5.0 source tree, not recovered original 0.6.1 source and not byte-identical to that build.

- Restore compact Language Reader action menu and own-library ready state.
- Restore guarded Shift hover activation across book frames and parent focus.
- Enforce source-language definitions for all vocabulary senses, with versioned cache invalidation and conservative mismatch rejection.
- Add default-off, explicitly opted-in LeftAlt grammar, independent explanation language, editable preview, separate LanguageReader.Grammar.v1 model, manual save and bounded persistent cache.
- Recover uniquely identifiable exact grammar construction spans when only numeric offsets were miscounted, never fuzzy rewrites or extra paid repairs.
- Resolve bounded contiguous English phrasal-verb candidates in the same initial contextual lookup. Preserve selected surface/range separately from lemma through cache, refinement, examples, audio and Anki.
- Preserve 0.5 search, bookmarks, appearance, existing note models, queue behavior and audio consent.

See README_RECONSTRUCTED.md and docs/RECONSTRUCTION_TEST_REPORT.md for provenance, validation and limits.

# 0.5.0

- Per-book local bookmarks and appearance persistence, with session-only mode and backward-compatible state storage.
- Bounded cancellable local text search for PDF, EPUB and FB2; no API use or OCR.
- Fixed PDF last-page clamping and search location fidelity across Unicode/HTML parsing.
- Defensive FB2 metadata and complete generated-byte bounds.

# 0.4.0

- Local PDF page navigation, fit/zoom and guarded keyboard shortcuts.
- EPUB/FB2 section navigation, screen position, responsive layout and preserved CFI.
- Bounded local plain-FB2 import with original source provenance; no images or .fb2.zip support.
- Race-safe library opening and visible session-only mode.
- Shift replaces stale popup for a new selection without canceling dispatched Anki saves.
- gpt-6-luna text generation with explicit none/low effort separation; audio model unchanged.

# 0.3.1

- Settings feedback appears at the top of the viewport independently of page scroll. Persistent security/repair warnings remain in their original sections.

# Изменения Language Reader for Anki

## 0.3.0 — кандидат

- Новые карточки сохраняют все полученные распространённые значения и переводы, с выбранным контекстным значением первым. Это не обещание полного словаря; запрос ограничен максимум восемью значениями и четырьмя переводами на значение.
- Изучаемое слово выделено красным и подчёркнуто в точном выбранном месте предложения. Ответ cloze остаётся скрытым до переворота.
- Транскрипция показывается в квадратных скобках; в окне расширения она крупнее. Исходная IPA и её происхождение не изменяются.
- Галочка подготовки аудио запускает явный платный запрос после отдельного разрешения облачного аудио. Готовый файл можно прослушать и сохранить без повторной генерации. Загрузка окна сама не запускает аудио.
- Используются уже созданные типы Anki v2. Старые карточки и сохранённые v1/v2 задания не переписываются.

## 0.2.1 — кандидат, 2026-10-21

- Результат «Проверить Anki и получить колоды» теперь виден непосредственно под кнопкой: ход проверки, успех с количеством колод или ошибка. Общее сообщение вверху страницы сохранено.
- Повторные нажатия во время проверки не отправляют дополнительные запросы. Настройки подключения, согласия, создание типов заметок и отправка карточек не изменены.
- Добавлены шесть UI-регрессий с подменённым RPC. Полный статус и ограничения проверки: [TEST_REPORT](docs/TEST_REPORT.md).

Кандидат не означает завершённую проверку Windows Chrome, платного перевода OpenAI или сохранения настоящей карточки в Anki.
