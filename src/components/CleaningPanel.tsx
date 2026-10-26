/**
 * Cleaning pipeline panel: add, configure, enable/disable, remove and reset
 * steps, with per-step impact from the latest pipeline run. Every change is a
 * configuration edit — the app recomputes results in the background and the
 * stored dataset is never modified, which the copy states explicitly.
 *
 * Named presets live here too: they are the same pipeline, saved so it can be
 * applied to a different file (ADR-032). A preset matches columns by header
 * label, so the panel says so rather than implying it is tied to this dataset.
 */
import { useEffect, useRef, useState } from 'react';
import type { CleaningStep, CleaningStepType, StepSummary } from '../features/cleaning/types';
import { stepDescription, stepDisplayName } from '../features/cleaning/types';
import {
  MAX_PRESETS,
  MAX_PRESET_NAME_LENGTH,
  normalizePresetName,
  presetSummary,
  type CleaningPreset,
} from '../features/cleaning/presets';

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
  presets: readonly CleaningPreset[];
  /** Saves the current steps under a name; returns an error message or null. */
  onSavePreset: (name: string, overwriteId?: string) => string | null;
  onApplyPreset: (presetId: string) => void;
  onDeletePreset: (presetId: string) => void;
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
  presets,
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
}: CleaningPanelProps) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetTimer = useRef<number | null>(null);

  /** Preset name being saved; null when the form is closed. */
  const [presetName, setPresetName] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  /** Set when the typed name matches an existing preset and awaits confirmation. */
  const [overwriteId, setOverwriteId] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, []);

  const closeSaveForm = () => {
    setPresetName(null);
    setPresetError(null);
    setOverwriteId(null);
  };

  const submitPresetName = (raw: string) => {
    const name = normalizePresetName(raw);
    if (name === null) {
      setPresetError(`Enter a name of up to ${MAX_PRESET_NAME_LENGTH} characters.`);
      return;
    }
    // Saving over an existing name is destructive, so it needs a second click
    // rather than silently replacing someone's saved recipe.
    const existing = presets.find((preset) => preset.name === name);
    if (existing !== undefined && overwriteId !== existing.id) {
      setOverwriteId(existing.id);
      setPresetError(`A preset named “${name}” already exists.`);
      return;
    }
    const error = onSavePreset(name, existing?.id);
    if (error !== null) {
      setPresetError(error);
      return;
    }
    closeSaveForm();
  };

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

      <section className="cleaning-presets" aria-labelledby="cleaning-presets-title">
        <h3 className="cleaning-presets__title" id="cleaning-presets-title">
          Saved presets
        </h3>
        {presets.length === 0 ? (
          <p className="cleaning-panel__note">
            Save this pipeline as a preset to apply it to another file.
          </p>
        ) : (
          <ul className="cleaning-presets__list">
            {presets.map((preset) => (
              <li key={preset.id} className="cleaning-preset">
                <span className="cleaning-preset__name truncate">{preset.name}</span>
                <span className="cleaning-preset__summary truncate">{presetSummary(preset)}</span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => onApplyPreset(preset.id)}
                  aria-label={`Apply preset: ${preset.name}`}
                >
                  Apply
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => onDeletePreset(preset.id)}
                  aria-label={`Delete preset: ${preset.name}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {presetName === null ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPresetName('');
              setPresetError(null);
              setOverwriteId(null);
            }}
            disabled={steps.length === 0 || presets.length >= MAX_PRESETS}
            title={
              steps.length === 0
                ? 'Add at least one step before saving a preset.'
                : presets.length >= MAX_PRESETS
                  ? `At most ${MAX_PRESETS} presets can be saved.`
                  : undefined
            }
          >
            Save as preset…
          </button>
        ) : (
          <form
            className="cleaning-presets__form"
            onSubmit={(event) => {
              event.preventDefault();
              submitPresetName(presetName);
            }}
          >
            <label htmlFor="preset-name" className="visually-hidden">
              Preset name
            </label>
            <input
              id="preset-name"
              className="text-input"
              value={presetName}
              maxLength={MAX_PRESET_NAME_LENGTH}
              placeholder="Preset name"
              autoFocus
              onChange={(event) => {
                setPresetName(event.target.value);
                setPresetError(null);
                setOverwriteId(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeSaveForm();
                }
              }}
            />
            <button type="submit" className="btn btn--primary">
              {overwriteId === null ? 'Save' : 'Replace'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={closeSaveForm}>
              Cancel
            </button>
          </form>
        )}
        {presetError !== null && (
          <p className="cleaning-presets__error" role="alert">
            {presetError}
          </p>
        )}
        {presets.length > 0 && (
          <p className="cleaning-panel__note">
            Presets match columns by header name, so they work on other files with the same headers.
          </p>
        )}
      </section>

      <p className="cleaning-panel__note">
        Steps recompute the view only — the stored file is never modified.
      </p>
    </section>
  );
}
