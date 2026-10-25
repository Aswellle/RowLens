// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AppError } from '../../app/app-error';
import type { DatasetMetadata } from '../dataset/types';
import type { StoredRow } from '../dataset/types';
import { ImportCoordinator, type WorkerTransport } from './coordinator';
import type { ImportBatch } from './csv-session';
import type { ImportStartOptions, ImportWorkerToMain, MainToImportWorker } from './protocol';

/** Worker stand-in: records posted messages, lets tests inject replies. */
class ScriptedTransport implements WorkerTransport {
  readonly posted: MainToImportWorker[] = [];
  private handler: ((message: ImportWorkerToMain) => void) | null = null;
  terminated = 0;

  post(message: MainToImportWorker): void {
    this.posted.push(message);
  }

  set onMessage(handler: ((message: ImportWorkerToMain) => void) | null) {
    this.handler = handler;
  }

  emit(message: ImportWorkerToMain): void {
    this.handler?.(message);
  }

  terminate(): void {
    this.terminated += 1;
  }

  acks(): number {
    return this.posted.filter((m) => m.type === 'ACK').length;
  }

  cancels(): number {
    return this.posted.filter((m) => m.type === 'CANCEL').length;
  }
}

type RepoCalls = {
  inserted: DatasetMetadata[];
  rowBatches: Array<{ datasetId: string; rows: StoredRow[] }>;
  finalized: DatasetMetadata[];
  deleted: string[];
};

function makeRepository(
  overrides: Partial<{
    putRows: (datasetId: string, rows: StoredRow[]) => Promise<void>;
  }> = {},
) {
  const calls: RepoCalls = { inserted: [], rowBatches: [], finalized: [], deleted: [] };
  const repository = {
    insertDataset: async (meta: DatasetMetadata) => {
      calls.inserted.push(meta);
    },
    putRows:
      overrides.putRows ??
      (async (datasetId: string, rows: StoredRow[]) => {
        calls.rowBatches.push({ datasetId, rows });
      }),
    finalizeDataset: async (meta: DatasetMetadata) => {
      calls.finalized.push(meta);
    },
    deleteDataset: async (id: string) => {
      calls.deleted.push(id);
    },
    putImportErrors: async () => {},
  };
  return { repository, calls };
}

const OPTIONS: ImportStartOptions = { format: 'csv', hasHeader: true };

function wireRow(
  rowIndex: number,
  a: string,
): { rowIndex: number; values: Record<string, string | null> } {
  return { rowIndex, values: { c0: a } };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ImportCoordinator', () => {
  it('persists batches, ACKs them and finalises a ready dataset', async () => {
    const { repository, calls } = makeRepository();
    const transport = new ScriptedTransport();
    const batches: ImportBatch[] = [];
    const progress: number[] = [];
    const coordinator = new ImportCoordinator({
      repository,
      createTransport: () => transport,
      generateId: () => 'job-1',
      onBatch: (batch) => batches.push(batch),
      onProgress: (p) => progress.push(p.rowsParsed),
    });

    const file = new File(['a\n1\n'], 'x.csv');
    const active = await coordinator.start(file, OPTIONS);
    expect(coordinator.hasActiveJob).toBe(true);
    expect(transport.posted[0]?.type).toBe('IMPORT_START');

    transport.emit({
      type: 'BATCH',
      jobId: 'job-1',
      batchSeq: 0,
      rows: [wireRow(0, 'v1')],
      schemaAppend: [{ id: 'c0', label: 'a', sourceIndex: 0 }],
    });
    await flush();
    expect(calls.rowBatches).toHaveLength(1);
    expect(transport.acks()).toBe(1);
    expect(batches[0]?.rows).toHaveLength(1);

    transport.emit({ type: 'PROGRESS', jobId: 'job-1', rowsParsed: 1 });
    await flush();
    expect(progress).toEqual([1]);

    transport.emit({
      type: 'IMPORT_DONE',
      jobId: 'job-1',
      rowCount: 1,
      columns: [{ id: 'c0', label: 'a', sourceIndex: 0 }],
      parseErrorCount: 0,
      warnings: [],
    });
    const outcome = await active.outcome;
    expect(outcome).toEqual({
      kind: 'ready',
      metadata: expect.objectContaining({ status: 'ready', rowCount: 1 }),
    });
    expect(calls.finalized[0]?.status).toBe('ready');
    expect(calls.deleted).toEqual([]);
    expect(transport.terminated).toBe(1);
    expect(coordinator.hasActiveJob).toBe(false);
  });

  it('ignores messages with a stale jobId or after a terminal message', async () => {
    const { repository, calls } = makeRepository();
    const transport = new ScriptedTransport();
    const coordinator = new ImportCoordinator({
      repository,
      createTransport: () => transport,
      generateId: () => 'job-1',
    });

    const active = await coordinator.start(new File(['a\n'], 'x.csv'), OPTIONS);
    transport.emit({
      type: 'IMPORT_DONE',
      jobId: 'job-1',
      rowCount: 0,
      columns: [],
      parseErrorCount: 0,
      warnings: [],
    });
    await active.outcome;

    // Late batch from the finished job must be ignored entirely.
    transport.emit({ type: 'BATCH', jobId: 'job-1', batchSeq: 9, rows: [wireRow(0, 'late')] });
    await flush();
    expect(calls.rowBatches).toHaveLength(0);

    // And a message for some other job id never touches this coordinator.
    transport.emit({ type: 'BATCH', jobId: 'job-other', batchSeq: 0, rows: [] });
    await flush();
    expect(calls.rowBatches).toHaveLength(0);
    expect(transport.acks()).toBe(0);
  });

  it('stops the worker, cleans up and reports quota failures', async () => {
    const { repository, calls } = makeRepository({
      putRows: async () => {
        throw new AppError('STORAGE_QUOTA_EXCEEDED', 'browser quota exceeded');
      },
    });
    const transport = new ScriptedTransport();
    const coordinator = new ImportCoordinator({
      repository,
      createTransport: () => transport,
      generateId: () => 'job-q',
    });

    const active = await coordinator.start(new File(['a\n'], 'x.csv'), OPTIONS);
    transport.emit({ type: 'BATCH', jobId: 'job-q', batchSeq: 0, rows: [wireRow(0, 'x')] });
    const outcome = await active.outcome;

    expect(outcome).toEqual({
      kind: 'failed',
      error: expect.objectContaining({ code: 'STORAGE_QUOTA_EXCEEDED' }),
    });
    expect(transport.cancels()).toBe(1); // worker told to stop parsing
    expect(calls.deleted).toEqual(['job-q']); // partial data removed
    // No ACK: the failed batch is never acknowledged.
    expect(transport.acks()).toBe(0);
  });

  it('cancel is idempotent and a worker cancellation clears the dataset', async () => {
    const { repository, calls } = makeRepository();
    const transport = new ScriptedTransport();
    const coordinator = new ImportCoordinator({
      repository,
      createTransport: () => transport,
      generateId: () => 'job-c',
    });

    const active = await coordinator.start(new File(['a\n'], 'x.csv'), OPTIONS);
    active.cancel();
    active.cancel(); // second call is a no-op
    expect(transport.cancels()).toBe(1);

    transport.emit({ type: 'IMPORT_CANCELLED', jobId: 'job-c' });
    const outcome = await active.outcome;
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(calls.deleted).toEqual(['job-c']);
    expect(coordinator.hasActiveJob).toBe(false);
  });

  it('maps worker ERROR failures onto AppError and cleans up', async () => {
    const { repository, calls } = makeRepository();
    const transport = new ScriptedTransport();
    const coordinator = new ImportCoordinator({
      repository,
      createTransport: () => transport,
      generateId: () => 'job-e',
    });

    const active = await coordinator.start(new File(['a\n'], 'x.csv'), OPTIONS);
    transport.emit({
      type: 'ERROR',
      jobId: 'job-e',
      failure: { code: 'PARSE_FAILED', detail: 'unrecoverable parse error', physicalLine: 12 },
    });
    const outcome = await active.outcome;
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('PARSE_FAILED');
      expect(outcome.error.physicalLine).toBe(12);
    }
    expect(calls.deleted).toEqual(['job-e']);
  });

  it('refuses to start a second import while one is active', async () => {
    const { repository } = makeRepository();
    const coordinator = new ImportCoordinator({
      repository,
      createTransport: () => new ScriptedTransport(),
      generateId: () => 'job-x',
    });
    await coordinator.start(new File(['a\n'], 'x.csv'), OPTIONS);
    await expect(coordinator.start(new File(['b\n'], 'y.csv'), OPTIONS)).rejects.toThrow(
      /already running/,
    );
  });
});
