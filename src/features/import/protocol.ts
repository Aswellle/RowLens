/**
 * Import Worker message protocol.
 *
 * Contract source: docs/02-architecture.md §7 and PRD FR-01.
 * - Every message carries `jobId` and a discriminant `type`.
 * - Backpressure: the worker emits a `BATCH` and pauses parsing until the
 *   main thread persisted it and replies `ACK` with the same `batchSeq`.
 * - Cancellation is idempotent; messages for stale jobIds must be ignored by
 *   the receiver so a late reply can never overwrite a newer job's state.
 * - Errors carry a stable AppErrorCode plus an optional physical line number;
 *   they never embed raw row content.
 */
import type { AppErrorCode } from '../../app/error-codes';
import type {
  ColumnDefinition,
  ColumnId,
  DatasetFormat,
  ImportWarningSummary,
} from '../dataset/types';

export type ImportJobId = string;

/** Options fixed by the user before import starts. */
export type ImportStartOptions = {
  format: DatasetFormat;
  /** CSV/TSV only: whether the first record is a header row. */
  hasHeader: boolean;
  /** CSV/TSV only: explicit delimiter override; absent = auto-detect. */
  delimiter?: string;
};

// --- Main thread → Import Worker -------------------------------------------------

export type MainToImportWorker =
  | {
      type: 'IMPORT_START';
      jobId: ImportJobId;
      options: ImportStartOptions;
      /** The File handle itself; structured clone delivers it to the worker. */
      file: File;
    }
  | { type: 'ACK'; jobId: ImportJobId; batchSeq: number }
  | { type: 'CANCEL'; jobId: ImportJobId };

// --- Import Worker → Main thread --------------------------------------------------

/** One wire-format record inside a BATCH message. */
export type ImportWireRow = {
  rowIndex: number;
  values: Record<ColumnId, string | null>;
};

export type ImportWorkerToMain =
  | {
      type: 'BATCH';
      jobId: ImportJobId;
      /** Zero-based, incremented per batch within one job. */
      batchSeq: number;
      rows: ImportWireRow[];
      /** Schema columns discovered since the previous batch (JSONL growth). */
      schemaAppend?: ColumnDefinition[];
    }
  | {
      type: 'PROGRESS';
      jobId: ImportJobId;
      rowsParsed: number;
      /** Bytes consumed so far, when the format allows counting. */
      bytesProcessed?: number;
    }
  | {
      type: 'IMPORT_DONE';
      jobId: ImportJobId;
      rowCount: number;
      columns: ColumnDefinition[];
      parseErrorCount: number;
      warnings: ImportWarningSummary[];
    }
  | { type: 'IMPORT_CANCELLED'; jobId: ImportJobId }
  | { type: 'ERROR'; jobId: ImportJobId; failure: ImportFailure };

export type ImportFailure = {
  code: AppErrorCode;
  /** Human-readable, non-sensitive explanation category. */
  detail: string;
  /** 1-based physical line in the source file, when known. */
  physicalLine?: number;
};

/** Messages that terminate a job; anything after these for the same jobId is ignored. */
export type ImportTerminalMessage = Extract<
  ImportWorkerToMain,
  { type: 'IMPORT_DONE' | 'IMPORT_CANCELLED' | 'ERROR' }
>;
