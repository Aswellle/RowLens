/**
 * Tunable limits. These are named constants (not scattered magic numbers) so
 * they can be referenced from tests and adjusted after real benchmarks, per
 * PRD FR-01 and docs/02-architecture.md §6.
 */

/** Initial import size cap: 100 MiB (PRD FR-01, pending real-machine tuning). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** JSONL maximum line length before a line is recorded as an error (contracts §3). */
export const MAX_JSONL_LINE_BYTES = 5 * 1024 * 1024;

/**
 * Rows persisted per IndexedDB batch. Architecture §6 recommends starting at
 * 500 and adjusting only with benchmark evidence.
 */
export const ROW_WRITE_BATCH_SIZE = 500;

/** Parse warnings shown as examples in the UI (contracts §2). */
export const PARSE_WARNING_SAMPLE_LIMIT = 20;

/** IndexedDB database identity. Must stay in sync across main thread and workers. */
export const IDB_NAME = 'rowlens-local';
/**
 * v2 adds `cellEdits`: user edits persisted separately from imported rows, so
 * the "imported rows are never rewritten" boundary holds across reloads too
 * (docs/decisions.md ADR-027).
 * v3 adds `pipelines`: the configured cleaning steps, so reopening a dataset
 * does not lose the pipeline (ADR-030).
 * v4 adds `views`: the last query view (search, filters, sort, hidden
 * columns), so reopening a dataset returns to what the user was looking at
 * (ADR-031).
 * Every upgrade only creates missing stores and leaves existing records alone.
 */
export const IDB_VERSION = 4;

/** Object store names inside IDB_NAME. */
export const IDB_STORE_DATASETS = 'datasets';
export const IDB_STORE_ROWS = 'rows';
export const IDB_STORE_IMPORT_ERRORS = 'importErrors';
/** One record per dataset: { datasetId, updatedAt, format, cells: [rowIndex, columnId, value][] }. */
export const IDB_STORE_CELL_EDITS = 'cellEdits';
/** One record per dataset: { datasetId, updatedAt, format, steps: CleaningStep[] }. */
export const IDB_STORE_PIPELINES = 'pipelines';
/** One record per dataset: { datasetId, updatedAt, format, search, columnFilters, sort, hiddenColumns }. */
export const IDB_STORE_VIEWS = 'views';

/** Datasets older than this are cleaned up on startup (architecture §6, security §3). */
export const DATASET_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Verified upper bound on matched row indices returned by one query
 * (architecture §8: exceeding the cap must be reported, never truncated).
 */
export const QUERY_MATCH_LIMIT = 200_000;

/**
 * Stricter size cap for the download fallback path (blob in memory) versus
 * the streaming File System Access path; exceeding it refuses the export
 * with an actionable message instead of attempting the allocation.
 */
export const EXPORT_FALLBACK_MAX_BYTES = 150 * 1024 * 1024;

/** Object URLs live until this delay after the download starts, then revoke. */
export const EXPORT_URL_REVOKE_DELAY_MS = 60_000;
