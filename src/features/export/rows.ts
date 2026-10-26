/**
 * Total row reads for non-render consumers (export, risk estimate).
 *
 * The grid's cell source is allowed to miss: a lazily restored dataset returns
 * `null` for an unloaded chunk and fills it in the background (ADR-028). That
 * contract is fine for painting — the cell turns blank for a frame — and
 * worthless for anything that writes output, where a miss would export as an
 * empty cell. Consumers that produce artifacts therefore read stored rows
 * straight from IndexedDB through this helper instead of the render cache
 * (ADR-037).
 *
 * Reads are grouped into contiguous runs and windowed, so one call issues a
 * handful of key-range reads rather than one request per row, and memory stays
 * bounded by what the caller processes per window.
 */
import type { StoredRow } from '../dataset/types';

export type RowWindowReader = (offset: number, limit: number) => Promise<StoredRow[]>;

/** Rows per IndexedDB read while walking a contiguous run. */
const READ_WINDOW = 1_000;

/**
 * Calls `processRow` once per stored row named in `indices`, reading the rows
 * from IndexedDB in as few key-range windows as the index layout allows.
 * Duplicate indices are read once; the callback order is not the caller's
 * index order — group rows yourself when order matters.
 */
export async function readRowsForIndices(
  readWindow: RowWindowReader,
  indices: readonly number[],
  processRow: (row: StoredRow) => void,
): Promise<void> {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  let start = 0;
  while (start < sorted.length) {
    // Extend the run while indices stay consecutive: one windowed sweep covers
    // the whole run regardless of its length.
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end += 1;
    const runStart = sorted[start]!;
    const runLength = sorted[end]! - runStart + 1;
    for (let offset = runStart; offset < runStart + runLength; offset += READ_WINDOW) {
      const limit = Math.min(READ_WINDOW, runStart + runLength - offset);
      const rows = await readWindow(offset, limit);
      for (const row of rows) processRow(row);
    }
    start = end + 1;
  }
}

/**
 * Reads the given indices and returns them keyed by row index, for callers
 * that need random access within a bounded batch (export emits one batch of
 * indices at a time, so the map stays small).
 */
export async function readRowsByIndices(
  readWindow: RowWindowReader,
  indices: readonly number[],
): Promise<Map<number, StoredRow>> {
  const byIndex = new Map<number, StoredRow>();
  await readRowsForIndices(readWindow, indices, (row) => {
    byIndex.set(row.rowIndex, row);
  });
  return byIndex;
}
