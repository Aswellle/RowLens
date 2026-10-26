/**
 * Pure cleaning pipeline: sequential row transforms with per-step impact
 * accounting (data contract §5–8). Original stored rows are never touched —
 * the pipeline projects rows in memory while a dataset scan streams through.
 *
 * "All columns" resolves against the columns present at that point in the
 * pipeline, so a preceding select-columns step narrows what later steps see.
 * Deduplication keys are exact-comparison strings (JSON-encoded value
 * tuples), so no hash collision can drop a distinct row.
 */
import type { ColumnId, RowIndex } from '../dataset/types';
import type { EngineRow } from '../query/engine';
import type { CleaningStep, ColumnScope, StepSummary } from './types';

export type CleaningRow = {
  rowIndex: RowIndex;
  values: Record<ColumnId, string | null>;
  /** Column order at this point in the pipeline (drives all-columns scope). */
  columnOrder: ColumnId[];
};

type StepTransform = {
  stepId: string;
  process(row: CleaningRow): CleaningRow | undefined;
  summary(): StepSummary;
};

/**
 * Resolves a scope against the row's column order. The all-columns branch
 * returns the shared order array itself — every consumer only iterates, and
 * copying it per scanned row showed up as millions of short-lived arrays on
 * large datasets (ADR-035-era profiling of the query hot path).
 */
function resolveScope(
  scope: ColumnScope,
  columnOrder: readonly ColumnId[],
): readonly ColumnId[] {
  return scope.kind === 'all-columns' ? columnOrder : scope.columnIds;
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

function createTrim(step: Extract<CleaningStep, { type: 'trim' }>): StepTransform {
  let cellsChanged = 0;
  return {
    stepId: step.id,
    process(row) {
      const scope = resolveScope(step.scope, row.columnOrder);
      if (scope.length === 0) return row;
      const values = { ...row.values };
      let changed = false;
      for (const columnId of scope) {
        const value = values[columnId];
        if (typeof value === 'string' && value !== value.trim()) {
          values[columnId] = value.trim();
          cellsChanged += 1;
          changed = true;
        }
      }
      return changed ? { ...row, values } : row;
    },
    summary: () => ({ stepId: step.id, rowsRemoved: 0, cellsChanged }),
  };
}

function createRemoveEmptyRows(
  step: Extract<CleaningStep, { type: 'remove-empty-rows' }>,
): StepTransform {
  let rowsRemoved = 0;
  return {
    stepId: step.id,
    process(row) {
      const scope = resolveScope(step.scope, row.columnOrder);
      if (scope.length > 0 && scope.every((columnId) => isBlank(row.values[columnId]))) {
        rowsRemoved += 1;
        return undefined;
      }
      return row;
    },
    summary: () => ({ stepId: step.id, rowsRemoved, cellsChanged: 0 }),
  };
}

function createRemoveDuplicates(
  step: Extract<CleaningStep, { type: 'remove-duplicates' }>,
): StepTransform {
  let rowsRemoved = 0;
  const seen = new Set<string>();
  return {
    stepId: step.id,
    process(row) {
      const keys = resolveScope(step.keys, row.columnOrder);
      const keyValues = keys.map((columnId) => {
        const value = row.values[columnId] ?? null;
        return step.compare === 'trimmed' && typeof value === 'string' ? value.trim() : value;
      });
      // Exact-value key: JSON encoding cannot collide across distinct tuples.
      const key = JSON.stringify(keyValues);
      if (seen.has(key)) {
        rowsRemoved += 1;
        return undefined;
      }
      seen.add(key);
      return row;
    },
    summary: () => ({ stepId: step.id, rowsRemoved, cellsChanged: 0 }),
  };
}

function createSelectColumns(
  step: Extract<CleaningStep, { type: 'select-columns' }>,
): StepTransform {
  return {
    stepId: step.id,
    process(row) {
      if (step.columnIds.length === row.columnOrder.length) return row;
      const values: Record<ColumnId, string | null> = {};
      for (const columnId of step.columnIds) {
        values[columnId] = row.values[columnId] ?? null;
      }
      return { ...row, values, columnOrder: [...step.columnIds] };
    },
    summary: () => ({
      stepId: step.id,
      rowsRemoved: 0,
      cellsChanged: 0,
      columnsKept: step.columnIds.length,
    }),
  };
}

export type CleaningTransform = {
  /** Apply every enabled step in order; undefined drops the row. */
  process(row: EngineRow): EngineRow | undefined;
  /** True when at least one enabled step actually transforms or drops rows. */
  readonly active: boolean;
  summaries(): StepSummary[];
};

/**
 * Build a transform from serializable steps. `columns` is the dataset's
 * column order feeding the first step.
 */
export function createCleaningTransform(
  steps: readonly CleaningStep[],
  columns: readonly ColumnId[],
): CleaningTransform {
  const transforms: StepTransform[] = steps
    .filter((step) => step.enabled)
    .map((step) => {
      switch (step.type) {
        case 'trim':
          return createTrim(step);
        case 'remove-empty-rows':
          return createRemoveEmptyRows(step);
        case 'remove-duplicates':
          return createRemoveDuplicates(step);
        case 'select-columns':
          return createSelectColumns(step);
      }
    });

  // The initial column order is the same for every scanned row and nothing
  // mutates it (select-columns allocates its own narrowed order), so one array
  // is shared across the whole pass instead of copied per row.
  const initialColumnOrder: ColumnId[] = [...columns];

  return {
    active: transforms.length > 0,
    process(row) {
      let current: CleaningRow | undefined = {
        rowIndex: row.rowIndex,
        values: row.values,
        columnOrder: initialColumnOrder,
      };
      for (const transform of transforms) {
        if (current === undefined) return undefined;
        current = transform.process(current);
      }
      return current === undefined
        ? undefined
        : { rowIndex: current.rowIndex, values: current.values };
    },
    summaries: () => transforms.map((transform) => transform.summary()),
  };
}
