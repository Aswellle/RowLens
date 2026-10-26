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
import { LazyDatasetStore } from './features/dataset/lazy-store';
import type {
  ColumnDefinition,
  ColumnId,
  DatasetFormat,
  DatasetMetadata,
  StoredRow,
} from './features/dataset/types';
import { createSampleDataset, type SampleDataset } from './features/dataset/sample';
import type { CleaningStep, CleaningStepType, StepSummary } from './features/cleaning/types';
import { createCleaningTransform } from './features/cleaning/transform';
import { trimmedColumnSet } from './features/cleaning/display';
import {
  PIPELINE_RECORD_FORMAT,
  deserializePipeline,
  isSupportedPipelineRecord,
} from './features/cleaning/persist';
import { cleanedFileName, hasFormulaRisk, sanitizeCsvFileName } from './features/export/csv';
import { createDownloadSaver, runExport } from './features/export/run';
import { readRowsByIndices, readRowsForIndices } from './features/export/rows';
import { useDebouncedPersist } from './app/use-debounced-persist';
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
import {
  QueryClient,
  createQueryWorkerTransport,
  runLocalQuery,
  type QueryOutcome,
  type QueryRequestSpec,
  type QueryRun,
} from './features/query/client';
import type { SelectionBounds } from './features/grid/selection';
import { parseSearchQuery } from './features/query/search';
import {
  deserializeView,
  emptyView,
  isActiveView,
  isSupportedViewRecord,
  serializeView,
  viewSignature,
  type ViewState,
} from './features/query/persist';
import {
  PRESET_RECORD_FORMAT,
  applyPreset,
  capturePresetSteps,
  deserializePresets,
  isSupportedPresetRecord,
  type CleaningPreset,
  type PresetColumn,
} from './features/cleaning/presets';
import {
  MAX_PRESET_FILE_BYTES,
  describeImport,
  mergePresets,
  parsePresetFile,
  presetFileName,
  serializePresetFile,
} from './features/cleaning/preset-file';

/**
 * Anything the grid can read cells from synchronously. The import path uses a
 * write-through in-memory store (the rows are already streaming past), while a
 * restored dataset uses a chunked lazy store so a reload does not read the
 * whole dataset before the first paint (ADR-028).
 */
type CellSource = {
  getCell(rowIndex: number, columnIndex: number): string | null;
};

type ReadyData = {
  meta: DatasetMetadata;
  store: CellSource;
  /**
   * Total stored-row reader, present only for lazily restored datasets whose
   * render cache may miss (ADR-037). Export and the risk estimate read through
   * this instead of the cache; the in-memory store needs no second reader.
   */
  readStoredRows?: (offset: number, limit: number) => Promise<StoredRow[]>;
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
      sort: { datasetIndex: number; direction: 'asc' | 'desc'; numeric: boolean } | null;
      hiddenColumns: ColumnId[];
      cleaningSteps: CleaningStep[];
      stepSummaries: StepSummary[];
      rowIndices: number[];
      queryBusy: boolean;
      /** In-memory cell edits; the stored rows are never modified. */
      edits: EditState;
    };

/** Stored rows read per IndexedDB window while exporting a restored dataset. */
const EXPORT_READ_BATCH = 500;

const SEARCH_DEBOUNCE_MS = 250;
/** Coalesces bursts of edits into one persisted record write. */
const EDIT_PERSIST_DEBOUNCE_MS = 400;

/** The pipeline persist signature: dataset-scoped and order-sensitive. */
function pipelineSignatureOf(
  pending: { id: string; steps: readonly CleaningStep[] } | null,
): string {
  return pending === null ? '' : `${pending.id}\n${JSON.stringify(pending.steps)}`;
}

/** A fresh id for a cleaning step or a preset. */
function newPresetId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
  /**
   * Notices produced inside `setView` updaters are parked here and drained by
   * an effect — calling `setNotice` inside an updater would be a side effect in
   * a function React may invoke more than once.
   */
  const pendingNoticeRef = useRef<{ variant: NoticeVariant; message: string } | null>(null);
  /**
   * Named cleaning recipes. They live outside `view` on purpose: a preset is
   * global, not per dataset, and must stay available in the empty state and
   * after the dataset it was captured from is removed (ADR-032).
   */
  const [presets, setPresets] = useState<CleaningPreset[]>([]);
  const [exportState, setExportState] = useState<{
    open: boolean;
    busy: boolean;
    error: string | null;
    /** Size of the grid selection at open time; null when it is a single cell. */
    selection: { rows: number; columns: number } | null;
  }>({
    open: false,
    busy: false,
    error: null,
    selection: null,
  });
  const exportCancelRef = useRef<{ aborted: boolean } | null>(null);
  /**
   * The selection captured when the export dialog opened: dataset row indices
   * in view order plus the selected dataset column indexes. A snapshot, not a
   * live mapping — a query finishing under the modal must not silently change
   * what an export writes (ADR-036).
   */
  const selectionSnapshotRef = useRef<{ rowIndices: number[]; columnIndexes: number[] } | null>(
    null,
  );
  /** Latest grid selection bounds, kept without re-rendering on every drag frame. */
  const selectionBoundsRef = useRef<SelectionBounds | null>(null);
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
  /** Set when the ready view is backed by a lazily loaded restored dataset. */
  const lazyStoreRef = useRef<LazyDatasetStore | null>(null);
  /** Bumped when a lazy chunk lands, so the grid re-reads visible cells. */
  const [chunkRevision, setChunkRevision] = useState(0);

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

        lazyStoreRef.current?.dispose();
        lazyStoreRef.current = null;
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
      lazyStoreRef.current?.dispose();
      lazyStoreRef.current = null;
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
    lazyStoreRef.current?.dispose();
    lazyStoreRef.current = null;
    rememberLastDataset(null);
    setView({ kind: 'empty' });
    try {
      await repositoryRef.current?.deleteDataset(datasetId);
    } catch {
      // Startup TTL cleanup will retry; the view is already reset.
    }
  }, [view]);

  // Debounce the committed search term behind the input value. Keyed on the
  // input itself: depending on the whole view would restart the timer on every
  // query result, and a burst of view changes could postpone the commit
  // indefinitely — the same starvation the persistence effects avoid.
  const searchInput = view.kind === 'ready' ? view.searchInput : '';
  const searchCommitted = view.kind === 'ready' ? view.search : '';
  useEffect(() => {
    if (view.kind !== 'ready') return;
    if (searchInput === searchCommitted) return;
    const timer = window.setTimeout(() => {
      setView((current) =>
        current.kind === 'ready' && current.search !== current.searchInput
          ? { ...current, search: current.searchInput }
          : current,
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- input identity, not the view
  }, [view.kind, searchInput, searchCommitted]);

  /**
   * Persist the edit overlay whenever it changes (ADR-027). Debounced so a
   * burst of typing does not queue one write per keystroke; the write is
   * fire-and-forget because losing persistence must not interrupt editing —
   * the in-memory overlay stays authoritative for this session either way.
   *
   * Keyed on the revision rather than the whole `view`: every query result
   * produces a new view object, and depending on it would restart the timer
   * each time, so a busy query could postpone the write indefinitely.
   */
  const editPersistRef = useRef<{ id: string; edits: EditState } | null>(null);
  editPersistRef.current =
    view.kind === 'ready' ? { id: view.data.meta.id, edits: view.edits } : null;
  const { markPersisted: markEditsPersisted } = useDebouncedPersist(
    view.kind === 'ready' ? `${view.data.meta.id}:${view.edits.revision}` : '',
    async (repository) => {
      const pending = editPersistRef.current;
      if (pending === null) return;
      if (pending.edits.edits.size === 0) {
        await repository.deleteCellEdits(pending.id);
        return;
      }
      await repository.putCellEdits({
        datasetId: pending.id,
        updatedAt: Date.now(),
        format: EDIT_RECORD_FORMAT,
        cells: serializeEdits(pending.edits),
      });
    },
    ensureRepository,
    EDIT_PERSIST_DEBOUNCE_MS,
  );
  /**
   * Persist the cleaning pipeline whenever its configuration changes
   * (ADR-030). Steps are configuration, not data: saving them never touches
   * the stored rows, and applying them stays a view-time projection. An empty
   * pipeline deletes the record so a reset really resets.
   *
   * Keyed on the steps' signature for the same reason as the edits above.
   */
  const pipelinePersistRef = useRef<{
    id: string;
    steps: readonly CleaningStep[];
  } | null>(null);
  if (view.kind === 'ready') {
    pipelinePersistRef.current = {
      id: view.data.meta.id,
      steps: view.cleaningSteps,
    };
  } else {
    pipelinePersistRef.current = null;
  }
  const { markPersisted: markPipelinePersisted } = useDebouncedPersist(
    pipelineSignatureOf(pipelinePersistRef.current),
    async (repository) => {
      const pending = pipelinePersistRef.current;
      if (pending === null) return;
      if (pending.steps.length === 0) {
        await repository.deletePipeline(pending.id);
        return;
      }
      await repository.putPipeline({
        datasetId: pending.id,
        updatedAt: Date.now(),
        format: PIPELINE_RECORD_FORMAT,
        steps: [...pending.steps],
      });
    },
    ensureRepository,
    EDIT_PERSIST_DEBOUNCE_MS,
  );
  /**
   * Persist the query view whenever it changes (ADR-031): the search term, the
   * column filters, the sort and the hidden columns. An untouched view deletes
   * the record rather than storing an empty one, so "Reset" is a real reset at
   * the storage layer too.
   */
  /**
   * The view in stored form, rebuilt on every render but consumed by an effect
   * keyed on `viewPersistSignature`. Depending on the whole `view` would restart
   * the debounce on every query result (rowIndices, summaries, busy flag), so a
   * slow query could keep postponing the write indefinitely.
   */
  const viewPersistRef = useRef<{ id: string; state: ViewState; signature: string } | null>(null);
  if (view.kind === 'ready') {
    const { id } = view.data.meta;
    // Stored by column id so a re-import that reorders columns still sorts the
    // same column; the grid sorts by dataset index.
    const sortColumnId =
      view.sort === null ? null : (view.data.meta.columns[view.sort.datasetIndex]?.id ?? null);
    const state: ViewState = {
      search: view.search,
      columnFilters: view.columnFilters,
      sort:
        sortColumnId === null || view.sort === null
          ? null
          : {
              columnId: sortColumnId,
              direction: view.sort.direction,
              numeric: view.sort.numeric,
            },
      hiddenColumns: view.hiddenColumns,
    };
    // Scoped by dataset id: an identical-looking view on a different dataset
    // is still a change that has to be written.
    viewPersistRef.current = { id, state, signature: `${id}\n${viewSignature(state)}` };
  } else {
    viewPersistRef.current = null;
  }
  const viewPersistSignature = viewPersistRef.current?.signature ?? '';
  const { markPersisted: markViewPersisted } = useDebouncedPersist(
    viewPersistSignature,
    async (repository) => {
      const pending = viewPersistRef.current;
      if (pending === null) return;
      if (!isActiveView(pending.state)) {
        await repository.deleteView(pending.id);
        return;
      }
      await repository.putView(serializeView(pending.state, pending.id));
    },
    ensureRepository,
    EDIT_PERSIST_DEBOUNCE_MS,
  );
  /**
   * Load the saved presets once on startup. Deliberately independent of the
   * dataset restore below: presets are global, so they must be available even
   * when there is nothing to restore (ADR-032).
   */
  const presetsLoadedRef = useRef(false);
  useEffect(() => {
    if (presetsLoadedRef.current) return;
    presetsLoadedRef.current = true;
    void (async () => {
      try {
        const repository = await ensureRepository();
        const record = await repository.getPresets();
        if (!isSupportedPresetRecord(record)) return;
        setPresets(deserializePresets(record));
      } catch {
        // Storage unavailable: presets simply start empty.
      }
    })();
  }, [ensureRepository]);

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

        // Rows are read on demand (500-row chunks) instead of all up front:
        // a reload used to issue one transaction per 500 rows before showing
        // anything, which cost seconds on a large dataset for rows the grid
        // would never render (ADR-028). A landed chunk bumps a counter so the
        // grid re-reads the cells it is already showing.
        let chunksLoaded = 0;
        const store = new LazyDatasetStore(
          meta.columns,
          meta.rowCount,
          (offset, limit) => repository.readRows(datasetId, offset, limit),
          () => {
            chunksLoaded += 1;
            setChunkRevision(chunksLoaded);
          },
        );
        store.ensureRows(0, 40);

        const record = await repository.getCellEdits(datasetId);
        const restoredEdits = isSupportedEditRecord(record)
          ? pruneEdits(
              deserializeEdits(record),
              meta.rowCount,
              new Set(meta.columns.map((column) => column.id)),
            )
          : emptyEditState();
        markEditsPersisted(`${datasetId}:${restoredEdits.revision}`);

        // The cleaning pipeline is configuration, so it is restored together
        // with the dataset: reopening a file should not make the user rebuild
        // the steps they already defined (ADR-030).
        const pipelineRecord = await repository.getPipeline(datasetId);
        const validColumns = new Set(meta.columns.map((column) => column.id));
        const restoredSteps = isSupportedPipelineRecord(pipelineRecord)
          ? deserializePipeline(pipelineRecord, validColumns)
          : [];
        markPipelinePersisted(pipelineSignatureOf({ id: datasetId, steps: restoredSteps }));

        // The query view is the other half of "where I left off": the filter
        // the user was reading through is as much a part of the session as the
        // pipeline. It is restored last so the grid's first paint is already
        // filtered and sorted, never a flash of the full table (ADR-031).
        const viewRecord = await repository.getView(datasetId);
        const restoredView = isSupportedViewRecord(viewRecord)
          ? deserializeView(viewRecord, validColumns)
          : emptyView();
        markViewPersisted(`${datasetId}\n${viewSignature(restoredView)}`);
        // Stored by column id so a re-import that reorders columns still
        // sorts the same column; the grid sorts by dataset index.
        const restoredSortIndex =
          restoredView.sort === null
            ? -1
            : meta.columns.findIndex((column) => column.id === restoredView.sort?.columnId);

        lazyStoreRef.current = store;
        setView({
          kind: 'ready',
          data: {
            meta,
            store,
            readStoredRows: (offset, limit) => repository.readRows(datasetId, offset, limit),
          },
          searchInput: restoredView.search,
          search: restoredView.search,
          columnFilters: restoredView.columnFilters,
          sort:
            restoredSortIndex === -1 || restoredView.sort === null
              ? null
              : {
                  datasetIndex: restoredSortIndex,
                  direction: restoredView.sort.direction,
                  numeric: restoredView.sort.numeric,
                },
          hiddenColumns: restoredView.hiddenColumns,
          cleaningSteps: restoredSteps,
          stepSummaries: [],
          rowIndices: [],
          queryBusy: true,
          edits: restoredEdits,
        });
        const editCountRestored = editCount(restoredEdits);
        const hasRestoredView = isActiveView(restoredView);
        if (editCountRestored > 0 || restoredSteps.length > 0 || hasRestoredView) {
          const parts: string[] = [];
          if (editCountRestored > 0) {
            parts.push(
              `${editCountRestored.toLocaleString('en-US')} cell edit${editCountRestored === 1 ? '' : 's'}`,
            );
          }
          if (restoredSteps.length > 0) {
            parts.push(
              `${restoredSteps.length} cleaning step${restoredSteps.length === 1 ? '' : 's'}`,
            );
          }
          if (hasRestoredView) parts.push('its filters and sort');
          setNotice({
            variant: 'info',
            message: `Restored your previous session with ${parts.join(' and ')}.`,
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
  // The numeric flag is part of the sort identity: toggling it must re-run
  // the query even though column and direction are unchanged (ADR-035).
  const sortKey = queryDeps?.sort
    ? `${queryDeps.sort.datasetIndex}:${queryDeps.sort.direction}:${queryDeps.sort.numeric}`
    : '';
  const cleaningKey = queryDeps ? JSON.stringify(queryDeps.cleaningSteps) : '';
  // The revision, not the overlay itself: an edit bumps it, so edits re-run
  // the query without the dep list holding a large Map.
  const editsKey = queryDeps?.edits.revision ?? 0;

  useEffect(() => {
    if (view.kind !== 'ready') return;
    let live = true;
    const current = view;
    // Every query input change lands here, including search and filter
    // commits that no mutation site marks busy — without this, the longest
    // scans run with no "Searching…" feedback and no way to cancel.
    setView((state) =>
      state.kind === 'ready' && !state.queryBusy ? { ...state, queryBusy: true } : state,
    );
    void (async () => {
      const runner = await ensureQueryRunner();
      if (!live) return;
      const spec: QueryRequestSpec = {
        datasetId: current.data.meta.id,
        columns: current.data.meta.columns.map((column) => column.id),
        // The raw input is parsed here, where the column labels live; the
        // worker only ever sees resolved column indexes (ADR-034).
        searchTerms: parseSearchQuery(
          current.search,
          current.data.meta.columns.map((column) => ({ id: column.id, label: column.label })),
        ),
        columnFilters: current.columnFilters,
      };
      if (current.sort) {
        spec.sort = {
          columnIndex: current.sort.datasetIndex,
          direction: current.sort.direction,
          numeric: current.sort.numeric,
        };
      }
      if (current.cleaningSteps.length > 0) spec.cleaning = current.cleaningSteps;
      const overrides = overridesForQuery(current.edits);
      if (overrides.length > 0) spec.edits = overrides;
      const run = runner.run(spec);
      activeQueryRef.current = run;
      const outcome: QueryOutcome = await run.done;
      // Only the newest run may clear the handle: a superseded run's closure
      // resolves after its successor started, and nulling here would disable
      // Cancel Query for the query that is actually running.
      if (activeQueryRef.current === run) activeQueryRef.current = null;
      if (!live) return;
      setView((state) => {
        if (state.kind !== 'ready') return state;
        const reduced = reduceQueryOutcome(state, outcome, (code, message) =>
          friendlyImportError(new AppError(code as AppError['code'], message)),
        );
        // Stashed for the drain effect below: state updaters must stay pure.
        pendingNoticeRef.current = reduced.notice ?? null;
        return reduced.state;
      });
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- leaf keys above
  }, [datasetIdKey, searchKey, filtersKey, sortKey, cleaningKey, editsKey, ensureQueryRunner]);

  useEffect(() => {
    if (pendingNoticeRef.current === null) return;
    const pending = pendingNoticeRef.current;
    pendingNoticeRef.current = null;
    setNotice(pending);
  });

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
    return {
      columnIndex: gridIndex,
      direction: view.sort.direction,
      numeric: view.sort.numeric,
    };
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

  /** Writes the whole preset list; the record is replaced, never appended. */
  const persistPresets = useCallback(
    (next: CleaningPreset[]) => {
      setPresets(next);
      void (async () => {
        try {
          const repository = await ensureRepository();
          if (next.length === 0) {
            await repository.deletePresets();
            return;
          }
          await repository.putPresets({ format: PRESET_RECORD_FORMAT, presets: next });
        } catch {
          // Storage blocked or full: the presets stay usable for this session.
          setNotice({
            variant: 'error',
            message: 'Presets could not be saved to this browser.',
          });
        }
      })();
    },
    [ensureRepository],
  );

  /**
   * Saves the current pipeline under a name. Returns an error message for the
   * panel to show, or null on success. Overwriting an existing preset keeps its
   * id so anything referring to it stays valid.
   */
  const savePreset = useCallback(
    (name: string, overwriteId?: string): string | null => {
      if (view.kind !== 'ready') return 'Open a dataset before saving a preset.';
      if (view.cleaningSteps.length === 0) return 'Add at least one step first.';
      const columns: PresetColumn[] = view.data.meta.columns.map((column) => ({
        id: column.id,
        label: column.label,
      }));
      const captured = capturePresetSteps(view.cleaningSteps, columns);
      if (captured.steps.length === 0) {
        // Every step pointed at a duplicate header, so nothing could be
        // described by name. Saying so is better than saving an empty recipe.
        return 'These steps only use duplicate column names, which cannot be matched by name in another file.';
      }
      const now = Date.now();
      const existing =
        overwriteId === undefined ? undefined : presets.find((p) => p.id === overwriteId);
      const preset: CleaningPreset = {
        id: existing?.id ?? newPresetId(),
        name,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        steps: captured.steps,
      };
      const next =
        existing === undefined
          ? [...presets, preset]
          : presets.map((entry) => (entry.id === existing.id ? preset : entry));
      persistPresets(next);

      const parts = [`Saved preset “${name}”`];
      if (captured.droppedSteps > 0) {
        parts.push(
          `${captured.droppedSteps} step${captured.droppedSteps === 1 ? '' : 's'} left out because their columns share a header name`,
        );
      }
      setNotice({
        variant: captured.droppedSteps > 0 ? 'warning' : 'info',
        message: `${parts.join(' — ')}.`,
      });
      return null;
    },
    [view, presets, persistPresets],
  );

  const applyPresetById = useCallback(
    (presetId: string) => {
      const preset = presets.find((entry) => entry.id === presetId);
      if (preset === undefined || view.kind !== 'ready') return;
      const columns: PresetColumn[] = view.data.meta.columns.map((column) => ({
        id: column.id,
        label: column.label,
      }));
      const outcome = applyPreset(preset, columns, newPresetId);
      if (outcome.steps.length === 0) {
        setNotice({
          variant: 'warning',
          message: `“${preset.name}” could not be applied: none of its columns exist in this dataset.`,
        });
        return;
      }
      patchReady((current) => ({
        ...current,
        cleaningSteps: outcome.steps,
        stepSummaries: [],
        queryBusy: true,
      }));

      const parts = [
        `Applied “${preset.name}” (${outcome.steps.length} step${outcome.steps.length === 1 ? '' : 's'})`,
      ];
      if (outcome.droppedSteps > 0) {
        parts.push(
          `${outcome.droppedSteps} step${outcome.droppedSteps === 1 ? '' : 's'} skipped because no matching column exists`,
        );
      }
      if (outcome.unresolvedLabels > 0) {
        parts.push(
          `${outcome.unresolvedLabels} column name${outcome.unresolvedLabels === 1 ? '' : 's'} could not be matched uniquely`,
        );
      }
      setNotice({
        variant: outcome.droppedSteps > 0 || outcome.unresolvedLabels > 0 ? 'warning' : 'info',
        message: `${parts.join('; ')}.`,
      });
    },
    [presets, view, patchReady],
  );

  const deletePreset = useCallback(
    (presetId: string) => {
      const preset = presets.find((entry) => entry.id === presetId);
      persistPresets(presets.filter((entry) => entry.id !== presetId));
      if (preset !== undefined) {
        setNotice({ variant: 'info', message: `Deleted preset “${preset.name}”.` });
      }
    },
    [presets, persistPresets],
  );

  /**
   * Download every preset as a JSON file (ADR-033). Only configuration leaves
   * the device — step types and column header names — and only because the
   * user asked for it.
   */
  const exportPresets = useCallback(() => {
    if (presets.length === 0) return;
    const fileName = presetFileName();
    const text = serializePresetFile(presets);
    void (async () => {
      try {
        // A preset file is a few kilobytes, so the download saver is used
        // directly: no streaming picker, and the blob gets the JSON type
        // rather than the CSV default.
        const saver = createDownloadSaver(fileName, MAX_PRESET_FILE_BYTES, {
          mimeType: 'application/json;charset=utf-8',
        });
        await saver.write(text);
        await saver.close();
        setNotice({
          variant: 'info',
          message: `Exported ${presets.length} preset${presets.length === 1 ? '' : 's'} to ${fileName}.`,
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'EXPORT_CANCELLED') return;
        setNotice({
          variant: 'error',
          message: 'The preset file could not be saved.',
        });
      }
    })();
  }, [presets]);

  /**
   * Merge a chosen preset file into the list. Existing presets always win, so
   * an import can never silently overwrite a recipe (ADR-033).
   */
  const importPresets = useCallback(
    (file: File) => {
      void (async () => {
        try {
          if (file.size > MAX_PRESET_FILE_BYTES) {
            setNotice({
              variant: 'error',
              message: 'That file is too large to be a preset file.',
            });
            return;
          }
          const text = await file.text();
          const parsed = parsePresetFile(text);
          if (!parsed.ok) {
            setNotice({ variant: 'error', message: parsed.message });
            return;
          }
          const outcome = mergePresets(presets, parsed.presets, newPresetId);
          if (outcome.added === 0) {
            setNotice({ variant: 'warning', message: describeImport(outcome, parsed.dropped) });
            return;
          }
          persistPresets(outcome.presets);
          setNotice({
            variant:
              outcome.skippedByName > 0 || outcome.skippedByCap > 0 || parsed.dropped > 0
                ? 'warning'
                : 'info',
            message: describeImport(outcome, parsed.dropped),
          });
        } catch {
          setNotice({ variant: 'error', message: 'That file could not be read.' });
        }
      })();
    },
    [presets, persistPresets],
  );

  /** Row indices for an export scope: the current view, or all records. */
  const exportIndices = useCallback(
    (scope: ExportScope): number[] => {
      if (view.kind !== 'ready') return [];
      if (scope === 'selection') return selectionSnapshotRef.current?.rowIndices ?? [];
      return scope === 'filtered'
        ? view.rowIndices
        : Array.from({ length: view.data.meta.rowCount }, (_, i) => i);
    },
    [view],
  );

  /**
   * Formula-risk estimates per scope, computed once and cached while the
   * dialog is open. A lazily restored dataset reads through IndexedDB windows
   * (the render cache would undercount unloaded chunks), so the computation is
   * asynchronous: the first call per scope returns null ("counting…") and the
   * dialog re-asks when the cached value lands.
   */
  const [riskCounts, setRiskCounts] = useState<Partial<Record<ExportScope, number>>>({});
  const riskInFlightRef = useRef<Set<ExportScope>>(new Set());
  const riskOpenTokenRef = useRef(0);

  const countRiskCells = useCallback(
    (scope: ExportScope): number | null => {
      const cached = riskCounts[scope];
      if (cached !== undefined) return cached;
      if (!riskInFlightRef.current.has(scope)) {
        const token = riskOpenTokenRef.current;
        const current = viewRef.current;
        if (current.kind !== 'ready') return 0;
        const { meta, readStoredRows } = current.data;
        const indices = exportIndices(scope);
        const columnIndexes =
          scope === 'selection'
            ? (selectionSnapshotRef.current?.columnIndexes ?? [])
            : meta.columns.map((_, index) => index);
        if (indices.length * columnIndexes.length > 3_000_000) {
          setRiskCounts((prev) => ({ ...prev, [scope]: -1 }));
          return -1;
        }
        riskInFlightRef.current.add(scope);
        void (async () => {
          const edits = current.edits;
          const allColumnIds = meta.columns.map((column) => column.id);
          let count = 0;
          const countRow = (rowIndex: number, values: Record<ColumnId, string | null>) => {
            for (const columnIndex of columnIndexes) {
              const columnId = allColumnIds[columnIndex];
              const cell =
                columnId === undefined
                  ? null
                  : (editedValue(edits, rowIndex, columnId) ?? values[columnId] ?? null);
              if (cell !== null && hasFormulaRisk(cell)) count += 1;
            }
          };
          if (readStoredRows === undefined) {
            const { store } = current.data;
            for (const rowIndex of indices) {
              const values: Record<ColumnId, string | null> = {};
              for (let d = 0; d < allColumnIds.length; d++) {
                values[allColumnIds[d]!] = store.getCell(rowIndex, d);
              }
              countRow(rowIndex, values);
            }
          } else {
            await readRowsForIndices(readStoredRows, indices, (row) => {
              countRow(row.rowIndex, row.values);
            });
          }
          // A dialog reopened for another dataset must not take this result.
          if (token !== riskOpenTokenRef.current) return;
          setRiskCounts((prev) => ({ ...prev, [scope]: count }));
          riskInFlightRef.current.delete(scope);
        })();
      }
      return null;
    },
    [riskCounts, exportIndices],
  );

  /**
   * Opens the export dialog with a snapshot of the current selection. A single
   * focused cell offers no Selected-range scope — extracting one cell is what
   * the cell Copy button is for.
   */
  const openExportDialog = useCallback(() => {
    if (view.kind !== 'ready') return;
    const bounds = selectionBoundsRef.current;
    const columns = bounds === null ? 1 : bounds.right - bounds.left + 1;
    const rows = bounds === null ? 1 : bounds.bottom - bounds.top + 1;
    const isRange = bounds !== null && (rows > 1 || columns > 1);
    if (isRange) {
      selectionSnapshotRef.current = {
        rowIndices: view.rowIndices.slice(bounds.top, bounds.bottom + 1),
        columnIndexes: effectiveDatasetIndexes.slice(bounds.left, bounds.right + 1),
      };
    } else {
      selectionSnapshotRef.current = null;
    }
    riskOpenTokenRef.current += 1;
    riskInFlightRef.current.clear();
    setRiskCounts({});
    setExportState((current) => ({
      ...current,
      open: true,
      error: null,
      selection: isRange ? { rows, columns } : null,
    }));
  }, [view, effectiveDatasetIndexes]);

  const handleExportConfirm = useCallback(
    async (request: ExportRequest) => {
      if (view.kind !== 'ready') return;
      const cancelFlag = { aborted: false };
      exportCancelRef.current = cancelFlag;
      setExportState((current) => ({ ...current, open: true, busy: true, error: null }));

      const { store, meta, readStoredRows } = view.data;
      // Captured for the row generator: narrowing does not survive into a
      // nested function, and the export must read the same overlay.
      const edits = view.edits;
      const allColumnIds = meta.columns.map((column) => column.id);
      const transform = view.cleaningSteps.length
        ? createCleaningTransform(view.cleaningSteps, allColumnIds)
        : null;
      const columnIndexes =
        request.scope === 'selection'
          ? (selectionSnapshotRef.current?.columnIndexes ?? [])
          : effectiveDatasetIndexes;
      const exportIds = columnIndexes.map((index) => allColumnIds[index]!);
      const indices = exportIndices(request.scope);
      // Lazily restored datasets read through IndexedDB windows (ADR-037); the
      // in-memory store's getCell never misses, so it stays the direct source.
      const rowWindow = readStoredRows ?? null;

      async function* rows(): AsyncGenerator<(string | null)[]> {
        if (rowWindow === null) {
          for (const rowIndex of indices) {
            const record: Record<string, string | null> = {};
            for (let d = 0; d < allColumnIds.length; d++) {
              const columnId = allColumnIds[d]!;
              // Edits are part of the data the user sees, so exports include
              // them; cleaning then runs on top of the edited values.
              record[columnId] =
                editedValue(edits, rowIndex, columnId) ?? store.getCell(rowIndex, d);
            }
            const out = transform
              ? transform.process({ rowIndex, values: record })
              : { rowIndex, values: record };
            if (!out) continue;
            yield exportIds.map((id) => out.values[id] ?? null);
          }
          return;
        }
        // Restored dataset: batch the (possibly sorted) view order, read each
        // batch's stored rows through IndexedDB, and never touch the render
        // cache — an unloaded chunk must not export as empty cells.
        for (let start = 0; start < indices.length; start += EXPORT_READ_BATCH) {
          const batch = indices.slice(start, start + EXPORT_READ_BATCH);
          const byIndex = await readRowsByIndices(rowWindow, batch);
          for (const rowIndex of batch) {
            const stored = byIndex.get(rowIndex);
            const record: Record<string, string | null> = {};
            for (let d = 0; d < allColumnIds.length; d++) {
              const columnId = allColumnIds[d]!;
              record[columnId] =
                editedValue(edits, rowIndex, columnId) ?? stored?.values[columnId] ?? null;
            }
            const out = transform
              ? transform.process({ rowIndex, values: record })
              : { rowIndex, values: record };
            if (!out) continue;
            yield exportIds.map((id) => out.values[id] ?? null);
          }
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
          setExportState({ open: false, busy: false, error: null, selection: null });
          setNotice({ variant: 'info', message: 'Export cancelled.' });
          return;
        }
        setExportState({ open: false, busy: false, error: null, selection: null });
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
          setExportState({ open: false, busy: false, error: null, selection: null });
          return; // save picker dismissed, nothing to report
        }
        setExportState((current) => ({
          ...current,
          open: true,
          busy: false,
          error: appError.message,
        }));
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
      const current = viewRef.current;
      if (current.kind === 'ready' && wouldExceedCap(current.edits, inputs)) {
        return `Cell edits are limited to ${MAX_EDITS.toLocaleString('en-US')} cells. Reset edits or use a cleaning step for bulk changes.`;
      }
      patchReady((state) => {
        const edits = applyEdits(state.edits, inputs);
        if (edits === state.edits) return state;
        return { ...state, edits, queryBusy: true };
      });
      return null;
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
            onExport={openExportDialog}
          />
          {exportState.open && (
            <ExportDialog
              defaultFileName={cleanedFileName(view.data.meta.fileName)}
              filteredCount={view.rowIndices.length}
              totalCount={view.data.meta.rowCount}
              exportColumnCount={effectiveDatasetIndexes.length}
              totalColumnCount={view.data.meta.columns.length}
              selection={exportState.selection}
              countRiskCells={countRiskCells}
              busy={exportState.busy}
              error={exportState.error}
              onConfirm={(request) => void handleExportConfirm(request)}
              onCancel={() => {
                if (exportState.busy) {
                  if (exportCancelRef.current) exportCancelRef.current.aborted = true;
                  return;
                }
                setExportState({ open: false, busy: false, error: null, selection: null });
              }}
            />
          )}
          <StatusLine
            matchCount={view.rowIndices.length}
            totalRows={view.data.meta.rowCount}
            hasActiveQuery={
              view.search !== '' ||
              activeFilterCount > 0 ||
              view.sort !== null ||
              view.hiddenColumns.length > 0
            }
            hiddenCount={view.hiddenColumns.length}
            onReset={() =>
              setView({
                ...view,
                searchInput: '',
                search: '',
                columnFilters: {},
                sort: null,
                hiddenColumns: [],
              })
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
              presets={presets}
              onSavePreset={savePreset}
              onApplyPreset={applyPresetById}
              onDeletePreset={deletePreset}
              onExportPresets={exportPresets}
              onImportPresets={importPresets}
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
                  // A lazily restored dataset fills chunks after the first
                  // paint. `dataVersion` re-renders the visible window when a
                  // chunk lands (remounting here would reset scroll position
                  // and fight the user), and warmRows prefetches the rows
                  // about to be scrolled into view.
                  dataVersion={chunkRevision}
                  onSelectionBoundsChange={(bounds) => {
                    selectionBoundsRef.current = bounds;
                  }}
                  {...(lazyStoreRef.current === null
                    ? {}
                    : {
                        warmRows: (first: number, last: number) =>
                          lazyStoreRef.current?.ensureRows(first, last),
                      })}
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
                              numeric: gridSort.numeric,
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
