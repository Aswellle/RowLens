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
});
