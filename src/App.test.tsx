// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { DatasetRepository } from './features/dataset/repository';

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

  it('the numeric toggle reorders a numeric column; string order does not', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={300} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('300 of 300 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });

    const readColumn = () =>
      Array.from({ length: 14 }, (_, rowIndex) =>
        Number(
          document.querySelector(`[data-cell="${rowIndex}-6"] .grid-cell__text`)?.textContent ?? '',
        ),
      );

    // "First response (h)" holds plain integers 0–71. The default string sort
    // interleaves ("0", "1", "10", …), so the first window already contains
    // two-digit values; numeric order puts every single digit first.
    await user.click(screen.getByRole('button', { name: 'Sort by First response (h)' }));
    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: /^First response/ })).toHaveAttribute(
        'aria-sort',
        'ascending',
      ),
    );
    expect(readColumn().some((value) => value >= 10)).toBe(true);

    // Turning the toggle on re-runs the query numerically.
    await user.click(
      screen.getByRole('button', { name: 'Treat First response (h) values as numbers' }),
    );
    await waitFor(() => expect(readColumn().every((value) => value < 10)).toBe(true), {
      timeout: 15_000,
    });
  }, 30_000);

  it('a column:value term searches only that column', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={300} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('300 of 300 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });

    const search = screen.getByLabelText('Search all columns');
    // "P1" only exists in Priority; Status holds open/pending/closed.
    await user.type(search, 'Priority:P1');
    await waitFor(
      () => {
        const status = screen.getByText(/of 300 rows match/).textContent ?? '';
        const count = Number(status.split(' of ')[0]!.replace(/,/g, ''));
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThan(300);
      },
      { timeout: 15_000 },
    );

    // The same text scoped to a column that cannot contain it matches nothing,
    // and the no-results state offers the way back.
    await user.clear(search);
    await user.type(search, 'Status:P1');
    await waitFor(() => expect(screen.getByText(/No rows match/)).toBeInTheDocument(), {
      timeout: 15_000,
    });

    await user.clear(search);
    await user.type(search, 'Status:open');
    await waitFor(
      () => {
        const status = screen.getByText(/of 300 rows match/);
        expect(status).not.toHaveTextContent('300 of 300');
      },
      { timeout: 15_000 },
    );
  }, 30_000);

  it('two search terms must both match', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={300} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('300 of 300 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });

    const search = screen.getByLabelText('Search all columns');
    await user.type(search, 'Status:open chat');
    await waitFor(
      () => {
        const status = screen.getByText(/of 300 rows match/);
        expect(status).not.toHaveTextContent('300 of 300');
      },
      { timeout: 15_000 },
    );
    const narrowed = Number(
      (screen.getByText(/of 300 rows match/).textContent ?? '').split(' of ')[0]!.replace(/,/g, ''),
    );
    expect(narrowed).toBeGreaterThan(0);

    // Dropping the second term can only widen the result.
    await user.type(search, ' zzz-no-such-value');
    await waitFor(() => expect(screen.getByText(/No rows match/)).toBeInTheDocument(), {
      timeout: 15_000,
    });
  }, 30_000);

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

describe('App paste', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  async function loadReady(user: ReturnType<typeof userEvent.setup>) {
    render(<App sampleSize={40} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('40 of 40 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });
  }

  function pasteEvent(text: string) {
    return {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? text : ''),
        setData: () => {},
      },
    };
  }

  it('pastes a block into cells and undoes the whole block at once', async () => {
    const user = userEvent.setup();
    await loadReady(user);

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    const text = (row: number, column: number) =>
      grid.querySelector(`[data-cell="${row}-${column}"] .grid-cell__text`)?.textContent ?? '';
    const before = [text(0, 0), text(0, 1), text(1, 0), text(1, 1)];

    grid.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
    fireEvent.paste(grid, pasteEvent('P1\tP2\r\nP3\tP4'));

    await waitFor(() => expect(text(0, 0)).toBe('P1'));
    expect(text(0, 1)).toBe('P2');
    expect(text(1, 0)).toBe('P3');
    expect(text(1, 1)).toBe('P4');
    expect(screen.getByText('4 cells edited')).toBeInTheDocument();
    expect(screen.getByText('Pasted 4 cells.')).toBeInTheDocument();

    // One paste is one undo entry, so a single undo restores all four cells.
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(text(0, 0)).toBe(before[0]));
    expect([text(0, 0), text(0, 1), text(1, 0), text(1, 1)]).toEqual(before);
    expect(screen.queryByText(/cell edited|cells edited/)).not.toBeInTheDocument();
  }, 30_000);

  it('makes pasted values findable by search', async () => {
    const user = userEvent.setup();
    await loadReady(user);

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
    fireEvent.paste(grid, pasteEvent('unique-paste-token'));

    await waitFor(() =>
      expect(grid.querySelector('[data-cell="0-0"] .grid-cell__text')?.textContent).toBe(
        'unique-paste-token',
      ),
    );

    await user.type(screen.getByLabelText('Search all columns'), 'unique-paste-token');
    await waitFor(() => expect(screen.getByText('1 of 40 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });
  }, 30_000);
});

/**
 * Session continuity: edits and the last dataset survive a reload because they
 * are persisted separately from the imported rows (ADR-027).
 */
describe('App session restore', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  async function loadAndEdit(user: ReturnType<typeof userEvent.setup>, size = 40) {
    render(<App sampleSize={size} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(
      () => expect(screen.getByText(`${size} of ${size} rows match`)).toBeInTheDocument(),
      {
        timeout: 15_000,
      },
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
    await user.keyboard('{Enter}');
    await user.clear(screen.getByRole('textbox', { name: /^Edit Ticket in Record 1/ }));
    await user.type(
      screen.getByRole('textbox', { name: /^Edit Ticket in Record 1/ }),
      'PERSISTED-EDIT',
    );
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(grid.querySelector('[data-cell="0-0"] .grid-cell__text')?.textContent).toBe(
        'PERSISTED-EDIT',
      ),
    );
    return grid;
  }

  it('restores the last dataset and its edits after a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App sampleSize={40} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('40 of 40 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
    await user.keyboard('{Enter}');
    await user.clear(screen.getByRole('textbox', { name: /^Edit Ticket in Record 1/ }));
    await user.type(
      screen.getByRole('textbox', { name: /^Edit Ticket in Record 1/ }),
      'PERSISTED-EDIT',
    );
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(grid.querySelector('[data-cell="0-0"] .grid-cell__text')?.textContent).toBe(
        'PERSISTED-EDIT',
      ),
    );

    // Wait for the debounced write to land before tearing the app down.
    await waitFor(
      () => {
        const raw = window.localStorage.getItem('rowlens:last-dataset');
        expect(raw).toBe('sample-tickets');
      },
      { timeout: 5_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    unmount();

    // A fresh mount restores the dataset and the edit from IndexedDB.
    render(<App sampleSize={40} />);
    await waitFor(
      () =>
        expect(
          screen
            .getByRole('grid', { name: 'Data grid' })
            .querySelector('[data-cell="0-0"] .grid-cell__text')?.textContent,
        ).toBe('PERSISTED-EDIT'),
      { timeout: 15_000 },
    );
    expect(screen.getByText('1 cell edited')).toBeInTheDocument();
    expect(screen.getByText(/Restored your previous session with 1 cell edit/)).toBeInTheDocument();
  }, 40_000);

  it('does not restore a dataset the user removed', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={40} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('40 of 40 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Explore a data file. Keep it on your device.' }),
      ).toBeInTheDocument(),
    );
    expect(window.localStorage.getItem('rowlens:last-dataset')).toBeNull();
  }, 30_000);

  it('stays on the empty state when the remembered dataset is gone', async () => {
    // A pointer left over from a cleared profile must not resurrect anything.
    window.localStorage.setItem('rowlens:last-dataset', 'deleted-dataset-id');
    render(<App sampleSize={40} />);

    await waitFor(
      () =>
        expect(
          screen.getByRole('heading', { name: 'Explore a data file. Keep it on your device.' }),
        ).toBeInTheDocument(),
      { timeout: 10_000 },
    );
    await waitFor(() => expect(window.localStorage.getItem('rowlens:last-dataset')).toBeNull());
  }, 20_000);

  it('keeps the imported rows unchanged while edits persist separately', async () => {
    const user = userEvent.setup();
    const grid = await loadAndEdit(user);
    expect(grid.querySelector('[data-cell="0-0"]')).toHaveClass('grid-cell--edited');

    // Resetting the edits removes the record rather than writing values back.
    await user.click(screen.getByRole('button', { name: 'Reset edits' }));
    await waitFor(() => expect(screen.queryByText(/cells? edited/)).not.toBeInTheDocument());
    expect(grid.querySelector('[data-cell="0-0"]')).not.toHaveClass('grid-cell--edited');
  }, 30_000);
});

/**
 * The cleaning pipeline is configuration, so it is restored with the dataset
 * (ADR-030) — the same way cell edits are.
 */
describe('App pipeline persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('restores the cleaning pipeline after a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App sampleSize={60} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('60 of 60 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });

    await user.click(screen.getByRole('button', { name: '+ Remove duplicates' }));
    await waitFor(() => expect(screen.getByText(/rows? removed/)).toBeInTheDocument(), {
      timeout: 15_000,
    });
    // The step exists in the panel before the reload.
    expect(screen.getByText('Remove duplicates')).toBeInTheDocument();

    // Let the debounced pipeline write land, then remount as a reload would.
    await new Promise((resolve) => setTimeout(resolve, 800));
    unmount();

    render(<App sampleSize={60} />);
    await waitFor(() => expect(screen.getByText('Remove duplicates')).toBeInTheDocument(), {
      timeout: 15_000,
    });
    // The pipeline actually ran again: the summary is present, not just the step.
    await waitFor(() => expect(screen.getByText(/rows? removed/)).toBeInTheDocument(), {
      timeout: 15_000,
    });
    expect(
      screen.getByText(/Restored your previous session with 1 cleaning step/),
    ).toBeInTheDocument();
  }, 40_000);

  it('does not restore a pipeline the user reset', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App sampleSize={60} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('60 of 60 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });

    await user.click(screen.getByRole('button', { name: '+ Trim whitespace' }));
    await waitFor(() => expect(screen.getByText('Trim whitespace')).toBeInTheDocument(), {
      timeout: 10_000,
    });
    // Reset is a two-step confirmation, so the second click confirms it.
    await user.click(screen.getByRole('button', { name: 'Reset all steps' }));
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }));
    await waitFor(() => expect(screen.getByText('No cleaning steps yet.')).toBeInTheDocument(), {
      timeout: 10_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));
    unmount();

    render(<App sampleSize={60} />);
    await waitFor(() => expect(screen.getByText('60 of 60 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });
    expect(screen.getByText('No cleaning steps yet.')).toBeInTheDocument();
  }, 40_000);
});

/**
 * The query view (search, filters, sort, hidden columns) is the other half of
 * "where I left off": reopening a dataset returns to what was on screen
 * instead of the unfiltered table (ADR-031).
 */
describe('App view persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  async function loadSample(user: ReturnType<typeof userEvent.setup>, size: number): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(
      () => expect(screen.getByText(`${size} of ${size} rows match`)).toBeInTheDocument(),
      { timeout: 15_000 },
    );
  }

  it('restores the search term and its narrowed result after a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App sampleSize={80} />);
    await loadSample(user, 80);

    await user.type(screen.getByLabelText('Search all columns'), 'T-0001');
    // Wait for the debounced query to actually narrow the count, not just for
    // the status line to exist (it is present the whole time).
    await waitFor(
      () => expect(screen.getByText(/of 80 rows match/).textContent).not.toContain('80 of 80'),
      { timeout: 15_000 },
    );
    const narrowed = screen.getByText(/of 80 rows match/).textContent ?? '';

    // Let the debounced write land, then remount as a reload would.
    await new Promise((resolve) => setTimeout(resolve, 800));
    unmount();

    render(<App sampleSize={80} />);
    await waitFor(() => expect(screen.getByText(/of 80 rows match/).textContent).toBe(narrowed), {
      timeout: 15_000,
    });
    expect(screen.getByLabelText('Search all columns')).toHaveValue('T-0001');
    expect(
      screen.getByText(/Restored your previous session with its filters and sort/),
    ).toBeInTheDocument();
  }, 40_000);

  it('restores the sort direction after a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App sampleSize={80} />);
    await loadSample(user, 80);

    await user.click(screen.getByRole('button', { name: 'Sort by Status' }));
    expect(screen.getByRole('columnheader', { name: /^Status/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );

    await new Promise((resolve) => setTimeout(resolve, 800));
    unmount();

    render(<App sampleSize={80} />);
    await waitFor(
      () =>
        expect(screen.getByRole('columnheader', { name: /^Status/ })).toHaveAttribute(
          'aria-sort',
          'ascending',
        ),
      { timeout: 15_000 },
    );
  }, 40_000);

  it('restores the numeric sort mode after a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App sampleSize={80} />);
    await loadSample(user, 80);

    await user.click(screen.getByRole('button', { name: 'Sort by Status' }));
    await user.click(screen.getByRole('button', { name: 'Treat Status values as numbers' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Treat Status values as numbers' }),
      ).toHaveAttribute('aria-pressed', 'true'),
    );

    await new Promise((resolve) => setTimeout(resolve, 800));
    unmount();

    render(<App sampleSize={80} />);
    await waitFor(
      () =>
        expect(
          screen.getByRole('button', { name: 'Treat Status values as numbers' }),
        ).toHaveAttribute('aria-pressed', 'true'),
      { timeout: 15_000 },
    );
  }, 40_000);

  it('restores hidden columns and lets Reset bring them back', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App sampleSize={80} />);
    await loadSample(user, 80);

    await user.click(screen.getByRole('button', { name: 'Columns' }));
    await user.click(screen.getByRole('checkbox', { name: /Status/ }));
    await waitFor(() => expect(screen.getByText('1 column hidden')).toBeInTheDocument());
    expect(screen.queryByRole('columnheader', { name: /Status/ })).not.toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 800));
    unmount();

    render(<App sampleSize={80} />);
    await waitFor(() => expect(screen.getByText('1 column hidden')).toBeInTheDocument(), {
      timeout: 15_000,
    });
    expect(screen.queryByRole('columnheader', { name: /Status/ })).not.toBeInTheDocument();

    // Reset clears the whole view, hidden columns included.
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: /Status/ })).toBeInTheDocument(),
    );
    expect(screen.queryByText('1 column hidden')).not.toBeInTheDocument();
  }, 40_000);

  it('does not restore a view the user reset', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App sampleSize={80} />);
    await loadSample(user, 80);

    await user.type(screen.getByLabelText('Search all columns'), 'T-0002');
    // The Reset control appears with the active query, which lands after the
    // search debounce — wait for the count to narrow first.
    await waitFor(
      () => expect(screen.getByText(/of 80 rows match/).textContent).not.toContain('80 of 80'),
      { timeout: 15_000 },
    );
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(screen.getByText('80 of 80 rows match')).toBeInTheDocument());

    await new Promise((resolve) => setTimeout(resolve, 800));
    unmount();

    render(<App sampleSize={80} />);
    await waitFor(() => expect(screen.getByText('80 of 80 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });
    expect(screen.getByLabelText('Search all columns')).toHaveValue('');
    expect(
      screen.queryByText(/Restored your previous session with its filters and sort/),
    ).not.toBeInTheDocument();
  }, 40_000);
});

/**
 * Presets are recipes, not per-dataset state: they survive the dataset they
 * were captured from and can be applied to a different file (ADR-032).
 */
describe('App cleaning presets', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    // Presets are global, so they survive into the next test in this file.
    const repository = await DatasetRepository.open();
    await repository.deletePresets();
  });

  async function loadSample(user: ReturnType<typeof userEvent.setup>, size: number): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(
      () => expect(screen.getByText(`${size} of ${size} rows match`)).toBeInTheDocument(),
      { timeout: 15_000 },
    );
  }

  async function savePreset(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Save as preset…' }));
    await user.type(screen.getByLabelText('Preset name'), name);
    await user.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('saves the pipeline as a preset and keeps it after a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App sampleSize={60} />);
    await loadSample(user, 60);

    await user.click(screen.getByRole('button', { name: '+ Trim whitespace' }));
    await waitFor(() => expect(screen.getByText('Trim whitespace')).toBeInTheDocument(), {
      timeout: 10_000,
    });
    await savePreset(user, 'Weekly cleanup');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply preset: Weekly cleanup' })).toBeVisible(),
    );

    await new Promise((resolve) => setTimeout(resolve, 600));
    unmount();

    // Presets load on startup independently of the dataset restore.
    render(<App sampleSize={60} />);
    await waitFor(
      () =>
        expect(screen.getByRole('button', { name: 'Apply preset: Weekly cleanup' })).toBeVisible(),
      { timeout: 15_000 },
    );
  }, 40_000);

  it('keeps presets after the dataset they came from is removed', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={60} />);
    await loadSample(user, 60);

    await user.click(screen.getByRole('button', { name: '+ Trim whitespace' }));
    await waitFor(() => expect(screen.getByText('Trim whitespace')).toBeInTheDocument(), {
      timeout: 10_000,
    });
    await savePreset(user, 'Reusable recipe');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply preset: Reusable recipe' })).toBeVisible(),
    );

    // Removing the dataset deletes its rows, edits, pipeline and view — but the
    // preset is a recipe for other files, so it must outlive them.
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Explore a data file. Keep it on your device.' }),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('60 of 60 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });
    expect(screen.getByRole('button', { name: 'Apply preset: Reusable recipe' })).toBeVisible();
    // The new dataset starts with an empty pipeline; the preset is not applied
    // automatically.
    expect(screen.getByText('No cleaning steps yet.')).toBeInTheDocument();
  }, 40_000);

  it('applies a preset to a fresh pipeline and recomputes the view', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={60} />);
    await loadSample(user, 60);

    await user.click(screen.getByRole('button', { name: '+ Remove duplicates' }));
    await waitFor(() => expect(screen.getByText(/rows? removed/)).toBeInTheDocument(), {
      timeout: 15_000,
    });
    await savePreset(user, 'Dedupe');

    // Clear the pipeline, then re-apply the recipe from scratch.
    await user.click(screen.getByRole('button', { name: 'Reset all steps' }));
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }));
    await waitFor(() => expect(screen.getByText('No cleaning steps yet.')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Apply preset: Dedupe' }));
    await waitFor(() => expect(screen.getByText('Remove duplicates')).toBeInTheDocument(), {
      timeout: 15_000,
    });
    // The applied step actually ran: its impact summary is present.
    await waitFor(() => expect(screen.getByText(/rows? removed/)).toBeInTheDocument(), {
      timeout: 15_000,
    });
    expect(screen.getByText(/Applied “Dedupe” \(1 step\)/)).toBeInTheDocument();
  }, 40_000);

  it('deletes a preset without touching the current pipeline', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={60} />);
    await loadSample(user, 60);

    await user.click(screen.getByRole('button', { name: '+ Trim whitespace' }));
    await waitFor(() => expect(screen.getByText('Trim whitespace')).toBeInTheDocument(), {
      timeout: 10_000,
    });
    await savePreset(user, 'Temp');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply preset: Temp' })).toBeVisible(),
    );

    await user.click(screen.getByRole('button', { name: 'Delete preset: Temp' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Apply preset: Temp' })).not.toBeInTheDocument(),
    );
    // The live pipeline is untouched by deleting the saved copy.
    expect(screen.getByText('Trim whitespace')).toBeInTheDocument();
    expect(screen.getByText(/Deleted preset “Temp”/)).toBeInTheDocument();
  }, 40_000);
});

/**
 * Preset files carry recipes between browsers (ADR-033). The round trip is the
 * contract: what one browser exports, another can import, and an import never
 * overwrites an existing recipe.
 */
describe('App preset files', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    // Presets are global (ADR-032), so they outlive a dataset and survive into
    // the next test in this file. Clear the store so each case starts from a
    // known, empty list.
    const repository = await DatasetRepository.open();
    await repository.deletePresets();
  });

  async function loadSampleWithPreset(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
  ): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('60 of 60 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });
    await user.click(screen.getByRole('button', { name: '+ Trim whitespace' }));
    await waitFor(() => expect(screen.getByText('Trim whitespace')).toBeInTheDocument(), {
      timeout: 10_000,
    });
    await user.click(screen.getByRole('button', { name: 'Save as preset…' }));
    await user.type(screen.getByLabelText('Preset name'), name);
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: `Apply preset: ${name}` })).toBeVisible(),
    );
  }

  it('exports the presets and imports them back into an empty list', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={60} />);
    await loadSampleWithPreset(user, 'Portable recipe');

    // The export itself is covered end-to-end in `e2e/presets.spec.ts` (a real
    // download is read back and re-imported). Here only the notice matters:
    // jsdom has no download plumbing to assert against.
    await user.click(screen.getByRole('button', { name: 'Export presets…' }));
    await waitFor(() => expect(screen.getByText(/Exported 1 preset/)).toBeInTheDocument());

    // A fresh list: drop the preset, then import a file carrying one.
    await user.click(screen.getByRole('button', { name: 'Delete preset: Portable recipe' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Apply preset: Portable recipe' }),
      ).not.toBeInTheDocument(),
    );

    const file = new File(
      [
        JSON.stringify({
          format: 1,
          exportedAt: '2026-10-26T00:00:00.000Z',
          presets: [
            {
              id: 'imported',
              name: 'Portable recipe',
              createdAt: 1,
              updatedAt: 1,
              steps: [{ type: 'trim', enabled: true, scope: { kind: 'all-columns' } }],
            },
          ],
        }),
      ],
      'rowlens-presets.json',
      { type: 'application/json' },
    );
    await user.upload(screen.getByTestId('preset-file-input'), file);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply preset: Portable recipe' })).toBeVisible(),
    );
    expect(screen.getByText(/Imported 1 preset/)).toBeInTheDocument();
  }, 40_000);

  it('does not overwrite an existing preset when the imported name collides', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={60} />);
    await loadSampleWithPreset(user, 'Weekly cleanup');

    const file = new File(
      [
        JSON.stringify({
          format: 1,
          presets: [
            {
              id: 'other-id',
              name: 'Weekly cleanup',
              createdAt: 1,
              updatedAt: 1,
              steps: [{ type: 'select-columns', enabled: true, labels: ['Ticket'] }],
            },
          ],
        }),
      ],
      'rowlens-presets.json',
      { type: 'application/json' },
    );
    await user.upload(screen.getByTestId('preset-file-input'), file);

    await waitFor(() => expect(screen.getByText(/Imported 0 presets/)).toBeInTheDocument());
    expect(screen.getByText(/name is already in use/)).toBeInTheDocument();
    // The local recipe still holds its trim step: it was not replaced by the
    // incoming select-columns recipe.
    const row = screen.getByRole('button', { name: 'Apply preset: Weekly cleanup' }).closest('li');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('trim')).toBeInTheDocument();
  }, 40_000);

  it('reports an unreadable preset file without touching the list', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={60} />);
    await loadSampleWithPreset(user, 'Keep me');

    const file = new File(['this is not json'], 'broken.json', { type: 'application/json' });
    await user.upload(screen.getByTestId('preset-file-input'), file);

    await waitFor(() => expect(screen.getByText(/not valid JSON/)).toBeInTheDocument());
    // The existing preset survived the failed import.
    expect(screen.getByRole('button', { name: 'Apply preset: Keep me' })).toBeVisible();
  }, 40_000);

  it('refuses a preset file that is far too large', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={60} />);
    await loadSampleWithPreset(user, 'Untouched');

    // A File reports whatever size it was constructed with; no 1 MiB string
    // needs to exist to exercise the guard.
    const file = new File(['{}'], 'huge.json', { type: 'application/json' });
    Object.defineProperty(file, 'size', { value: 2 * 1024 * 1024 });
    await user.upload(screen.getByTestId('preset-file-input'), file);

    await waitFor(() =>
      expect(screen.getByText(/too large to be a preset file/)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Apply preset: Untouched' })).toBeVisible();
  }, 40_000);
});

/**
 * Exporting the selected rectangle (ADR-036): the dialog offers the
 * Selected-range scope exactly when the grid holds a multi-cell selection, and
 * confirming it exports that rectangle through the normal streaming path.
 */
describe('App export selection', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    const repository = await DatasetRepository.open();
    await repository.deletePresets();
  });

  it('exports the selected range and reports its row count', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={60} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('60 of 60 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(screen.getByText('2 × 2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Export' }));
    const dialog = screen.getByRole('dialog', { name: 'Export CSV' });
    expect(within(dialog).getByText(/Selected range \(2 rows × 2 columns\)/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Selected range/)).toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(screen.getByText(/2 rows exported/)).toBeInTheDocument(), {
      timeout: 15_000,
    });
  }, 40_000);

  it('offers no selection scope for a single focused cell', async () => {
    const user = userEvent.setup();
    render(<App sampleSize={60} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('60 of 60 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Export' }));
    const dialog = screen.getByRole('dialog', { name: 'Export CSV' });
    expect(within(dialog).queryByText(/Selected range/)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Filtered rows/)).toBeChecked();
  }, 40_000);
});

/**
 * Exporting a restored dataset must read stored rows through IndexedDB
 * (ADR-037), never through the render cache whose unloaded chunks read as
 * empty cells — the bug this regression test pins: rows beyond the restored
 * prefetch window used to export blank.
 */
describe('App export from a restored dataset', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    const repository = await DatasetRepository.open();
    await repository.deletePresets();
  });

  it('writes real cell values beyond the restored prefetch window', async () => {
    const user = userEvent.setup();
    const first = render(<App sampleSize={80} />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByText('80 of 80 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });
    first.unmount();

    // A fresh mount restores the dataset through the lazy chunk store.
    render(<App sampleSize={80} />);
    await waitFor(() => expect(screen.getByText('80 of 80 rows match')).toBeInTheDocument(), {
      timeout: 15_000,
    });

    const blobs: Blob[] = [];
    const spy = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
      blobs.push(blob as Blob);
      return 'blob:mocked';
    });
    try {
      await user.click(screen.getByRole('button', { name: 'Export' }));
      const dialog = screen.getByRole('dialog', { name: 'Export CSV' });
      await user.click(within(dialog).getByRole('radio', { name: /All rows/ }));
      await user.click(within(dialog).getByRole('button', { name: /Export CSV/ }));
      await waitFor(() => expect(screen.getByText(/80 rows exported/)).toBeInTheDocument(), {
        timeout: 15_000,
      });
    } finally {
      spy.mockRestore();
    }

    expect(blobs).toHaveLength(1);
    const csv = await blobs[0]!.text();
    const lines = csv.split('\r\n').filter((line) => line !== '');
    expect(lines).toHaveLength(81); // header + 80 records
    expect(lines[1]).toContain('T-00001');
    // Row 60 sits two chunks past the restored prefetch window.
    expect(lines[61]).toContain('T-00061');
  }, 40_000);
});
