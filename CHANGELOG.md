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
