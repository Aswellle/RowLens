import { describe, expect, it } from 'vitest';
import type { ViewState } from './persist';
import {
  VIEW_RECORD_FORMAT,
  deserializeView,
  emptyView,
  isActiveView,
  isSupportedViewRecord,
  pruneView,
  serializeView,
  viewSignature,
} from './persist';

const COLUMNS = new Set(['c0', 'c1', 'c2']);

function view(overrides: Partial<ViewState> = {}): ViewState {
  return { ...emptyView(), ...overrides };
}

describe('view record round trip', () => {
  it('round-trips a view using every field', () => {
    const original = view({
      search: 'north',
      columnFilters: { c0: 'T-0', c2: 'open' },
      sort: { columnId: 'c1', direction: 'desc' },
      hiddenColumns: ['c2'],
    });
    const record = serializeView(original, 'ds-1', 1234);
    expect(record.format).toBe(VIEW_RECORD_FORMAT);
    expect(record.datasetId).toBe('ds-1');
    expect(record.updatedAt).toBe(1234);
    expect(deserializeView(record, COLUMNS)).toEqual(original);
  });

  it('stores the sort by column id, not by position', () => {
    const record = serializeView(view({ sort: { columnId: 'c2', direction: 'asc' } }), 'ds-1', 1);
    expect(record.sort).toEqual({ columnId: 'c2', direction: 'asc' });
  });

  it('omits empty filter values so "no restriction" is not stored', () => {
    const record = serializeView(view({ columnFilters: { c0: '', c1: 'x' } }), 'ds-1', 1);
    expect(record.columnFilters).toEqual({ c1: 'x' });
    expect(deserializeView(record, COLUMNS)).toEqual(view({ columnFilters: { c1: 'x' } }));
  });

  it('serializes filter keys in a stable order', () => {
    const a = serializeView(view({ columnFilters: { c2: 'y', c0: 'x' } }), 'ds-1', 1);
    const b = serializeView(view({ columnFilters: { c0: 'x', c2: 'y' } }), 'ds-1', 2);
    expect(Object.keys(a.columnFilters)).toEqual(['c0', 'c2']);
    expect(a.columnFilters).toEqual(b.columnFilters);
  });
});

describe('view record validation', () => {
  it('drops a filter whose column no longer exists', () => {
    const restored = deserializeView(
      { format: VIEW_RECORD_FORMAT, search: 'q', columnFilters: { c0: 'a', gone: 'b' } },
      COLUMNS,
    );
    expect(restored.columnFilters).toEqual({ c0: 'a' });
    expect(restored.search).toBe('q');
  });

  it('ignores a crafted filter key instead of assigning it', () => {
    // JSON.parse creates a real own "__proto__" property, which an object
    // literal cannot express — this is the shape a hand-edited record has.
    const crafted = JSON.parse(
      '{"format":1,"columnFilters":{"__proto__":"x","c0":"ok"}}',
    ) as unknown;
    const restored = deserializeView(crafted, COLUMNS);
    expect(Object.keys(restored.columnFilters)).toEqual(['c0']);
    expect(restored.columnFilters).toEqual({ c0: 'ok' });
    expect(Object.getPrototypeOf(restored.columnFilters)).toBe(Object.prototype);
  });

  it('drops a sort on a column that no longer exists', () => {
    expect(
      deserializeView(
        { format: VIEW_RECORD_FORMAT, sort: { columnId: 'gone', direction: 'asc' } },
        COLUMNS,
      ).sort,
    ).toBeNull();
  });

  it('drops a sort with an unknown direction', () => {
    expect(
      deserializeView(
        { format: VIEW_RECORD_FORMAT, sort: { columnId: 'c0', direction: 'sideways' } },
        COLUMNS,
      ).sort,
    ).toBeNull();
  });

  it('drops hidden columns that no longer exist', () => {
    expect(
      deserializeView({ format: VIEW_RECORD_FORMAT, hiddenColumns: ['c1', 'gone'] }, COLUMNS)
        .hiddenColumns,
    ).toEqual(['c1']);
  });

  it('refuses to restore a view that hides every column', () => {
    // That state leaves no grid to interact with, so it restores as "nothing
    // hidden" rather than reproducing a dead end.
    expect(
      deserializeView({ format: VIEW_RECORD_FORMAT, hiddenColumns: ['c0', 'c1', 'c2'] }, COLUMNS)
        .hiddenColumns,
    ).toEqual([]);
  });

  it('drops an over-long search term as a corrupt record', () => {
    const restored = deserializeView(
      { format: VIEW_RECORD_FORMAT, search: 'x'.repeat(2_001) },
      COLUMNS,
    );
    expect(restored.search).toBe('');
  });

  it('treats a non-record as an empty view', () => {
    expect(deserializeView(null, COLUMNS)).toEqual(emptyView());
    expect(deserializeView('nope', COLUMNS)).toEqual(emptyView());
    expect(deserializeView({}, COLUMNS)).toEqual(emptyView());
  });

  it('keeps valid fields when another field is unusable', () => {
    const restored = deserializeView(
      {
        format: VIEW_RECORD_FORMAT,
        search: 'kept',
        columnFilters: 'not-an-object',
        sort: { columnId: 'c1', direction: 'asc' },
      },
      COLUMNS,
    );
    expect(restored).toEqual(view({ search: 'kept', sort: { columnId: 'c1', direction: 'asc' } }));
  });

  it('accepts only the known record format', () => {
    expect(isSupportedViewRecord({ format: VIEW_RECORD_FORMAT })).toBe(true);
    expect(isSupportedViewRecord({ format: 2 })).toBe(false);
    expect(isSupportedViewRecord(null)).toBe(false);
  });
});

describe('view activity and pruning', () => {
  it('reports an untouched view as inactive', () => {
    expect(isActiveView(emptyView())).toBe(false);
    expect(isActiveView(view({ columnFilters: { c0: '' } }))).toBe(false);
  });

  it('reports each kind of restriction as active', () => {
    expect(isActiveView(view({ search: 'q' }))).toBe(true);
    expect(isActiveView(view({ columnFilters: { c0: 'x' } }))).toBe(true);
    expect(isActiveView(view({ sort: { columnId: 'c0', direction: 'asc' } }))).toBe(true);
    expect(isActiveView(view({ hiddenColumns: ['c0'] }))).toBe(true);
  });

  it('returns the same object when everything still applies', () => {
    const current = view({ search: 'q', columnFilters: { c0: 'x' }, sort: null });
    expect(pruneView(current, COLUMNS)).toBe(current);
  });

  it('narrows a view whose columns disappeared', () => {
    const current = view({
      search: 'q',
      columnFilters: { c0: 'x', gone: 'y' },
      sort: { columnId: 'gone', direction: 'asc' },
      hiddenColumns: ['c1'],
    });
    expect(pruneView(current, COLUMNS)).toEqual(
      view({ search: 'q', columnFilters: { c0: 'x' }, sort: null, hiddenColumns: ['c1'] }),
    );
  });

  it('produces the same signature for equal views regardless of key order', () => {
    const a = view({ columnFilters: { c2: 'y', c0: 'x' }, search: 'q' });
    const b = view({ columnFilters: { c0: 'x', c2: 'y' }, search: 'q' });
    expect(viewSignature(a)).toBe(viewSignature(b));
  });

  it('changes the signature when a field changes', () => {
    expect(viewSignature(view({ search: 'a' }))).not.toBe(viewSignature(view({ search: 'b' })));
    expect(viewSignature(view({ hiddenColumns: ['c0'] }))).not.toBe(
      viewSignature(view({ hiddenColumns: [] })),
    );
  });

  it('ignores empty filter values in the signature', () => {
    expect(viewSignature(view({ columnFilters: { c0: '' } }))).toBe(viewSignature(emptyView()));
  });
});
