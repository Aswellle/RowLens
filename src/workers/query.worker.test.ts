import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatasetMetadata, StoredRow } from '../features/dataset/types';
import { DatasetRepository } from '../features/dataset/repository';
import type { QueryRequestSpec } from '../features/query/protocol';

/**
 * Worker behavior tests. The module registers its message handler on `self`,
 * so the test host plays the worker global: stub `postMessage` to capture the
 * outgoing messages and call `self.onmessage` directly. A fresh module import
 * per test resets the single-slot state.
 *
 * The race under test: the client supersedes by sending CANCEL immediately
 * followed by the new QUERY_START. CANCEL only flags the running engine, which
 * stops at its next batch boundary — so the START used to arrive while the old
 * query still owned the single slot and was silently dropped, leaving the
 * client's promise unsettled forever (the regression these tests pin).
 */

type PostedMessage = { type: string; queryId?: string };
const posted: PostedMessage[] = [];

function postOf(type: string, queryId: string): PostedMessage | undefined {
  return posted.find((message) => message.type === type && message.queryId === queryId);
}

async function waitDone(queryId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(postOf('QUERY_DONE', queryId)).toBeDefined();
  }, { timeout: 10_000 });
}

function makeMeta(rowCount: number): DatasetMetadata {
  return {
    id: 'ds-worker',
    format: 'csv',
    fileName: 'worker-test.csv',
    byteSize: 10,
    status: 'ready',
    createdAt: 1,
    lastTouchedAt: 1,
    rowCount,
    columns: [
      { id: 'c0', label: 'a', sourceIndex: 0 },
      { id: 'c1', label: 'b', sourceIndex: 1 },
    ],
    parseErrorCount: 0,
    importWarnings: [],
    schemaVersion: 1,
  };
}

function rowOf(rowIndex: number): StoredRow {
  return {
    datasetId: 'ds-worker',
    rowIndex,
    values: { c0: rowIndex % 2 === 0 ? 'even' : 'odd', c1: String(rowIndex) },
  };
}

function spec(queryIdIgnore: string, filters: Record<string, string> = {}): QueryRequestSpec {
  return {
    datasetId: 'ds-worker',
    columns: ['c0', 'c1'],
    searchTerms: [],
    columnFilters: filters,
  };
}

function send(message: unknown): void {
  (globalThis as { onmessage?: (event: { data: unknown }) => void }).onmessage?.({ data: message });
}

async function seed(rowCount: number): Promise<void> {
  const repository = await DatasetRepository.open();
  await repository.insertDataset(makeMeta(rowCount));
  const rows = Array.from({ length: rowCount }, (_, index) => rowOf(index));
  await repository.putRows('ds-worker', rows);
  await repository.finalizeDataset({ ...makeMeta(rowCount), lastTouchedAt: Date.now() });
}

describe('query worker message gate', () => {
  beforeEach(async () => {
    vi.resetModules();
    posted.length = 0;
    (globalThis as { self?: unknown }).self = globalThis;
    (globalThis as { postMessage?: unknown }).postMessage = (message: unknown) => {
      posted.push(message as PostedMessage);
    };
    await seed(20);
    await import('./query.worker');
  });

  afterEach(() => {
    send({ type: 'CANCEL', queryId: 'any' });
  });

  it('runs a query that owns the slot and reports its result', async () => {
    send({ type: 'QUERY_START', queryId: 'q-solo', spec: spec('q-solo', { c0: 'even' }) });
    await waitDone('q-solo');
    expect(postOf('QUERY_DONE', 'q-solo')?.matched as number | undefined).toBe(10);
  });

  it('queues a start that arrives while the previous scan unwinds', async () => {
    // Back-to-back, in one synchronous block: exactly the shape the client's
    // supersede path produces.
    send({ type: 'QUERY_START', queryId: 'q-old', spec: spec('q-old', { c0: 'even' }) });
    send({ type: 'CANCEL', queryId: 'q-old' });
    send({ type: 'QUERY_START', queryId: 'q-new', spec: spec('q-new', { c0: 'odd' }) });

    // The new query must run, not be dropped: its result settles.
    await waitDone('q-new');
    expect(postOf('QUERY_DONE', 'q-new')?.matched as number | undefined).toBe(10);
    // The old run reports cancellation instead of a result.
    expect(postOf('QUERY_CANCELLED', 'q-old')).toBeDefined();
    expect(postOf('QUERY_DONE', 'q-old')).toBeUndefined();
  });

  it('keeps only the newest queued query when starts pile up', async () => {
    send({ type: 'QUERY_START', queryId: 'q-1', spec: spec('q-1', { c0: 'even' }) });
    send({ type: 'QUERY_START', queryId: 'q-2', spec: spec('q-2', { c0: 'odd' }) });
    send({ type: 'QUERY_START', queryId: 'q-3', spec: spec('q-3', { c0: 'even' }) });

    await waitDone('q-1');
    await waitDone('q-3');
    expect(postOf('QUERY_DONE', 'q-2')).toBeUndefined();
  });

  it('drops a queued query the client cancels before it starts', async () => {
    send({ type: 'QUERY_START', queryId: 'q-a', spec: spec('q-a', { c0: 'even' }) });
    send({ type: 'QUERY_START', queryId: 'q-b', spec: spec('q-b', { c0: 'odd' }) });
    send({ type: 'CANCEL', queryId: 'q-b' });

    await waitDone('q-a');
    expect(postOf('QUERY_DONE', 'q-b')).toBeUndefined();
    expect(postOf('QUERY_CANCELLED', 'q-b')).toBeUndefined();
  });
});
