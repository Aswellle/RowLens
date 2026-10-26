import { describe, expect, it } from 'vitest';
import {
  MAX_EDITS,
  applyEdits,
  applyOverrides,
  canRedo,
  canUndo,
  clearEdits,
  editCount,
  editedValue,
  emptyEditState,
  hasEdits,
  overridesForQuery,
  redoEdits,
  undoEdits,
  wouldExceedCap,
  type EditInput,
} from './edits';

/**
 * `displayed` is what the user saw; `after` is the value they typed (empty
 * string blanks the cell). The overlay records the previous *overlay* value,
 * so consecutive undos walk back through the edit history rather than jumping
 * straight to the stored value.
 */
function input(
  rowIndex: number,
  columnId: string,
  displayed: string | null,
  after: string,
  stored: string | null = null,
): EditInput {
  return { rowIndex, columnId, displayed, stored, after };
}

describe('edit overlay', () => {
  it('records a value and exposes it through editedValue', () => {
    const state = applyEdits(emptyEditState(), [input(3, 'c1', 'old', 'new')]);
    expect(editedValue(state, 3, 'c1')).toBe('new');
    expect(editedValue(state, 3, 'c2')).toBeUndefined();
    expect(editedValue(state, 4, 'c1')).toBeUndefined();
    expect(editCount(state)).toBe(1);
    expect(hasEdits(state)).toBe(true);
  });

  it('ignores an edit that writes the value already displayed', () => {
    // No undo entry for a change the user cannot perceive.
    const state = applyEdits(emptyEditState(), [input(0, 'c0', 'same', 'same')]);
    expect(state).toEqual(emptyEditState());
    expect(canUndo(state)).toBe(false);
  });

  it('undoes and redoes a single edit', () => {
    const edited = applyEdits(emptyEditState(), [input(1, 'c0', 'a', 'b')]);
    const undone = undoEdits(edited);
    expect(editedValue(undone, 1, 'c0')).toBeUndefined();
    expect(canUndo(undone)).toBe(false);
    expect(canRedo(undone)).toBe(true);

    const redone = redoEdits(undone);
    expect(editedValue(redone, 1, 'c0')).toBe('b');
    expect(canRedo(redone)).toBe(false);
  });

  it('walks back through successive edits of the same cell', () => {
    let state = applyEdits(emptyEditState(), [input(0, 'c0', 'v1', 'v2')]);
    state = applyEdits(state, [input(0, 'c0', 'v2', 'v3')]);
    expect(editedValue(state, 0, 'c0')).toBe('v3');
    state = undoEdits(state);
    expect(editedValue(state, 0, 'c0')).toBe('v2');
    state = undoEdits(state);
    expect(editedValue(state, 0, 'c0')).toBeUndefined();
    expect(editCount(state)).toBe(0);
  });

  it('drops the redo branch once a new edit lands', () => {
    let state = applyEdits(emptyEditState(), [input(0, 'c0', 'a', 'b')]);
    state = undoEdits(state);
    expect(canRedo(state)).toBe(true);
    state = applyEdits(state, [input(0, 'c1', 'x', 'y')]);
    expect(canRedo(state)).toBe(false);
  });

  it('treats an emptied cell as a real edit, distinct from no override', () => {
    // Typing over a stored "text" with nothing leaves a real blank edit.
    const state = applyEdits(emptyEditState(), [input(2, 'c3', 'text', '', 'text')]);
    expect(editedValue(state, 2, 'c3')).toBe('');
    expect(editCount(state)).toBe(1);
    const undone = undoEdits(state);
    expect(editedValue(undone, 2, 'c3')).toBeUndefined();
  });

  it('drops an override when the user retypes the stored value', () => {
    // Retyping the stored value makes the cell indistinguishable from the
    // original, so the overlay entry is removed rather than kept as a copy.
    let state = applyEdits(emptyEditState(), [input(4, 'c0', 'stored', 'changed', 'stored')]);
    expect(editedValue(state, 4, 'c0')).toBe('changed');
    state = applyEdits(state, [input(4, 'c0', 'changed', 'stored', 'stored')]);
    // Typing the original back leaves no override at all.
    expect(editedValue(state, 4, 'c0')).toBeUndefined();
    // Undo still walks back through the recorded action.
    state = undoEdits(state);
    expect(editedValue(state, 4, 'c0')).toBe('changed');
  });

  it('clears every edit as one undoable action', () => {
    let state = applyEdits(emptyEditState(), [input(0, 'c0', 'a', 'b'), input(5, 'c2', null, 'x')]);
    expect(editCount(state)).toBe(2);

    state = clearEdits(state);
    expect(editCount(state)).toBe(0);
    expect(hasEdits(state)).toBe(false);

    // "Reset edits" is itself undoable, restoring both cells.
    state = undoEdits(state);
    expect(editedValue(state, 0, 'c0')).toBe('b');
    expect(editedValue(state, 5, 'c2')).toBe('x');
  });

  it('does nothing when undoing or redoing an empty history', () => {
    const state = emptyEditState();
    expect(undoEdits(state)).toBe(state);
    expect(redoEdits(state)).toBe(state);
    expect(clearEdits(state)).toBe(state);
  });

  it('bumps the revision on every applied change and undo', () => {
    const a = applyEdits(emptyEditState(), [input(0, 'c0', 'a', 'b')]);
    const b = applyEdits(a, [input(1, 'c0', 'a', 'b')]);
    const c = undoEdits(b);
    expect(a.revision).toBe(1);
    expect(b.revision).toBe(2);
    expect(c.revision).toBe(3);
  });

  it('keeps the undo stack untouched when a no-op edit arrives', () => {
    const state = applyEdits(emptyEditState(), [input(0, 'c0', 'a', 'b')]);
    const same = applyEdits(state, [input(0, 'c0', 'b', 'b')]);
    expect(same).toBe(state);
    expect(same.undoStack).toHaveLength(1);
  });
});

describe('overlay cap', () => {
  it('allows edits up to the cap and refuses the one past it', () => {
    // One cell below the cap: the last slot is still usable.
    const oneBelow = {
      ...emptyEditState(),
      edits: new Map(
        Array.from({ length: MAX_EDITS - 1 }, (_, i) => [i, new Map([['c0', 'x']])] as const),
      ),
    };
    expect(editCount(oneBelow)).toBe(MAX_EDITS - 1);
    expect(wouldExceedCap(oneBelow, [input(MAX_EDITS - 1, 'c0', null, 'y')])).toBe(false);

    // At the cap: a new cell is refused, an existing one can still be edited.
    const atCap = {
      ...emptyEditState(),
      edits: new Map(
        Array.from({ length: MAX_EDITS }, (_, i) => [i, new Map([['c0', 'x']])] as const),
      ),
    };
    expect(wouldExceedCap(atCap, [input(MAX_EDITS, 'c0', null, 'y')])).toBe(true);
    expect(wouldExceedCap(atCap, [input(0, 'c0', 'x', 'z')])).toBe(false);
  });

  it('counts a batch by distinct cells, not by list length', () => {
    const state = emptyEditState();
    const batch = [input(0, 'c0', null, 'a'), input(0, 'c0', null, 'b')];
    expect(wouldExceedCap(state, batch)).toBe(false);
  });

  it('does not count re-editing an existing override as a new cell', () => {
    const full = {
      ...emptyEditState(),
      edits: new Map(
        Array.from({ length: MAX_EDITS }, (_, i) => [i, new Map([['c0', 'x']])] as const),
      ),
    };
    expect(wouldExceedCap(full, [input(0, 'c0', 'x', 'y')])).toBe(false);
  });
});

describe('query overrides', () => {
  it('groups edits per row in row order', () => {
    const state = applyEdits(emptyEditState(), [
      input(9, 'c1', 'a', 'b'),
      input(2, 'c3', 'c', 'd'),
      input(2, 'c0', 'e', 'f'),
    ]);
    expect(overridesForQuery(state)).toEqual([
      { rowIndex: 2, values: { c0: 'f', c3: 'd' } },
      { rowIndex: 9, values: { c1: 'b' } },
    ]);
  });

  it('returns nothing for an unedited dataset', () => {
    expect(overridesForQuery(emptyEditState())).toEqual([]);
  });

  it('applies an override without mutating the stored values', () => {
    const stored = { c0: 'a', c1: null };
    const applied = applyOverrides(stored, { c1: 'edited' });
    expect(applied).toEqual({ c0: 'a', c1: 'edited' });
    expect(stored).toEqual({ c0: 'a', c1: null });
    // No override: the same object is returned, so scans stay allocation-free.
    expect(applyOverrides(stored, undefined)).toBe(stored);
  });
});
