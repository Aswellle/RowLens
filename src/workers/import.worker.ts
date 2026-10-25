/**
 * Import worker: runs the CSV/TSV or JSONL session off the main thread and
 * speaks the message protocol. Batches are posted one at a time and parsing
 * waits for the main thread's ACK (backpressure, ADR-012). Cancellation is
 * delegated to the session's abort and acknowledged with IMPORT_CANCELLED.
 * Error details stay generic — raw file content never leaves this worker.
 */
import { runCsvImport, type CsvSessionResult } from '../features/import/csv-session';
import {
  fileByteSource,
  runJsonlImport,
  type JsonlSessionResult,
} from '../features/import/jsonl-session';
import type { ImportStartOptions, MainToImportWorker } from '../features/import/protocol';
import { WarningAggregator } from '../features/import/warnings';

type SessionResult = CsvSessionResult | JsonlSessionResult;

type ActiveJob = {
  jobId: string;
  abort: () => void;
};

let active: ActiveJob | null = null;
let ackWaiter: (() => void) | null = null;

const post = (message: unknown): void => {
  (self as unknown as { postMessage(message: unknown): void }).postMessage(message);
};

const waitForAck = (): Promise<void> =>
  new Promise((resolve) => {
    ackWaiter = resolve;
  });

async function runJob(jobId: string, options: ImportStartOptions, file: File): Promise<void> {
  const warnings = new WarningAggregator();
  let batchSeq = 0;

  const onBatch = async (batch: {
    rows: { rowIndex: number; values: Record<string, string | null> }[];
    schemaAppend?: unknown;
  }): Promise<void> => {
    const message = {
      type: 'BATCH' as const,
      jobId,
      batchSeq: batchSeq++,
      rows: batch.rows,
    };
    if (batch.schemaAppend)
      (message as { schemaAppend?: unknown }).schemaAppend = batch.schemaAppend;
    post(message);
    await waitForAck();
  };

  try {
    let result: SessionResult;
    if (options.format === 'csv' || options.format === 'tsv') {
      const delimiter = options.delimiter ?? (options.format === 'tsv' ? '\t' : undefined);
      const csvOptions: { hasHeader: boolean; delimiter?: string } = {
        hasHeader: options.hasHeader,
      };
      if (delimiter !== undefined) csvOptions.delimiter = delimiter;
      const session = runCsvImport(
        file,
        csvOptions,
        {
          onBatch,
          onProgress: (rowsParsed, bytesProcessed) =>
            post({ type: 'PROGRESS', jobId, rowsParsed, bytesProcessed }),
        },
        warnings,
      );
      active = { jobId, abort: session.abort };
      result = await session.done;
    } else {
      const session = runJsonlImport(
        fileByteSource(file),
        {
          onBatch,
          onProgress: (rowsParsed, bytesProcessed) =>
            post({ type: 'PROGRESS', jobId, rowsParsed, bytesProcessed }),
        },
        warnings,
      );
      active = { jobId, abort: session.abort };
      result = await session.done;
    }

    if (result.status === 'cancelled') {
      post({ type: 'IMPORT_CANCELLED', jobId });
      return;
    }
    post({
      type: 'IMPORT_DONE',
      jobId,
      rowCount: result.rowCount,
      columns: result.columns,
      parseErrorCount: result.parseErrorCount,
      warnings: result.warnings,
    });
  } catch {
    // Keep the detail generic: parser messages can echo file content.
    post({
      type: 'ERROR',
      jobId,
      failure: { code: 'PARSE_FAILED', detail: 'The file could not be parsed.' },
    });
  } finally {
    if (active?.jobId === jobId) active = null;
  }
}

self.onmessage = (event: MessageEvent<MainToImportWorker>): void => {
  const message = event.data;
  switch (message.type) {
    case 'IMPORT_START': {
      if (active !== null) return; // one job per worker instance
      void runJob(message.jobId, message.options, message.file);
      break;
    }
    case 'ACK': {
      if (message.jobId === active?.jobId) {
        ackWaiter?.();
        ackWaiter = null;
      }
      break;
    }
    case 'CANCEL': {
      if (message.jobId === active?.jobId) {
        active.abort();
      }
      break;
    }
  }
};
