# RowLens

**A local-only CSV/TSV/JSONL viewer and cleaning workbench. Drag a file in, preview, search, clean and export — your data never leaves your device.**

- No account, no upload endpoint, no telemetry, no remote fonts or CDN runtime scripts.
- All parsing, cleaning and exporting happens in your browser; parsed records are temporarily cached in the browser's own IndexedDB storage and are never transmitted anywhere.
- Source files are read-only: RowLens only ever writes a **new** exported file.

> **Status:** Imports and queries are live — CSV/TSV/JSONL import through a
> Web Worker into IndexedDB (with a header/delimiter options step), and
> search, per-column filters, column visibility and sorting run in a second
> worker over windowed dataset scans. Cleaning steps and export are **not
> implemented yet**; the UI says so in place instead of faking them. This
> README only documents capabilities that are actually built and verified.

## What works today (verified by tests)

- **Import**: choose or drop a supported file (≤ 100 MiB). Parsing runs off
  the main thread in bounded batches with explicit backpressure; every batch
  is persisted before parsing continues; cancellation removes all partial
  data. Unsupported formats and oversized files are rejected up front with
  actionable messages.
- **Parsing fidelity**: quoted fields with embedded commas/quotes/newlines,
  BOM + CRLF, duplicate/empty headers (kept as separate positional columns),
  leading zeros and date-like text preserved as strings, mid-file blank lines
  kept for the (future) cleaning pipeline, JSONL schema growth, invalid JSONL
  lines recorded with line numbers while parsing continues, oversized JSONL
  lines dropped safely.
- **View**: virtualized grid (viewport-sized DOM, asserted in tests), live
  literal case-insensitive search with announced counts, per-column literal
  filters with active-filter counts, column show/hide (presentation only —
  counts unchanged), stable string sort with aria-sort semantics, Esc clears
  search in place, light/dark themes, responsive layout from 360px. Queries
  run off the main thread; a slow query can never overwrite a newer one, and
  results over the verified match limit are reported, never truncated.
- **CSV/TSV import options**: before importing, choose whether the first row
  is a header and pick a delimiter (or let it be detected).
- **Try sample data** seeds a deterministic synthetic table (5,000 × 8,
  generated locally — no real data) into the same IndexedDB pipeline.
- Data never leaves the browser: parsing happens in a Worker, records are
  cached in this origin's IndexedDB, and removing the dataset (or the 24h
  startup cleanup) deletes them.

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
