import { describe, expect, it } from 'vitest';
import type { ColumnDefinition, StoredRow } from './types';
import { LazyDatasetStore, STORE_CHUNK_ROWS } from './lazy-store';

const COLUMNS: ColumnDefinition[] = [
  { id: 'c0', label: 'A', sourceIndex: 0 },
  { id: 'c1', label: 'B', sourceIndex: 1 },
];

function makeRows(count: number): StoredRow[] {
  return Array.from({ length: count }, (_, i) => ({
    datasetId: 'ds',
    rowIndex: i,
    values: { c0: `r${i}`, c1: `v${i}` },
  }));
}

/** A loader over an in-memory table that records the windows it was asked for. */
function loaderFor(total: number) {
  const table = makeRows(total);
  const calls: Array<[number, number]> = [];
  const load = async (offset: number, limit: number): Promise<readonly StoredRow[]> => {
    calls.push([offset, limit]);
    return table.slice(offset, offset + limit);
  };
  return { load, calls, table };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('LazyDatasetStore', () => {
  it('reports a miss as null and loads the chunk in the background', async () => {
    const { load, calls } = loaderFor(2000);
    let renders = 0;
    const store = new LazyDatasetStore(COLUMNS, 2000, load, () => {
      renders += 1;
    });

    expect(store.getCell(0, 0)).toBeNull();
    expect(calls).toEqual([[0, STORE_CHUNK_ROWS]]);

    await tick();
    expect(store.getCell(0, 0)).toBe('r0');
    expect(store.getCell(0, 1)).toBe('v0');
    expect(renders).toBe(1);
  });

  it('never loads a chunk twice, even under repeated reads', async () => {
    const { load, calls } = loaderFor(2000);
    const store = new LazyDatasetStore(COLUMNS, 2000, load);

    for (let i = 0; i < 50; i += 1) store.getCell(i, 0);
    await tick();
    for (let i = 0; i < 50; i += 1) store.getCell(i, 0);
    await tick();

    expect(calls).toHaveLength(1);
    expect(store.loadedChunkCount).toBe(1);
  });

  it('loads only the chunks the reader touches, not the dataset', async () => {
    const { load, calls } = loaderFor(250_000);
    const store = new LazyDatasetStore(COLUMNS, 250_000, load);

    // Read a window near the top, as the grid does on first paint.
    store.ensureRows(0, 30);
    await tick();
    expect(calls).toEqual([[0, STORE_CHUNK_ROWS]]);

    // Jump far down: exactly one more chunk, not the 500 in between.
    store.getCell(249_999, 0);
    await tick();
    expect(calls).toHaveLength(2);
    expect(store.loadedChunkCount).toBe(2);
    expect(store.getCell(249_999, 0)).toBe('r249999');
  });

  it('warms a multi-chunk window in one pass', async () => {
    const { load, calls } = loaderFor(5000);
    const store = new LazyDatasetStore(COLUMNS, 5000, load);

    store.ensureRows(400, 1100);
    await tick();
    expect(calls.map(([offset]) => offset)).toEqual([0, 500, 1000]);
  });

  it('answers out-of-range reads with null and does not load anything', async () => {
    const { load, calls } = loaderFor(10);
    const store = new LazyDatasetStore(COLUMNS, 10, load);

    expect(store.getCell(-1, 0)).toBeNull();
    expect(store.getCell(10, 0)).toBeNull();
    await tick();
    expect(calls).toHaveLength(0);
  });

  it('resolves ensureRow only after the row is readable', async () => {
    const { load } = loaderFor(2000);
    const store = new LazyDatasetStore(COLUMNS, 2000, load);

    await store.ensureRow(700);
    expect(store.getCell(700, 0)).toBe('r700');
  });

  it('leaves blank cells for a chunk whose read failed, and retries later', async () => {
    let attempts = 0;
    const table = makeRows(2000);
    const store = new LazyDatasetStore(COLUMNS, 2000, async (offset, limit) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return table.slice(offset, offset + limit);
    });

    store.getCell(0, 0);
    await tick();
    expect(store.getCell(0, 0)).toBeNull();

    // A later read of the same chunk retries instead of caching the failure.
    store.getCell(1, 0);
    await tick();
    expect(store.getCell(1, 0)).toBe('r1');
  });

  it('stops loading after dispose', async () => {
    const { load, calls } = loaderFor(2000);
    const store = new LazyDatasetStore(COLUMNS, 2000, load);

    store.getCell(0, 0);
    store.dispose();
    await tick();
    const callsAfterDispose = calls.length;
    store.getCell(1500, 0);
    await tick();
    expect(calls.length).toBe(callsAfterDispose);
    expect(store.loadedChunkCount).toBe(0);
  });

  it('exposes the dataset shape it was built for', () => {
    const { load } = loaderFor(2000);
    const store = new LazyDatasetStore(COLUMNS, 2000, load);
    expect(store.columnCount).toBe(2);
    expect(store.totalRowCount).toBe(2000);
    expect(store.getColumns()).toEqual(COLUMNS);
  });
});

describe('LazyDatasetStore eviction', () => {
  it('keeps at most the configured number of chunks', async () => {
    const { load } = loaderFor(100_000);
    const store = new LazyDatasetStore(COLUMNS, 100_000, load, undefined, 4);

    // Walk the file chunk by chunk, as scrolling does.
    for (let chunk = 0; chunk < 12; chunk += 1) {
      store.ensureRows(chunk * STORE_CHUNK_ROWS, chunk * STORE_CHUNK_ROWS + 20);
      await tick();
    }
    expect(store.loadedChunkCount).toBeLessThanOrEqual(4);
  });

  it('drops the least recently used chunk, not the newest', async () => {
    const { load } = loaderFor(100_000);
    const store = new LazyDatasetStore(COLUMNS, 100_000, load, undefined, 3);

    for (let chunk = 0; chunk < 3; chunk += 1) {
      store.ensureRows(chunk * STORE_CHUNK_ROWS, chunk * STORE_CHUNK_ROWS + 1);
      await tick();
    }
    // Re-read chunk 0 so it becomes the most recent, then load a fourth.
    store.ensureRows(0, 1);
    await tick();
    store.ensureRows(3 * STORE_CHUNK_ROWS, 3 * STORE_CHUNK_ROWS + 1);
    await tick();

    expect(store.loadedChunkCount).toBe(3);
    // Chunk 0 survived because it was touched; chunk 1 is the oldest now.
    expect(store.hasRow(0)).toBe(true);
    expect(store.hasRow(3 * STORE_CHUNK_ROWS)).toBe(true);
    expect(store.hasRow(1 * STORE_CHUNK_ROWS)).toBe(false);
  });

  it('never evicts the window the grid is currently rendering', async () => {
    const { load } = loaderFor(100_000);
    const store = new LazyDatasetStore(COLUMNS, 100_000, load, undefined, 2);

    // Scrolling moves the pin: only the window reported last is protected,
    // because the previous one is no longer on screen.
    for (let chunk = 5; chunk < 12; chunk += 1) {
      store.ensureRows(chunk * STORE_CHUNK_ROWS, chunk * STORE_CHUNK_ROWS + 1);
      await tick();
      // The window just asked for is always present.
      expect(store.hasRow(chunk * STORE_CHUNK_ROWS)).toBe(true);
      expect(store.loadedChunkCount).toBeLessThanOrEqual(2);
    }
  });

  it('protects every chunk of a window wider than the cap', async () => {
    const { load } = loaderFor(100_000);
    const store = new LazyDatasetStore(COLUMNS, 100_000, load, undefined, 2);

    // A window spanning three chunks is pinned as a whole; eviction must not
    // take one of them just because the cap is smaller.
    store.ensureRows(0, 1200);
    await tick();
    expect(store.loadedChunkCount).toBe(3);
    expect(store.hasRow(0)).toBe(true);
    expect(store.hasRow(600)).toBe(true);
    expect(store.hasRow(1100)).toBe(true);
  });

  it('allows a window larger than the cap rather than blanking the screen', async () => {
    const { load } = loaderFor(100_000);
    const store = new LazyDatasetStore(COLUMNS, 100_000, load, undefined, 1);

    // A window spanning three chunks is pinned as a whole.
    store.ensureRows(0, 1200);
    await tick();
    expect(store.loadedChunkCount).toBe(3);
    expect(store.getCell(1100, 0)).toBe('r1100');
  });

  it('reloads an evicted chunk when it is read again', async () => {
    const { load, calls } = loaderFor(100_000);
    const store = new LazyDatasetStore(COLUMNS, 100_000, load, undefined, 2);

    store.ensureRows(0, 1);
    await tick();
    for (let chunk = 1; chunk < 4; chunk += 1) {
      store.ensureRows(chunk * STORE_CHUNK_ROWS, chunk * STORE_CHUNK_ROWS + 1);
      await tick();
    }
    expect(store.hasRow(0)).toBe(false);

    store.ensureRows(0, 1);
    await tick();
    expect(store.getCell(0, 0)).toBe('r0');
    // It was fetched twice: the eviction did not corrupt the cache.
    expect(calls.filter(([offset]) => offset === 0)).toHaveLength(2);
  });
});
