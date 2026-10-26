/**
 * Reusable cleaning presets (ADR-032).
 *
 * A preset is a pipeline saved under a name so it can be applied to a
 * *different* file — that is the whole difference from the per-dataset pipeline
 * that ADR-030 already persists. Because the target dataset is unknown when the
 * preset is saved, columns cannot be referenced by id: ids are positional
 * (`c0`, `c1`, …), so `c1` means "the second column" in one file and something
 * else in the next. A preset therefore references columns by **header label**.
 *
 * Two consequences follow, and both are reported rather than guessed:
 *
 * 1. **Ambiguity is not resolved.** A dataset may legitimately carry duplicate
 *    headers (they stay separate columns by design). A label that matches more
 *    than one column cannot identify one of them, so it is dropped instead of
 *    silently picking the first.
 * 2. **A scope with nothing left is dropped, not widened.** This mirrors
 *    ADR-030: turning an explicit column list into "every column" would
 *    silently change what the step does.
 */
import type { ColumnId } from '../dataset/types';
import type { CleaningStep, ColumnScope } from './types';

/** Bumped when the stored layout changes; older records are ignored. */
export const PRESET_RECORD_FORMAT = 1;

/** Presets are configuration; this keeps the list browsable. */
export const MAX_PRESETS = 50;

export const MAX_PRESET_NAME_LENGTH = 60;

/** A column scope expressed by header label instead of column id. */
export type PresetScope = { kind: 'all-columns' } | { kind: 'labels'; labels: string[] };

export type PresetStep =
  | { type: 'trim'; enabled: boolean; scope: PresetScope }
  | { type: 'remove-empty-rows'; enabled: boolean; scope: PresetScope }
  | {
      type: 'remove-duplicates';
      enabled: boolean;
      keys: PresetScope;
      compare: 'exact' | 'trimmed';
    }
  | { type: 'select-columns'; enabled: boolean; labels: string[] };

export type CleaningPreset = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  steps: PresetStep[];
};

export type StoredPresetRecord = {
  format: number;
  presets: CleaningPreset[];
};

/** A column as the preset layer sees it: an id for this dataset, a label for people. */
export type PresetColumn = { id: ColumnId; label: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Labels shared by more than one column cannot identify a single column. */
function ambiguousLabels(columns: readonly PresetColumn[]): Set<string> {
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.label)) ambiguous.add(column.label);
    else seen.add(column.label);
  }
  return ambiguous;
}

/**
 * Captures the current pipeline as preset steps, translating column ids to
 * labels. Steps that cannot be expressed faithfully are dropped and counted:
 * a step pointing at a duplicate header cannot survive the trip to another
 * file, and silently narrowing it would be a lie about what it does.
 */
export function capturePresetSteps(
  steps: readonly CleaningStep[],
  columns: readonly PresetColumn[],
): { steps: PresetStep[]; droppedSteps: number; ambiguousColumns: number } {
  const labelById = new Map<ColumnId, string>();
  for (const column of columns) labelById.set(column.id, column.label);
  const ambiguous = ambiguousLabels(columns);

  let droppedSteps = 0;
  let ambiguousColumns = 0;

  /**
   * Maps explicit column ids to labels, returning null when the result would be
   * unusable. Only the `columns` scope reaches here: `all-columns` needs no
   * translation and is handled by the caller.
   */
  const scopeToLabels = (scope: Extract<ColumnScope, { kind: 'columns' }>): string[] | null => {
    const labels: string[] = [];
    for (const id of scope.columnIds) {
      const label = labelById.get(id);
      // A column with no label in this dataset cannot be described to another
      // file at all.
      if (label === undefined) return null;
      if (ambiguous.has(label)) {
        ambiguousColumns += 1;
        continue;
      }
      if (!labels.includes(label)) labels.push(label);
    }
    return labels.length === 0 ? null : labels;
  };

  const captured: PresetStep[] = [];
  for (const step of steps) {
    switch (step.type) {
      case 'trim':
      case 'remove-empty-rows': {
        if (step.scope.kind === 'all-columns') {
          captured.push({ type: step.type, enabled: step.enabled, scope: { kind: 'all-columns' } });
          break;
        }
        const labels = scopeToLabels(step.scope);
        if (labels === null) {
          droppedSteps += 1;
          break;
        }
        captured.push({
          type: step.type,
          enabled: step.enabled,
          scope: { kind: 'labels', labels },
        });
        break;
      }
      case 'remove-duplicates': {
        let keys: PresetScope;
        if (step.keys.kind === 'all-columns') {
          keys = { kind: 'all-columns' };
        } else {
          const labels = scopeToLabels(step.keys);
          if (labels === null) {
            droppedSteps += 1;
            break;
          }
          keys = { kind: 'labels', labels };
        }
        captured.push({
          type: 'remove-duplicates',
          enabled: step.enabled,
          keys,
          compare: step.compare,
        });
        break;
      }
      case 'select-columns': {
        const labels = scopeToLabels({ kind: 'columns', columnIds: step.columnIds });
        if (labels === null) {
          droppedSteps += 1;
          break;
        }
        captured.push({ type: 'select-columns', enabled: step.enabled, labels });
        break;
      }
    }
  }
  return { steps: captured, droppedSteps, ambiguousColumns };
}

export type ApplyOutcome = {
  steps: CleaningStep[];
  /** Steps dropped because none of their labels exist in this dataset. */
  droppedSteps: number;
  /** Labels dropped because they matched no column or more than one. */
  unresolvedLabels: number;
};

/**
 * Resolves a preset against a dataset's columns, producing steps the engine can
 * run. Fresh step ids are generated so an applied preset never collides with a
 * step already in the pipeline.
 */
export function applyPreset(
  preset: CleaningPreset,
  columns: readonly PresetColumn[],
  newId: () => string,
): ApplyOutcome {
  const idsByLabel = new Map<string, ColumnId[]>();
  for (const column of columns) {
    const existing = idsByLabel.get(column.label);
    if (existing === undefined) idsByLabel.set(column.label, [column.id]);
    else existing.push(column.id);
  }

  let unresolvedLabels = 0;
  const resolve = (labels: readonly string[]): ColumnId[] => {
    const ids: ColumnId[] = [];
    for (const label of labels) {
      const matches = idsByLabel.get(label) ?? [];
      // Exactly one match is the only unambiguous answer.
      if (matches.length !== 1) {
        unresolvedLabels += 1;
        continue;
      }
      const id = matches[0]!;
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  };

  let droppedSteps = 0;
  const applied: CleaningStep[] = [];
  for (const step of preset.steps) {
    switch (step.type) {
      case 'trim':
      case 'remove-empty-rows': {
        if (step.scope.kind === 'all-columns') {
          applied.push({
            id: newId(),
            type: step.type,
            enabled: step.enabled,
            scope: { kind: 'all-columns' },
          });
          break;
        }
        const columnIds = resolve(step.scope.labels);
        if (columnIds.length === 0) {
          droppedSteps += 1;
          break;
        }
        applied.push({
          id: newId(),
          type: step.type,
          enabled: step.enabled,
          scope: { kind: 'columns', columnIds },
        });
        break;
      }
      case 'remove-duplicates': {
        if (step.keys.kind === 'all-columns') {
          applied.push({
            id: newId(),
            type: 'remove-duplicates',
            enabled: step.enabled,
            keys: { kind: 'all-columns' },
            compare: step.compare,
          });
          break;
        }
        const columnIds = resolve(step.keys.labels);
        if (columnIds.length === 0) {
          droppedSteps += 1;
          break;
        }
        applied.push({
          id: newId(),
          type: 'remove-duplicates',
          enabled: step.enabled,
          keys: { kind: 'columns', columnIds },
          compare: step.compare,
        });
        break;
      }
      case 'select-columns': {
        const columnIds = resolve(step.labels);
        if (columnIds.length === 0) {
          droppedSteps += 1;
          break;
        }
        applied.push({
          id: newId(),
          type: 'select-columns',
          enabled: step.enabled,
          columnIds,
        });
        break;
      }
    }
  }
  return { steps: applied, droppedSteps, unresolvedLabels };
}

/** Trims a user-supplied name; null when it cannot be used. */
export function normalizePresetName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name === '' || name.length > MAX_PRESET_NAME_LENGTH) return null;
  return name;
}

function pruneLabels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const labels: string[] = [];
  for (const label of value) {
    if (typeof label !== 'string' || label === '') continue;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length === 0 ? null : labels;
}

function prunePresetScope(value: unknown): PresetScope | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'all-columns') return { kind: 'all-columns' };
  if (value.kind === 'labels') {
    const labels = pruneLabels(value.labels);
    return labels === null ? null : { kind: 'labels', labels };
  }
  return null;
}

/**
 * Validates one stored step. A preset outlives the build that wrote it, so an
 * unknown type or a malformed scope costs that step only.
 */
export function prunePresetStep(step: unknown): PresetStep | null {
  if (!isRecord(step)) return null;
  const enabled = typeof step.enabled === 'boolean' ? step.enabled : true;
  switch (step.type) {
    case 'trim':
    case 'remove-empty-rows': {
      const scope = prunePresetScope(step.scope);
      return scope === null ? null : { type: step.type, enabled, scope };
    }
    case 'remove-duplicates': {
      const keys = prunePresetScope(step.keys);
      if (keys === null) return null;
      const compare = step.compare === 'trimmed' ? 'trimmed' : 'exact';
      return { type: 'remove-duplicates', enabled, keys, compare };
    }
    case 'select-columns': {
      const labels = pruneLabels(step.labels);
      return labels === null ? null : { type: 'select-columns', enabled, labels };
    }
    default:
      return null;
  }
}

/**
 * Validates one stored preset. The name is normalized (a preset with no usable
 * name is unidentifiable in a list) and steps are validated individually.
 */
export function prunePreset(preset: unknown): CleaningPreset | null {
  if (!isRecord(preset)) return null;
  const id = typeof preset.id === 'string' && preset.id !== '' ? preset.id : null;
  const name = typeof preset.name === 'string' ? normalizePresetName(preset.name) : null;
  if (id === null || name === null) return null;
  const steps = Array.isArray(preset.steps) ? preset.steps : [];
  const kept: PresetStep[] = [];
  for (const step of steps) {
    const pruned = prunePresetStep(step);
    if (pruned !== null) kept.push(pruned);
  }
  // A preset with no usable steps would apply as a no-op; dropping it is more
  // honest than offering a button that does nothing.
  if (kept.length === 0) return null;
  const createdAt = typeof preset.createdAt === 'number' ? preset.createdAt : Date.now();
  const updatedAt = typeof preset.updatedAt === 'number' ? preset.updatedAt : createdAt;
  return { id, name, createdAt, updatedAt, steps: kept };
}

/** Rebuilds the stored preset list, dropping records this build cannot use. */
export function deserializePresets(record: unknown): CleaningPreset[] {
  if (!isRecord(record)) return [];
  const presets = record.presets;
  if (!Array.isArray(presets)) return [];
  const seen = new Set<string>();
  const restored: CleaningPreset[] = [];
  for (const candidate of presets) {
    const preset = prunePreset(candidate);
    if (preset === null || seen.has(preset.id)) continue;
    seen.add(preset.id);
    restored.push(preset);
  }
  return restored.slice(0, MAX_PRESETS);
}

/** True when the record is a version this build understands. */
export function isSupportedPresetRecord(record: unknown): boolean {
  if (!isRecord(record)) return false;
  return record.format === PRESET_RECORD_FORMAT;
}

/** One-line description for the preset list, e.g. "Trim, dedupe ×2". */
export function presetSummary(preset: CleaningPreset): string {
  const counts = new Map<string, number>();
  for (const step of preset.steps) {
    counts.set(step.type, (counts.get(step.type) ?? 0) + 1);
  }
  const order: PresetStep['type'][] = [
    'trim',
    'remove-empty-rows',
    'remove-duplicates',
    'select-columns',
  ];
  const names: Record<PresetStep['type'], string> = {
    trim: 'trim',
    'remove-empty-rows': 'drop empty',
    'remove-duplicates': 'dedupe',
    'select-columns': 'select columns',
  };
  return order
    .filter((type) => (counts.get(type) ?? 0) > 0)
    .map((type) => {
      const count = counts.get(type) ?? 0;
      return count === 1 ? names[type] : `${names[type]} ×${count}`;
    })
    .join(', ');
}
