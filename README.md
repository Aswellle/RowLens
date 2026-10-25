# RowLens

**A local-only CSV/TSV/JSONL viewer and cleaning workbench. Drag a file in, preview, search, clean and export — your data never leaves your device.**

- No account, no upload endpoint, no telemetry, no remote fonts or CDN runtime scripts.
- All parsing, cleaning and exporting happens in your browser; parsed records are temporarily cached in the browser's own IndexedDB storage and are never transmitted anywhere.
- Source files are read-only: RowLens only ever writes a **new** exported file.

> **Status:** Phase 1 complete — UI skeleton and design system, driven by
> synthetic data only. Real file import, cleaning and export are **not
> implemented yet**; the UI says so in place instead of faking them. This
> README only documents capabilities that are actually built and verified.

## What works today (verified by tests)

- Empty state, drag-and-drop zone, toolbar, virtualized data grid, status
  line, loading / no-results / error states, responsive layout (360px+),
  light & dark themes.
- **Try sample data** loads a deterministic, seeded synthetic table (5,000
  rows × 8 columns, generated on your machine — no real data).
- Live literal case-insensitive search with announced result counts; stable
  string sorting with `aria-sort`; Esc clears search in place.
- Keyboard-operable main path; the grid renders only a viewport-sized DOM
  window (asserted in unit and browser E2E tests).

## Supported formats (planned for v0.1)

| Format         | Extensions          | Notes                                                                                           |
| -------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| CSV            | `.csv`              | Parsed with [Papa Parse](https://www.papaparse.com/); quoted fields, embedded newlines, CRLF/LF |
| TSV            | `.tsv`              | Tab-delimited variant of the CSV pipeline                                                       |
| JSONL / NDJSON | `.jsonl`, `.ndjson` | One JSON object per line; nested values shown as JSON text                                      |

All cell values are kept as strings by default — no implicit numeric or date
conversion, so leading zeros and date-like text are preserved exactly.

## Development

Requirements: Node.js **>= 22.12** (22 LTS or 24 LTS recommended) and npm.

```bash
npm ci        # reproducible install from package-lock.json
npm run dev   # start the Vite dev server
```

### Verification commands

```bash
npm run typecheck    # tsc --noEmit (strict mode)
npm run test:unit    # Vitest unit & component tests
npm run build        # typecheck + production build
npm run format:check # Prettier check
npm run format       # Prettier write
npm run test:e2e     # Playwright E2E (production preview server)
```

If the Playwright browser bundle cannot be downloaded, the suite can run on
an installed browser: `PLAYWRIGHT_CHANNEL=msedge npm run test:e2e` (or
`chrome`). CI uses the bundled Chromium.

### CI

GitHub Actions runs `npm ci`, `typecheck`, `test:unit` and `build` on every
push/PR (`.github/workflows/ci.yml`). Browser end-to-end tests will run as a
separate job once implemented (see `docs/07-implementation-roadmap.md`).

## Privacy boundary

RowLens makes this promise, and no stronger one: file contents are processed
locally in your browser and are not uploaded to any RowLens server; the app
contains no telemetry or third-party analytics. Loading the app itself fetches
static assets from its host, and browsers may cache those assets. Parsed
records are temporarily stored in the browser's IndexedDB until you remove
them, the tab's datasets expire, or you clear site data — see
`docs/05-security-privacy.md` for the full threat model.

## Project layout

```
docs/            specification documents and decision records (ADR)
src/
  app/           app shell, error-code catalogue
  features/
    dataset/     data model, schema derivation, limits, IndexedDB constants
    import/      import job protocol (worker message contracts)
    query/       search/filter/sort query contracts
    export/      CSV export option contracts
```

Full specification lives in `docs/` (start with `docs/00-product-brief.md`).
Key decisions are recorded in `docs/decisions.md`.
