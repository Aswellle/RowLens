import { describe, expect, it } from 'vitest';
import type { CleaningStep } from './types';
import {
  MAX_PRESETS,
  PRESET_RECORD_FORMAT,
  applyPreset,
  capturePresetSteps,
  deserializePresets,
  isSupportedPresetRecord,
  normalizePresetName,
  presetSummary,
  prunePreset,
  prunePresetStep,
  type CleaningPreset,
  type PresetColumn,
} from './presets';

const COLUMNS: PresetColumn[] = [
  { id: 'c0', label: 'Ticket' },
  { id: 'c1', label: 'Status' },
  { id: 'c2', label: 'Note' },
];

/** A dataset where the same labels sit in different positions. */
const OTHER: PresetColumn[] = [
  { id: 'c0', label: 'Note' },
  { id: 'c1', label: 'Ticket' },
  { id: 'c2', label: 'Status' },
  { id: 'c3', label: 'Extra' },
];

function counter(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

function preset(steps: CleaningPreset['steps']): CleaningPreset {
  return { id: 'p1', name: 'Recipe', createdAt: 1, updatedAt: 1, steps };
}

describe('capturing a preset', () => {
  it('translates column ids to header labels', () => {
    const steps: CleaningStep[] = [
      { id: 's1', type: 'trim', enabled: true, scope: { kind: 'columns', columnIds: ['c1'] } },
    ];
    const { steps: captured } = capturePresetSteps(steps, COLUMNS);
    expect(captured).toEqual([
      { type: 'trim', enabled: true, scope: { kind: 'labels', labels: ['Status'] } },
    ]);
  });

  it('keeps all-columns scopes as they are', () => {
    const steps: CleaningStep[] = [
      { id: 's1', type: 'remove-empty-rows', enabled: false, scope: { kind: 'all-columns' } },
    ];
    expect(capturePresetSteps(steps, COLUMNS).steps).toEqual([
      { type: 'remove-empty-rows', enabled: false, scope: { kind: 'all-columns' } },
    ]);
  });

  it('captures every step type', () => {
    const steps: CleaningStep[] = [
      { id: 's1', type: 'trim', enabled: true, scope: { kind: 'all-columns' } },
      { id: 's2', type: 'remove-empty-rows', enabled: true, scope: { kind: 'all-columns' } },
      {
        id: 's3',
        type: 'remove-duplicates',
        enabled: true,
        keys: { kind: 'columns', columnIds: ['c0', 'c1'] },
        compare: 'trimmed',
      },
      { id: 's4', type: 'select-columns', enabled: true, columnIds: ['c0', 'c2'] },
    ];
    const { steps: captured, droppedSteps } = capturePresetSteps(steps, COLUMNS);
    expect(droppedSteps).toBe(0);
    expect(captured).toHaveLength(4);
    expect(captured[2]).toEqual({
      type: 'remove-duplicates',
      enabled: true,
      keys: { kind: 'labels', labels: ['Ticket', 'Status'] },
      compare: 'trimmed',
    });
    expect(captured[3]).toEqual({
      type: 'select-columns',
      enabled: true,
      labels: ['Ticket', 'Note'],
    });
  });

  it('drops a step whose columns are all duplicate headers', () => {
    const duplicated: PresetColumn[] = [
      { id: 'c0', label: 'Name' },
      { id: 'c1', label: 'Name' },
    ];
    const steps: CleaningStep[] = [
      { id: 's1', type: 'trim', enabled: true, scope: { kind: 'columns', columnIds: ['c0'] } },
      { id: 's2', type: 'trim', enabled: true, scope: { kind: 'all-columns' } },
    ];
    const {
      steps: captured,
      droppedSteps,
      ambiguousColumns,
    } = capturePresetSteps(steps, duplicated);
    // The ambiguous step is dropped, the unambiguous one survives.
    expect(droppedSteps).toBe(1);
    expect(ambiguousColumns).toBe(1);
    expect(captured).toEqual([{ type: 'trim', enabled: true, scope: { kind: 'all-columns' } }]);
  });

  it('keeps the unambiguous labels of a partly ambiguous scope', () => {
    const duplicated: PresetColumn[] = [
      { id: 'c0', label: 'Name' },
      { id: 'c1', label: 'Name' },
      { id: 'c2', label: 'City' },
    ];
    const steps: CleaningStep[] = [
      {
        id: 's1',
        type: 'trim',
        enabled: true,
        scope: { kind: 'columns', columnIds: ['c0', 'c2'] },
      },
    ];
    const { steps: captured, ambiguousColumns } = capturePresetSteps(steps, duplicated);
    expect(captured).toEqual([
      { type: 'trim', enabled: true, scope: { kind: 'labels', labels: ['City'] } },
    ]);
    expect(ambiguousColumns).toBe(1);
  });
});

describe('applying a preset', () => {
  it('resolves labels to the target dataset columns, which sit elsewhere', () => {
    const recipe = preset([
      { type: 'trim', enabled: true, scope: { kind: 'labels', labels: ['Status'] } },
    ]);
    const { steps, droppedSteps, unresolvedLabels } = applyPreset(recipe, OTHER, counter());
    expect(droppedSteps).toBe(0);
    expect(unresolvedLabels).toBe(0);
    // "Status" is c2 in OTHER, not c1 as it was where the preset was captured.
    expect(steps).toEqual([
      { id: 'new-1', type: 'trim', enabled: true, scope: { kind: 'columns', columnIds: ['c2'] } },
    ]);
  });

  it('gives every applied step a fresh id', () => {
    const recipe = preset([
      { type: 'trim', enabled: true, scope: { kind: 'all-columns' } },
      { type: 'remove-empty-rows', enabled: true, scope: { kind: 'all-columns' } },
    ]);
    const ids = applyPreset(recipe, OTHER, counter()).steps.map((step) => step.id);
    expect(ids).toEqual(['new-1', 'new-2']);
    expect(new Set(ids).size).toBe(2);
  });

  it('drops a step whose labels all vanished instead of widening it', () => {
    const recipe = preset([
      { type: 'trim', enabled: true, scope: { kind: 'labels', labels: ['Gone'] } },
    ]);
    const { steps, droppedSteps, unresolvedLabels } = applyPreset(recipe, OTHER, counter());
    expect(steps).toEqual([]);
    expect(droppedSteps).toBe(1);
    expect(unresolvedLabels).toBe(1);
  });

  it('drops a label that matches two columns rather than picking one', () => {
    const duplicated: PresetColumn[] = [
      { id: 'c0', label: 'Name' },
      { id: 'c1', label: 'Name' },
    ];
    const recipe = preset([
      { type: 'trim', enabled: true, scope: { kind: 'labels', labels: ['Name'] } },
    ]);
    const { steps, unresolvedLabels } = applyPreset(recipe, duplicated, counter());
    expect(steps).toEqual([]);
    expect(unresolvedLabels).toBe(1);
  });

  it('narrows a partly resolvable scope to the labels that do match', () => {
    const recipe = preset([
      { type: 'select-columns', enabled: true, labels: ['Ticket', 'Missing', 'Note'] },
    ]);
    const { steps, unresolvedLabels } = applyPreset(recipe, OTHER, counter());
    expect(steps).toEqual([
      { id: 'new-1', type: 'select-columns', enabled: true, columnIds: ['c1', 'c0'] },
    ]);
    expect(unresolvedLabels).toBe(1);
  });

  it('preserves the enabled flag and the dedupe comparison mode', () => {
    const recipe = preset([
      {
        type: 'remove-duplicates',
        enabled: false,
        keys: { kind: 'all-columns' },
        compare: 'trimmed',
      },
    ]);
    expect(applyPreset(recipe, OTHER, counter()).steps).toEqual([
      {
        id: 'new-1',
        type: 'remove-duplicates',
        enabled: false,
        keys: { kind: 'all-columns' },
        compare: 'trimmed',
      },
    ]);
  });
});

describe('preset record validation', () => {
  it('round-trips a captured preset through applyPreset', () => {
    const steps: CleaningStep[] = [
      { id: 's1', type: 'trim', enabled: true, scope: { kind: 'columns', columnIds: ['c2'] } },
      { id: 's2', type: 'select-columns', enabled: true, columnIds: ['c0', 'c2'] },
    ];
    const { steps: captured } = capturePresetSteps(steps, COLUMNS);
    const applied = applyPreset(preset(captured), COLUMNS, counter());
    expect(applied.steps.map((step) => step.type)).toEqual(['trim', 'select-columns']);
    // Same columns, different ids: the round trip is faithful in meaning.
    expect(applied.steps[0]).toMatchObject({ scope: { kind: 'columns', columnIds: ['c2'] } });
    expect(applied.steps[1]).toMatchObject({ columnIds: ['c0', 'c2'] });
  });

  it('drops a step with an unknown type or malformed scope', () => {
    expect(prunePresetStep({ type: 'explode', enabled: true })).toBeNull();
    expect(prunePresetStep({ type: 'trim', scope: { kind: 'labels', labels: [] } })).toBeNull();
    expect(prunePresetStep({ type: 'select-columns', labels: 'nope' })).toBeNull();
    expect(prunePresetStep(null)).toBeNull();
  });

  it('defaults a missing enabled flag to true and a bad compare to exact', () => {
    expect(prunePresetStep({ type: 'trim', scope: { kind: 'all-columns' } })).toEqual({
      type: 'trim',
      enabled: true,
      scope: { kind: 'all-columns' },
    });
    expect(
      prunePresetStep({
        type: 'remove-duplicates',
        keys: { kind: 'all-columns' },
        compare: 'fuzzy',
      }),
    ).toMatchObject({ compare: 'exact' });
  });

  it('rejects a preset with no usable steps', () => {
    expect(prunePreset({ id: 'p', name: 'x', steps: [] })).toBeNull();
    expect(prunePreset({ id: 'p', name: 'x', steps: [{ type: 'nope' }] })).toBeNull();
  });

  it('rejects a preset with no usable name or id', () => {
    const step = { type: 'trim', enabled: true, scope: { kind: 'all-columns' } };
    expect(prunePreset({ id: 'p', name: '   ', steps: [step] })).toBeNull();
    expect(prunePreset({ name: 'x', steps: [step] })).toBeNull();
  });

  it('keeps the usable steps of a partly corrupt preset', () => {
    const restored = prunePreset({
      id: 'p',
      name: 'Partial',
      steps: [
        { type: 'trim', enabled: true, scope: { kind: 'all-columns' } },
        { type: 'nope' },
        { type: 'select-columns', labels: ['Ticket'] },
      ],
    });
    expect(restored?.steps).toHaveLength(2);
  });

  it('drops duplicate preset ids and caps the list', () => {
    const step = { type: 'trim', enabled: true, scope: { kind: 'all-columns' } };
    const many = Array.from({ length: MAX_PRESETS + 5 }, (_, i) => ({
      id: `p${i}`,
      name: `Preset ${i}`,
      steps: [step],
    }));
    const restored = deserializePresets({
      format: PRESET_RECORD_FORMAT,
      presets: [...many, { id: 'p0', name: 'dupe', steps: [step] }],
    });
    expect(restored).toHaveLength(MAX_PRESETS);
    expect(new Set(restored.map((p) => p.id)).size).toBe(MAX_PRESETS);
  });

  it('accepts only the known record format', () => {
    expect(isSupportedPresetRecord({ format: PRESET_RECORD_FORMAT })).toBe(true);
    expect(isSupportedPresetRecord({ format: 99 })).toBe(false);
    expect(isSupportedPresetRecord(null)).toBe(false);
  });

  it('treats a non-record as an empty list', () => {
    expect(deserializePresets(null)).toEqual([]);
    expect(deserializePresets({ presets: 'nope' })).toEqual([]);
  });
});

describe('preset names and summaries', () => {
  it('normalizes whitespace and rejects empty or over-long names', () => {
    expect(normalizePresetName('  Weekly   cleanup  ')).toBe('Weekly cleanup');
    expect(normalizePresetName('   ')).toBeNull();
    expect(normalizePresetName('x'.repeat(61))).toBeNull();
    expect(normalizePresetName('x'.repeat(60))).toBe('x'.repeat(60));
  });

  it('summarizes a pipeline in a stable order with counts', () => {
    expect(
      presetSummary(
        preset([
          {
            type: 'remove-duplicates',
            enabled: true,
            keys: { kind: 'all-columns' },
            compare: 'exact',
          },
          { type: 'trim', enabled: true, scope: { kind: 'all-columns' } },
          { type: 'trim', enabled: false, scope: { kind: 'all-columns' } },
        ]),
      ),
    ).toBe('trim ×2, dedupe');
  });
});
