# Language Reader 0.7.6 verification

- Clean `npm ci` with Node 24.22.1 and the committed lockfile: passed.
- `npm run typecheck`: passed.
- `npm test`: 936 Vitest cases and 494 Node service cases passed (1,430 total). Tests cover display for the recommended English sense, a single mock lookup, missing/invalid optional estimates, no export in the Anki draft or fields, and local highlight replacement and cleanup.
- `npm run build`: passed, producing the unpacked extension and ZIP.
- `npm run test:e2e`: attempted. Chromium could not start in the sandbox because opening its local process socket was not permitted. No browser assertions ran. Two new smoke tests are included for HTML and EPUB trusted Shift and closing/replacing the marker.
- Live OpenAI, real Anki collections, and device-specific compatibility were not tested. No API key or paid requests were used. CEFR/register/frequency are qualitative estimates from the original lookup, not a dictionary or corpus result.
