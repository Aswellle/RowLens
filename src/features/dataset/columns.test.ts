import { describe, expect, it } from 'vitest';
import { csvColumnId, deriveColumnsFromHeader, generateColumnsForCount } from './columns';
import type { ColumnDefinition } from './types';

describe('deriveColumnsFromHeader', () => {
  it('uses header cells verbatim as labels and positional ids', () => {
    const columns = deriveColumnsFromHeader(['name', 'amount', 'note'], {
      hasHeader: true,
    });
    expect(columns).toEqual<ColumnDefinition[]>([
      { id: 'c0', label: 'name', sourceIndex: 0 },
      { id: 'c1', label: 'amount', sourceIndex: 1 },
      { id: 'c2', label: 'note', sourceIndex: 2 },
    ]);
  });

  it('keeps duplicate headers as separate columns instead of merging them', () => {
    const columns = deriveColumnsFromHeader(['id', 'id', 'id'], {
      hasHeader: true,
    });
    expect(columns.map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);
    expect(columns.map((c) => c.label)).toEqual(['id', 'id', 'id']);
  });

  it('assigns a stable placeholder label to empty header cells', () => {
    const columns = deriveColumnsFromHeader(['', null, 'valid'], {
      hasHeader: true,
    });
    expect(columns.map((c) => c.label)).toEqual(['Column 1', 'Column 2', 'valid']);
    expect(columns.map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);
  });

  it('does not trim or normalise header labels', () => {
    const columns = deriveColumnsFromHeader(['  spaced  ', 'MiXeD'], {
      hasHeader: true,
    });
    expect(columns[0]?.label).toBe('  spaced  ');
    expect(columns[1]?.label).toBe('MiXeD');
  });

  it('ignores header content entirely when hasHeader is false', () => {
    const columns = deriveColumnsFromHeader(['ignored', 'header', 'cells'], {
      hasHeader: false,
    });
    expect(columns.map((c) => c.label)).toEqual(['Column 1', 'Column 2', 'Column 3']);
    expect(columns.every((c) => typeof c.sourceIndex === 'number')).toBe(true);
  });

  it('supports unicode labels without alteration', () => {
    const columns = deriveColumnsFromHeader(['名前', 'コメント'], {
      hasHeader: true,
    });
    expect(columns.map((c) => c.label)).toEqual(['名前', 'コメント']);
  });
});

describe('generateColumnsForCount', () => {
  it('generates positional columns for headerless files', () => {
    const columns = generateColumnsForCount(3);
    expect(columns).toEqual<ColumnDefinition[]>([
      { id: 'c0', label: 'Column 1', sourceIndex: 0 },
      { id: 'c1', label: 'Column 2', sourceIndex: 1 },
      { id: 'c2', label: 'Column 3', sourceIndex: 2 },
    ]);
  });

  it('rejects non-positive and fractional counts', () => {
    expect(generateColumnsForCount(0)).toEqual([]);
    expect(generateColumnsForCount(-5)).toEqual([]);
    expect(generateColumnsForCount(2.9)).toHaveLength(2);
  });
});

describe('csvColumnId', () => {
  it('is stable and collision-free for the first thousand columns', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => csvColumnId(i));
    expect(new Set(ids).size).toBe(1000);
    expect(ids[0]).toBe('c0');
    expect(ids[999]).toBe('c999');
  });
});
