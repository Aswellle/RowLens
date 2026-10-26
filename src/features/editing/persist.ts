/**
 * Serialization for persisted cell edits (ADR-027).
 *
 * The overlay is a nested Map, which is not structured-clone friendly for a
 * schema we may need to migrate. The stored form is deliberately boring and
 * self-describing:
 *
 *   { datasetId, updatedAt, format: 1, cells: [[rowIndex, columnId, value], …] }
 *
 * A flat tuple list keeps the record small, survives a JSON round trip, and
 * makes a partially written or hand-edited record easy to validate — a single
 * bad tuple is dropped instead of poisoning the whole dataset's edits.
 */
import type { ColumnId, RowIndex } from '../dataset/types';
import { emptyEditState, MAX_EDITS, type EditState } from './edits';

/** Bumped when the stored layout changes; older records are ignored. */
export const EDIT_RECORD_FORMAT = 1;

export type StoredEditCell = [RowIndex, ColumnId, string];

export type StoredEditRecord = {
  datasetId: string;
  updatedAt: number;
  format: number;
  cells: StoredEditCell[];
};

/** Flattens the overlay into the stored tuple list, sorted for stable diffs. */
export function serializeEdits(state: EditState): StoredEditCell[] {
  const cells: StoredEditCell[] = [];
  const rows = [...state.edits.keys()].sort((a, b) => a - b);
  for (const rowIndex of rows) {
    const row = state.edits.get(rowIndex);
    if (!row) continue;
    for (const columnId of [...row.keys()].sort()) {
      cells.push([rowIndex, columnId, row.get(columnId) ?? '']);
    }
  }
  return cells;
}

/**
 * Rebuilds the overlay from a stored record.
 *
 * Validation is per tuple: a negative or non-integer row index, a non-string
 * column id or value, or a duplicate cell is dropped. The result carries no
 * undo history — a reload is a fresh editing session, and pretending the
 * previous session's undo stack still applies would be a lie about what the
 * user can take back.
 */
export function deserializeEdits(record: unknown): EditState {
  if (record === null || typeof record !== 'object') return emptyEditState();
  const cells = (record as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return emptyEditState();

  const edits = new Map<RowIndex, Map<ColumnId, string>>();
  for (const entry of cells) {
    // A corrupt or hand-edited record can carry millions of tuples; stop at
    // the editing cap so deserialization can never materialize more state
    // than the session itself allows.
    if (countEdits(edits) >= MAX_EDITS) break;
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const [rowIndex, columnId, value] = entry as unknown[];
    if (
      typeof rowIndex !== 'number' ||
      !Number.isInteger(rowIndex) ||
      rowIndex < 0 ||
      typeof columnId !== 'string' ||
      columnId === '' ||
      typeof value !== 'string'
    ) {
      continue;
    }
    let row = edits.get(rowIndex);
    if (row === undefined) {
      row = new Map();
      edits.set(rowIndex, row);
    }
    row.set(columnId, value);
  }

  if (edits.size === 0) return emptyEditState();
  return { edits, undoStack: [], redoStack: [], revision: 0 };
}

/** Total edited cells across rows. */
function countEdits(edits: Map<RowIndex, Map<ColumnId, string>>): number {
  let total = 0;
  for (const row of edits.values()) total += row.size;
  return total;
}

/** True when the record is a version this build understands. */
export function isSupportedEditRecord(record: unknown): boolean {
  if (record === null || typeof record !== 'object') return false;
  const format = (record as { format?: unknown }).format;
  return format === EDIT_RECORD_FORMAT;
}

/**
 * Drops edits for columns that no longer exist (a re-import can change the
 * schema) and rows past the end of the dataset. Returns the input state
 * unchanged when everything still applies, so callers can skip a write.
 */
export function pruneEdits(
  state: EditState,
  rowCount: number,
  columnIds: ReadonlySet<ColumnId>,
): EditState {
  if (state.edits.size === 0) return state;
  const edits = new Map<RowIndex, Map<ColumnId, string>>();
  let dropped = false;
  for (const [rowIndex, row] of state.edits) {
    if (rowIndex >= rowCount) {
      dropped = true;
      continue;
    }
    const kept = new Map<ColumnId, string>();
    for (const [columnId, value] of row) {
      if (columnIds.has(columnId)) kept.set(columnId, value);
      else dropped = true;
    }
    if (kept.size > 0) edits.set(rowIndex, kept);
  }
  if (!dropped) return state;
  const revision = state.revision + 1;
  if (edits.size === 0) return { ...emptyEditState(), revision };
  return { ...state, edits, revision };
}
