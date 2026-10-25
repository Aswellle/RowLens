import { describe, expect, it } from 'vitest';
import {
  SAMPLE_METADATA,
  getRowCount,
  getRows,
  rowValues,
  sampleColumnIds,
  valueAt,
} from './sample';

describe('synthetic sample dataset', () => {
  it('is deterministic: rows are identical across reads', () => {
    expect(getRows(0, 3)).toEqual(getRows(0, 3));
    expect(getRows(100, 3)).toEqual(getRows(100, 3));
  });

  it('windowed reads respect bounds and never over-read', () => {
    expect(getRows(0, 10)).toHaveLength(10);
    expect(getRows(getRowCount() - 5, 100)).toHaveLength(5);
    expect(getRows(-10, 5)).toHaveLength(5);
  });

  it('has exactly 8 columns per row, matching the declared schema', () => {
    const ids = sampleColumnIds();
    expect(ids).toHaveLength(8);
    for (const row of getRows(0, 50)) {
      expect(row).toHaveLength(ids.length);
    }
  });

  it('preserves leading zeros in ticket ids (values stay strings)', () => {
    expect(rowValues(0)[0]).toBe('T-00001');
    expect(valueAt(123, 0)).toBe('T-00124');
  });

  it('returns null for out-of-range lookups instead of throwing', () => {
    expect(valueAt(getRowCount(), 0)).toBeNull();
    expect(valueAt(0, 99)).toBeNull();
  });

  it('metadata declares the full row count and zero parse errors', () => {
    expect(SAMPLE_METADATA.rowCount).toBe(getRowCount());
    expect(SAMPLE_METADATA.parseErrorCount).toBe(0);
  });
});
