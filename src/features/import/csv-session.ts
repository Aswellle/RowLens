/**
 * Streaming CSV/TSV import session on Papa Parse chunk mode.
 *
 * Memory and backpressure contract (ADR-012): Papa reads the file in bounded
 * chunks (never the whole text at once); parsed records accumulate into
 * batches of at most ROW_WRITE_BATCH_SIZE rows; after handing a batch to the
 * caller the parser stays paused until the caller's persistence promise
 * resolves, so a slow sink can never build an unbounded queue.
 *
 * Semantics (data contract §2): header handled by us (Papa's header mapping is
 * off so we keep raw field arrays), dynamicTyping off, skipEmptyLines off —
 * empty records are preserved for the cleaning pipeline to decide about.
 * Duplicate/empty headers become positional column ids; a longer record grows
 * the schema (never silently truncating fields) and any width mismatch is
 * reported as a field-count warning.
 *
 * Papa's chunk emitter produces a phantom trailing empty record for files
 * ending in a newline (it does not in non-chunk mode). A trailing empty
 * record is therefore held back and dropped at completion when the file ends
 * with a line break, while genuine blank lines mid-file are preserved.
 */
import Papa from 'papaparse';
import { ROW_WRITE_BATCH_SIZE } from '../dataset/constants';
import { csvColumnId, deriveColumnsFromHeader } from '../dataset/columns';
import type { ColumnDefinition, ImportWarningSummary } from '../dataset/types';
import type { ImportWireRow } from './protocol';
import type { WarningReporter } from './warnings';

export type ImportBatch = {
  rows: ImportWireRow[];
  /** Columns discovered since the previous emitted batch. */
  schemaAppend?: ColumnDefinition[];
};

export type CsvSessionCallbacks = {
  /** Persist the batch; resolve only once the rows are durably stored. */
  onBatch: (batch: ImportBatch) => Promise<void>;
  onProgress?: (rowsParsed: number, bytesProcessed: number) => void;
};

export type CsvImportOptions = {
  hasHeader: boolean;
  /** Explicit delimiter; omit for auto-detection (CSV default). */
  delimiter?: string;
};

export type CsvSessionResult = {
  status: 'done' | 'cancelled';
  rowCount: number;
  columns: ColumnDefinition[];
  parseErrorCount: number;
  warnings: ImportWarningSummary[];
};

const CHUNK_SIZE_BYTES = 1024 * 1024;

function isEmptyRecord(fields: string[]): boolean {
  return fields.length === 1 && fields[0] === '';
}

async function fileEndsWithLineBreak(file: File): Promise<boolean> {
  if (file.size === 0) return false;
  const tail = new Uint8Array(await file.slice(file.size - 1).arrayBuffer());
  return tail[0] === 0x0a || tail[0] === 0x0d;
}

export function runCsvImport(
  file: File,
  options: CsvImportOptions,
  callbacks: CsvSessionCallbacks,
  warnings: WarningReporter,
): { done: Promise<CsvSessionResult>; abort: () => void } {
  let columns: ColumnDefinition[] = [];
  let schemaAppendSinceBatch: ColumnDefinition[] = [];
  let sawFirstRecord = false;
  let rowIndex = 0;
  let pending: ImportWireRow[] = [];
  /** A trailing empty record held back until provenance (real vs phantom) is known. */
  let heldEmpty: ImportWireRow | null = null;
  let pumping = false;
  let ended = false;
  let settled = false;
  let cancelled = false;
  let encodingWarned = false;
  let parserHandle: Papa.Parser | null = null;

  let settle!: (result: CsvSessionResult) => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<CsvSessionResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const result = (status: 'done' | 'cancelled'): CsvSessionResult => ({
    status,
    rowCount: rowIndex,
    columns,
    parseErrorCount: status === 'cancelled' ? 0 : warnings.total,
    warnings: status === 'cancelled' ? [] : warnings.summaries(),
  });

  const settleOnce = (status: 'done' | 'cancelled'): void => {
    if (settled) return;
    settled = true;
    settle(result(status));
  };

  function ensureColumnCount(count: number): void {
    while (columns.length < count) {
      const index = columns.length;
      const column: ColumnDefinition = {
        id: csvColumnId(index),
        label: `Column ${index + 1}`,
        sourceIndex: index,
      };
      columns.push(column);
      schemaAppendSinceBatch.push(column);
    }
  }

  function buildWireRecord(fields: string[]): ImportWireRow {
    // Blank records are "empty records" by definition and never count as a
    // width mismatch — mid-file blanks are data, the trailing phantom is
    // dropped at completion, and neither is a field-count problem.
    if (fields.length !== columns.length && !isEmptyRecord(fields)) {
      ensureColumnCount(fields.length);
      warnings.add('field-count-mismatch', rowIndex + (options.hasHeader ? 2 : 1));
    }
    const values: Record<string, string | null> = {};
    for (let i = 0; i < fields.length; i++) {
      const column = columns[i];
      if (column) values[column.id] = fields[i] ?? null;
    }
    if (!encodingWarned && fields.some((value) => value.includes('\uFFFD'))) {
      encodingWarned = true;
      warnings.add('encoding-suspect', rowIndex + (options.hasHeader ? 2 : 1));
    }
    return { rowIndex: rowIndex++, values };
  }

  function ingestRecord(fields: string[]): void {
    if (!sawFirstRecord) {
      sawFirstRecord = true;
      if (options.hasHeader) {
        columns = deriveColumnsFromHeader(fields, { hasHeader: true });
        schemaAppendSinceBatch = [...columns];
        return;
      }
    }
    if (isEmptyRecord(fields)) {
      if (heldEmpty) pending.push(heldEmpty);
      heldEmpty = buildWireRecord(fields);
      return;
    }
    if (heldEmpty) {
      pending.push(heldEmpty);
      heldEmpty = null;
    }
    pending.push(buildWireRecord(fields));
  }

  function maybePump(): void {
    if (settled || pumping) return;
    if (!cancelled && pending.length >= ROW_WRITE_BATCH_SIZE) {
      pumping = true;
      const rows = pending.splice(0, ROW_WRITE_BATCH_SIZE);
      const schemaAppend = schemaAppendSinceBatch;
      schemaAppendSinceBatch = [];
      Promise.resolve(callbacks.onBatch({ rows, schemaAppend })).then(() => {
        pumping = false;
        maybePump();
      }, fail);
      return;
    }
    if (ended) {
      if (pending.length > 0 && !cancelled) {
        pumping = true;
        const rows = pending.splice(0, pending.length);
        const schemaAppend = schemaAppendSinceBatch;
        schemaAppendSinceBatch = [];
        Promise.resolve(callbacks.onBatch({ rows, schemaAppend })).then(
          () => settleOnce('done'),
          fail,
        );
      } else {
        settleOnce(cancelled ? 'cancelled' : 'done');
      }
      return;
    }
    parserHandle?.resume();
  }

  Papa.parse<string[]>(file, {
    delimiter: options.delimiter,
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
    chunkSize: CHUNK_SIZE_BYTES,
    chunk: (chunkResults, parser) => {
      parserHandle = parser;
      parser.pause();
      if (cancelled) {
        parser.abort();
        return;
      }
      for (const error of chunkResults.errors) {
        // Papa row indices are 0-based data rows; +1 makes them 1-based
        // physical-ish lines (exact when no embedded newlines precede them).
        warnings.add('malformed-row', (error.row ?? 0) + 1);
      }
      for (const fields of chunkResults.data) {
        ingestRecord(fields);
      }
      callbacks.onProgress?.(rowIndex, chunkResults.meta.cursor);
      maybePump();
    },
    complete: () => {
      void (async () => {
        // Resolve the held trailing empty record: real final blank line
        // (file does not end with a line break) vs Papa's chunk-mode phantom.
        if (heldEmpty) {
          if (await fileEndsWithLineBreak(file)) {
            heldEmpty = null;
            rowIndex--; // the held record never entered any batch
          } else {
            pending.push(heldEmpty);
            heldEmpty = null;
          }
        }
        ended = true;
        maybePump();
      })().catch(fail);
    },
    error: fail,
  });

  return {
    done,
    abort: () => {
      if (settled) return;
      cancelled = true;
      ended = true;
      heldEmpty = null;
      parserHandle?.abort();
      if (!pumping) maybePump();
    },
  };
}
