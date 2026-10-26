/**
 * Serialization for a persisted cleaning pipeline (ADR-030).
 *
 * Cleaning steps are already plain serializable data (contract §8), so there
 * is no encoding step — the work here is *validation*. A record can outlive
 * the schema it was written against: a re-import can rename columns, and an
 * older build could have written a step type this build does not know. Each
 * step is therefore validated and pruned on its own, so one bad step costs
 * that step and not the whole pipeline.
 *
 * The stored form:
 *
 *   { datasetId, updatedAt, format: 1, steps: [ …CleaningStep ] }
 */
import type { ColumnId } from '../dataset/types';
import type { CleaningStep, ColumnScope } from './types';

/** Bumped when the stored layout changes; older records are ignored. */
export const PIPELINE_RECORD_FORMAT = 1;

export type StoredPipelineRecord = {
  datasetId: string;
  updatedAt: number;
  format: number;
  steps: CleaningStep[];
};

const STEP_TYPES = new Set(['trim', 'remove-empty-rows', 'remove-duplicates', 'select-columns']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Keeps only column ids that still exist in the dataset. */
function pruneColumns(columnIds: unknown, valid: ReadonlySet<ColumnId>): ColumnId[] | null {
  if (!Array.isArray(columnIds)) return null;
  const kept: ColumnId[] = [];
  for (const id of columnIds) {
    if (typeof id === 'string' && valid.has(id) && !kept.includes(id)) kept.push(id);
  }
  return kept;
}

/**
 * Validates a column scope. `null` means the step cannot be salvaged: a
 * explicit column list whose every entry is gone would silently change what
 * the step does, which is worse than dropping it.
 */
function pruneScope(scope: unknown, valid: ReadonlySet<ColumnId>): ColumnScope | null {
  if (!isRecord(scope)) return null;
  if (scope.kind === 'all-columns') return { kind: 'all-columns' };
  if (scope.kind === 'columns') {
    const columnIds = pruneColumns(scope.columnIds, valid);
    if (columnIds === null || columnIds.length === 0) return null;
    return { kind: 'columns', columnIds };
  }
  return null;
}

/**
 * Validates one stored step. Returns null for anything unusable: unknown
 * type, missing id, malformed scope, or a column list that no longer matches
 * the dataset.
 */
export function pruneStep(step: unknown, valid: ReadonlySet<ColumnId>): CleaningStep | null {
  if (!isRecord(step)) return null;
  const id = typeof step.id === 'string' && step.id !== '' ? step.id : null;
  const type = step.type;
  if (id === null || typeof type !== 'string' || !STEP_TYPES.has(type)) return null;
  const enabled = typeof step.enabled === 'boolean' ? step.enabled : true;

  switch (type) {
    case 'trim':
    case 'remove-empty-rows': {
      const scope = pruneScope(step.scope, valid);
      return scope === null ? null : { id, type, enabled, scope };
    }
    case 'remove-duplicates': {
      const keys = pruneScope(step.keys, valid);
      if (keys === null) return null;
      const compare = step.compare === 'trimmed' ? 'trimmed' : 'exact';
      return { id, type, enabled, keys, compare };
    }
    case 'select-columns': {
      const columnIds = pruneColumns(step.columnIds, valid);
      if (columnIds === null || columnIds.length === 0) return null;
      return { id, type, enabled, columnIds };
    }
    default:
      return null;
  }
}

/**
 * Rebuilds a pipeline from a stored record, dropping steps that no longer
 * apply. Duplicate step ids are rejected (the UI keys by id, so two steps
 * sharing one would edit each other).
 */
export function deserializePipeline(
  record: unknown,
  validColumnIds: ReadonlySet<ColumnId>,
): CleaningStep[] {
  if (!isRecord(record)) return [];
  const steps = record.steps;
  if (!Array.isArray(steps)) return [];

  const seen = new Set<string>();
  const restored: CleaningStep[] = [];
  for (const candidate of steps) {
    const step = pruneStep(candidate, validColumnIds);
    if (step === null || seen.has(step.id)) continue;
    seen.add(step.id);
    restored.push(step);
  }
  return restored;
}

/** True when the record is a version this build understands. */
export function isSupportedPipelineRecord(record: unknown): boolean {
  if (!isRecord(record)) return false;
  return record.format === PIPELINE_RECORD_FORMAT;
}

/**
 * Drops column references that no longer exist, for a pipeline that is
 * already in memory (the user re-imported into the same dataset id).
 * Returns the same array when nothing changed, so callers can skip a write.
 */
export function prunePipeline(
  steps: readonly CleaningStep[],
  validColumnIds: ReadonlySet<ColumnId>,
): readonly CleaningStep[] {
  const pruned: CleaningStep[] = [];
  let changed = false;
  for (const step of steps) {
    const next = pruneStep(step, validColumnIds);
    if (next === null) {
      changed = true;
      continue;
    }
    if (JSON.stringify(next) !== JSON.stringify(step)) changed = true;
    pruned.push(next);
  }
  return changed ? pruned : steps;
}
