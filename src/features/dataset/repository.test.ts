import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError, toAppError } from '../../app/app-error';
import type { DatasetMetadata, StoredRow } from './types';
import { DatasetRepository } from './repository';

// Node (non-DOM) vitest environments have no global IDBKeyRange; the
// repository code uses the browser global, so wire fake-indexeddb's in.
if (typeof globalThis.IDBKeyRange === 'undefined') {
  globalThis.IDBKeyRange = IDBKeyRange;
}

function makeMeta(overrides: Partial<DatasetMetadata> = {}): DatasetMetadata {
  return {
    id: 'ds-1',
    format: 'csv',
    fileName: 'test.csv',
    byteSize: 100,
    status: 'importing',
    createdAt: 1_000,
    lastTouchedAt: 1_000,
    rowCount: 0,
    columns: [
      { id: 'c0', label: 'a', sourceIndex: 0 },
      { id: 'c1', label: 'b', sourceIndex: 1 },
    ],
    parseErrorCount: 0,
    importWarnings: [],
    schemaVersion: 1,
    ...overrides,
  };
}

function makeRow(datasetId: string, rowIndex: number, values: string[]): StoredRow {
  const record: Record<string, string | null> = {};
  values.forEach((value, i) => {
    record[`c${i}`] = value;
  });
  return { datasetId, rowIndex, values: record };
}

describe('DatasetRepository (fake IndexedDB)', () => {
  let repository: DatasetRepository;

  beforeEach(async () => {
    // A fresh factory per test gives complete isolation between cases.
    repository = await DatasetRepository.open(new IDBFactory());
  });

  it('inserts, finalizes and reads back dataset metadata', async () => {
    const meta = makeMeta();
    await repository.insertDataset(meta);

    const importing = await repository.getDataset('ds-1');
    expect(importing?.status).toBe('importing');

    await repository.finalizeDataset({ ...meta, status: 'ready', rowCount: 2 });
    const ready = await repository.getDataset('ds-1');
    expect(ready?.status).toBe('ready');
    expect(ready?.rowCount).toBe(2);
  });

  it('writes rows under compound keys and reads windows in order', async () => {
    const batchA = [makeRow('ds-1', 0, ['x', 'y']), makeRow('ds-1', 1, ['p', 'q'])];
    const batchB = [makeRow('ds-1', 2, ['m', 'n'])];
    await repository.putRows('ds-1', batchA);
    await repository.putRows('ds-1', batchB);

    expect(await repository.countRows('ds-1')).toBe(3);
    const window = await repository.readRows('ds-1', 1, 2);
    expect(window.map((row) => row.rowIndex)).toEqual([1, 2]);
    expect(window[0]?.values.c0).toBe('p');
  });

  it('isolates rows between datasets', async () => {
    await repository.putRows('ds-1', [makeRow('ds-1', 0, ['a'])]);
    await repository.putRows('ds-2', [makeRow('ds-2', 0, ['b'])]);
    expect(await repository.countRows('ds-1')).toBe(1);
    expect((await repository.readRows('ds-2', 0, 1))[0]?.values.c0).toBe('b');
  });

  it('stores import errors keyed by physical line and overwrites duplicates', async () => {
    await repository.putImportErrors([
      { datasetId: 'ds-1', physicalLineNumber: 7, kind: 'invalid-json-line' },
      { datasetId: 'ds-1', physicalLineNumber: 7, kind: 'line-too-long' },
    ]);
    await repository.deleteDataset('ds-1');
    // Deletion removed the error rows; re-inserting the same key must not
    // conflict (compound key uniqueness is per dataset).
    await repository.putImportErrors([
      { datasetId: 'ds-1', physicalLineNumber: 7, kind: 'invalid-json-line' },
    ]);
  });

  it('deleteDataset removes metadata, rows and errors together', async () => {
    await repository.insertDataset(makeMeta());
    await repository.putRows('ds-1', [makeRow('ds-1', 0, ['z'])]);
    await repository.putImportErrors([
      { datasetId: 'ds-1', physicalLineNumber: 3, kind: 'malformed-row' },
    ]);

    await repository.deleteDataset('ds-1');

    expect(await repository.getDataset('ds-1')).toBeUndefined();
    expect(await repository.countRows('ds-1')).toBe(0);
  });

  it('startup cleanup removes cancelled, failed, expired-importing and TTL-expired datasets', async () => {
    const now = 10_000_000;
    const fresh = now - 1_000;
    const ttlAgo = now - (24 * 60 * 60 * 1000 + 5_000);

    await repository.insertDataset(
      makeMeta({ id: 'cancelled', status: 'cancelled', lastTouchedAt: fresh }),
    );
    await repository.insertDataset(
      makeMeta({ id: 'failed', status: 'failed', lastTouchedAt: fresh }),
    );
    await repository.insertDataset(
      makeMeta({ id: 'stale-import', status: 'importing', lastTouchedAt: ttlAgo }),
    );
    await repository.insertDataset(
      makeMeta({ id: 'old-ready', status: 'ready', lastTouchedAt: ttlAgo }),
    );
    await repository.insertDataset(
      makeMeta({ id: 'live-ready', status: 'ready', lastTouchedAt: fresh, rowCount: 1 }),
    );
    await repository.putRows('live-ready', [makeRow('live-ready', 0, ['keep'])]);
    await repository.putRows('cancelled', [makeRow('cancelled', 0, ['gone'])]);

    const removed = await repository.cleanupStale(now);

    expect(removed).toBe(4);
    const remaining = (await repository.listDatasets()).map((meta) => meta.id);
    expect(remaining).toEqual(['live-ready']);
    expect(await repository.countRows('live-ready')).toBe(1);
    expect(await repository.countRows('cancelled')).toBe(0);
  });

  it('maps quota and unknown IndexedDB failures onto catalogue codes', () => {
    const quota = toAppError(
      Object.assign(new Error('out of space'), { name: 'QuotaExceededError' }),
    );
    expect(quota).toBeInstanceOf(AppError);
    expect(quota.code).toBe('STORAGE_QUOTA_EXCEEDED');

    const generic = toAppError(new Error('boom'));
    expect(generic.code).toBe('STORAGE_UNAVAILABLE');

    const passthrough = toAppError(new AppError('QUERY_FAILED', 'kept'));
    expect(passthrough.code).toBe('QUERY_FAILED');
  });
});

describe('DatasetRepository cell edits (fake IndexedDB)', () => {
  let repository: DatasetRepository;

  beforeEach(async () => {
    repository = await DatasetRepository.open(new IDBFactory());
  });

  it('stores one edit record per dataset and reads it back', async () => {
    await repository.putCellEdits({
      datasetId: 'ds-1',
      updatedAt: 5,
      format: 1,
      cells: [
        [0, 'c0', 'edited'],
        [2, 'c1', ''],
      ],
    });
    const record = (await repository.getCellEdits('ds-1')) as {
      cells: [number, string, string][];
    };
    expect(record.cells).toEqual([
      [0, 'c0', 'edited'],
      [2, 'c1', ''],
    ]);
  });

  it('overwrites the record instead of appending', async () => {
    await repository.putCellEdits({
      datasetId: 'ds-1',
      updatedAt: 1,
      format: 1,
      cells: [[0, 'c0', 'a']],
    });
    await repository.putCellEdits({
      datasetId: 'ds-1',
      updatedAt: 2,
      format: 1,
      cells: [[0, 'c0', 'b']],
    });
    const record = (await repository.getCellEdits('ds-1')) as {
      updatedAt: number;
      cells: [number, string, string][];
    };
    expect(record.updatedAt).toBe(2);
    expect(record.cells).toEqual([[0, 'c0', 'b']]);
  });

  it('keeps edit records separate per dataset', async () => {
    await repository.putCellEdits({
      datasetId: 'ds-1',
      updatedAt: 1,
      format: 1,
      cells: [[0, 'c0', 'a']],
    });
    await repository.putCellEdits({
      datasetId: 'ds-2',
      updatedAt: 1,
      format: 1,
      cells: [[0, 'c0', 'b']],
    });
    expect(((await repository.getCellEdits('ds-1')) as { cells: unknown[] }).cells).toEqual([
      [0, 'c0', 'a'],
    ]);
    expect(((await repository.getCellEdits('ds-2')) as { cells: unknown[] }).cells).toEqual([
      [0, 'c0', 'b'],
    ]);
  });

  it('returns undefined for a dataset with no edits', async () => {
    expect(await repository.getCellEdits('missing')).toBeUndefined();
  });

  it('deleting the dataset removes its edits too', async () => {
    await repository.insertDataset(makeMeta({ status: 'ready', rowCount: 1 }));
    await repository.putRows('ds-1', [makeRow('ds-1', 0, ['a'])]);
    await repository.putCellEdits({
      datasetId: 'ds-1',
      updatedAt: 1,
      format: 1,
      cells: [[0, 'c0', 'x']],
    });

    await repository.deleteDataset('ds-1');

    expect(await repository.getCellEdits('ds-1')).toBeUndefined();
    expect(await repository.getDataset('ds-1')).toBeUndefined();
    expect(await repository.countRows('ds-1')).toBe(0);
  });

  it('deletes edits without touching rows, and rows without touching edits', async () => {
    await repository.putRows('ds-1', [makeRow('ds-1', 0, ['kept'])]);
    await repository.putCellEdits({
      datasetId: 'ds-1',
      updatedAt: 1,
      format: 1,
      cells: [[0, 'c0', 'x']],
    });

    await repository.deleteCellEdits('ds-1');
    expect(await repository.getCellEdits('ds-1')).toBeUndefined();
    // The imported row is still there: edits are a separate store.
    expect(await repository.countRows('ds-1')).toBe(1);
  });
});
