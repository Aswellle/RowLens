import { describe, expect, it } from 'vitest';
import type { CleaningStep } from '../cleaning/types';
import { emptyEditState } from '../editing/edits';
import { queryInputFingerprint, type QueryInputs } from './inputs';

const STEPS: CleaningStep[] = [
  { id: 's1', type: 'trim', enabled: true, scope: { kind: 'all-columns' } },
];

function inputs(overrides: Partial<QueryInputs> = {}): QueryInputs {
  return {
    datasetId: 'ds-1',
    search: '',
    columnFilters: {},
    sort: null,
    cleaningSteps: [],
    editsRevision: emptyEditState().revision,
    ...overrides,
  };
}

describe('queryInputFingerprint', () => {
  it('is stable for identical inputs', () => {
    const a = queryInputFingerprint(inputs());
    const b = queryInputFingerprint(inputs());
    expect(a).toBe(b);
  });

  it('changes when the dataset changes', () => {
    expect(queryInputFingerprint(inputs({ datasetId: 'ds-2' }))).not.toBe(
      queryInputFingerprint(inputs()),
    );
  });

  it('changes when the search changes', () => {
    expect(queryInputFingerprint(inputs({ search: 'open' }))).not.toBe(
      queryInputFingerprint(inputs()),
    );
  });

  it('changes when a filter is added, changed or removed', () => {
    const base = queryInputFingerprint(inputs());
    expect(queryInputFingerprint(inputs({ columnFilters: { c0: 'x' } }))).not.toBe(base);
    expect(queryInputFingerprint(inputs({ columnFilters: { c0: 'y' } }))).not.toBe(
      queryInputFingerprint(inputs({ columnFilters: { c0: 'x' } })),
    );
    expect(queryInputFingerprint(inputs({ columnFilters: { c1: 'x' } }))).not.toBe(
      queryInputFingerprint(inputs({ columnFilters: { c0: 'x' } })),
    );
  });

  it('changes for every sort field — column, direction and the numeric flag (ADR-035)', () => {
    const base = queryInputFingerprint(inputs());
    expect(
      queryInputFingerprint(
        inputs({ sort: { datasetIndex: 1, direction: 'asc', numeric: false } }),
      ),
    ).not.toBe(base);
    expect(
      queryInputFingerprint(
        inputs({ sort: { datasetIndex: 2, direction: 'asc', numeric: false } }),
      ),
    ).not.toBe(
      queryInputFingerprint(
        inputs({ sort: { datasetIndex: 1, direction: 'asc', numeric: false } }),
      ),
    );
    expect(
      queryInputFingerprint(
        inputs({ sort: { datasetIndex: 1, direction: 'desc', numeric: false } }),
      ),
    ).not.toBe(
      queryInputFingerprint(
        inputs({ sort: { datasetIndex: 1, direction: 'asc', numeric: false } }),
      ),
    );
    // The silent-failure case that motivated this module: a numeric toggle
    // with the same column and direction must re-run the query.
    expect(
      queryInputFingerprint(inputs({ sort: { datasetIndex: 1, direction: 'asc', numeric: true } })),
    ).not.toBe(
      queryInputFingerprint(
        inputs({ sort: { datasetIndex: 1, direction: 'asc', numeric: false } }),
      ),
    );
    expect(queryInputFingerprint(inputs({ sort: null }))).not.toBe(
      queryInputFingerprint(
        inputs({ sort: { datasetIndex: 1, direction: 'asc', numeric: false } }),
      ),
    );
  });

  it('changes when cleaning steps change', () => {
    const base = queryInputFingerprint(inputs());
    expect(queryInputFingerprint(inputs({ cleaningSteps: STEPS }))).not.toBe(base);
    expect(
      queryInputFingerprint(inputs({ cleaningSteps: [{ ...STEPS[0]!, enabled: false }] })),
    ).not.toBe(queryInputFingerprint(inputs({ cleaningSteps: STEPS })));
  });

  it('changes when the edit revision bumps', () => {
    expect(queryInputFingerprint(inputs({ editsRevision: 7 }))).not.toBe(
      queryInputFingerprint(inputs({ editsRevision: 6 })),
    );
  });
});
