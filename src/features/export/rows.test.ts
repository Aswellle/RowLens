import { describe, expect, it } from 'vitest';
import type { StoredRow } from '../dataset/types';
import { readRowsByIndices, readRowsForIndices } from './rows';

/** A fake IndexedDB window reader over a fixed row universe. */
function fakeStore(
  rowCount: number,
  track: { reads: { offset: number; limit: number }[] } = { reads: [] },
) {
  const universe = new Map<number, StoredRow>();
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    universe.set(rowIndex, {
      datasetId: 'ds',
      rowIndex,
      values: { c0: `v${rowIndex}` },
    });
  }
  return {
    universe,
    track,
    readWindow: async (offset: number, limit: number): Promise<StoredRow[]> => {
      track.reads.push({ offset, limit });
      const rows: StoredRow[] = [];
      for (let index = offset; index < offset + limit; index++) {
        const row = universe.get(index);
        if (row !== undefined) rows.push(row);
      }
      return rows;
    },
  };
}

describe('readRowsForIndices', () => {
  it('reads a contiguous run in one sweep and reports every row', async () => {
    const store = fakeStore(10);
    const seen: number[] = [];
    await readRowsForIndices(store.readWindow, [3, 4, 5], (row) => seen.push(row.rowIndex));
    expect(seen.sort((a, b) => a - b)).toEqual([3, 4, 5]);
    // The read covers exactly the requested run, not a padded window.
    expect(store.track.reads).toEqual([{ offset: 3, limit: 3 }]);
  });

  it('splits scattered indices into runs and windows long runs', async () => {
    const store = fakeStore(2_500);
    const seen = new Set<number>();
    await readRowsForIndices(store.readWindow, [0, 2_400, 2_450, 2_451], (row) =>
      seen.add(row.rowIndex),
    );
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 2_400, 2_450, 2_451]);
    const offsets = store.track.reads.map((read) => read.offset);
    expect(offsets).toEqual([0, 2_400, 2_450]);
  });

  it('deduplicates repeated indices', async () => {
    const store = fakeStore(5);
    const seen: number[] = [];
    await readRowsForIndices(store.readWindow, [1, 1, 1], (row) => seen.push(row.rowIndex));
    expect(seen).toEqual([1]);
    expect(store.track.reads).toHaveLength(1);
  });

  it('caps each read window for a long run', async () => {
    const store = fakeStore(2_100);
    const fullRun = Array.from({ length: 2_100 }, (_, index) => index);
    await readRowsForIndices(store.readWindow, fullRun, () => {});
    // One contiguous 2,100-row run is swept in 1000-row windows.
    expect(store.track.reads).toEqual([
      { offset: 0, limit: 1_000 },
      { offset: 1_000, limit: 1_000 },
      { offset: 2_000, limit: 100 },
    ]);
  });
});

describe('readRowsByIndices', () => {
  it('returns rows keyed by their row index for random access', async () => {
    const store = fakeStore(8);
    const map = await readRowsByIndices(store.readWindow, [6, 1]);
    expect(map.get(1)?.values.c0).toBe('v1');
    expect(map.get(6)?.values.c0).toBe('v6');
    expect(map.has(2)).toBe(false);
  });

  it('returns an empty map for an empty index list', async () => {
    const store = fakeStore(3);
    const map = await readRowsByIndices(store.readWindow, []);
    expect(map.size).toBe(0);
    expect(store.track.reads).toEqual([]);
  });
});
