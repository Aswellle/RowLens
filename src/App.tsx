/**
 * Application shell: empty state → import (progress + cancel) → ready view.
 * Imports run through the coordinator (worker + IndexedDB + ACK backpressure);
 * the grid reads cells from the write-through in-memory store, never from
 * React state. The synthetic sample bypasses the pipeline and feeds the same
 * store shape.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { AppError } from './app/app-error';
import { AppHeader } from './components/AppHeader';
import { CleaningPanel } from './components/CleaningPanel';
import { DataGrid, type GridSort } from './components/DataGrid';
import { DropZone } from './components/DropZone';
import { EmptyState } from './components/EmptyState';
import { FileInfoBar } from './components/FileInfoBar';
import { NoResultsState } from './components/GridStates';
import { ImportProgress } from './components/ImportProgress';
import { NoticeBar, type NoticeVariant } from './components/NoticeBar';
import { StatusLine } from './components/StatusLine';
import { Toolbar } from './components/Toolbar';
import {
  ImportCoordinator,
  type ActiveImport,
  type ImportProgress as ImportProgressInfo,
} from './features/import/coordinator';
import { createImportWorkerTransport } from './features/import/worker-transport';
import { rowMatchesSearch, sortIndicesStable } from './features/query/literal';
import { validateForImport } from './features/import/validate';
import { DatasetRepository } from './features/dataset/repository';
import { InMemoryDataset } from './features/dataset/store';
import type { ColumnDefinition, DatasetFormat, DatasetMetadata } from './features/dataset/types';
import {
  SAMPLE_METADATA,
  getRowCount,
  rowValues,
  sampleColumnIds,
  sampleLabels,
} from './features/dataset/sample';

type ReadyData = {
  meta: DatasetMetadata;
  store: InMemoryDataset;
};

type View =
  | { kind: 'empty' }
  | { kind: 'importing'; fileName: string; rowsParsed: number }
  | {
      kind: 'ready';
      data: ReadyData;
      search: string;
      sort: GridSort | null;
    };

function friendlyImportError(error: AppError): string {
  switch (error.code) {
    case 'STORAGE_QUOTA_EXCEEDED':
      return 'Browser storage is full. Remove unused datasets or clear this site’s data, then try importing again.';
    case 'STORAGE_UNAVAILABLE':
      return 'Browser storage is unavailable (for example in some private-browsing modes). Importing needs IndexedDB.';
    case 'PARSE_FAILED':
      return 'The file could not be parsed. Check that it is valid CSV, TSV or JSONL and try again.';
    case 'IMPORT_CANCELLED':
      return 'Import cancelled.';
    default:
      return error.message;
  }
}

function gridColumns(columns: ColumnDefinition[]): { id: string; label: string; width: number }[] {
  return columns.map((column) => ({ id: column.id, label: column.label, width: 140 }));
}

function loadSampleData(): ReadyData {
  const store = new InMemoryDataset();
  const ids = sampleColumnIds();
  const columns: ColumnDefinition[] = ids.map((id, index) => ({
    id,
    label: sampleLabels()[id] ?? id,
    sourceIndex: index,
  }));
  const rows = Array.from({ length: getRowCount() }, (_, rowIndex) => {
    const values: Record<string, string | null> = {};
    rowValues(rowIndex).forEach((value, columnIndex) => {
      values[ids[columnIndex] ?? ''] = value;
    });
    return { rowIndex, values };
  });
  store.appendBatch(columns, rows);
  return { meta: SAMPLE_METADATA, store };
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'empty' });
  const [notice, setNotice] = useState<{ variant: NoticeVariant; message: string } | null>(null);

  const repositoryRef = useRef<DatasetRepository | null>(null);
  const coordinatorRef = useRef<ImportCoordinator | null>(null);
  const activeImportRef = useRef<ActiveImport | null>(null);
  const storeRef = useRef<InMemoryDataset>(new InMemoryDataset());

  const handleProgress = useCallback((progress: ImportProgressInfo) => {
    setView((current) =>
      current.kind === 'importing' ? { ...current, rowsParsed: progress.rowsParsed } : current,
    );
  }, []);

  const importFile = useCallback(
    async (file: File) => {
      let format: DatasetFormat;
      try {
        format = validateForImport(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The file could not be opened.';
        setNotice({ variant: 'error', message });
        return;
      }

      try {
        repositoryRef.current ??= await DatasetRepository.open();
        coordinatorRef.current ??= new ImportCoordinator({
          repository: repositoryRef.current,
          createTransport: createImportWorkerTransport,
          onProgress: handleProgress,
          onBatch: (batch) => storeRef.current.appendBatch(batch.schemaAppend, batch.rows),
        });

        storeRef.current.reset();
        const active = await coordinatorRef.current.start(file, {
          format,
          hasHeader: true,
        });
        activeImportRef.current = active;
        setNotice(null);
        setView({ kind: 'importing', fileName: file.name, rowsParsed: 0 });

        const outcome = await active.outcome;
        activeImportRef.current = null;

        if (outcome.kind === 'ready') {
          setView({
            kind: 'ready',
            data: { meta: outcome.metadata, store: storeRef.current },
            search: '',
            sort: null,
          });
          if (outcome.metadata.parseErrorCount > 0) {
            setNotice({
              variant: 'warning',
              message: `Imported with ${outcome.metadata.parseErrorCount.toLocaleString('en-US')} parse warnings.`,
            });
          }
        } else if (outcome.kind === 'cancelled') {
          setView({ kind: 'empty' });
        } else {
          setView({ kind: 'empty' });
          setNotice({ variant: 'error', message: friendlyImportError(outcome.error) });
        }
      } catch (error) {
        activeImportRef.current = null;
        setView({ kind: 'empty' });
        setNotice({
          variant: 'error',
          message:
            error instanceof Error
              ? `Import could not start: ${error.message}`
              : 'Import could not start.',
        });
      }
    },
    [handleProgress],
  );

  const loadSample = useCallback(() => {
    setNotice(null);
    const data = loadSampleData();
    storeRef.current = data.store;
    setView({ kind: 'ready', data, search: '', sort: null });
  }, []);

  const removeDataset = useCallback(async () => {
    if (view.kind !== 'ready') return;
    const datasetId = view.data.meta.id;
    storeRef.current = new InMemoryDataset();
    setView({ kind: 'empty' });
    try {
      await repositoryRef.current?.deleteDataset(datasetId);
    } catch {
      // Startup TTL cleanup will retry; the view is already reset.
    }
  }, [view]);

  const visibleIndices = useMemo(() => {
    if (view.kind !== 'ready') return [];
    const { store } = view.data;
    let indices = Array.from({ length: store.rowCount }, (_, i) => i);
    if (view.search !== '') {
      indices = indices.filter((rowIndex) =>
        rowMatchesSearch(store.getRowValues(rowIndex), view.search),
      );
    }
    if (view.sort !== null) {
      const column = view.sort.columnIndex;
      indices = sortIndicesStable(
        indices,
        (rowIndex) => store.getCell(rowIndex, column),
        view.sort.direction,
      );
    }
    return indices;
  }, [view]);

  return (
    <DropZone
      onFilesDropped={(fileList) => {
        const file = fileList[0];
        if (file) void importFile(file);
      }}
    >
      <AppHeader />

      {notice !== null && (
        <NoticeBar variant={notice.variant} onDismiss={() => setNotice(null)}>
          {notice.message}
        </NoticeBar>
      )}

      {view.kind === 'empty' && (
        <EmptyState onChooseFile={(file) => void importFile(file)} onLoadSample={loadSample} />
      )}

      {view.kind === 'importing' && (
        <ImportProgress
          fileName={view.fileName}
          rowsParsed={view.rowsParsed}
          onCancel={() => activeImportRef.current?.cancel()}
        />
      )}

      {view.kind === 'ready' && (
        <>
          <FileInfoBar
            fileName={view.data.meta.fileName}
            rowCount={view.data.meta.rowCount}
            columnCount={view.data.meta.columns.length}
            format={view.data.meta.format}
            warningCount={view.data.meta.parseErrorCount}
            onRemove={() => void removeDataset()}
          />
          <Toolbar
            searchTerm={view.search}
            onSearchChange={(search) => setView({ ...view, search })}
          />
          <StatusLine
            matchCount={visibleIndices.length}
            totalRows={view.data.meta.rowCount}
            hasActiveQuery={view.search !== '' || view.sort !== null}
            onReset={() => setView({ ...view, search: '', sort: null })}
          />
          <div className="workspace">
            <CleaningPanel />
            <div className="grid-region">
              {visibleIndices.length === 0 && view.search !== '' ? (
                <NoResultsState
                  searchTerm={view.search}
                  onClear={() => setView({ ...view, search: '' })}
                />
              ) : (
                <DataGrid
                  columns={gridColumns(view.data.meta.columns)}
                  totalRowCount={view.data.meta.rowCount}
                  visibleIndices={visibleIndices}
                  valueAt={(rowIndex, columnIndex) =>
                    view.data.store.getCell(rowIndex, columnIndex)
                  }
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
