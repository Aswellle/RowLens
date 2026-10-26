// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from './App';

/**
 * Phase 1 interaction tests: empty state, sample load, live search with live
 * status counts, sort aria state, Esc-to-clear, no-results and reset.
 */
describe('App shell (synthetic data)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows the empty state with honest copy on first load', () => {
    render(<App sampleSize={300} />);
    expect(
      screen.getByRole('heading', { name: 'Explore a data file. Keep it on your device.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Try sample data' })).toBeEnabled();
  });

  it('loads the synthetic sample and reports the full row count', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={300} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));

    await waitFor(() => expect(screen.getByText('300 of 300 rows match')).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.getByText('sample-tickets.csv (synthetic)')).toBeInTheDocument();
    expect(screen.getByRole('grid', { name: 'Data grid' })).toHaveAttribute('aria-rowcount', '300');
  }, 20_000);

  it('search narrows results, updates the live count, and Esc clears in place', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={300} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Search all columns…')), {
      timeout: 15000,
    });

    const search = screen.getByLabelText('Search all columns');
    await user.type(search, 'chat');

    // The committed search term is debounced, then the query runs; wait for
    // the count to move off the unfiltered value.
    await waitFor(
      () => {
        const status = screen.getByText(/of 300 rows match/);
        expect(status).not.toHaveTextContent('300 of 300');
      },
      { timeout: 15000 },
    );

    // Esc clears and keeps focus in the input (UI spec §4).
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    await waitFor(() => expect(screen.getByText('300 of 300 rows match')).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(document.activeElement).toBe(search);
  }, 20_000);

  it('sort clicks cycle ascending → descending → off with aria-sort following', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={300} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(
      () => expect(screen.getByRole('grid', { name: 'Data grid' })).toBeInTheDocument(),
      { timeout: 15000 },
    );

    const statusHeader = screen.getByRole('columnheader', { name: /^Status/ });
    await user.click(screen.getByRole('button', { name: 'Sort by Status' }));
    expect(statusHeader).toHaveAttribute('aria-sort', 'ascending');

    await user.click(screen.getByRole('button', { name: 'Sort by Status' }));
    expect(statusHeader).toHaveAttribute('aria-sort', 'descending');

    await user.click(screen.getByRole('button', { name: 'Sort by Status' }));
    expect(statusHeader).toHaveAttribute('aria-sort', 'none');
  }, 20_000);

  it('a search matching nothing shows the no-results state with a clear action', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={300} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Search all columns…')), {
      timeout: 15000,
    });

    await user.type(screen.getByLabelText('Search all columns'), 'zzz-no-such-value');
    const noResults = await screen.findByText(/No rows match/, undefined, { timeout: 15000 });
    expect(noResults).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('300 of 300 rows match')).toBeInTheDocument();
  }, 20_000);

  it('Remove returns to the empty state', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={300} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })));

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(
      screen.getByRole('heading', { name: 'Explore a data file. Keep it on your device.' }),
    ).toBeInTheDocument();
  }, 20_000);
  it('cleaning steps recompute the view and can be edited and disabled', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={300} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('300 of 300 rows match')).toBeInTheDocument(), {
      timeout: 15000,
    });

    await user.click(screen.getByRole('button', { name: '+ Remove duplicates' }));
    // Full-row keys include unique ticket ids: nothing removed, pipeline ran.
    await waitFor(() => expect(screen.getByText(/rows? removed/)).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.getByText('300 of 300 rows match')).toBeInTheDocument();

    // Narrow the key to the Priority column through the step editor.
    await user.click(screen.getByText('Edit'));
    await user.click(screen.getByRole('checkbox', { name: 'Compare all columns' }));
    await user.click(screen.getByRole('checkbox', { name: 'Use as key Priority' }));
    await waitFor(() => expect(screen.getByText('3 of 300 rows match')).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.getByText('297 rows removed')).toBeInTheDocument();

    // Disabling the step restores the full view.
    await user.click(screen.getByRole('checkbox', { name: 'Enable Remove duplicates' }));
    await waitFor(() => expect(screen.getByText('300 of 300 rows match')).toBeInTheDocument(), {
      timeout: 15000,
    });
  }, 20_000);
  it('shows trimmed values in the grid once a trim step runs', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={300} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('300 of 300 rows match')).toBeInTheDocument(), {
      timeout: 15000,
    });

    // The padded sample note exists raw (title attribute preserves spacing).
    expect(document.querySelector('[title="  padded note  "]')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: '+ Trim whitespace' }));
    await waitFor(() => expect(document.querySelector('[title="padded note"]')).not.toBeNull(), {
      timeout: 15000,
    });
    expect(document.querySelector('[title="  padded note  "]')).toBeNull();
  }, 20_000);
});

/**
 * Cell editing through the real shell: the grid reports a commit, the overlay
 * holds it, and everything downstream (query, counts, undo) follows.
 */
describe('App cell editing', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  async function loadReady(user: ReturnType<typeof userEvent.setup>) {
    render(<App sampleSize={60} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('60 of 60 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });
  }

  it('edits a cell, marks it, and reflects the new value in the grid', async () => {
    const user = userEvent.setup();
    await loadReady(user);

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    const cell = grid.querySelector<HTMLElement>('[data-cell="0-0"]');
    expect(cell).not.toBeNull();
    const original = cell!.querySelector('.grid-cell__text')?.textContent ?? '';

    cell!.focus();
    await user.keyboard('{Enter}');
    const editor = screen.getByRole('textbox', { name: /Edit Ticket in Record 1/ });
    await user.clear(editor);
    await user.type(editor, 'EDITED-1');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(grid.querySelector('[data-cell="0-0"] .grid-cell__text')?.textContent).toBe(
        'EDITED-1',
      ),
    );
    expect(grid.querySelector('[data-cell="0-0"]')).toHaveClass('grid-cell--edited');
    expect(screen.getByText('1 cell edited')).toBeInTheDocument();
    // The original text is no longer what the first record shows.
    if (original !== 'EDITED-1') {
      expect(grid.querySelector('[data-cell="0-0"]')?.textContent).not.toBe(original);
    }
  }, 30_000);

  it('undoes and redoes an edit, and resets every edit at once', async () => {
    const user = userEvent.setup();
    await loadReady(user);

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    const cell = () => grid.querySelector<HTMLElement>('[data-cell="0-0"]');
    const text = () => cell()?.querySelector('.grid-cell__text')?.textContent ?? '';
    const before = text();

    cell()?.focus();
    await user.keyboard('{Enter}');
    await user.clear(screen.getByRole('textbox', { name: /^Edit Ticket in Record 1/ }));
    await user.type(screen.getByRole('textbox', { name: /^Edit Ticket in Record 1/ }), 'TEMP');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(text()).toBe('TEMP'));

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(text()).toBe(before));
    expect(screen.queryByText(/cell edited/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(text()).toBe('TEMP'));

    await user.click(screen.getByRole('button', { name: 'Reset edits' }));
    await waitFor(() => expect(text()).toBe(before));
    // Reset is itself undoable, so the edited value can come back.
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(text()).toBe('TEMP'));
  }, 30_000);

  it('finds an edited value through search', async () => {
    const user = userEvent.setup();
    await loadReady(user);

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
    await user.keyboard('{Enter}');
    await user.clear(screen.getByRole('textbox', { name: /^Edit Ticket in Record 1/ }));
    await user.type(
      screen.getByRole('textbox', { name: /^Edit Ticket in Record 1/ }),
      'zebra-unique-token',
    );
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(grid.querySelector('[data-cell="0-0"] .grid-cell__text')?.textContent).toBe(
        'zebra-unique-token',
      ),
    );

    // The edited value is what the query engine sees, so the row matches.
    await user.type(screen.getByLabelText('Search all columns'), 'zebra-unique-token');
    await waitFor(() => expect(screen.getByText('1 of 60 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });
  }, 30_000);

  it('keeps the source rows intact: removing the edit restores the original', async () => {
    const user = userEvent.setup();
    await loadReady(user);

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    const cell = () => grid.querySelector<HTMLElement>('[data-cell="0-1"]');
    const before = cell()?.querySelector('.grid-cell__text')?.textContent ?? '';

    cell()?.focus();
    await user.keyboard('{Enter}');
    await user.clear(screen.getByRole('textbox', { name: /^Edit Status in Record 1/ }));
    await user.type(screen.getByRole('textbox', { name: /^Edit Status in Record 1/ }), 'changed');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(cell()?.querySelector('.grid-cell__text')?.textContent).toBe('changed'),
    );

    // Undo drops the overlay entry; the value comes back from the store, which
    // proves the edit never touched the stored rows.
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() =>
      expect(cell()?.querySelector('.grid-cell__text')?.textContent).toBe(before),
    );
  }, 30_000);
});
