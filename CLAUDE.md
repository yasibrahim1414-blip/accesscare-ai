# AccessCare AI — notes for Claude Code

- Branch `source` = the app's source. Branch `main` = the built website served by GitHub Pages
  (https://yasibrahim1414-blip.github.io/accesscare-ai/). Never put source files on `main`.
- Install: `npm install`. Unit tests: `npm test`. Browser tests: `npm run test:server &` then
  `python3 tests/e2e/<name>.py` (Playwright for Python + Chromium; `care_flow.py` also needs `opencv-python`).
- Build: `npm run build:web` → `dist/web/` (copy into `main`), `dist/accesscare-ai.html` (the in-Claude artifact).
  After a build delete `dist/*/mp/face_landmarker.task` (unused, large).
- Tests that need the local AI stand-in build with `ACCESSCARE_AI_ENDPOINT=http://localhost:8787/ai`.
- The AI key lives only in the Cloudflare worker (`server/cloudflare-worker.mjs`, copy also published on `main`).
  Never put a key in the app.
- Talk to the owner in Egyptian Arabic. Don't claim untested features work; no fake data; no diagnosis.
