import { describe, expect, it } from 'vitest';
import type { CleaningStep } from './types';
import {
  PIPELINE_RECORD_FORMAT,
  deserializePipeline,
  isSupportedPipelineRecord,
  prunePipeline,
  pruneStep,
} from './persist';

const COLUMNS = new Set(['c0', 'c1', 'c2']);

function trim(id: string): CleaningStep {
  return { id, type: 'trim', enabled: true, scope: { kind: 'all-columns' } };
}

describe('pipeline record validation', () => {
  it('round-trips a full pipeline of every step type', () => {
    const steps: CleaningStep[] = [
      trim('s1'),
      {
        id: 's2',
        type: 'remove-empty-rows',
        enabled: false,
        scope: { kind: 'columns', columnIds: ['c0'] },
      },
      {
        id: 's3',
        type: 'remove-duplicates',
        enabled: true,
        keys: { kind: 'all-columns' },
        compare: 'trimmed',
      },
      { id: 's4', type: 'select-columns', enabled: true, columnIds: ['c0', 'c2'] },
    ];
    const restored = deserializePipeline({ format: PIPELINE_RECORD_FORMAT, steps }, COLUMNS);
    expect(restored).toEqual(steps);
  });

  it('drops a step whose explicit column list no longer exists', () => {
    // Silently widening to "all columns" would change what the step does.
    const restored = deserializePipeline(
      {
        format: PIPELINE_RECORD_FORMAT,
        steps: [
          {
            id: 's1',
            type: 'trim',
            enabled: true,
            scope: { kind: 'columns', columnIds: ['gone'] },
          },
          trim('s2'),
        ],
      },
      COLUMNS,
    );
    expect(restored.map((step) => step.id)).toEqual(['s2']);
  });

  it('keeps only the surviving columns of a partially stale list', () => {
    const restored = deserializePipeline(
      {
        format: PIPELINE_RECORD_FORMAT,
        steps: [
          {
            id: 's1',
            type: 'trim',
            enabled: true,
            scope: { kind: 'columns', columnIds: ['c0', 'gone', 'c1'] },
          },
        ],
      },
      COLUMNS,
    );
    expect(restored[0]).toEqual({
      id: 's1',
      type: 'trim',
      enabled: true,
      scope: { kind: 'columns', columnIds: ['c0', 'c1'] },
    });
  });

  it('rejects unknown step types, missing ids and malformed scopes', () => {
    const restored = deserializePipeline(
      {
        format: PIPELINE_RECORD_FORMAT,
        steps: [
          { id: 's1', type: 'sort-rows', enabled: true },
          { type: 'trim', enabled: true, scope: { kind: 'all-columns' } },
          { id: '', type: 'trim', enabled: true, scope: { kind: 'all-columns' } },
          { id: 's2', type: 'trim', enabled: true },
          { id: 's3', type: 'trim', enabled: true, scope: { kind: 'weird' } },
          'not a step',
          trim('ok'),
        ],
      },
      COLUMNS,
    );
    expect(restored.map((step) => step.id)).toEqual(['ok']);
  });

  it('defaults a missing enabled flag to true and a bad compare to exact', () => {
    const restored = deserializePipeline(
      {
        format: PIPELINE_RECORD_FORMAT,
        steps: [
          { id: 's1', type: 'trim', scope: { kind: 'all-columns' } },
          {
            id: 's2',
            type: 'remove-duplicates',
            keys: { kind: 'all-columns' },
            compare: 'fuzzy',
          },
        ],
      },
      COLUMNS,
    );
    expect(restored[0]?.enabled).toBe(true);
    expect(restored[1]).toMatchObject({ compare: 'exact' });
  });

  it('rejects a duplicated step id so two steps cannot edit each other', () => {
    const restored = deserializePipeline(
      {
        format: PIPELINE_RECORD_FORMAT,
        steps: [trim('same'), { ...trim('same'), enabled: false }],
      },
      COLUMNS,
    );
    expect(restored).toHaveLength(1);
    expect(restored[0]?.enabled).toBe(true);
  });

  it('returns an empty pipeline for unusable records', () => {
    expect(deserializePipeline(null, COLUMNS)).toEqual([]);
    expect(deserializePipeline({}, COLUMNS)).toEqual([]);
    expect(deserializePipeline({ steps: 'nope' }, COLUMNS)).toEqual([]);
    expect(deserializePipeline({ steps: [] }, COLUMNS)).toEqual([]);
  });

  it('recognises only its own record format', () => {
    expect(isSupportedPipelineRecord({ format: PIPELINE_RECORD_FORMAT, steps: [] })).toBe(true);
    expect(isSupportedPipelineRecord({ format: 9, steps: [] })).toBe(false);
    expect(isSupportedPipelineRecord({ steps: [] })).toBe(false);
    expect(isSupportedPipelineRecord(null)).toBe(false);
  });

  it('validates a single step without a record wrapper', () => {
    expect(pruneStep(trim('a'), COLUMNS)).toEqual(trim('a'));
    expect(pruneStep({ id: 'a', type: 'nope' }, COLUMNS)).toBeNull();
  });
});

describe('pruning an in-memory pipeline', () => {
  it('returns the same array when nothing references a missing column', () => {
    const steps = [trim('s1')];
    expect(prunePipeline(steps, COLUMNS)).toBe(steps);
  });

  it('drops steps whose columns are gone', () => {
    const steps: CleaningStep[] = [
      trim('s1'),
      { id: 's2', type: 'select-columns', enabled: true, columnIds: ['gone'] },
    ];
    expect(prunePipeline(steps, COLUMNS).map((step) => step.id)).toEqual(['s1']);
  });

  it('narrows a partially stale column list in place', () => {
    const steps: CleaningStep[] = [
      { id: 's1', type: 'select-columns', enabled: true, columnIds: ['c0', 'gone'] },
    ];
    expect(prunePipeline(steps, COLUMNS)).toEqual([
      { id: 's1', type: 'select-columns', enabled: true, columnIds: ['c0'] },
    ]);
  });

  it('returns the same array for an empty pipeline', () => {
    const steps: CleaningStep[] = [];
    expect(prunePipeline(steps, COLUMNS)).toBe(steps);
  });
});
