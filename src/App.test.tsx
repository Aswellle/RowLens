// @vitest-environment jsdom
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
    render(<App />);
    expect(
      screen.getByRole('heading', { name: 'Explore a data file. Keep it on your device.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Try sample data' })).toBeEnabled();
  });

  it('loads the synthetic sample and reports the full row count', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));

    await waitFor(() => expect(screen.getByText('5,000 of 5,000 rows match')).toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(screen.getByText('sample-tickets.csv (synthetic)')).toBeInTheDocument();
    expect(screen.getByRole('grid', { name: 'Data grid' })).toHaveAttribute(
      'aria-rowcount',
      '5000',
    );
  });

  it('search narrows results, updates the live count, and Esc clears in place', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Search all columns…')));

    const search = screen.getByLabelText('Search all columns');
    await user.type(search, 'chat');

    const status = await screen.findByText(/of 5,000 rows match/);
    expect(status).not.toHaveTextContent('5,000 of 5,000');

    // Esc clears and keeps focus in the input (UI spec §4).
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(screen.getByText('5,000 of 5,000 rows match')).toBeInTheDocument();
    expect(document.activeElement).toBe(search);
  });

  it('sort clicks cycle ascending → descending → off with aria-sort following', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() =>
      expect(screen.getByRole('grid', { name: 'Data grid' })).toBeInTheDocument(),
    );

    const statusHeader = screen.getByRole('columnheader', { name: /^Status/ });
    await user.click(screen.getByRole('button', { name: 'Sort by Status' }));
    expect(statusHeader).toHaveAttribute('aria-sort', 'ascending');

    await user.click(screen.getByRole('button', { name: 'Sort by Status' }));
    expect(statusHeader).toHaveAttribute('aria-sort', 'descending');

    await user.click(screen.getByRole('button', { name: 'Sort by Status' }));
    expect(statusHeader).toHaveAttribute('aria-sort', 'none');
  });

  it('a search matching nothing shows the no-results state with a clear action', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Search all columns…')));

    await user.type(screen.getByLabelText('Search all columns'), 'zzz-no-such-value');
    const noResults = await screen.findByText(/No rows match/, undefined, { timeout: 2000 });
    expect(noResults).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('5,000 of 5,000 rows match')).toBeInTheDocument();
  });

  it('Remove returns to the empty state', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Try sample data' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })));

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(
      screen.getByRole('heading', { name: 'Explore a data file. Keep it on your device.' }),
    ).toBeInTheDocument();
  });
});
