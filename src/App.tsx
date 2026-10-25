/**
 * Phase 1 application shell. Orchestrates the honest state machine:
 * empty → loading → ready (synthetic data only). Real file import arrives in
 * Phase 2; choosing/dropping a file says so instead of faking an import.
 */
import { useCallback, useMemo, useState } from 'react';
import { AppHeader } from './components/AppHeader';
import { CleaningPanel } from './components/CleaningPanel';
import { DataGrid, type GridSort } from './components/DataGrid';
import { DropZone } from './components/DropZone';
import { EmptyState } from './components/EmptyState';
import { FileInfoBar } from './components/FileInfoBar';
import { GridErrorState, LoadingState, NoResultsState } from './components/GridStates';
import { NoticeBar } from './components/NoticeBar';
import { StatusLine } from './components/StatusLine';
import { Toolbar } from './components/Toolbar';
import {
  SAMPLE_METADATA,
  allIndices,
  rowValues,
  sampleColumnIds,
  sampleLabels,
  valueAt,
} from './features/dataset/sample';
import { rowMatchesSearch, sortIndicesStable } from './features/query/literal';

type View =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'ready'; search: string; sort: GridSort | null };

const GRID_COLUMNS = sampleColumnIds().map((id, index) => ({
  id,
  label: sampleLabels()[id] ?? id,
  width: index === 7 ? 320 : 140,
}));

const IMPORT_NOTICE =
  'Opening real files arrives in the next development phase — nothing was read or stored. Try the synthetic sample to explore the UI.';

export default function App() {
  const [view, setView] = useState<View>({ kind: 'empty' });
  const [notice, setNotice] = useState<string | null>(null);

  const loadSample = useCallback(() => {
    setNotice(null);
    setView({ kind: 'loading' });
    // A real async boundary so the loading state is genuine, not decorative.
    window.setTimeout(() => setView({ kind: 'ready', search: '', sort: null }), 250);
  }, []);

  const visibleIndices = useMemo(() => {
    if (view.kind !== 'ready') return [];
    let indices = allIndices();
    if (view.search !== '') {
      indices = indices.filter((rowIndex) => rowMatchesSearch(rowValues(rowIndex), view.search));
    }
    if (view.sort !== null) {
      const column = view.sort.columnIndex;
      indices = sortIndicesStable(
        indices,
        (rowIndex) => valueAt(rowIndex, column),
        view.sort.direction,
      );
    }
    return indices;
  }, [view]);

  const matchCount = visibleIndices.length;

  return (
    <DropZone onFilesDropped={() => setNotice(IMPORT_NOTICE)}>
      <AppHeader />

      {notice !== null && (
        <NoticeBar variant="info" onDismiss={() => setNotice(null)}>
          {notice}
        </NoticeBar>
      )}

      {view.kind === 'empty' && (
        <EmptyState onChooseFile={() => setNotice(IMPORT_NOTICE)} onLoadSample={loadSample} />
      )}

      {view.kind === 'loading' && <LoadingState label="Loading sample data…" />}

      {view.kind === 'ready' && (
        <>
          <FileInfoBar
            fileName={SAMPLE_METADATA.fileName}
            rowCount={SAMPLE_METADATA.rowCount}
            columnCount={SAMPLE_METADATA.columns.length}
            format={SAMPLE_METADATA.format}
            warningCount={SAMPLE_METADATA.parseErrorCount}
            onRemove={() => setView({ kind: 'empty' })}
          />
          <Toolbar
            searchTerm={view.search}
            onSearchChange={(search) => setView({ ...view, search })}
          />
          <StatusLine
            matchCount={matchCount}
            totalRows={SAMPLE_METADATA.rowCount}
            hasActiveQuery={view.search !== '' || view.sort !== null}
            onReset={() => setView({ ...view, search: '', sort: null })}
          />
          <div className="workspace">
            <CleaningPanel />
            <div className="grid-region">
              {matchCount === 0 && view.search !== '' ? (
                <NoResultsState
                  searchTerm={view.search}
                  onClear={() => setView({ ...view, search: '' })}
                />
              ) : (
                <DataGrid
                  columns={GRID_COLUMNS}
                  totalRowCount={SAMPLE_METADATA.rowCount}
                  visibleIndices={visibleIndices}
                  valueAt={valueAt}
                  recordLabel={(rowIndex) => `Record ${rowIndex + 1}`}
                  sort={view.sort}
                  onSortChange={(sort) => setView({ ...view, sort })}
                />
              )}
            </div>
          </div>
        </>
      )}
    </DropZone>
  );
}

export { GridErrorState };
