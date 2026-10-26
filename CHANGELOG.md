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
- **Targeted search**: a search term of the form `column:value` restricts that
  one term to the named column (`Status:open`), with quoted headers for names
  containing spaces (`"First response (h)":14`). Whitespace-separated terms
  must all match. A prefix that names no column stays an ordinary substring —
  URLs, times and typos are unaffected — and a header shared by several
  columns searches all of them rather than silently picking one. Everything
  remains a literal substring; there is no regex or wildcard syntax.
- **Numeric sort**: a sorted column's header gains a "123" toggle that re-sorts
  the column by value instead of string order, so `9` comes before `1,050` and
  `00123` parses as 123. The mode is strictly opt-in — never inferred — and the
  parsing rule is fixed: plain decimals with optional sign/exponent, and strict
  thousands grouping (`1,050` accepts; `1,05` does not). Hex, `Infinity`,
  `NaN` and currency symbols are not numbers. Mixed columns partition
  predictably: numbers, then values that do not parse (string order among
  themselves), then empty cells — the partition order is identical in both
  directions, only comparisons inside a partition reverse. The mode persists
  with the rest of the view, composes with cleaning and edits (they feed the
  sort keys), and the direction cycle keeps it.
- **Selected-range export**: the Export dialog gains a third scope —
  "Selected range (N rows × M columns)" — that streams exactly the rectangle
  on screen, in view order, with the same values Copy would put on the
  clipboard but without the copy cell cap. It appears (and defaults) only when
  the grid holds a multi-cell selection; a single focused cell keeps the
  two-scope dialog. The rectangle is snapshotted when the dialog opens, so a
  query finishing under the modal cannot silently change what gets written.
- **Fixed**: the grid header's CSS had targeted `th` elements since the first
  release while the grid renders `div[role='columnheader']` — every header
  rule (background, sticky position, borders, arrow visibility) silently
  matched nothing, leaving the header transparent and scrolling away with the
  body. The selectors now target the roles.
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
- **Keyboard grid navigation**: arrow keys, Home/End and PageUp/PageDown move
  focus cell-by-cell with a roving tabindex (one tabbable cell), scrolling the
  virtualized window as needed; clicking a cell makes it the focus target.
- **Row header and range selection**: the record header joins the keyboard
  roam (one step left of the first column) and selects its whole row with
  Space or a click. Shift+arrows, Shift+click and drag extend a rectangular
  selection that auto-scrolls past the viewport edge, Ctrl/Cmd+A selects the
  whole view, Escape collapses it, and Ctrl/Cmd+C or the selection bar copies
  the range as tab-separated text with CRLF rows. Copies over 100,000 cells
  are refused with an explanation instead of being truncated, and the record
  header is a selector that never contributes a value.
- **Cell editing with undo/redo**: Enter, F2, double-click or typing a
  character opens an in-cell editor; Enter/Tab commit (Tab moves on), Escape
  cancels, and leaving the cell commits. Edited cells carry a visible marker
  and the status line reports the count with Undo, Redo and Reset edits
  (Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z work anywhere outside a text field).
  Edits are an in-memory overlay: the imported rows, the IndexedDB copy and
  the source file are never rewritten, search/filter/sort run against the
  edited values, exports write them, and reloading discards them. Editing is
  capped at 5,000 cells with an explanation instead of a silent drop.
- **Block paste**: pasting tab-separated text (quoted fields with tabs and
  newlines included) fills cells from the active cell, or tiles the block to
  fill a larger selection. One paste is one undo entry. Anything that would
  land outside the visible rows or columns is clipped and reported rather
  than written to records you cannot see.
- **Edits survive a reload**: cell edits are persisted in their own
  IndexedDB store (`cellEdits`, database v2), separate from the imported
  rows, and the app reopens the dataset you were last viewing. Imported rows
  are still never rewritten — removing a dataset deletes its edits with it,
  and a reloaded session starts without undo history, so `Reset edits` is the
  way back to the imported values.
- **Faster reload**: a restored dataset is read from IndexedDB in 500-row
  chunks on demand instead of all at once, so reopening no longer waits on
  transactions for rows the grid will never show. Measured restore time went
  from 1.0/2.7/6.9 s to 0.28/0.39/0.38 s at 20k/100k/250k rows — flat in
  dataset size (`docs/performance-results.md`).
- **Cleaning pipeline survives a reload**: the configured steps are saved in
  their own IndexedDB store and restored with the dataset, so reopening a file
  no longer means rebuilding the pipeline. Steps are still configuration only —
  the stored rows are never modified, and resetting the steps deletes the saved
  record rather than writing anything back. Steps whose columns no longer exist
  after a re-import are dropped instead of silently widening to every column.
- **Bounded chunk cache**: at most 40 chunks (20,000 rows) stay in memory, with
  the window currently on screen pinned so it is never evicted mid-render.
  Scrolling a whole 250k-row file now leaves 48 MB of JS heap instead of
  accumulating every chunk it passed; an evicted chunk is simply re-read from
  IndexedDB when it comes back into view.
- **Query view survives a reload**: the search term, column filters, sort and
  hidden columns are saved per dataset and restored with it, so reopening a
  file returns to the view you were reading rather than the full table. The
  view is stored by column id, so a re-import that reorders columns still sorts
  the same column. Parts that no longer apply (a filter on a deleted column) are
  dropped individually instead of discarding the whole view; a view that would
  hide every column is ignored, since it would leave no grid to interact with.
  `Reset` now clears all four and deletes the saved record, and the status line
  reports hidden columns so that state is visible.
- **Cleaning presets**: the current pipeline can be saved under a name and
  applied to a _different_ file, so a recurring cleanup (trim, dedupe, keep
  these columns) no longer has to be rebuilt for every export. Presets match
  columns by **header name** rather than position, so they still target the
  right column when the next file orders its columns differently. A header name
  that matches several columns is never guessed at — the affected step or label
  is skipped and reported, and a preset that matches nothing is refused with an
  explanation instead of applying silently. Presets are stored globally, so
  removing the dataset they were captured from does not delete them; saving over
  an existing name asks for confirmation first.
- **Preset files**: the saved presets can be exported as a JSON file and
  imported again — on another browser or machine — so a cleanup recipe survives
  beyond the installation that created it. A preset file contains configuration
  only: step types, enabled flags and column header names, never cell values or
  file names. Import treats the file as untrusted input (size-capped,
  defensively parsed, every entry validated) and **never overwrites** an
  existing recipe: a name collision is skipped and reported, so the user can
  rename and retry. The merge outcome is announced in full — how many were
  imported, skipped, or unreadable.
- **Fixed**: the debounced save effects for edits and the cleaning pipeline
  depended on the whole view object, so every query result restarted the timer
  and a slow query could postpone the write indefinitely. They now depend on a
  derived signature, and the same fix applies to the new view save.
- **Fixed**: cancelling a query left the busy marker and Cancel button on
  screen permanently — the cancelled outcome now clears busy while preserving
  the previous view (regression test in `reduce-outcome.test.ts`).

### Known limitations

See the README ("Known limitations") — notably search's per-cell scan cost
at very large datasets, memory amplification from the write-through cache,
and Chromium-only verification so far.

[0.1.0-rc.1]: https://github.com/rowlens/rowlens/releases/tag/v0.1.0-rc.1
