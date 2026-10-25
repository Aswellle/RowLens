import { describe, expect, it } from 'vitest';
import { compareCellValues, matchesLiteral, rowMatchesSearch, sortIndicesStable } from './literal';

describe('matchesLiteral', () => {
  it('matches case-insensitively as a literal substring', () => {
    expect(matchesLiteral('Open Ticket', 'ticket')).toBe(true);
    expect(matchesLiteral('Open Ticket', 'OPEN')).toBe(true);
  });

  it('never treats the input as a regular expression', () => {
    expect(matchesLiteral('a.c value', '.')).toBe(true); // regex '.' would match anywhere anyway
    expect(matchesLiteral('plain text', 'a{2}')).toBe(false); // regex would need 'aa'
    expect(matchesLiteral('cost [high]', '[high]')).toBe(true); // char class as literal
    expect(matchesLiteral('abc', 'B*C')).toBe(false);
  });

  it('treats an empty needle as match-all and never matches null/undefined', () => {
    expect(matchesLiteral(null, '')).toBe(true);
    expect(matchesLiteral('anything', '')).toBe(true);
    expect(matchesLiteral(null, 'x')).toBe(false);
    expect(matchesLiteral(undefined, 'x')).toBe(false);
  });
});

describe('rowMatchesSearch', () => {
  it('is true when any cell matches', () => {
    expect(rowMatchesSearch(['a', 'b', 'c'], 'B')).toBe(true);
    expect(rowMatchesSearch(['a', null, 'c'], 'c')).toBe(true);
    expect(rowMatchesSearch(['a', null], 'z')).toBe(false);
  });
});

describe('compareCellValues', () => {
  it('sorts by UTF-16 string order without numeric or date inference', () => {
    expect(compareCellValues('00123', '123')).toBe(-1); // '0' < '1'
    expect(compareCellValues('2024-01-02', '2024-01-10')).toBeLessThan(0);
    expect(compareCellValues('9', '10')).toBe(1); // string order, not numeric
  });

  it('places missing values last regardless of call order', () => {
    expect(compareCellValues(null, 'a')).toBe(1);
    expect(compareCellValues('a', null)).toBe(-1);
    expect(compareCellValues(null, null)).toBe(0);
  });
});

describe('sortIndicesStable', () => {
  const values = ['b', 'a', 'b', null, 'a'];

  it('keeps equal values in original relative order (ascending)', () => {
    expect(sortIndicesStable([0, 1, 2, 3, 4], (i) => values[i] ?? null, 'asc')).toEqual([
      1, 4, 0, 2, 3,
    ]);
  });

  it('keeps equal values in original relative order and missing last (descending)', () => {
    expect(sortIndicesStable([0, 1, 2, 3, 4], (i) => values[i] ?? null, 'desc')).toEqual([
      0, 2, 1, 4, 3,
    ]);
  });

  it('does not mutate the input index list', () => {
    const input = [2, 1, 0];
    sortIndicesStable(input, (i) => String(i), 'asc');
    expect(input).toEqual([2, 1, 0]);
  });
});
