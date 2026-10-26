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
import { AppError, toAppError } from './app/app-error';
import { reduceQueryOutcome } from './features/query/reduce-outcome';
import { AppHeader } from './components/AppHeader';
import { CleaningPanel } from './components/CleaningPanel';
import { DataGrid, type GridCellEdit, type GridSort } from './components/DataGrid';
import { DropZone } from './components/DropZone';
import { EmptyState } from './components/EmptyState';
import { FileInfoBar } from './components/FileInfoBar';
import { LoadingState, NoResultsState } from './components/GridStates';
import { ImportOptions, type DelimiterChoice } from './components/ImportOptions';
import { ExportDialog, type ExportRequest } from './components/ExportDialog';
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
import { createCleaningTransform } from './features/cleaning/transform';
import { trimmedColumnSet } from './features/cleaning/display';
import { cleanedFileName, hasFormulaRisk, sanitizeCsvFileName } from './features/export/csv';
import { runExport } from './features/export/run';
import type { ExportScope } from './features/export/types';
import {
  MAX_EDITS,
  applyEdits,
  canRedo,
  canUndo,
  clearEdits,
  editCount,
  editedValue,
  emptyEditState,
  overridesForQuery,
  redoEdits,
  undoEdits,
  wouldExceedCap,
  type EditInput,
  type EditState,
} from './features/editing/edits';
import {
  EDIT_RECORD_FORMAT,
  deserializeEdits,
  isSupportedEditRecord,
  pruneEdits,
  serializeEdits,
} from './features/editing/persist';
import { readLastDatasetId, rememberLastDataset } from './features/dataset/session';
import { ROW_WRITE_BATCH_SIZE } from './features/dataset/constants';
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
      /** In-memory cell edits; the stored rows are never modified. */
      edits: EditState;
    };

const SEARCH_DEBOUNCE_MS = 250;
/** Coalesces bursts of edits into one persisted record write. */
const EDIT_PERSIST_DEBOUNCE_MS = 400;

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
  const [exportState, setExportState] = useState<{
    open: boolean;
    busy: boolean;
    error: string | null;
  }>({
    open: false,
    busy: false,
    error: null,
  });
  const exportCancelRef = useRef<{ aborted: boolean } | null>(null);
  const sampleRef = useRef<SampleDataset | null>(null);
  /** Set once startup restoration ran, so it never fights a user action. */
  const restoreAttemptedRef = useRef(false);
  /** Latest view, readable from async startup work without stale closures. */
  const viewRef = useRef(view);
  viewRef.current = view;

  const repositoryRef = useRef<DatasetRepository | null>(null);
  const coordinatorRef = useRef<ImportCoordinator | null>(null);
  const queryRunnerRef = useRef<AppQueryRunner | null>(null);
  const activeImportRef = useRef<ActiveImport | null>(null);
  const activeQueryRef = useRef<QueryRun | null>(null);
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
          rememberLastDataset(outcome.metadata.id);
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
            edits: emptyEditState(),
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
      rememberLastDataset(sample.metadata.id);
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
        edits: emptyEditState(),
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
    rememberLastDataset(null);
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

  /**
   * Persist the edit overlay whenever it changes (ADR-027). Debounced so a
   * burst of typing does not queue one write per keystroke; the write is
   * fire-and-forget because losing persistence must not interrupt editing —
   * the in-memory overlay stays authoritative for this session either way.
   */
  const persistedRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (view.kind !== 'ready') return;
    const { id } = view.data.meta;
    const edits = view.edits;
    if (persistedRevisionRef.current === edits.revision) return;
    const timer = window.setTimeout(() => {
      persistedRevisionRef.current = edits.revision;
      void (async () => {
        try {
          const repository = await ensureRepository();
          if (edits.edits.size === 0) {
            await repository.deleteCellEdits(id);
            return;
          }
          await repository.putCellEdits({
            datasetId: id,
            updatedAt: Date.now(),
            format: EDIT_RECORD_FORMAT,
            cells: serializeEdits(edits),
          });
        } catch {
          // Storage full or blocked: the session keeps its edits in memory.
          // Resetting the marker makes the next change retry.
          persistedRevisionRef.current = null;
        }
      })();
    }, EDIT_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [view, ensureRepository]);

  /**
   * Restore the dataset the user was last looking at, together with its saved
   * edits. Runs once; any user action (import, sample, removal) supersedes it,
   * and a dataset that no longer exists simply leaves the empty state in place.
   */
  useEffect(() => {
    if (restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;
    const datasetId = readLastDatasetId();
    if (datasetId === null) return;

    void (async () => {
      try {
        const repository = await ensureRepository();
        const meta = await repository.getDataset(datasetId);
        if (meta === undefined || meta.status !== 'ready') {
          rememberLastDataset(null);
          return;
        }
        // A user action may have started while IndexedDB was opening.
        if (viewRef.current.kind !== 'empty') return;

        const store = new InMemoryDataset();
        const batchSize = ROW_WRITE_BATCH_SIZE;
        for (let offset = 0; offset < meta.rowCount; offset += batchSize) {
          const rows = await repository.readRows(datasetId, offset, batchSize);
          if (rows.length === 0) break;
          store.appendBatch(
            offset === 0 ? meta.columns : undefined,
            rows.map((row) => ({ rowIndex: row.rowIndex, values: row.values })),
          );
        }

        const record = await repository.getCellEdits(datasetId);
        const restoredEdits = isSupportedEditRecord(record)
          ? pruneEdits(
              deserializeEdits(record),
              meta.rowCount,
              new Set(meta.columns.map((column) => column.id)),
            )
          : emptyEditState();
        persistedRevisionRef.current = restoredEdits.revision;

        storeRef.current = store;
        setView({
          kind: 'ready',
          data: { meta, store },
          searchInput: '',
          search: '',
          columnFilters: {},
          sort: null,
          hiddenColumns: [],
          cleaningSteps: [],
          stepSummaries: [],
          rowIndices: [],
          queryBusy: true,
          edits: restoredEdits,
        });
        if (editCount(restoredEdits) > 0) {
          setNotice({
            variant: 'info',
            message: `Restored your previous session with ${editCount(restoredEdits).toLocaleString('en-US')} cell edit${editCount(restoredEdits) === 1 ? '' : 's'}.`,
          });
        }
      } catch {
        // Storage unavailable: the empty state is still a working app.
        rememberLastDataset(null);
      }
    })();
    // Runs once on mount; viewRef guards against clobbering a user action.
  }, [ensureRepository]);

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
  // The revision, not the overlay itself: an edit bumps it, so edits re-run
  // the query without the dep list holding a large Map.
  const editsKey = queryDeps?.edits.revision ?? 0;

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
      const overrides = overridesForQuery(current.edits);
      if (overrides.length > 0) spec.edits = overrides;
      const run = runner.run(spec);
      activeQueryRef.current = run;
      const outcome: QueryOutcome = await run.done;
      activeQueryRef.current = null;
      if (!live) return;
      setView((state) => {
        if (state.kind !== 'ready') return state;
        const reduced = reduceQueryOutcome(state, outcome, (code, message) =>
          friendlyImportError(new AppError(code as AppError['code'], message)),
        );
        if (reduced.notice) {
          setNotice({ variant: reduced.notice.variant, message: reduced.notice.message });
        }
        return reduced.state;
      });
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- leaf keys above
  }, [datasetIdKey, searchKey, filtersKey, sortKey, cleaningKey, editsKey, ensureQueryRunner]);

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

  /** Columns whose values are displayed trimmed, mirroring what exports produce. */
  const trimmedColumns = useMemo(() => {
    if (view.kind !== 'ready') return new Set<string>();
    return trimmedColumnSet(
      view.cleaningSteps,
      view.data.meta.columns.map((column) => column.id),
    );
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

  /** Row indices for an export scope: the current view, or all records. */
  const exportIndices = useCallback(
    (scope: ExportScope): number[] => {
      if (view.kind !== 'ready') return [];
      return scope === 'filtered'
        ? view.rowIndices
        : Array.from({ length: view.data.meta.rowCount }, (_, i) => i);
    },
    [view],
  );

  const countRiskCells = useCallback(
    (scope: ExportScope): number | null => {
      if (view.kind !== 'ready') return 0;
      const { store, meta } = view.data;
      const indices = exportIndices(scope);
      if (indices.length * meta.columns.length > 3_000_000) return -1;
      let count = 0;
      for (const rowIndex of indices) {
        for (let columnIndex = 0; columnIndex < meta.columns.length; columnIndex++) {
          // The estimate must describe what will actually be written, so an
          // edited cell counts with its edited value.
          const stored = store.getCell(rowIndex, columnIndex);
          const columnId = meta.columns[columnIndex]?.id;
          const cell =
            columnId === undefined
              ? stored
              : (editedValue(view.edits, rowIndex, columnId) ?? stored);
          if (cell !== null && hasFormulaRisk(cell)) count += 1;
        }
      }
      return count;
    },
    [view, exportIndices],
  );

  const handleExportConfirm = useCallback(
    async (request: ExportRequest) => {
      if (view.kind !== 'ready') return;
      const cancelFlag = { aborted: false };
      exportCancelRef.current = cancelFlag;
      setExportState({ open: true, busy: true, error: null });

      const { store, meta } = view.data;
      // Captured for the row generator: narrowing does not survive into a
      // nested function, and the export must read the same overlay.
      const edits = view.edits;
      const allColumnIds = meta.columns.map((column) => column.id);
      const transform = view.cleaningSteps.length
        ? createCleaningTransform(view.cleaningSteps, allColumnIds)
        : null;
      const columnIndexes = view.kind === 'ready' ? effectiveDatasetIndexes : ([] as number[]);
      const exportIds = columnIndexes.map((index) => allColumnIds[index]!);
      const indices = exportIndices(request.scope);

      async function* rows(): AsyncGenerator<(string | null)[]> {
        for (const rowIndex of indices) {
          const record: Record<string, string | null> = {};
          for (let d = 0; d < allColumnIds.length; d++) {
            const columnId = allColumnIds[d]!;
            // Edits are part of the data the user sees, so exports include
            // them; cleaning then runs on top of the edited values.
            record[columnId] = editedValue(edits, rowIndex, columnId) ?? store.getCell(rowIndex, d);
          }
          const out = transform
            ? transform.process({ rowIndex, values: record })
            : { rowIndex, values: record };
          if (!out) continue;
          yield exportIds.map((id) => out.values[id] ?? null);
        }
      }

      const header = exportIds.map((id) => meta.columns[allColumnIds.indexOf(id)]?.label ?? id);

      try {
        const result = await runExport({
          fileName: sanitizeCsvFileName(request.fileName),
          header,
          rows: rows(),
          safetyMode: request.safetyMode,
          isCancelled: () => cancelFlag.aborted,
        });
        if (result.status === 'cancelled') {
          setExportState({ open: false, busy: false, error: null });
          setNotice({ variant: 'info', message: 'Export cancelled.' });
          return;
        }
        setExportState({ open: false, busy: false, error: null });
        setNotice({
          variant: 'success',
          message: `${result.stats.rows.toLocaleString('en-US')} rows exported${
            result.stats.protectedCells > 0
              ? `, ${result.stats.protectedCells.toLocaleString('en-US')} cells prefixed for spreadsheet safety`
              : ''
          }.`,
        });
      } catch (error) {
        const appError = toAppError(error) as AppError;
        if (appError.code === 'EXPORT_CANCELLED') {
          setExportState({ open: false, busy: false, error: null });
          return; // save picker dismissed, nothing to report
        }
        setExportState({ open: true, busy: false, error: appError.message });
      } finally {
        exportCancelRef.current = null;
      }
    },
    // effectiveDatasetIndexes is derived from view and captured fresh per run.
    [view, effectiveDatasetIndexes, exportIndices],
  );

  const cancelQuery = useCallback(() => {
    activeQueryRef.current?.cancel();
  }, []);

  /**
   * Commit one cell edit into the overlay. Returns a refusal message when the
   * overlay cap is reached, so the grid can explain instead of silently
   * dropping the draft.
   */
  const commitEdits = useCallback(
    (gridEdits: readonly GridCellEdit[]): string | null => {
      const inputs: EditInput[] = gridEdits.map((edit) => ({
        rowIndex: edit.rowIndex,
        columnId: edit.columnId,
        displayed: edit.displayed,
        stored: edit.stored,
        after: edit.value,
      }));
      let refusal: string | null = null;
      patchReady((current) => {
        if (wouldExceedCap(current.edits, inputs)) {
          refusal = `Cell edits are limited to ${MAX_EDITS.toLocaleString('en-US')} cells. Reset edits or use a cleaning step for bulk changes.`;
          return current;
        }
        const edits = applyEdits(current.edits, inputs);
        if (edits === current.edits) return current;
        return { ...current, edits, queryBusy: true };
      });
      return refusal;
    },
    [patchReady],
  );

  const editCell = useCallback(
    (edit: GridCellEdit): string | null => commitEdits([edit]),
    [commitEdits],
  );

  const undoEdit = useCallback(() => {
    patchReady((current) => {
      const edits = undoEdits(current.edits);
      return edits === current.edits ? current : { ...current, edits, queryBusy: true };
    });
  }, [patchReady]);

  const redoEdit = useCallback(() => {
    patchReady((current) => {
      const edits = redoEdits(current.edits);
      return edits === current.edits ? current : { ...current, edits, queryBusy: true };
    });
  }, [patchReady]);

  const resetEdits = useCallback(() => {
    patchReady((current) => {
      const edits = clearEdits(current.edits);
      return edits === current.edits ? current : { ...current, edits, queryBusy: true };
    });
  }, [patchReady]);

  /**
   * Undo/redo at the document level, so the shortcut works wherever focus is
   * (grid, toolbar, after a click). Text fields keep their native undo: the
   * handler bails out while the event target is an input or a textarea.
   */
  useEffect(() => {
    if (view.kind !== 'ready') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 'z' && event.key.toLowerCase() !== 'y') return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const redo = event.key.toLowerCase() === 'y' || event.shiftKey;
      event.preventDefault();
      if (redo) redoEdit();
      else undoEdit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view.kind, undoEdit, redoEdit]);

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
            onExport={() => setExportState((current) => ({ ...current, open: true, error: null }))}
          />
          {exportState.open && (
            <ExportDialog
              defaultFileName={cleanedFileName(view.data.meta.fileName)}
              filteredCount={view.rowIndices.length}
              totalCount={view.data.meta.rowCount}
              exportColumnCount={effectiveDatasetIndexes.length}
              totalColumnCount={view.data.meta.columns.length}
              countRiskCells={countRiskCells}
              busy={exportState.busy}
              error={exportState.error}
              onConfirm={(request) => void handleExportConfirm(request)}
              onCancel={() => {
                if (exportState.busy) {
                  if (exportCancelRef.current) exportCancelRef.current.aborted = true;
                  return;
                }
                setExportState({ open: false, busy: false, error: null });
              }}
            />
          )}
          <StatusLine
            matchCount={view.rowIndices.length}
            totalRows={view.data.meta.rowCount}
            hasActiveQuery={view.search !== '' || activeFilterCount > 0 || view.sort !== null}
            onReset={() =>
              setView({ ...view, searchInput: '', search: '', columnFilters: {}, sort: null })
            }
            filterCount={activeFilterCount}
            busy={view.queryBusy}
            onCancelQuery={cancelQuery}
            editedCount={editCount(view.edits)}
            canUndoEdit={canUndo(view.edits)}
            canRedoEdit={canRedo(view.edits)}
            onUndoEdit={undoEdit}
            onRedoEdit={redoEdit}
            onResetEdits={resetEdits}
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
                  valueAt={(rowIndex, gridColumnIndex) => {
                    const datasetIndex = effectiveDatasetIndexes[gridColumnIndex] ?? -1;
                    const columnId = view.data.meta.columns[datasetIndex]?.id;
                    const stored = view.data.store.getCell(rowIndex, datasetIndex);
                    // An edit replaces the stored value; trimming still applies
                    // to it so the grid keeps showing what an export would.
                    const raw =
                      columnId === undefined
                        ? stored
                        : (editedValue(view.edits, rowIndex, columnId) ?? stored);
                    if (raw === null || columnId === undefined || !trimmedColumns.has(columnId)) {
                      return raw;
                    }
                    return raw.trim();
                  }}
                  storedValueAt={(rowIndex, gridColumnIndex) =>
                    view.data.store.getCell(
                      rowIndex,
                      effectiveDatasetIndexes[gridColumnIndex] ?? -1,
                    )
                  }
                  isEdited={(rowIndex, gridColumnIndex) => {
                    const columnId =
                      view.data.meta.columns[effectiveDatasetIndexes[gridColumnIndex] ?? -1]?.id;
                    return (
                      columnId !== undefined &&
                      editedValue(view.edits, rowIndex, columnId) !== undefined
                    );
                  }}
                  onEditCell={editCell}
                  onPasteCells={commitEdits}
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
                      queryBusy: true,
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
