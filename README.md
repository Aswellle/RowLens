# RowLens

**A local-only CSV/TSV/JSONL viewer and cleaning workbench. Drag a file in, preview, search, clean and export — your data never leaves your device.**

![RowLens data grid with the cleaning pipeline and toolbar](docs/screenshots/grid.png)

- No account, no upload endpoint, no telemetry, no remote fonts or CDN runtime scripts.
- All parsing, cleaning and exporting happens in your browser; parsed records are temporarily cached in the browser's own IndexedDB storage and are never transmitted anywhere.
- Source files are read-only: RowLens only ever writes a **new** exported file.

## What it does

|                                                           |                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ![Empty state](docs/screenshots/empty.png)                | ![Export dialog with safety modes](docs/screenshots/export-dialog.png)            |
| Choose a file, drop one, or explore the synthetic sample. | Filtered-vs-all scope, spreadsheet-safe vs raw export with distinct explanations. |

**Import** CSV, TSV and JSONL/NDJSON (≤ 100 MiB) through a Web Worker in
bounded batches with explicit backpressure; cancellation removes all partial
data. **Query** with literal case-insensitive search, per-column filters,
stable string sort and column show/hide — run in a second worker over windowed
dataset scans, where the newest query always wins. **Clean** with serializable
steps (trim whitespace, remove empty rows, remove duplicates, select columns),
each showing its impact, never touching the stored file. **Export** CSV as the
filtered view or the cleaned dataset, streamed to a File System Access save
picker when available (capped in-browser download otherwise), with
spreadsheet-safe formula protection by default and an explicit raw mode.

All cell values stay strings — no implicit numeric or date conversion, so
leading zeros and date-like text are preserved exactly.

The grid is fully keyboard-operable: arrows/Home/End/PageUp/PageDown move the
active cell, the record header is one step to the left of the first column,
Shift+arrows or a drag extends a rectangular selection, Ctrl/Cmd+A selects the
view and Ctrl/Cmd+C copies the range as tab-separated text.

Cells are editable in place: Enter, F2, a double-click or just typing opens an
editor, Enter/Tab commits, Escape cancels, and Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z
step back and forth. Pasting tab-separated text fills cells from the active
cell (or tiles the block across a larger selection) as one undoable action. Edits are an **in-memory overlay** — the imported rows,
the IndexedDB copy and the source file are never rewritten, search and sort see
the edited values, exports write them, and reloading the page returns to the
imported data. Up to 5,000 cells can be edited at once.

## Getting started

Requirements: Node.js **>= 22.12** (22 LTS or 24 LTS recommended) and npm.

```bash
npm ci        # reproducible install from package-lock.json
npm run dev   # start the Vite dev server
```

Then open the printed local URL, drop in a file — or try the bundled
synthetic demo (`public/demo-support-tickets.csv`, 2,000 rows) and the
built-in **Try sample data** table.

### Verification commands

```bash
npm run typecheck    # tsc --noEmit (strict mode)
npm run test:unit    # Vitest unit & component tests
npm run build        # typecheck + production build + network audit
npm run format:check # Prettier check
npm run test:e2e     # Playwright E2E (production preview server)
```

If the Playwright browser bundle cannot be downloaded, the suite can run on
an installed browser: `PLAYWRIGHT_CHANNEL=msedge npm run test:e2e` (or
`chrome`). The accessibility scans and the `PERF=1`-gated performance
benchmarks live in the same suite.

### CI

GitHub Actions runs `npm ci`, `typecheck`, `test:unit`, `build` (including
the network audit) and `format:check` on Node 22 and 24, plus a separate
Playwright browser job (`.github/workflows/ci.yml`).

## Known limitations

- Search scans the current dataset on each query; a case-folded cache makes
  repeat searches much faster than the first (measured in
  [docs/performance-results.md](docs/performance-results.md)): P2 repeat
  ~2.6 s vs ~10–17 s before, P3 first search ~35 s (was ~65 s).
- Memory holds a write-through mirror of the dataset (~6.5× file size at the
  95 MiB benchmark); bounded by the 100 MiB import cap but heavy on low-RAM
  devices.
- Grid keyboard navigation covers arrows/Home/End/PageUp/PageDown, the record
  header and rectangular range selection (Shift+arrows, drag with edge
  auto-scroll, Ctrl/Cmd+A, Ctrl/Cmd+C as TSV). Copies above 100,000 cells are
  refused rather than truncated — use Export CSV for extracts that large.
  There is no multi-range (Ctrl+click) selection.
- Cell edits live in memory only: they are not written back to the imported
  rows or to IndexedDB, and reloading the page discards them. Editing is
  capped at 5,000 cells, and edits are not part of the undo history for
  cleaning steps. A paste that would run past the last visible row or column
  is clipped and reported instead of writing to hidden records.
- Verified on Chromium (Edge 156, headless) only; Firefox/Safari and
  reduced-motion/200 % zoom checks are still manual and unrecorded.
- The File System Access export path is preferred but is only exercised via
  the capped download fallback under test (headless has no save picker).
- No XLSX/Parquet/databases/SQL/charts — see the product brief's explicit
  non-goals (`docs/00-product-brief.md`).

## Privacy boundary

RowLens makes this promise, and no stronger one: file contents are processed
locally in your browser and are not uploaded to any RowLens server; the app
contains no telemetry or third-party analytics. Loading the app itself fetches
static assets from its host, and browsers may cache those assets. Parsed
records are temporarily stored in the browser's IndexedDB until you remove
them, the datasets expire (24 h), or you clear site data — see
`docs/05-security-privacy.md` for the full threat model and
`SECURITY.md` for reporting a vulnerability.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The
local-only boundary and data-correctness contracts are non-negotiable;
`docs/decisions.md` records every architecture decision. This project follows
the [Contributor Covenant](CODE_OF_CONDUCT.md).

## Project layout

```
docs/              specification documents, ADRs, performance results
e2e/               Playwright browser tests, benchmarks, screenshot capture
public/            synthetic demo data
scripts/           demo generator, network audit
src/
  app/             app shell, error-code catalogue
  components/      grid, toolbar, panels, dialogs
  features/
    cleaning/      serializable cleaning steps and pure transforms
    dataset/       data model, schema, IndexedDB repository, sample data
    export/        CSV encoding, serializer, saver abstraction
    import/        validation, CSV/TSV & JSONL sessions, coordinator, worker
    query/         query engine, worker client, protocols
    settings/      theme preference
  workers/         import & query workers
```

Full specification lives in `docs/` (start with `docs/00-product-brief.md`).

## License

[MIT](LICENSE)
