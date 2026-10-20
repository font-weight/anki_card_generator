# Integration fixtures and evidence rules

`fixtures/reading.html` contains no network resources, API key or private data. Serve it from loopback with `python -m http.server 8765 --directory tests/integration/fixtures` and open `http://127.0.0.1:8765/reading.html` in the extension-enabled test browser. Grant extension access to this site by explicit action. A local fixture is not representative of all site layout engines.

Use genuine Playwright mouse/keyboard input (or manual keyboard input), not DOM `dispatchEvent` to simulate an authorized Shift. Synthetic events are explicitly required to be ignored.

For mocked provider tests, record them as mock integration. Never label those results as live OpenAI or real Anki. For real-Anki checklist and Windows evidence requirements, see `docs/TEST_REPORT.md`.
