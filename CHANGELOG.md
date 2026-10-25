# Changelog

All notable changes to RowLens are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project has
not reached a stable 1.0 — minor-version zero signals an evolving API and
feature set.

## [0.1.0-rc.1] — 2026-10-26

First release candidate of the complete core workflow: import → query →
clean → export, entirely in the browser.

### Added

- **Import** — CSV, TSV and JSONL/NDJSON via file picker or drag-and-drop,
  capped at 100 MiB. Parsing runs in a Web Worker in bounded batches with
  explicit backpressure (the parser pauses until each batch is persisted to
  IndexedDB); cancellation removes all partial data. A CSV/TSV options step
  offers the header-row toggle and delimiter choice. Unsupported formats and
  oversized files are rejected up front with actionable messages.
- **Parsing fidelity** — quoted fields with embedded commas, quotes and
  newlines; BOM and CRLF handling; duplicate/empty headers kept as separate
  positional columns; all values kept as strings (leading zeros and date-like
  text preserved); mid-file blank lines retained; JSONL schema growth in
  first-seen key order, invalid lines recorded with line numbers while
  parsing continues, oversized lines dropped safely; suspected encoding
  problems flagged.
- **Querying** — global literal case-insensitive search, per-column literal
  filters, stable string sorting (equal values keep their order, missing
  values last), column show/hide; all executed in a second worker over
  windowed dataset scans. The newest query supersedes older ones; results
  above the verified 200,000-row match limit are reported, never truncated.
- **Cleaning pipeline** — serializable steps (trim whitespace, remove empty
  rows, remove duplicates with exact or trimmed comparison over whole rows or
  key columns, select columns) added, edited, enabled/disabled, removed and
  reset from a panel with per-step impact counts, executed in the same worker
  pass as the query. The stored dataset is never modified.
- **CSV export** — streamed serialization with CRLF endings and minimal
  quoting; spreadsheet-safe mode prefixes formula-looking cells (OWASP
  prefix set, including whitespace-obscured ones) and reports the count;
  raw mode keeps original values behind an explicit warning; filtered-view or
  all-rows-cleaned scope; File System Access save streaming when available,
  a capped in-browser download otherwise; sanitised file names.
- **Local data lifecycle** — datasets cached in IndexedDB, removed on demand,
  cleaned up on startup after a 24-hour TTL; quota and storage failures show
  typed, actionable errors.
- **UI** — virtualized grid (viewport-sized DOM), light/dark themes,
  responsive layout from 360 px, keyboard-operable main path, `aria-sort`,
  announced result counts, axe-scanned states with zero critical/serious
  violations.
- **Quality infrastructure** — 150+ unit/component tests, 34 browser E2E
  tests, parser contract tests, network audit in CI, deterministic synthetic
  sample and benchmark fixtures, and measured performance results
  (`docs/performance-results.md`).

### Improved (post-rc additions, same release)

- **Query cancellation**: long-running searches show a busy marker with a
  working "Cancel query" button; the engine stops between batches and the
  previous view is preserved.
- **Cell copy action**: every cell gains a keyboard-reachable Copy button
  (with a non-secure-context fallback) so full values no longer depend on
  the hover tooltip.
- **Search performance**: the query worker keeps a case-folded value cache
  per dataset (invalidated on re-import), amortising per-cell folding across
  queries — measured on the P2 benchmark: first search 12.4 s, repeat
  searches 2.6 s (was 17–19 s uncached); P3 first search 34.8 s (was
  64.7 s). Numbers and methodology in `docs/performance-results.md`.
- **Viewport coverage**: automated layout checks at 360/768/1280/1440 px
  (internal grid scrolling, no page-level horizontal overflow on narrow
  screens, feature buttons reachable).

### Known limitations

See the README ("Known limitations") — notably search's per-cell scan cost
at very large datasets, memory amplification from the write-through cache,
and Chromium-only verification so far.

[0.1.0-rc.1]: https://github.com/rowlens/rowlens/releases/tag/v0.1.0-rc.1
