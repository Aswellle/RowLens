import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

// Node (non-DOM) vitest environments have no global IDBKeyRange.
if (typeof globalThis.IDBKeyRange === 'undefined') {
  globalThis.IDBKeyRange = IDBKeyRange;
}
import { beforeEach, describe, expect, it } from 'vitest';
import { DatasetRepository } from '../dataset/repository';
import type { DatasetMetadata } from '../dataset/types';
import { QueryClient, runLocalQuery, type QueryTransport } from './client';
import { scanDatasetRows } from './scan';
import type { MainToQueryWorker, QueryRequestSpec, QueryWorkerToMain } from './protocol';

class ScriptedQueryTransport implements QueryTransport {
  readonly posted: MainToQueryWorker[] = [];
  private handler: ((message: QueryWorkerToMain) => void) | null = null;
  terminated = 0;

  post(message: MainToQueryWorker): void {
    this.posted.push(message);
  }

  get onMessage(): ((message: QueryWorkerToMain) => void) | null {
    return this.handler;
  }

  set onMessage(next: ((message: QueryWorkerToMain) => void) | null) {
    this.handler = next;
  }

  emit(message: QueryWorkerToMain): void {
    this.handler?.(message);
  }

  terminate(): void {
    this.terminated += 1;
  }

  cancels(): number {
    return this.posted.filter((m) => m.type === 'CANCEL').length;
  }
}

function makeClient(): { client: QueryClient; transport: ScriptedQueryTransport } {
  const transport = new ScriptedQueryTransport();
  const client = new QueryClient({
    createTransport: () => transport,
    generateId: (() => {
      let n = 0;
      return () => `q-${n++}`;
    })(),
  });
  return { client, transport };
}

const SPEC: QueryRequestSpec = {
  datasetId: 'ds',
  columns: ['c0'],
  search: '',
  columnFilters: {},
};

describe('QueryClient (scripted worker transport)', () => {
  it('delivers done results for the current query', async () => {
    const { client, transport } = makeClient();
    const run = client.run(SPEC);
    expect(transport.posted[0]?.type).toBe('QUERY_START');

    transport.emit({
      type: 'QUERY_DONE',
      queryId: 'q-0',
      rowIndices: [2, 0],
      matched: 2,
      totalRows: 3,
    });
    await expect(run.done).resolves.toEqual({
      kind: 'done',
      rowIndices: [2, 0],
      matched: 2,
      totalRows: 3,
    });
  });

  it('ignores results carrying a stale queryId', async () => {
    const { client, transport } = makeClient();
    const first = client.run(SPEC);
    const second = client.run(SPEC); // supersedes the first

    // A late reply for the superseded query must not resolve anything.
    transport.emit({
      type: 'QUERY_DONE',
      queryId: 'q-0',
      rowIndices: [1],
      matched: 1,
      totalRows: 1,
    });
    await expect(first.done).resolves.toEqual({ kind: 'superseded' });
    expect(transport.cancels()).toBe(1); // supersede posted CANCEL for q-0

    transport.emit({
      type: 'QUERY_DONE',
      queryId: 'q-1',
      rowIndices: [0],
      matched: 1,
      totalRows: 1,
    });
    await expect(second.done).resolves.toMatchObject({ kind: 'done', matched: 1 });
  });

  it('resolves cancelled runs when the worker confirms', async () => {
    const { client, transport } = makeClient();
    const run = client.run(SPEC);
    run.cancel();
    expect(transport.cancels()).toBe(1);
    run.cancel(); // idempotent at the transport level
    expect(transport.cancels()).toBe(2); // second post is harmless

    transport.emit({ type: 'QUERY_CANCELLED', queryId: 'q-0' });
    await expect(run.done).resolves.toEqual({ kind: 'cancelled' });
  });

  it('maps limit and error results', async () => {
    const { client, transport } = makeClient();
    const run = client.run(SPEC);
    transport.emit({ type: 'QUERY_LIMIT', queryId: 'q-0', matched: 200_001, limit: 200_000 });
    await expect(run.done).resolves.toEqual({ kind: 'limit', matched: 200_001, limit: 200_000 });

    const failing = client.run(SPEC);
    transport.emit({
      type: 'ERROR',
      queryId: 'q-1',
      failure: { code: 'DATASET_NOT_FOUND', detail: 'gone' },
    });
    const outcome = await failing.done;
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('DATASET_NOT_FOUND');
  });
});

describe('Local query fallback and dataset scan (fake IndexedDB)', () => {
  let repository: DatasetRepository;

  const META: DatasetMetadata = {
    id: 'ds',
    format: 'csv',
    fileName: 'x.csv',
    byteSize: 10,
    status: 'ready',
    createdAt: 1,
    lastTouchedAt: 1,
    rowCount: 3,
    columns: [
      { id: 'c0', label: 'city', sourceIndex: 0 },
      { id: 'c1', label: 'temp', sourceIndex: 1 },
    ],
    parseErrorCount: 0,
    importWarnings: [],
    schemaVersion: 1,
  };

  beforeEach(async () => {
    repository = await DatasetRepository.open(new IDBFactory());
    await repository.insertDataset(META);
    await repository.putRows('ds', [
      { datasetId: 'ds', rowIndex: 0, values: { c0: 'Berlin', c1: '12' } },
      { datasetId: 'ds', rowIndex: 1, values: { c0: 'Cairo', c1: '34' } },
      { datasetId: 'ds', rowIndex: 2, values: { c0: 'Berlin', c1: '21' } },
    ]);
  });

  it('scans stored rows in index order in bounded windows', async () => {
    const batches: string[][] = [];
    for await (const batch of scanDatasetRows(repository, 'ds', 2)) {
      batches.push(batch.map((row) => row.values.c0 ?? ''));
    }
    expect(batches).toEqual([['Berlin', 'Cairo'], ['Berlin']]);
  });

  it('runs the full engine over stored data: filter + sort', async () => {
    const outcome = await runLocalQuery(
      {
        datasetId: 'ds',
        columns: ['c0', 'c1'],
        search: '',
        columnFilters: { c0: 'berlin' },
        sort: { columnIndex: 1, direction: 'desc' },
      },
      repository,
    );
    expect(outcome).toEqual({
      kind: 'done',
      rowIndices: [2, 0],
      matched: 2,
      totalRows: 3,
    });
  });

  it('fails with DATASET_NOT_FOUND for missing datasets', async () => {
    const outcome = await runLocalQuery(
      { datasetId: 'nope', columns: ['c0'], search: '', columnFilters: {} },
      repository,
    );
    expect(outcome.kind === 'failed' && outcome.error.code).toBe('DATASET_NOT_FOUND');
  });

  it('applies serializable cleaning steps in the same pass', async () => {
    await repository.putRows('ds', [
      { datasetId: 'ds', rowIndex: 3, values: { c0: 'Berlin', c1: '12' } },
      { datasetId: 'ds', rowIndex: 4, values: { c0: ' Cairo ', c1: '34' } },
      { datasetId: 'ds', rowIndex: 5, values: { c0: 'Cairo', c1: '34' } },
      { datasetId: 'ds', rowIndex: 6, values: { c0: '   ', c1: '  ' } },
    ]);
    const outcome = await runLocalQuery(
      {
        datasetId: 'ds',
        columns: ['c0', 'c1'],
        search: '',
        columnFilters: {},
        cleaning: [
          { id: 't', type: 'trim', enabled: true, scope: { kind: 'all-columns' } },
          {
            id: 'd',
            type: 'remove-duplicates',
            enabled: true,
            keys: { kind: 'all-columns' },
            compare: 'exact',
          },
          {
            id: 'e',
            type: 'remove-empty-rows',
            enabled: false, // disabled: blank row 6 stays
            scope: { kind: 'all-columns' },
          },
        ],
      },
      repository,
    );
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    // rows: 0 Berlin/12, 1 Cairo/34, 2 Berlin/21, 3 Berlin/12 dup-of-0,
    // 4 ' Cairo ' trims to Cairo/34 dup-of-1, 5 Cairo/34 dup, 6 blanks kept.
    expect(outcome.rowIndices).toEqual([0, 1, 2, 6]);
    expect(outcome.stepSummaries).toEqual([
      // row 4 ' Cairo ' (1 cell) + row 6 two whitespace cells = 3 changed.
      { stepId: 't', rowsRemoved: 0, cellsChanged: 3 },
      { stepId: 'd', rowsRemoved: 3, cellsChanged: 0 },
    ]);
  });

  it('returns every index when no predicates are set', async () => {
    const outcome = await runLocalQuery(
      { datasetId: 'ds', columns: ['c0', 'c1'], search: '', columnFilters: {} },
      repository,
    );
    expect(outcome).toEqual({ kind: 'done', rowIndices: [0, 1, 2], matched: 3, totalRows: 3 });
  });
});
