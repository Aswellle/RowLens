// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CleaningStep } from '../features/cleaning/types';
import type { CleaningPreset } from '../features/cleaning/presets';
import { CleaningPanel } from './CleaningPanel';

const columns = [
  { id: 'c0', label: 'Ticket' },
  { id: 'c1', label: 'Status' },
];

const steps: CleaningStep[] = [
  { id: 's1', type: 'trim', enabled: true, scope: { kind: 'all-columns' } },
];

function preset(overrides: Partial<CleaningPreset> = {}): CleaningPreset {
  return {
    id: 'p1',
    name: 'Weekly cleanup',
    createdAt: 1,
    updatedAt: 1,
    steps: [{ type: 'trim', enabled: true, scope: { kind: 'all-columns' } }],
    ...overrides,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof CleaningPanel>> = {}) {
  const handlers = {
    onAdd: vi.fn(),
    onUpdate: vi.fn(),
    onRemove: vi.fn(),
    onReset: vi.fn(),
    onSavePreset: vi.fn(() => null as string | null),
    onApplyPreset: vi.fn(),
    onDeletePreset: vi.fn(),
  };
  render(
    <CleaningPanel
      steps={steps}
      columns={columns}
      summaries={new Map()}
      busy={false}
      presets={[]}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe('CleaningPanel presets', () => {
  it('offers to save a preset once the pipeline has a step', async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(screen.getByRole('button', { name: 'Save as preset…' }));
    await user.type(screen.getByLabelText('Preset name'), 'Weekly cleanup');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(handlers.onSavePreset).toHaveBeenCalledWith('Weekly cleanup', undefined);
  });

  it('disables saving when there are no steps to save', () => {
    setup({ steps: [] });
    expect(screen.getByRole('button', { name: 'Save as preset…' })).toBeDisabled();
  });

  it('asks before overwriting a preset with the same name', async () => {
    const user = userEvent.setup();
    const handlers = setup({ presets: [preset()] });

    await user.click(screen.getByRole('button', { name: 'Save as preset…' }));
    await user.type(screen.getByLabelText('Preset name'), 'Weekly cleanup');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // First click only warns; nothing is written yet.
    expect(handlers.onSavePreset).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('already exists');

    // The second click confirms, reusing the existing preset's id.
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    expect(handlers.onSavePreset).toHaveBeenCalledWith('Weekly cleanup', 'p1');
  });

  it('rejects an empty name with an explanation', async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(screen.getByRole('button', { name: 'Save as preset…' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(handlers.onSavePreset).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name');
  });

  it('closes the save form on Escape without saving', async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(screen.getByRole('button', { name: 'Save as preset…' }));
    await user.type(screen.getByLabelText('Preset name'), 'Half-typed');
    await user.keyboard('{Escape}');

    expect(screen.queryByLabelText('Preset name')).not.toBeInTheDocument();
    expect(handlers.onSavePreset).not.toHaveBeenCalled();
  });

  it('shows an error returned by the save handler', async () => {
    const user = userEvent.setup();
    setup({ onSavePreset: vi.fn(() => 'These steps only use duplicate column names.') });

    await user.click(screen.getByRole('button', { name: 'Save as preset…' }));
    await user.type(screen.getByLabelText('Preset name'), 'Recipe');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('alert')).toHaveTextContent('duplicate column names');
    // The form stays open so the name can be fixed.
    expect(screen.getByLabelText('Preset name')).toBeInTheDocument();
  });

  it('lists saved presets with a summary and applies one', async () => {
    const user = userEvent.setup();
    const handlers = setup({ presets: [preset()] });

    expect(screen.getByText('Weekly cleanup')).toBeInTheDocument();
    expect(screen.getByText('trim')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply preset: Weekly cleanup' }));
    expect(handlers.onApplyPreset).toHaveBeenCalledWith('p1');
  });

  it('deletes a preset from its row', async () => {
    const user = userEvent.setup();
    const handlers = setup({ presets: [preset()] });

    await user.click(screen.getByRole('button', { name: 'Delete preset: Weekly cleanup' }));
    expect(handlers.onDeletePreset).toHaveBeenCalledWith('p1');
  });

  it('explains that presets match columns by header name', () => {
    setup({ presets: [preset()] });
    expect(screen.getByText(/match columns by header name/)).toBeInTheDocument();
  });
});
