/**
 * Cell editing as an in-memory overlay (ADR-025).
 *
 * The stored rows and the source file stay untouched: an edit records a new
 * value for one (row, column) pair and everything downstream — the grid, the
 * query scan, the export — reads through the overlay. That keeps the original
 * data recoverable by construction, makes undo a pure state transition, and
 * leaves the cleaning pipeline independent (it runs after edits).
 *
 * Edits are keyed by column *id*, not display position, so hiding or
 * reordering columns cannot move an edit to another column. A missing entry
 * means "use the stored value"; an empty string is a real edit that blanks
 * the cell, which is why `null` is reserved for "no override".
 */
import type { ColumnId, RowIndex } from '../dataset/types';

/**
 * One cell change as recorded for undo/redo. Both sides are *overlay* values:
 * `null` means "no override, fall back to the stored value". Blanking a cell
 * is the empty string, which is why `null` cannot also mean blank.
 */
export type EditChange = {
  rowIndex: RowIndex;
  columnId: ColumnId;
  before: string | null;
  after: string | null;
};

/**
 * A requested edit from the UI. `displayed` is what the user was looking at
 * (store plus overlay) and `stored` is the value underneath the overlay;
 * together they let an edit that reproduces the original value drop the
 * override instead of freezing a copy of it. `after` is the typed text —
 * empty means a blank cell, which is a real edit, not a revert.
 */
export type EditInput = {
  rowIndex: RowIndex;
  columnId: ColumnId;
  displayed: string | null;
  stored: string | null;
  after: string;
};

/** Changes applied by one user action (a cell edit, or a bulk reset). */
export type EditBatch = readonly EditChange[];

export type EditState = {
  /** rowIndex → columnId → new value. Missing means "use the stored value". */
  readonly edits: ReadonlyMap<RowIndex, ReadonlyMap<ColumnId, string>>;
  readonly undoStack: readonly EditBatch[];
  readonly redoStack: readonly EditBatch[];
  /** Bumped on every change; the query effect keys on it. */
  readonly revision: number;
};

/**
 * Upper bound on distinct edited cells. The overlay travels with each query
 * request, so an unbounded one would turn every query into a large structured
 * clone. Editing more than this many cells means the user wants a cleaning
 * step or an external editor, not per-cell typing.
 */
export const MAX_EDITS = 5_000;

export function emptyEditState(): EditState {
  return { edits: new Map(), undoStack: [], redoStack: [], revision: 0 };
}

export function editCount(state: EditState): number {
  let count = 0;
  for (const row of state.edits.values()) count += row.size;
  return count;
}

/** Current overlay value for a cell, or undefined when it is not edited. */
export function editedValue(
  state: EditState,
  rowIndex: RowIndex,
  columnId: ColumnId,
): string | undefined {
  return state.edits.get(rowIndex)?.get(columnId);
}

export function hasEdits(state: EditState): boolean {
  return state.edits.size > 0;
}

export function canUndo(state: EditState): boolean {
  return state.undoStack.length > 0;
}

export function canRedo(state: EditState): boolean {
  return state.redoStack.length > 0;
}

/** Writes one side of each change into a fresh overlay map. */
function withChanges(state: EditState, changes: EditBatch, side: 'before' | 'after'): EditState {
  const edits = new Map(state.edits);
  for (const change of changes) {
    const row = new Map(edits.get(change.rowIndex) ?? []);
    const next = change[side];
    if (next === null) {
      row.delete(change.columnId);
    } else {
      row.set(change.columnId, next);
    }
    if (row.size === 0) {
      edits.delete(change.rowIndex);
    } else {
      edits.set(change.rowIndex, row);
    }
  }
  return { ...state, edits, revision: state.revision + 1 };
}

/**
 * Apply one user action. Redo history is dropped: after a new edit the old
 * redo path no longer describes a reachable state.
 *
 * Each input's `before` is the overlay's previous value (not the displayed
 * one), so undo restores the exact overlay state and a second undo reaches
 * the stored value. Inputs whose result equals what the user already saw are
 * dropped: an edit that changes nothing must not create an undo entry the
 * user cannot perceive.
 */
export function applyEdits(state: EditState, inputs: readonly EditInput[]): EditState {
  const changes: EditChange[] = [];
  for (const input of inputs) {
    if (input.after === (input.displayed ?? '')) continue;
    const current = state.edits.get(input.rowIndex)?.get(input.columnId) ?? null;
    // Typing the original value back removes the override: a cell that reads
    // the same as the stored value should not count as edited (no phantom
    // "edited" marker, no wasted overlay entry).
    const after = input.after === (input.stored ?? '') ? null : input.after;
    if (after === current) continue;
    changes.push({
      rowIndex: input.rowIndex,
      columnId: input.columnId,
      before: current,
      after,
    });
  }
  if (changes.length === 0) return state;
  return {
    ...withChanges(state, changes, 'after'),
    undoStack: [...state.undoStack, changes],
    redoStack: [],
  };
}

export function undoEdits(state: EditState): EditState {
  const batch = state.undoStack.at(-1);
  if (batch === undefined) return state;
  return {
    ...withChanges(state, batch, 'before'),
    undoStack: state.undoStack.slice(0, -1),
    redoStack: [...state.redoStack, batch],
  };
}

export function redoEdits(state: EditState): EditState {
  const batch = state.redoStack.at(-1);
  if (batch === undefined) return state;
  return {
    ...withChanges(state, batch, 'after'),
    undoStack: [...state.undoStack, batch],
    redoStack: state.redoStack.slice(0, -1),
  };
}

/**
 * Revert every edit as one undoable action, so "Reset edits" can itself be
 * undone. Each change records the current overlay value as `before` and
 * "no override" as `after`; row and column order are sorted so the resulting
 * undo entry is deterministic.
 */
export function clearEdits(state: EditState): EditState {
  if (state.edits.size === 0) return state;
  const batch: EditChange[] = [];
  const rows = [...state.edits.keys()].sort((a, b) => a - b);
  for (const rowIndex of rows) {
    const row = state.edits.get(rowIndex);
    if (!row) continue;
    for (const columnId of [...row.keys()].sort()) {
      batch.push({ rowIndex, columnId, before: row.get(columnId) ?? null, after: null });
    }
  }
  if (batch.length === 0) return state;
  return {
    ...withChanges(state, batch, 'after'),
    undoStack: [...state.undoStack, batch],
    redoStack: [],
  };
}

/** True when applying these inputs would push the overlay past the cap. */
export function wouldExceedCap(state: EditState, inputs: readonly EditInput[]): boolean {
  const touched = new Set<string>();
  let alreadyEdited = 0;
  for (const input of inputs) {
    const key = `${input.rowIndex}:${input.columnId}`;
    if (touched.has(key)) continue;
    touched.add(key);
    if (state.edits.get(input.rowIndex)?.has(input.columnId)) alreadyEdited += 1;
  }
  const added = touched.size - alreadyEdited;
  return editCount(state) + Math.max(0, added) > MAX_EDITS;
}

/** Compact wire form for the query worker: one entry per edited row. */
export type EditOverride = { rowIndex: RowIndex; values: Record<ColumnId, string> };

export function overridesForQuery(state: EditState): EditOverride[] {
  if (state.edits.size === 0) return [];
  const rows = [...state.edits.keys()].sort((a, b) => a - b);
  const out: EditOverride[] = [];
  for (const rowIndex of rows) {
    const row = state.edits.get(rowIndex);
    if (!row || row.size === 0) continue;
    const values: Record<ColumnId, string> = {};
    for (const columnId of [...row.keys()].sort()) {
      values[columnId] = row.get(columnId) ?? '';
    }
    out.push({ rowIndex, values });
  }
  return out;
}

/**
 * Applies the overlay to a stored row's values. Pure and cheap: it only
 * copies when the row actually has an edit, so the scan stays allocation-free
 * for untouched rows.
 */
export function applyOverrides(
  values: Record<ColumnId, string | null>,
  override: Record<ColumnId, string> | undefined,
): Record<ColumnId, string | null> {
  if (override === undefined) return values;
  return { ...values, ...override };
}
