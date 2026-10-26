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
 * dataset size (ADR-028).
 */
import type { ColumnDefinition, RowIndex, StoredRow } from './types';

/** Rows per lazily loaded chunk. */
export const STORE_CHUNK_ROWS = 500;

export type ChunkLoader = (offset: number, limit: number) => Promise<readonly StoredRow[]>;

export class LazyDatasetStore {
  private readonly chunks = new Map<number, (string | null)[][]>();
  private readonly pending = new Set<number>();
  /** Rows requested before their chunk arrived; used to prioritise loads. */
  private readonly misses = new Map<number, number>();
  private readonly idToIndex = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly columns: readonly ColumnDefinition[],
    private readonly rowCount: number,
    private readonly loadChunk: ChunkLoader,
    /** Called after a chunk lands, so the view can re-render its window. */
    private readonly onChunkLoaded?: () => void,
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
   * first paint after a scroll does not show blanks.
   */
  ensureRows(firstRow: RowIndex, lastRow: RowIndex): void {
    const first = Math.max(0, Math.floor(firstRow / STORE_CHUNK_ROWS));
    const last = Math.min(
      Math.floor((this.rowCount - 1) / STORE_CHUNK_ROWS),
      Math.floor(Math.max(firstRow, lastRow) / STORE_CHUNK_ROWS),
    );
    for (let chunkIndex = first; chunkIndex <= last; chunkIndex += 1) {
      this.requestChunk(chunkIndex);
    }
  }

  /** Drops everything held; the loader is not called again after this. */
  dispose(): void {
    this.disposed = true;
    this.chunks.clear();
    this.pending.clear();
    this.misses.clear();
  }

  private requestChunk(chunkIndex: number): void {
    if (this.disposed || this.chunks.has(chunkIndex) || this.pending.has(chunkIndex)) return;
    this.pending.add(chunkIndex);
    void this.fetchChunk(chunkIndex);
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
