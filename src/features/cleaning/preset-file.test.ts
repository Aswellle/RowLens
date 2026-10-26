import { describe, expect, it } from 'vitest';
import { MAX_PRESETS, type CleaningPreset } from './presets';
import {
  PRESET_FILE_FORMAT,
  describeImport,
  mergePresets,
  parsePresetFile,
  presetFileName,
  serializePresetFile,
} from './preset-file';

function preset(overrides: Partial<CleaningPreset> = {}): CleaningPreset {
  return {
    id: 'p1',
    name: 'Weekly cleanup',
    createdAt: 1,
    updatedAt: 1,
    steps: [{ type: 'trim', enabled: true, scope: { kind: 'labels', labels: ['Status'] } }],
    ...overrides,
  };
}

function counter(): () => string {
  let n = 0;
  return () => `fresh-${++n}`;
}

describe('preset file serialization', () => {
  it('round-trips a preset list', () => {
    const original = [preset(), preset({ id: 'p2', name: 'Dedupe' })];
    const text = serializePresetFile(original, Date.UTC(2026, 9, 26, 12, 0, 0));
    const result = parsePresetFile(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.presets).toEqual(original);
    expect(result.dropped).toBe(0);
  });

  it('writes a readable, versioned document with an ISO timestamp', () => {
    const text = serializePresetFile([preset()], Date.UTC(2026, 9, 26, 12, 0, 0));
    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(text) as { format: number; exportedAt: string };
    expect(parsed.format).toBe(PRESET_FILE_FORMAT);
    expect(parsed.exportedAt).toBe('2026-10-26T12:00:00.000Z');
    // Indented, so the file is diffable by hand.
    expect(text).toContain('\n  "presets"');
  });

  it('carries only configuration, never data', () => {
    const text = serializePresetFile([preset()]);
    // Labels are the only dataset-derived content that may appear.
    expect(text).toContain('Status');
    expect(text).not.toMatch(/rowIndex|rowCount|cell/i);
  });
});

describe('preset file parsing', () => {
  it('rejects text that is not JSON', () => {
    const result = parsePresetFile('not json at all');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/not valid JSON/);
  });

  it('rejects JSON that is not an object', () => {
    expect(parsePresetFile('[1,2,3]').ok).toBe(false);
    expect(parsePresetFile('"a string"').ok).toBe(false);
  });

  it('refuses a format it does not understand', () => {
    const result = parsePresetFile(JSON.stringify({ format: 99, presets: [preset()] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/format this version does not understand/);
  });

  it('refuses a document with no preset list', () => {
    expect(parsePresetFile(JSON.stringify({ format: PRESET_FILE_FORMAT })).ok).toBe(false);
    expect(
      parsePresetFile(JSON.stringify({ format: PRESET_FILE_FORMAT, presets: 'nope' })).ok,
    ).toBe(false);
  });

  it('refuses a file with no usable presets', () => {
    const result = parsePresetFile(
      JSON.stringify({ format: PRESET_FILE_FORMAT, presets: [{ name: 'no id' }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/no usable presets/);
  });

  it('keeps the good presets and counts the bad ones', () => {
    const result = parsePresetFile(
      JSON.stringify({
        format: PRESET_FILE_FORMAT,
        presets: [preset(), { id: 'broken' }, preset({ id: 'p3', name: 'Third' })],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.presets.map((p) => p.name)).toEqual(['Weekly cleanup', 'Third']);
    expect(result.dropped).toBe(1);
  });

  it('does not echo file content in its error messages', () => {
    // Column names can be sensitive; an error banner must not repeat them.
    const result = parsePresetFile(JSON.stringify({ format: 99, presets: [{ name: 'secret' }] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('secret');
  });
});

describe('merging imported presets', () => {
  it('appends new presets', () => {
    const outcome = mergePresets([preset()], [preset({ id: 'p2', name: 'Dedupe' })], counter());
    expect(outcome.added).toBe(1);
    expect(outcome.presets.map((p) => p.name)).toEqual(['Weekly cleanup', 'Dedupe']);
  });

  it('never overwrites an existing preset with the same name', () => {
    const existing = preset({ id: 'keep', steps: [] as CleaningPreset['steps'] });
    const outcome = mergePresets(
      [existing],
      [preset({ id: 'other', name: 'Weekly cleanup' })],
      counter(),
    );
    expect(outcome.added).toBe(0);
    expect(outcome.skippedByName).toBe(1);
    // The existing recipe is untouched, id and steps included.
    expect(outcome.presets[0]).toBe(existing);
  });

  it('gives a fresh id when an incoming id collides under a different name', () => {
    const outcome = mergePresets(
      [preset({ id: 'shared' })],
      [preset({ id: 'shared', name: 'Different name' })],
      counter(),
    );
    expect(outcome.added).toBe(1);
    expect(outcome.reidentified).toBe(1);
    expect(outcome.presets[1]?.id).toBe('fresh-1');
    expect(outcome.presets[1]?.name).toBe('Different name');
  });

  it('stops at the cap and reports how many were skipped', () => {
    const existing = Array.from({ length: MAX_PRESETS }, (_, i) =>
      preset({ id: `p${i}`, name: `Existing ${i}` }),
    );
    const outcome = mergePresets(existing, [preset({ id: 'new', name: 'Overflow' })], counter());
    expect(outcome.presets).toHaveLength(MAX_PRESETS);
    expect(outcome.added).toBe(0);
    expect(outcome.skippedByCap).toBe(1);
  });

  it('dedupes names within the incoming file itself', () => {
    const outcome = mergePresets(
      [],
      [preset({ id: 'a', name: 'Same' }), preset({ id: 'b', name: 'Same' })],
      counter(),
    );
    expect(outcome.added).toBe(1);
    expect(outcome.skippedByName).toBe(1);
  });
});

describe('preset file naming and notices', () => {
  it('builds a date-stamped json file name', () => {
    expect(presetFileName(Date.UTC(2026, 9, 26, 12))).toBe('rowlens-presets-2026-10-26.json');
    // Single-digit months are padded so names sort correctly.
    expect(presetFileName(new Date(2026, 0, 5, 12).getTime())).toBe(
      'rowlens-presets-2026-01-05.json',
    );
  });

  it('describes a clean import', () => {
    const outcome = mergePresets([], [preset()], counter());
    expect(describeImport(outcome, 0)).toBe('Imported 1 preset.');
  });

  it('describes skipped and dropped entries', () => {
    const existing = [preset()];
    const outcome = mergePresets(existing, [preset()], counter());
    const text = describeImport(outcome, 2);
    expect(text).toContain('Imported 0 presets');
    expect(text).toContain('name is already in use');
    expect(text).toContain('2 entries in the file could not be read');
  });
});
