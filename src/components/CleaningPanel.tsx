/**
 * Cleaning pipeline panel: add, configure, enable/disable, remove and reset
 * steps, with per-step impact from the latest pipeline run. Every change is a
 * configuration edit — the app recomputes results in the background and the
 * stored dataset is never modified, which the copy states explicitly.
 */
import { useEffect, useRef, useState } from 'react';
import type { CleaningStep, CleaningStepType, StepSummary } from '../features/cleaning/types';
import { stepDescription, stepDisplayName } from '../features/cleaning/types';

export type CleaningPanelColumn = { id: string; label: string };

type CleaningPanelProps = {
  steps: CleaningStep[];
  columns: CleaningPanelColumn[];
  summaries: ReadonlyMap<string, StepSummary>;
  busy: boolean;
  onAdd: (type: CleaningStepType) => void;
  onUpdate: (step: CleaningStep) => void;
  onRemove: (stepId: string) => void;
  onReset: () => void;
};

const ADD_LABELS: { type: CleaningStepType; label: string }[] = [
  { type: 'trim', label: 'Trim whitespace' },
  { type: 'remove-empty-rows', label: 'Remove empty rows' },
  { type: 'remove-duplicates', label: 'Remove duplicates' },
  { type: 'select-columns', label: 'Select columns' },
];

function summaryText(step: CleaningStep, summary: StepSummary | undefined): string {
  if (!summary) return 'Not run yet';
  switch (step.type) {
    case 'trim':
      return `${summary.cellsChanged.toLocaleString('en-US')} cell${summary.cellsChanged === 1 ? '' : 's'} trimmed`;
    case 'remove-empty-rows':
    case 'remove-duplicates':
      return `${summary.rowsRemoved.toLocaleString('en-US')} row${summary.rowsRemoved === 1 ? '' : 's'} removed`;
    case 'select-columns':
      return `${summary.columnsKept ?? 0} column${(summary.columnsKept ?? 0) === 1 ? '' : 's'} kept`;
  }
}

function isAllColumnsScope(
  scope: { kind: 'all-columns' } | { kind: 'columns'; columnIds: string[] },
): boolean {
  return scope.kind === 'all-columns';
}

function ColumnCheckboxes({
  columns,
  checked,
  onChange,
  labelPrefix,
}: {
  columns: CleaningPanelColumn[];
  checked: ReadonlySet<string>;
  onChange: (columnId: string, on: boolean) => void;
  labelPrefix: string;
}) {
  return (
    <div className="cleaning-step__columns">
      {columns.map((column) => (
        <label key={column.id} className="cleaning-step__column">
          <input
            type="checkbox"
            checked={checked.has(column.id)}
            onChange={(event) => onChange(column.id, event.target.checked)}
            aria-label={`${labelPrefix} ${column.label}`}
          />
          <span className="truncate">{column.label}</span>
        </label>
      ))}
    </div>
  );
}

function StepEditor({
  step,
  columns,
  onUpdate,
}: {
  step: CleaningStep;
  columns: CleaningPanelColumn[];
  onUpdate: (step: CleaningStep) => void;
}) {
  const setScopeColumns = (scope: 'all-columns' | { kind: 'columns'; columnIds: string[] }) => {
    if (step.type === 'trim' || step.type === 'remove-empty-rows') {
      onUpdate({
        ...step,
        scope: scope === 'all-columns' ? { kind: 'all-columns' } : scope,
      });
    }
  };

  switch (step.type) {
    case 'trim':
    case 'remove-empty-rows': {
      const allColumns = isAllColumnsScope(step.scope);
      const checked = new Set(step.scope.kind === 'columns' ? step.scope.columnIds : []);
      return (
        <>
          <label className="cleaning-step__option">
            <input
              type="checkbox"
              checked={allColumns}
              onChange={(event) =>
                setScopeColumns(
                  event.target.checked ? 'all-columns' : { kind: 'columns', columnIds: [] },
                )
              }
            />
            All columns
          </label>
          {!allColumns && (
            <ColumnCheckboxes
              columns={columns}
              checked={checked}
              labelPrefix={step.type === 'trim' ? 'Trim' : 'Check for emptiness'}
              onChange={(columnId, on) => {
                const current = step.scope.kind === 'columns' ? [...step.scope.columnIds] : [];
                const next = on ? [...current, columnId] : current.filter((id) => id !== columnId);
                onUpdate({ ...step, scope: { kind: 'columns', columnIds: next } });
              }}
            />
          )}
        </>
      );
    }
    case 'remove-duplicates': {
      const allKeys = isAllColumnsScope(step.keys);
      const checked = new Set(step.keys.kind === 'columns' ? step.keys.columnIds : []);
      return (
        <>
          <label className="cleaning-step__option">
            Compare
            <select
              className="text-input"
              value={step.compare}
              onChange={(event) =>
                onUpdate({ ...step, compare: event.target.value as 'exact' | 'trimmed' })
              }
            >
              <option value="exact">exact values</option>
              <option value="trimmed">whitespace-trimmed values</option>
            </select>
          </label>
          <label className="cleaning-step__option">
            <input
              type="checkbox"
              checked={allKeys}
              onChange={(event) =>
                onUpdate({
                  ...step,
                  keys: event.target.checked
                    ? { kind: 'all-columns' }
                    : { kind: 'columns', columnIds: [] },
                })
              }
            />
            Compare all columns
          </label>
          {!allKeys && (
            <ColumnCheckboxes
              columns={columns}
              checked={checked}
              labelPrefix="Use as key"
              onChange={(columnId, on) => {
                const current = step.keys.kind === 'columns' ? [...step.keys.columnIds] : [];
                const next = on ? [...current, columnId] : current.filter((id) => id !== columnId);
                onUpdate({ ...step, keys: { kind: 'columns', columnIds: next } });
              }}
            />
          )}
        </>
      );
    }
    case 'select-columns': {
      const checked = new Set(step.columnIds);
      return (
        <ColumnCheckboxes
          columns={columns}
          checked={checked}
          labelPrefix="Keep"
          onChange={(columnId, on) => {
            const next = on
              ? columns
                  .map((column) => column.id)
                  .filter((id) => checked.has(id) || id === columnId)
              : [...step.columnIds].filter((id) => id !== columnId);
            onUpdate({ ...step, columnIds: next });
          }}
        />
      );
    }
  }
}

export function CleaningPanel({
  steps,
  columns,
  summaries,
  busy,
  onAdd,
  onUpdate,
  onRemove,
  onReset,
}: CleaningPanelProps) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, []);

  const requestReset = () => {
    if (steps.length === 0) return;
    if (!confirmingReset) {
      setConfirmingReset(true);
      resetTimer.current = window.setTimeout(() => setConfirmingReset(false), 4000);
      return;
    }
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    setConfirmingReset(false);
    onReset();
  };

  return (
    <section className="cleaning-panel" aria-labelledby="cleaning-panel-title">
      <h2 className="cleaning-panel__title" id="cleaning-panel-title">
        Cleaning pipeline
      </h2>

      {steps.length === 0 ? (
        <div className="cleaning-panel__empty">
          <p>No cleaning steps yet.</p>
        </div>
      ) : (
        <ol className="cleaning-panel__steps">
          {steps.map((step) => (
            <li key={step.id} className="cleaning-step">
              <div className="cleaning-step__header">
                <input
                  type="checkbox"
                  checked={step.enabled}
                  onChange={(event) => onUpdate({ ...step, enabled: event.target.checked })}
                  aria-label={`Enable ${stepDisplayName(step)}`}
                />
                <span className="cleaning-step__name truncate">{stepDisplayName(step)}</span>
                <span className="cleaning-step__impact num">
                  {summaryText(step, summaries.get(step.id))}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => onRemove(step.id)}
                  aria-label={`Remove step: ${stepDisplayName(step)}`}
                >
                  ✕
                </button>
              </div>
              <p className="cleaning-step__description">{stepDescription(step)}</p>
              <details>
                <summary>Edit</summary>
                <div className="cleaning-step__editor">
                  <StepEditor step={step} columns={columns} onUpdate={onUpdate} />
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}

      {busy && (
        <p role="status" className="cleaning-panel__busy">
          Recomputing…
        </p>
      )}

      <div className="cleaning-panel__actions">
        {ADD_LABELS.map((entry) => (
          <button key={entry.type} type="button" className="btn" onClick={() => onAdd(entry.type)}>
            + {entry.label}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn--ghost" onClick={requestReset}>
        {confirmingReset ? 'Confirm reset' : 'Reset all steps'}
      </button>
      <p className="cleaning-panel__note">
        Steps recompute the view only — the stored file is never modified.
      </p>
    </section>
  );
}
