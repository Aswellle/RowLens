import { describe, expect, it } from 'vitest';
import { DEFAULT_SAMPLE_ROWS, createSampleDataset } from './sample';

describe('synthetic sample dataset', () => {
  const sample = createSampleDataset(500);

  it('is deterministic: rows are identical across reads and instances', () => {
    expect(sample.getRows(0, 3)).toEqual(sample.getRows(0, 3));
    expect(createSampleDataset(500).getRows(100, 3)).toEqual(sample.getRows(100, 3));
  });

  it('windowed reads respect bounds and never over-read', () => {
    expect(sample.getRows(0, 10)).toHaveLength(10);
    expect(sample.getRows(sample.getRowCount() - 5, 100)).toHaveLength(5);
    expect(sample.getRows(-10, 5)).toHaveLength(5);
  });

  it('has exactly 8 columns per row, matching the declared schema', () => {
    expect(sample.columnIds).toHaveLength(8);
    for (const row of sample.getRows(0, 50)) {
      expect(row).toHaveLength(8);
    }
  });

  it('preserves leading zeros in ticket ids (values stay strings)', () => {
    expect(sample.rowValues(0)[0]).toBe('T-00001');
    expect(sample.valueAt(123, 0)).toBe('T-00124');
  });

  it('returns null for out-of-range lookups instead of throwing', () => {
    expect(sample.valueAt(sample.getRowCount(), 0)).toBeNull();
    expect(sample.valueAt(0, 99)).toBeNull();
  });

  it('metadata declares the full row count and zero parse errors', () => {
    expect(sample.metadata.rowCount).toBe(sample.getRowCount());
    expect(sample.metadata.parseErrorCount).toBe(0);
  });

  it('default sample keeps the documented size used by the app', () => {
    const full = createSampleDataset();
    expect(full.getRowCount()).toBe(DEFAULT_SAMPLE_ROWS);
  });

  it('supports small sizes for fast tests', () => {
    const tiny = createSampleDataset(3);
    expect(tiny.getRowCount()).toBe(3);
    expect(tiny.rowValues(2)[0]).toBe('T-00003');
  });
});
