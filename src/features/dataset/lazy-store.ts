/**
 * Cell source for a restored dataset.
 *
 * A reload used to read every stored row into memory before showing the grid
 * (500 transactions for 250k rows), even though the grid renders a couple of
 * dozen rows at a time. This store instead keeps only the chunks that have
 * been touched: `getCell` answers synchronously from the loaded chunks and
 * reports a miss as null, while a chunk loader fills them in the background.
 *
 * The contract that makes this safe:
 * - Chunks are loaded in the same order the grid reads them (top-down, and
 *   always the chunk containing the requested row before it is rendered), so a
 *   miss only ever affects a row that is not on screen yet.
 * - `onChunkLoaded` lets the caller re-render once a chunk arrives; the grid
 *   then reads real values for the rows it is showing.
 * - Query, export and edits all run against IndexedDB directly (worker scans
 *   and repository windows), so they never depend on this cache.
 *
 * Memory therefore scales with what the user actually looks at, not with the
 * dataset size (ADR-028). A least-recently-used cap keeps that true even after
 * the user scrolls through the whole file: the window being rendered is
 * pinned, everything else is evictable (ADR-029).
 */
import type { ColumnDefinition, RowIndex, StoredRow } from './types';

/** Rows per lazily loaded chunk. */
export const STORE_CHUNK_ROWS = 500;

/**
 * Chunks kept in memory. 40 chunks × 500 rows = 20,000 rows, roughly 1.5× the
 * rows a 95 MiB P3 file would need for a few screenfuls plus read-ahead, and
 * small enough that scrolling the whole file does not accumulate it.
 */
export const STORE_MAX_CHUNKS = 40;

export type ChunkLoader = (offset: number, limit: number) => Promise<readonly StoredRow[]>;

export class LazyDatasetStore {
  /** Insertion order is the LRU order: oldest first, refreshed on read. */
  private readonly chunks = new Map<number, (string | null)[][]>();
  private readonly pending = new Set<number>();
  /** Rows requested before their chunk arrived; used to prioritise loads. */
  private readonly misses = new Map<number, number>();
  private readonly idToIndex = new Map<string, number>();
  /** Chunks the view is currently rendering; never evicted. */
  private pinned = new Set<number>();
  private disposed = false;

  constructor(
    private readonly columns: readonly ColumnDefinition[],
    private readonly rowCount: number,
    private readonly loadChunk: ChunkLoader,
    /** Called after a chunk lands, so the view can re-render its window. */
    private readonly onChunkLoaded?: () => void,
    private readonly maxChunks: number = STORE_MAX_CHUNKS,
  ) {
    columns.forEach((column, index) => this.idToIndex.set(column.id, index));
  }

  get columnCount(): number {
    return this.columns.length;
  }

  getColumns(): readonly ColumnDefinition[] {
    return this.columns;
  }

  get totalRowCount(): number {
    return this.rowCount;
  }

  /** Number of chunks currently held in memory (tests and diagnostics). */
  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  /**
   * Synchronous cell read. A miss returns null and schedules the chunk, which
   * is why callers must re-render when `onChunkLoaded` fires.
   */
  getCell(rowIndex: RowIndex, columnIndex: number): string | null {
    if (rowIndex < 0 || rowIndex >= this.rowCount) return null;
    const chunkIndex = Math.floor(rowIndex / STORE_CHUNK_ROWS);
    const chunk = this.chunks.get(chunkIndex);
    if (chunk === undefined) {
      this.requestChunk(chunkIndex);
      return null;
    }
    this.touch(chunkIndex);
    const local = rowIndex - chunkIndex * STORE_CHUNK_ROWS;
    return chunk[local]?.[columnIndex] ?? null;
  }

  /** True when the row is already in memory; used to decide re-renders. */
  hasRow(rowIndex: RowIndex): boolean {
    return this.chunks.has(Math.floor(rowIndex / STORE_CHUNK_ROWS));
  }

  /** Loads the chunk containing a row and resolves once it is in memory. */
  async ensureRow(rowIndex: RowIndex): Promise<void> {
    if (rowIndex < 0 || rowIndex >= this.rowCount) return;
    const chunkIndex = Math.floor(rowIndex / STORE_CHUNK_ROWS);
    if (this.chunks.has(chunkIndex)) return;
    this.pending.add(chunkIndex);
    await this.fetchChunk(chunkIndex);
  }

  /**
   * Warms a window of rows, e.g. the rows the grid is about to render, so the
   * first paint after a scroll does not show blanks. The window is also pinned
   * for eviction purposes until the next call moves it, and any chunk already
   * loaded for that window counts as recently used.
   */
  ensureRows(firstRow: RowIndex, lastRow: RowIndex): void {
    const first = Math.max(0, Math.floor(firstRow / STORE_CHUNK_ROWS));
    const last = Math.min(
      Math.floor((this.rowCount - 1) / STORE_CHUNK_ROWS),
      Math.floor(Math.max(firstRow, lastRow) / STORE_CHUNK_ROWS),
    );
    const pinned = new Set<number>();
    for (let chunkIndex = first; chunkIndex <= last; chunkIndex += 1) {
      pinned.add(chunkIndex);
      if (this.chunks.has(chunkIndex)) this.touch(chunkIndex);
      else this.requestChunk(chunkIndex);
    }
    this.pinned = pinned;
    this.evict();
  }

  /** Drops everything held; the loader is not called again after this. */
  dispose(): void {
    this.disposed = true;
    this.chunks.clear();
    this.pending.clear();
    this.misses.clear();
    this.pinned.clear();
  }

  private requestChunk(chunkIndex: number): void {
    if (this.disposed || this.chunks.has(chunkIndex) || this.pending.has(chunkIndex)) return;
    this.pending.add(chunkIndex);
    void this.fetchChunk(chunkIndex);
  }

  /** Marks a chunk as most recently used without changing its identity. */
  private touch(chunkIndex: number): void {
    const chunk = this.chunks.get(chunkIndex);
    if (chunk === undefined) return;
    this.chunks.delete(chunkIndex);
    this.chunks.set(chunkIndex, chunk);
  }

  /**
   * Drops least-recently-used chunks past the cap.
   *
   * Pinned chunks (the window the grid is rendering) are skipped: evicting one
   * would blank rows that are on screen right now. A single window larger than
   * the cap is therefore allowed to exceed it — correctness beats the bound,
   * and the grid's window is a few dozen rows, far below the cap.
   */
  private evict(): void {
    if (this.chunks.size <= this.maxChunks) return;
    for (const chunkIndex of [...this.chunks.keys()]) {
      if (this.chunks.size <= this.maxChunks) break;
      if (this.pinned.has(chunkIndex)) continue;
      this.chunks.delete(chunkIndex);
    }
  }

  private async fetchChunk(chunkIndex: number): Promise<void> {
    const offset = chunkIndex * STORE_CHUNK_ROWS;
    try {
      const rows = await this.loadChunk(offset, STORE_CHUNK_ROWS);
      if (this.disposed) return;
      this.chunks.set(
        chunkIndex,
        rows.map((row) => this.toColumnArray(row)),
      );
      this.evict();
      this.onChunkLoaded?.();
    } catch {
      // A failed read leaves the rows blank for this session; the grid shows
      // null cells and the next scroll retries. Persistence is not at risk:
      // the data is still in IndexedDB.
      this.misses.set(chunkIndex, (this.misses.get(chunkIndex) ?? 0) + 1);
    } finally {
      this.pending.delete(chunkIndex);
    }
  }

  private toColumnArray(row: StoredRow): (string | null)[] {
    const values: (string | null)[] = new Array<string | null>(this.columns.length).fill(null);
    for (const [id, value] of Object.entries(row.values)) {
      const index = this.idToIndex.get(id);
      if (index !== undefined) values[index] = value;
    }
    return values;
  }
}
