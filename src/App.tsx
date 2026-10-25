/**
 * Application shell: empty → (import options for CSV/TSV) → import (progress
 * + cancel) → ready. Imports run through the coordinator (worker + IndexedDB
 * + ACK backpressure); search, filters and sorting run through the query
 * worker over stored rows (windowed scans), with the newest query winning.
 * The grid reads cells from the write-through in-memory store, never from
 * React state. The synthetic sample seeds the same IndexedDB pipeline so
 * every dataset is queried the same way.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppError } from './app/app-error';
import { AppHeader } from './components/AppHeader';
import { CleaningPanel } from './components/CleaningPanel';
import { DataGrid, type GridSort } from './components/DataGrid';
import { DropZone } from './components/DropZone';
import { EmptyState } from './components/EmptyState';
import { FileInfoBar } from './components/FileInfoBar';
import { LoadingState, NoResultsState } from './components/GridStates';
import { ImportOptions, type DelimiterChoice } from './components/ImportOptions';
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
import { validateForImport } from './features/import/validate';
import { DatasetRepository } from './features/dataset/repository';
import { InMemoryDataset } from './features/dataset/store';
import type {
  ColumnDefinition,
  ColumnId,
  DatasetFormat,
  DatasetMetadata,
} from './features/dataset/types';
import { createSampleDataset, type SampleDataset } from './features/dataset/sample';
import type { CleaningStep, CleaningStepType, StepSummary } from './features/cleaning/types';
import {
  QueryClient,
  createQueryWorkerTransport,
  runLocalQuery,
  type QueryOutcome,
  type QueryRequestSpec,
  type QueryRun,
} from './features/query/client';

type ReadyData = {
  meta: DatasetMetadata;
  store: InMemoryDataset;
};

type AppQueryRunner = {
  run(spec: QueryRequestSpec): QueryRun;
  dispose(): void;
};

type View =
  | { kind: 'empty' }
  | {
      kind: 'options';
      file: File;
      format: DatasetFormat;
      hasHeader: boolean;
      delimiter: DelimiterChoice;
    }
  | { kind: 'importing'; fileName: string; rowsParsed: number }
  | { kind: 'working'; label: string }
  | {
      kind: 'ready';
      data: ReadyData;
      searchInput: string;
      search: string;
      columnFilters: Record<ColumnId, string>;
      sort: { datasetIndex: number; direction: 'asc' | 'desc' } | null;
      hiddenColumns: ColumnId[];
      cleaningSteps: CleaningStep[];
      stepSummaries: StepSummary[];
      rowIndices: number[];
      queryBusy: boolean;
    };

const SEARCH_DEBOUNCE_MS = 250;

function friendlyImportError(error: AppError): string {
  switch (error.code) {
    case 'STORAGE_QUOTA_EXCEEDED':
      return 'Browser storage is full. Remove unused datasets or clear this site’s data, then try importing again.';
    case 'STORAGE_UNAVAILABLE':
      return 'Browser storage is unavailable (for example in some private-browsing modes). Importing needs IndexedDB.';
    case 'PARSE_FAILED':
      return 'The file could not be parsed. Check that it is valid CSV, TSV or JSONL and try again.';
    default:
      return error.message;
  }
}

function gridColumns(columns: ColumnDefinition[]): { id: string; label: string; width: number }[] {
  return columns.map((column) => ({ id: column.id, label: column.label, width: 140 }));
}

function sampleWireRows(sample: SampleDataset, offset: number, count: number) {
  const ids = sample.columnIds;
  return sample.getRows(offset, count).map((values, i) => ({
    rowIndex: offset + i,
    values: Object.fromEntries(ids.map((id, c) => [id, values[c] ?? null])) as Record<
      ColumnId,
      string | null
    >,
  }));
}

function buildSampleStore(sample: SampleDataset): InMemoryDataset {
  const store = new InMemoryDataset();
  const columns: ColumnDefinition[] = sample.columnIds.map((id, index) => ({
    id,
    label: sample.labels[id] ?? id,
    sourceIndex: index,
  }));
  for (let offset = 0; offset < sample.getRowCount(); offset += 500) {
    store.appendBatch(columns, sampleWireRows(sample, offset, 500));
  }
  return store;
}

async function seedSampleDataset(
  repository: DatasetRepository,
  sample: SampleDataset,
): Promise<void> {
  const id = sample.metadata.id;
  await repository.deleteDataset(id);
  const now = Date.now();
  await repository.insertDataset({
    ...sample.metadata,
    status: 'importing',
    createdAt: now,
    lastTouchedAt: now,
  });
  for (let offset = 0; offset < sample.getRowCount(); offset += 500) {
    await repository.putRows(
      id,
      sampleWireRows(sample, offset, 500).map((row) => ({
        datasetId: id,
        rowIndex: row.rowIndex,
        values: row.values,
      })),
    );
  }
  await repository.finalizeDataset({
    ...sample.metadata,
    status: 'ready',
    lastTouchedAt: Date.now(),
  });
}

export default function App({ sampleSize }: { sampleSize?: number } = {}) {
  const [view, setView] = useState<View>({ kind: 'empty' });
  const [notice, setNotice] = useState<{ variant: NoticeVariant; message: string } | null>(null);
  const sampleRef = useRef<SampleDataset | null>(null);

  const repositoryRef = useRef<DatasetRepository | null>(null);
  const coordinatorRef = useRef<ImportCoordinator | null>(null);
  const queryRunnerRef = useRef<AppQueryRunner | null>(null);
  const activeImportRef = useRef<ActiveImport | null>(null);
  const storeRef = useRef<InMemoryDataset>(new InMemoryDataset());

  const handleProgress = useCallback((progress: ImportProgressInfo) => {
    setView((current) =>
      current.kind === 'importing' ? { ...current, rowsParsed: progress.rowsParsed } : current,
    );
  }, []);

  const ensureRepository = useCallback(async (): Promise<DatasetRepository> => {
    repositoryRef.current ??= await DatasetRepository.open();
    return repositoryRef.current;
  }, []);

  const ensureQueryRunner = useCallback(async (): Promise<AppQueryRunner> => {
    if (queryRunnerRef.current) return queryRunnerRef.current;
    const repository = await ensureRepository();
    if (typeof Worker === 'undefined') {
      // Same engine, same windowed reads — just on this thread.
      queryRunnerRef.current = {
        run: (spec) => ({
          cancel: () => undefined,
          done: runLocalQuery(spec, repository),
        }),
        dispose: () => undefined,
      };
    } else {
      const client = new QueryClient({ createTransport: createQueryWorkerTransport });
      queryRunnerRef.current = {
        run: (spec) => client.run(spec),
        dispose: () => client.dispose(),
      };
    }
    return queryRunnerRef.current;
  }, [ensureRepository]);

  const startImport = useCallback(
    async (
      file: File,
      options: { format: DatasetFormat; hasHeader: boolean; delimiter?: string },
    ) => {
      try {
        const repository = await ensureRepository();
        coordinatorRef.current ??= new ImportCoordinator({
          repository,
          createTransport: createImportWorkerTransport,
          onProgress: handleProgress,
          onBatch: (batch) => storeRef.current.appendBatch(batch.schemaAppend, batch.rows),
        });

        storeRef.current.reset();
        const active = await coordinatorRef.current.start(file, {
          format: options.format,
          hasHeader: options.hasHeader,
          ...(options.delimiter ? { delimiter: options.delimiter } : {}),
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
            searchInput: '',
            search: '',
            columnFilters: {},
            sort: null,
            hiddenColumns: [],
            cleaningSteps: [],
            stepSummaries: [],
            rowIndices: [],
            queryBusy: true,
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
    [ensureRepository, handleProgress],
  );

  const chooseFile = useCallback(
    (file: File) => {
      let format: DatasetFormat;
      try {
        format = validateForImport(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The file could not be opened.';
        setNotice({ variant: 'error', message });
        return;
      }
      setNotice(null);
      if (format === 'csv' || format === 'tsv') {
        setView({ kind: 'options', file, format, hasHeader: true, delimiter: 'auto' });
        return;
      }
      void startImport(file, { format, hasHeader: true });
    },
    [startImport],
  );

  const loadSample = useCallback(async () => {
    setNotice(null);
    setView({ kind: 'working', label: 'Preparing sample data…' });
    try {
      const repository = await ensureRepository();
      const sample = (sampleRef.current ??= createSampleDataset(sampleSize));
      await seedSampleDataset(repository, sample);
      storeRef.current = buildSampleStore(sample);
      setView({
        kind: 'ready',
        data: { meta: { ...sample.metadata, status: 'ready' }, store: storeRef.current },
        searchInput: '',
        search: '',
        columnFilters: {},
        sort: null,
        hiddenColumns: [],
        cleaningSteps: [],
        stepSummaries: [],
        rowIndices: [],
        queryBusy: true,
      });
    } catch {
      setView({ kind: 'empty' });
      setNotice({ variant: 'error', message: 'Sample data could not be prepared.' });
    }
  }, [ensureRepository, sampleSize]);

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

  // Debounce the committed search term behind the input value.
  useEffect(() => {
    if (view.kind !== 'ready') return;
    const timer = window.setTimeout(() => {
      setView((current) =>
        current.kind === 'ready' && current.search !== current.searchInput
          ? { ...current, search: current.searchInput }
          : current,
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [view]);

  // Run the query whenever the committed inputs change. Deps are leaf keys
  // (not the view object) so result updates never re-trigger the query.
  const queryDeps = view.kind === 'ready' ? view : null;
  const datasetIdKey = queryDeps?.data.meta.id ?? '';
  const searchKey = queryDeps?.search ?? '';
  const filtersKey = queryDeps ? JSON.stringify(queryDeps.columnFilters) : '';
  const sortKey = queryDeps?.sort
    ? `${queryDeps.sort.datasetIndex}:${queryDeps.sort.direction}`
    : '';
  const cleaningKey = queryDeps ? JSON.stringify(queryDeps.cleaningSteps) : '';

  useEffect(() => {
    if (view.kind !== 'ready') return;
    let live = true;
    const current = view;
    void (async () => {
      const runner = await ensureQueryRunner();
      if (!live) return;
      const spec: QueryRequestSpec = {
        datasetId: current.data.meta.id,
        columns: current.data.meta.columns.map((column) => column.id),
        search: current.search,
        columnFilters: current.columnFilters,
      };
      if (current.sort) {
        spec.sort = {
          columnIndex: current.sort.datasetIndex,
          direction: current.sort.direction,
        };
      }
      if (current.cleaningSteps.length > 0) spec.cleaning = current.cleaningSteps;
      const run = runner.run(spec);
      const outcome: QueryOutcome = await run.done;
      if (!live) return;
      setView((state) => {
        if (state.kind !== 'ready') return state;
        if (outcome.kind === 'superseded' || outcome.kind === 'cancelled') return state;
        if (outcome.kind === 'limit') {
          setNotice({
            variant: 'warning',
            message: `The query matched more than ${outcome.limit.toLocaleString('en-US')} rows. Narrow the search or filters to see results.`,
          });
          return { ...state, queryBusy: false };
        }
        if (outcome.kind === 'failed') {
          setNotice({ variant: 'error', message: friendlyImportError(outcome.error) });
          return { ...state, queryBusy: false };
        }
        return {
          ...state,
          rowIndices: outcome.rowIndices,
          stepSummaries: outcome.stepSummaries ?? [],
          queryBusy: false,
        };
      });
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- leaf keys above
  }, [datasetIdKey, searchKey, filtersKey, sortKey, cleaningKey, ensureQueryRunner]);

  const readyGridSort: GridSort | null = useMemo(() => {
    if (view.kind !== 'ready' || view.sort === null) return null;
    const visible = view.data.meta.columns
      .map((column, index) => ({ column, index }))
      .filter(({ column }) => !view.hiddenColumns.includes(column.id));
    const selection = [...view.cleaningSteps]
      .reverse()
      .find((step) => step.type === 'select-columns' && step.enabled);
    const kept =
      selection && selection.type === 'select-columns' ? new Set(selection.columnIds) : null;
    const effective = kept ? visible.filter(({ column }) => kept.has(column.id)) : visible;
    const gridIndex = effective.findIndex(({ index }) => index === view.sort?.datasetIndex);
    if (gridIndex === -1 || view.sort === null) return null;
    return { columnIndex: gridIndex, direction: view.sort.direction };
  }, [view]);

  const visibleDatasetIndexes = useMemo(() => {
    if (view.kind !== 'ready') return [] as number[];
    return view.data.meta.columns
      .map((_, index) => index)
      .filter((index) => !view.hiddenColumns.includes(view.data.meta.columns[index]?.id ?? ''));
  }, [view]);

  /** Visible columns further narrowed by the last enabled select-columns step. */
  const effectiveDatasetIndexes = useMemo(() => {
    if (view.kind !== 'ready') return [] as number[];
    const selection = [...view.cleaningSteps]
      .reverse()
      .find((step) => step.type === 'select-columns' && step.enabled);
    if (!selection || selection.type !== 'select-columns') return visibleDatasetIndexes;
    const kept = new Set(selection.columnIds);
    return visibleDatasetIndexes.filter((index) =>
      kept.has(view.data.meta.columns[index]?.id ?? ''),
    );
  }, [view, visibleDatasetIndexes]);

  const patchReady = useCallback(
    (patch: (current: Extract<View, { kind: 'ready' }>) => Extract<View, { kind: 'ready' }>) => {
      setView((current) => (current.kind === 'ready' ? patch(current) : current));
    },
    [],
  );

  const addCleaningStep = useCallback(
    (type: CleaningStepType) => {
      patchReady((current) => {
        const id =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `step-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const step: CleaningStep = (() => {
          switch (type) {
            case 'trim':
              return { id, type, enabled: true, scope: { kind: 'all-columns' } };
            case 'remove-empty-rows':
              return { id, type, enabled: true, scope: { kind: 'all-columns' } };
            case 'remove-duplicates':
              return {
                id,
                type,
                enabled: true,
                keys: { kind: 'all-columns' },
                compare: 'exact',
              };
            case 'select-columns':
              return {
                id,
                type,
                enabled: true,
                columnIds: current.data.meta.columns.map((column) => column.id),
              };
          }
        })();
        return {
          ...current,
          cleaningSteps: [...current.cleaningSteps, step],
          stepSummaries: [],
          queryBusy: true,
        };
      });
    },
    [patchReady],
  );

  const updateCleaningStep = useCallback(
    (step: CleaningStep) => {
      patchReady((current) => ({
        ...current,
        cleaningSteps: current.cleaningSteps.map((existing) =>
          existing.id === step.id ? step : existing,
        ),
        queryBusy: true,
      }));
    },
    [patchReady],
  );

  const removeCleaningStep = useCallback(
    (stepId: string) => {
      patchReady((current) => ({
        ...current,
        cleaningSteps: current.cleaningSteps.filter((step) => step.id !== stepId),
        queryBusy: true,
      }));
    },
    [patchReady],
  );

  const resetCleaningSteps = useCallback(() => {
    patchReady((current) => ({
      ...current,
      cleaningSteps: [],
      stepSummaries: [],
      queryBusy: true,
    }));
  }, [patchReady]);

  const activeFilterCount =
    view.kind === 'ready'
      ? Object.values(view.columnFilters).filter((value) => value !== '').length
      : 0;

  return (
    <DropZone
      onFilesDropped={(fileList) => {
        const file = fileList[0];
        if (file) chooseFile(file);
      }}
    >
      <AppHeader />

      {notice !== null && (
        <NoticeBar variant={notice.variant} onDismiss={() => setNotice(null)}>
          {notice.message}
        </NoticeBar>
      )}

      {view.kind === 'empty' && (
        <EmptyState onChooseFile={chooseFile} onLoadSample={() => void loadSample()} />
      )}

      {view.kind === 'options' && (
        <ImportOptions
          fileName={view.file.name}
          hasHeader={view.hasHeader}
          delimiter={view.delimiter}
          onHasHeaderChange={(hasHeader) => setView({ ...view, hasHeader })}
          onDelimiterChange={(delimiter) => setView({ ...view, delimiter })}
          onStart={() =>
            void startImport(view.file, {
              format: view.format,
              hasHeader: view.hasHeader,
              ...(view.delimiter !== 'auto' ? { delimiter: view.delimiter } : {}),
            })
          }
          onCancel={() => setView({ kind: 'empty' })}
        />
      )}

      {view.kind === 'importing' && (
        <ImportProgress
          fileName={view.fileName}
          rowsParsed={view.rowsParsed}
          onCancel={() => activeImportRef.current?.cancel()}
        />
      )}

      {view.kind === 'working' && <LoadingState label={view.label} />}

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
            searchTerm={view.searchInput}
            onSearchChange={(searchInput) => setView({ ...view, searchInput })}
            columns={view.data.meta.columns.map((column) => ({
              id: column.id,
              label: column.label,
            }))}
            columnFilters={view.columnFilters}
            onColumnFilterChange={(columnId, value) =>
              setView({ ...view, columnFilters: { ...view.columnFilters, [columnId]: value } })
            }
            onClearFilters={() => setView({ ...view, columnFilters: {} })}
            hiddenColumns={new Set(view.hiddenColumns)}
            onToggleColumn={(columnId, visible) =>
              setView({
                ...view,
                hiddenColumns: visible
                  ? view.hiddenColumns.filter((id) => id !== columnId)
                  : [...view.hiddenColumns, columnId],
              })
            }
          />
          <StatusLine
            matchCount={view.rowIndices.length}
            totalRows={view.data.meta.rowCount}
            hasActiveQuery={view.search !== '' || activeFilterCount > 0 || view.sort !== null}
            onReset={() =>
              setView({ ...view, searchInput: '', search: '', columnFilters: {}, sort: null })
            }
            filterCount={activeFilterCount}
            busy={view.queryBusy}
          />
          <div className="workspace">
            <CleaningPanel
              steps={view.cleaningSteps}
              columns={view.data.meta.columns.map((column) => ({
                id: column.id,
                label: column.label,
              }))}
              summaries={new Map(view.stepSummaries.map((s) => [s.stepId, s]))}
              busy={view.queryBusy}
              onAdd={addCleaningStep}
              onUpdate={updateCleaningStep}
              onRemove={removeCleaningStep}
              onReset={resetCleaningSteps}
            />
            <div className="grid-region">
              {view.rowIndices.length === 0 && !view.queryBusy && view.search !== '' ? (
                <NoResultsState
                  searchTerm={view.search}
                  onClear={() => setView({ ...view, searchInput: '', search: '' })}
                />
              ) : (
                <DataGrid
                  columns={gridColumns(
                    effectiveDatasetIndexes.map((index) => view.data.meta.columns[index]!),
                  )}
                  totalRowCount={view.data.meta.rowCount}
                  visibleIndices={view.rowIndices}
                  valueAt={(rowIndex, gridColumnIndex) =>
                    view.data.store.getCell(
                      rowIndex,
                      effectiveDatasetIndexes[gridColumnIndex] ?? -1,
                    )
                  }
                  recordLabel={(rowIndex) => `Record ${rowIndex + 1}`}
                  sort={readyGridSort}
                  onSortChange={(gridSort) =>
                    setView({
                      ...view,
                      sort:
                        gridSort === null
                          ? null
                          : {
                              datasetIndex: effectiveDatasetIndexes[gridSort.columnIndex] ?? 0,
                              direction: gridSort.direction,
                            },
                    })
                  }
                />
              )}
            </div>
          </div>
        </>
      )}
    </DropZone>
  );
}
