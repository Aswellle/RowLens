import { describe, expect, it } from 'vitest';
import { trimmedColumnSet } from './display';
import type { CleaningStep } from './types';

const ALL = ['c0', 'c1', 'c2'];

const trimAll: CleaningStep = {
  id: 'a',
  type: 'trim',
  enabled: true,
  scope: { kind: 'all-columns' },
};

describe('trimmedColumnSet', () => {
  it('returns an empty set with no trim steps', () => {
    expect(trimmedColumnSet([], ALL)).toEqual(new Set());
    const other: CleaningStep = {
      id: 'x',
      type: 'remove-empty-rows',
      enabled: true,
      scope: { kind: 'all-columns' },
    };
    expect(trimmedColumnSet([other], ALL)).toEqual(new Set());
  });

  it('unions the scopes of every enabled trim step', () => {
    const scoped: CleaningStep = {
      id: 'b',
      type: 'trim',
      enabled: true,
      scope: { kind: 'columns', columnIds: ['c2'] },
    };
    expect(trimmedColumnSet([trimAll], ALL)).toEqual(new Set(['c0', 'c1', 'c2']));
    expect(trimmedColumnSet([scoped], ALL)).toEqual(new Set(['c2']));
    expect(trimmedColumnSet([scoped, trimAll], ALL)).toEqual(new Set(['c0', 'c1', 'c2']));
  });

  it('ignores disabled trim steps', () => {
    const disabled: CleaningStep = { ...trimAll, enabled: false };
    expect(trimmedColumnSet([disabled], ALL)).toEqual(new Set());
  });
});
