import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  editCount,
  editedValue,
  emptyEditState,
  MAX_EDITS,
  type EditInput,
} from './edits';
import {
  EDIT_RECORD_FORMAT,
  deserializeEdits,
  isSupportedEditRecord,
  pruneEdits,
  serializeEdits,
} from './persist';

function input(
  rowIndex: number,
  columnId: string,
  displayed: string | null,
  after: string,
): EditInput {
  return { rowIndex, columnId, displayed, stored: '', after };
}

function sample() {
  return applyEdits(emptyEditState(), [
    input(3, 'c1', 'old', 'new'),
    input(0, 'c2', null, 'first'),
    { rowIndex: 3, columnId: 'c0', displayed: 'a', stored: 'a', after: '' },
  ]);
}

describe('edit record serialization', () => {
  it('round-trips the overlay through the stored tuple form', () => {
    const state = sample();
    const restored = deserializeEdits({ format: EDIT_RECORD_FORMAT, cells: serializeEdits(state) });
    expect(editCount(restored)).toBe(3);
    expect(editedValue(restored, 3, 'c1')).toBe('new');
    expect(editedValue(restored, 0, 'c2')).toBe('first');
    // An emptied cell stays an override with an empty value.
    expect(editedValue(restored, 3, 'c0')).toBe('');
  });

  it('writes tuples in row and column order for stable output', () => {
    expect(serializeEdits(sample())).toEqual([
      [0, 'c2', 'first'],
      [3, 'c0', ''],
      [3, 'c1', 'new'],
    ]);
  });

  it('restores without undo history: a reload is a new session', () => {
    const restored = deserializeEdits({
      format: EDIT_RECORD_FORMAT,
      cells: serializeEdits(sample()),
    });
    expect(restored.undoStack).toEqual([]);
    expect(restored.redoStack).toEqual([]);
    expect(restored.revision).toBe(0);
  });

  it('drops individual malformed tuples instead of losing the dataset', () => {
    const restored = deserializeEdits({
      format: EDIT_RECORD_FORMAT,
      cells: [
        [0, 'c0', 'ok'],
        [-1, 'c0', 'negative row'],
        [1.5, 'c0', 'fractional row'],
        ['2', 'c0', 'string row'],
        [2, '', 'empty column'],
        [2, 'c0', 42],
        ['not-an-array'],
        [3],
        [4, 'c1', 'also ok'],
      ],
    });
    expect(serializeEdits(restored)).toEqual([
      [0, 'c0', 'ok'],
      [4, 'c1', 'also ok'],
    ]);
  });

  it('returns an empty overlay for unusable records', () => {
    expect(deserializeEdits(null)).toEqual(emptyEditState());
    expect(deserializeEdits(undefined)).toEqual(emptyEditState());
    expect(deserializeEdits({})).toEqual(emptyEditState());
    expect(deserializeEdits({ cells: 'nope' })).toEqual(emptyEditState());
    expect(deserializeEdits({ cells: [] })).toEqual(emptyEditState());
  });

  it('keeps the last value when a record repeats a cell', () => {
    const restored = deserializeEdits({
      format: EDIT_RECORD_FORMAT,
      cells: [
        [1, 'c0', 'first'],
        [1, 'c0', 'second'],
      ],
    });
    expect(editedValue(restored, 1, 'c0')).toBe('second');
  });

  it('recognises only its own record format', () => {
    expect(isSupportedEditRecord({ format: EDIT_RECORD_FORMAT, cells: [] })).toBe(true);
    expect(isSupportedEditRecord({ format: 99, cells: [] })).toBe(false);
    expect(isSupportedEditRecord({ cells: [] })).toBe(false);
    expect(isSupportedEditRecord(null)).toBe(false);
  });
});

describe('pruning edits after a schema change', () => {
  it('drops rows past the end and columns that no longer exist', () => {
    const state = applyEdits(emptyEditState(), [
      input(0, 'c0', null, 'kept'),
      input(0, 'gone', null, 'dropped column'),
      input(9, 'c0', null, 'dropped row'),
    ]);
    const pruned = pruneEdits(state, 5, new Set(['c0', 'c1']));
    expect(serializeEdits(pruned)).toEqual([[0, 'c0', 'kept']]);
  });

  it('returns the same state when everything still applies', () => {
    const state = applyEdits(emptyEditState(), [input(0, 'c0', null, 'x')]);
    expect(pruneEdits(state, 10, new Set(['c0']))).toBe(state);
  });

  it('returns an empty overlay when nothing survives', () => {
    const state = applyEdits(emptyEditState(), [input(9, 'c0', null, 'x')]);
    const pruned = pruneEdits(state, 1, new Set(['c0']));
    expect(editCount(pruned)).toBe(0);
    expect(pruned.undoStack).toEqual([]);
  });

  it('does not bump the revision when nothing was dropped', () => {
    const state = applyEdits(emptyEditState(), [input(0, 'c0', null, 'x')]);
    expect(pruneEdits(state, 10, new Set(['c0'])).revision).toBe(state.revision);
    expect(pruneEdits(state, 0, new Set(['c0'])).revision).toBeGreaterThan(state.revision);
  });
});

describe('deserializeEdits cap', () => {
  it('stops accepting tuples beyond the editing cap', () => {
    const cells: [number, string, string][] = Array.from({ length: MAX_EDITS + 50 }, (_, i) => [
      i,
      'c0',
      `v${i}`,
    ]);
    const state = deserializeEdits({ format: 1, cells });
    let total = 0;
    for (const row of state.edits.values()) total += row.size;
    expect(total).toBe(MAX_EDITS);
  });
});
