/**
 * Streaming JSONL/NDJSON import session (data contract §3).
 *
 * Reads an async byte source in chunks through a streaming TextDecoder, so a
 * UTF-8 multi-byte character split across chunk boundaries reassembles
 * correctly and memory holds only the current unfinished line. Lines are
 * parsed independently: an invalid line is recorded as an error and parsing
 * continues. A line exceeding the byte cap is dropped with an error and
 * scanning resumes at the next newline rather than filling memory. The column
 * schema grows in first-seen key order; nested values display as stable JSON
 * text and JSON null displays as the string "null" while missing keys stay
 * missing. Batches await persistence before more bytes are read
 * (backpressure at the source).
 */
import { MAX_JSONL_LINE_BYTES, ROW_WRITE_BATCH_SIZE } from '../dataset/constants';
import type { ColumnDefinition, ImportWarningSummary } from '../dataset/types';
import type { ImportBatch } from './csv-session';
import type { ImportWireRow } from './protocol';
import type { WarningReporter } from './warnings';

export type JsonlSessionCallbacks = {
  onBatch: (batch: ImportBatch) => Promise<void>;
  onProgress?: (rowsParsed: number, bytesProcessed: number) => void;
};

export type JsonlSessionResult = {
  status: 'done' | 'cancelled';
  rowCount: number;
  columns: ColumnDefinition[];
  parseErrorCount: number;
  warnings: ImportWarningSummary[];
};

/** Async byte source; the browser File stream and tests both fit this. */
export type ByteSource = AsyncIterable<Uint8Array>;

export function fileByteSource(file: File): ByteSource {
  const stream = file.stream();
  return {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
  };
}

export function jsonlColumnId(index: number): string {
  return `k${index}`;
}

/** Convert one parsed JSON value into its display string (never throws). */
export function valueToDisplay(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sourceFromChunks(chunks: Uint8Array[]): ByteSource {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

export function runJsonlImport(
  source: ByteSource,
  callbacks: JsonlSessionCallbacks,
  warnings: WarningReporter,
): { done: Promise<JsonlSessionResult>; abort: () => void } {
  let cancelled = false;

  const done = (async (): Promise<JsonlSessionResult> => {
    const decoder = new TextDecoder('utf-8');
    const columnIdByKey = new Map<string, string>();
    const columns: ColumnDefinition[] = [];
    const pending: ImportWireRow[] = [];
    let schemaAppendBase = 0;
    let rowIndex = 0;
    let lineNo = 0; // 1-based physical line number of the last completed line
    let buffer = '';
    let bytesProcessed = 0;
    let currentLineBytes = 0; // raw bytes accumulated for the unfinished line
    let sawFirstContent = false;
    let skipUntilNewline = false;
    let encodingWarned = false;

    const ensureColumn = (key: string): string => {
      const existing = columnIdByKey.get(key);
      if (existing !== undefined) return existing;
      const id = jsonlColumnId(columns.length);
      columnIdByKey.set(key, id);
      columns.push({ id, label: key, sourceKey: key });
      return id;
    };

    const flushBatch = async (): Promise<void> => {
      if (pending.length === 0) return;
      const rows = pending.splice(0, ROW_WRITE_BATCH_SIZE);
      const schemaAppend = columns.slice(schemaAppendBase);
      schemaAppendBase = columns.length;
      await callbacks.onBatch({ rows, schemaAppend });
    };

    const handleLine = (rawLine: string): void => {
      lineNo++;
      if (rawLine.trim() === '') {
        warnings.add('blank-line-skipped', lineNo);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        warnings.add('invalid-json-line', lineNo);
        return;
      }
      if (!isPlainObject(parsed)) {
        // Top-level arrays, primitives and null are format errors, not records.
        warnings.add('invalid-json-line', lineNo);
        return;
      }
      const values: Record<string, string | null> = {};
      for (const key of Object.keys(parsed)) {
        values[ensureColumn(key)] = valueToDisplay(parsed[key]);
      }
      if (!encodingWarned && rawLine.includes('\uFFFD')) {
        encodingWarned = true;
        warnings.add('encoding-suspect', lineNo);
      }
      pending.push({ rowIndex: rowIndex++, values });
    };

    /**
     * Resync after an oversized line: discard through its newline and keep
     * whatever follows in the same chunk. Does not warn — callers decide
     * whether the drop is being reported for the first time.
     */
    const resyncAfterOverlong = (): void => {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        buffer = '';
        currentLineBytes = 0;
        skipUntilNewline = true;
        return;
      }
      lineNo++;
      buffer = buffer.slice(newlineIndex + 1);
      currentLineBytes = buffer.length;
      skipUntilNewline = false;
    };

    readLoop: for await (const chunk of source) {
      if (cancelled) break;
      bytesProcessed += chunk.byteLength;
      currentLineBytes += chunk.byteLength;
      let text = decoder.decode(chunk, { stream: true });

      if (!sawFirstContent) {
        sawFirstContent = true;
        if (text.startsWith('\uFEFF')) text = text.slice(1);
      }
      buffer += text;

      if (skipUntilNewline) {
        // Warning was already recorded when the oversized drop began.
        resyncAfterOverlong();
        if (buffer === '') continue;
      } else if (currentLineBytes > MAX_JSONL_LINE_BYTES) {
        // Crossed the byte cap while the line was still unfinished.
        warnings.add('line-too-long', lineNo + 1);
        resyncAfterOverlong();
        if (buffer === '') continue;
      }

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        if (cancelled) break readLoop;
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        currentLineBytes = buffer.length;
        // UTF-16 length is a lower bound on the line's byte size: a completed
        // line over the cap is dropped even when it arrived within one chunk.
        if (line.length > MAX_JSONL_LINE_BYTES) {
          lineNo++;
          warnings.add('line-too-long', lineNo);
          continue;
        }
        handleLine(line);
        if (pending.length >= ROW_WRITE_BATCH_SIZE) {
          await flushBatch(); // backpressure: stop reading until persisted
          callbacks.onProgress?.(rowIndex, bytesProcessed);
        }
      }

      if (!skipUntilNewline && currentLineBytes > MAX_JSONL_LINE_BYTES) {
        // Chunk ended mid-line over the cap: report once, then resync —
        // anything already after the terminating newline is kept.
        warnings.add('line-too-long', lineNo + 1);
        resyncAfterOverlong();
      }
      callbacks.onProgress?.(rowIndex, bytesProcessed);
    }

    // Flush the decoder: reassembles a pending multi-byte sequence, if any.
    const tail = cancelled ? '' : decoder.decode();
    if (!cancelled) {
      buffer += tail;
      if (buffer !== '') {
        let line = buffer;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (skipUntilNewline || line.length > MAX_JSONL_LINE_BYTES) {
          if (!skipUntilNewline) warnings.add('line-too-long', lineNo + 1);
        } else {
          handleLine(line); // last record may lack a trailing newline
        }
      }
    }

    if (!cancelled && pending.length > 0) {
      await flushBatch();
    }

    return {
      status: cancelled ? 'cancelled' : 'done',
      rowCount: rowIndex,
      columns,
      parseErrorCount: cancelled ? 0 : warnings.total,
      warnings: cancelled ? [] : warnings.summaries(),
    };
  })();

  return {
    done,
    abort: () => {
      cancelled = true;
    },
  };
}

export { sourceFromChunks };
