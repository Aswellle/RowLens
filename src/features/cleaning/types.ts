/**
 * Serializable cleaning-step configuration (data contract §8 and PRD FR-05).
 * Steps are plain data — never behaviour — so a pipeline can round-trip
 * through JSON and reproduce identical results. Execution order is the array
 * order; a disabled step is skipped without losing its configuration.
 */
import type { ColumnId } from '../dataset/types';

export type CleaningStepId = string;

/** Column scope: every column (as of this point in the pipeline) or a list. */
export type ColumnScope = { kind: 'all-columns' } | { kind: 'columns'; columnIds: ColumnId[] };

export type TrimStep = {
  id: CleaningStepId;
  type: 'trim';
  enabled: boolean;
  scope: ColumnScope;
};

export type RemoveEmptyRowsStep = {
  id: CleaningStepId;
  type: 'remove-empty-rows';
  enabled: boolean;
  scope: ColumnScope;
};

export type RemoveDuplicatesStep = {
  id: CleaningStepId;
  type: 'remove-duplicates';
  enabled: boolean;
  keys: ColumnScope;
  /** Comparison rule: exact raw values (default) or whitespace-trimmed. */
  compare: 'exact' | 'trimmed';
};

export type SelectColumnsStep = {
  id: CleaningStepId;
  type: 'select-columns';
  enabled: boolean;
  columnIds: ColumnId[];
};

export type CleaningStep =
  TrimStep | RemoveEmptyRowsStep | RemoveDuplicatesStep | SelectColumnsStep;

export type CleaningStepType = CleaningStep['type'];

export const CLEANING_STEP_TYPES: CleaningStepType[] = [
  'trim',
  'remove-empty-rows',
  'remove-duplicates',
  'select-columns',
];

export function stepDisplayName(step: CleaningStep): string {
  switch (step.type) {
    case 'trim':
      return 'Trim whitespace';
    case 'remove-empty-rows':
      return 'Remove empty rows';
    case 'remove-duplicates':
      return 'Remove duplicates';
    case 'select-columns':
      return 'Select columns';
  }
}

export function stepDescription(step: CleaningStep): string {
  switch (step.type) {
    case 'trim':
      return step.scope.kind === 'all-columns'
        ? 'Trims leading and trailing whitespace from every column.'
        : 'Trims leading and trailing whitespace from the selected columns.';
    case 'remove-empty-rows':
      return step.scope.kind === 'all-columns'
        ? 'Removes rows whose values are all blank.'
        : 'Removes rows where the selected columns are all blank.';
    case 'remove-duplicates':
      return `${step.keys.kind === 'all-columns' ? 'Whole-row' : 'Selected-key'} comparison, ${step.compare === 'exact' ? 'exact values' : 'whitespace-trimmed values'}; keeps the first occurrence.`;
    case 'select-columns':
      return 'Keeps only the selected columns for later steps and the view.';
  }
}

/** Per-step impact from the most recent pipeline run. */
export type StepSummary = {
  stepId: CleaningStepId;
  rowsRemoved: number;
  cellsChanged: number;
  /** Present for select-columns: the number of columns kept. */
  columnsKept?: number;
};
