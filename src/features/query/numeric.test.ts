import { describe, expect, it } from 'vitest';
import { parseSortableNumber, sortIndicesNumeric } from './numeric';

describe('parseSortableNumber', () => {
  it('accepts plain integers and decimals with an optional sign', () => {
    expect(parseSortableNumber('9')).toBe(9);
    expect(parseSortableNumber('00123')).toBe(123);
    expect(parseSortableNumber('-12')).toBe(-12);
    expect(parseSortableNumber('+3.5')).toBe(3.5);
    expect(parseSortableNumber('.5')).toBe(0.5);
    expect(parseSortableNumber('12.')).toBe(12);
  });

  it('accepts exponent notation', () => {
    expect(parseSortableNumber('1e3')).toBe(1000);
    expect(parseSortableNumber('-2.5E-2')).toBe(-0.025);
  });

  it('accepts strict en-US thousands grouping', () => {
    expect(parseSortableNumber('1,050')).toBe(1050);
    expect(parseSortableNumber('12,345,678')).toBe(12345678);
    expect(parseSortableNumber('-1,050.25')).toBe(-1050.25);
  });

  it('rejects grouping that is not strictly three digits', () => {
    // Reinterpreting "1,05" as 105 would silently change the data.
    expect(parseSortableNumber('1,05')).toBeNull();
    expect(parseSortableNumber(',123')).toBeNull();
    expect(parseSortableNumber('123,')).toBeNull();
    expect(parseSortableNumber('1,2345')).toBeNull();
  });

  it('rejects values Number() would accept but data should not mean', () => {
    expect(parseSortableNumber('0x1a')).toBeNull();
    expect(parseSortableNumber('Infinity')).toBeNull();
    expect(parseSortableNumber('NaN')).toBeNull();
    expect(parseSortableNumber('')).toBeNull();
    expect(parseSortableNumber('   ')).toBeNull();
  });

  it('rejects text and ignores surrounding whitespace only', () => {
    expect(parseSortableNumber('N/A')).toBeNull();
    expect(parseSortableNumber('$4')).toBeNull();
    expect(parseSortableNumber('1 2')).toBeNull();
    expect(parseSortableNumber(' 42 ')).toBe(42);
    expect(parseSortableNumber(null)).toBeNull();
  });
});

describe('sortIndicesNumeric', () => {
  const rows: (string | null)[] = ['9', '1,050', '00123', 'N/A', '', null, '42'];

  function order(indices: number[], direction: 'asc' | 'desc' = 'asc'): (string | null)[] {
    return sortIndicesNumeric(indices, (index) => rows[index] ?? null, direction).map(
      (index) => rows[index] ?? null,
    );
  }

  it('sorts numbers numerically, not lexicographically', () => {
    expect(order([0, 1, 2, 6])).toEqual(['9', '42', '00123', '1,050']);
  });

  it('partitions non-numeric text after every number', () => {
    expect(order([0, 3, 1])).toEqual(['9', '1,050', 'N/A']);
  });

  it('sorts empty cells and null last in both directions', () => {
    expect(order([4, 5, 0])).toEqual(['9', '', null]);
    expect(order([4, 5, 0], 'desc')).toEqual(['9', '', null]);
  });

  it('reverses numbers and text inside their partitions on descend', () => {
    // Numbers reverse; the N/A text partition and the empty partition keep
    // their position after the numbers.
    expect(order([0, 1, 2, 6, 3], 'desc')).toEqual(['1,050', '00123', '42', '9', 'N/A']);
  });

  it('keeps original order for equal keys (stability)', () => {
    const ties = ['2', '10', '2', '10'];
    const sorted = sortIndicesNumeric([0, 1, 2, 3], (index) => ties[index] ?? null, 'asc');
    expect(sorted).toEqual([0, 2, 1, 3]);
  });

  it('keeps original order for equal non-numeric keys (stability)', () => {
    const ties = ['b', 'a', 'b'];
    const sorted = sortIndicesNumeric([0, 1, 2], (index) => ties[index] ?? null, 'asc');
    expect(sorted).toEqual([1, 0, 2]);
  });

  it('treats whitespace-padded numbers as numbers', () => {
    const padded = [' 7 ', ' 42'];
    expect(sortIndicesNumeric([0, 1], (index) => padded[index] ?? null, 'asc')).toEqual([0, 1]);
  });
});
