/**
 * RowLens core data model.
 *
 * Contract source: docs/02-architecture.md §5 and docs/03-data-processing-contracts.md §1.
 * All cell values are strings (or null for missing); RowLens never performs
 * implicit numeric or date conversion.
 */

/** Unique identifier for an imported dataset instance. */
export type DatasetId = string;

/**
 * Zero-based index of a successfully imported logical data record.
 * Distinct from the physical line number in the source file.
 */
export type RowIndex = number;

/**
 * Stable, unique column identifier. Never derived from user-facing display
 * names, which may be empty or duplicated. CSV/TSV columns use `c0`, `c1`, …
 * based on source position; JSONL columns use `k0`, `k1`, … in first-seen order.
 */
export type ColumnId = string;

/** Supported input formats. */
export type DatasetFormat = 'csv' | 'tsv' | 'jsonl' | 'ndjson';

export type ColumnDefinition = {
  /** Unique, stable; never use the display label as primary key. */
  id: ColumnId;
  /** User-facing label; may duplicate or be a generated placeholder. */
  label: string;
  /** JSONL top-level key, when the dataset came from JSONL/NDJSON. */
  sourceKey?: string;
  /** CSV/TSV source position (zero-based), when applicable. */
  sourceIndex?: number;
};

/**
 * One stored record. `values` maps every column currently known in the dataset
 * schema to its display string; missing keys mean the record predates that
 * column (JSONL schema growth) and are treated as missing values, not "".
 */
export type StoredRow = {
  datasetId: DatasetId;
  rowIndex: RowIndex;
  values: Record<ColumnId, string | null>;
};

export type DatasetStatus = 'importing' | 'ready' | 'cancelled' | 'failed';

/** Categorised parse problem attached to a dataset summary. */
export type ImportWarningKind =
  | 'malformed-row'
  | 'invalid-json-line'
  | 'line-too-long'
  | 'field-count-mismatch'
  | 'encoding-suspect'
  | 'blank-line-skipped';

export type ImportWarningSummary = {
  kind: ImportWarningKind;
  /** Number of occurrences across the file. */
  count: number;
  /** Physical line numbers (1-based), capped at PARSE_WARNING_SAMPLE_LIMIT. */
  sampleLineNumbers: number[];
};

export type DatasetMetadata = {
  id: DatasetId;
  format: DatasetFormat;
  /** Local display only; never transmitted anywhere. */
  fileName: string;
  byteSize: number;
  status: DatasetStatus;
  createdAt: number;
  lastTouchedAt: number;
  rowCount: number;
  columns: ColumnDefinition[];
  parseErrorCount: number;
  importWarnings: ImportWarningSummary[];
  /** Bump whenever the persisted record layout changes; see docs/decisions.md. */
  schemaVersion: 1;
};
