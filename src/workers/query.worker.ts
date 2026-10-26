/**
 * Query worker: scans the dataset's stored rows through the shared IndexedDB
 * schema and runs the query engine off the main thread. Results are tagged
 * with the queryId; a CANCEL for the running query stops the scan between
 * batches. Errors stay generic — cell content never enters messages.
 */
import { DatasetRepository } from '../features/dataset/repository';
import { QUERY_MATCH_LIMIT } from '../features/dataset/constants';
import type { StepSummary } from '../features/cleaning/types';
import { createCleaningTransform } from '../features/cleaning/transform';
import { requestToEngineSpec, runQueryEngine } from '../features/query/engine';
import { scanDatasetRows } from '../features/query/scan';
import type { MainToQueryWorker, QueryRequestSpec } from '../features/query/protocol';

type ActiveQuery = {
  queryId: string;
  cancel: () => void;
};

type QueuedQuery = {
  queryId: string;
  spec: QueryRequestSpec;
};

let active: ActiveQuery | null = null;
/**
 * A QUERY_START that arrived while another scan was unwinding. The client
 * supersedes by sending CANCEL immediately followed by the new QUERY_START;
 * CANCEL only flags the running engine, which stops at its next batch
 * boundary — so the new query waits here and starts the moment the old run's
 * `finally` clears the slot. Only the newest queued query is kept: an older
 * queued one could never be read by the client anymore.
 */
let queued: QueuedQuery | null = null;

const post = (message: unknown): void => {
  (self as unknown as { postMessage(message: unknown): void }).postMessage(message);
};

let repositoryPromise: Promise<DatasetRepository> | null = null;

/**
 * Case-folded value cache, amortising search/filter folding across queries.
 * Populated row-by-row on the first pass over a dataset (a Map per row);
 * invalidated when the dataset's stored row count changes (re-import).
 * Trade-off (ADR-022): one folded copy of every cell in exchange for
 * repeated-query speed on large datasets.
 *
 * The cache is a two-entry LRU keyed by dataset id: each entry can hold a
 * folded copy of an entire dataset, so an unbounded map would accumulate every
 * file the session ever queried. Touching an entry on use and evicting the
 * oldest keeps the last two working sets hot.
 */
const foldedCache = new Map<
  string,
  { rowCount: number; rows: Map<number, Record<string, string | null>> }
>();

const FOLDED_CACHE_CAPACITY = 2;

/** Marks a dataset's cache entry as most recently used, evicting if needed. */
function touchFoldedCache(datasetId: string): void {
  const entry = foldedCache.get(datasetId);
  if (entry === undefined) return;
  foldedCache.delete(datasetId);
  foldedCache.set(datasetId, entry);
  while (foldedCache.size > FOLDED_CACHE_CAPACITY) {
    const oldest = foldedCache.keys().next().value;
    if (oldest === undefined) break;
    foldedCache.delete(oldest);
  }
}

async function getRepository(): Promise<DatasetRepository> {
  repositoryPromise ??= DatasetRepository.open();
  return repositoryPromise;
}

async function runQuery(queryId: string, spec: QueryRequestSpec): Promise<void> {
  let cancelled = false;
  active = {
    queryId,
    cancel: () => {
      cancelled = true;
    },
  };

  try {
    const repository = await getRepository();
    const dataset = await repository.getDataset(spec.datasetId);
    if (dataset === undefined) {
      post({
        type: 'ERROR',
        queryId,
        failure: { code: 'DATASET_NOT_FOUND', detail: 'The dataset is no longer stored.' },
      });
      return;
    }

    const hasActiveFilter = Object.values(spec.columnFilters).some((value) => value !== '');
    const hasActiveCleaning = (spec.cleaning ?? []).some((step) => step.enabled);
    if (spec.searchTerms.length === 0 && !hasActiveFilter && !spec.sort && !hasActiveCleaning) {
      // Every row matches by definition; the finalized row count already
      // knows it — no scan, and the match limit never blocks the full view.
      const rowIndices = Array.from({ length: dataset.rowCount }, (_, i) => i);
      post({
        type: 'QUERY_DONE',
        queryId,
        rowIndices,
        matched: rowIndices.length,
        totalRows: rowIndices.length,
      });
      return;
    }

    const transform = spec.cleaning
      ? createCleaningTransform(spec.cleaning, spec.columns)
      : undefined;

    // Cell edits travel with the request; the engine applies them before
    // search/filter/sort/cleaning. The folded cache holds pre-edit values, so
    // an edited cell is folded directly instead of being read from the cache.
    const overrideByRow = new Map<number, Record<string, string>>();
    for (const override of spec.edits ?? []) {
      overrideByRow.set(override.rowIndex, override.values);
    }

    const cacheEntry = foldedCache.get(spec.datasetId);
    const cache =
      cacheEntry && cacheEntry.rowCount === dataset.rowCount
        ? cacheEntry
        : { rowCount: dataset.rowCount, rows: new Map() };
    foldedCache.set(spec.datasetId, cache);
    touchFoldedCache(spec.datasetId);

    const result = await runQueryEngine(
      scanDatasetRows(repository, spec.datasetId),
      requestToEngineSpec(spec),
      {
        foldedAt: (row, columnId) => {
          const override = overrideByRow.get(row.rowIndex);
          if (override !== undefined && columnId in override) {
            return (override[columnId] ?? '').toLocaleLowerCase('en-US');
          }
          let foldedRow = cache.rows.get(row.rowIndex);
          if (foldedRow === undefined) {
            foldedRow = {};
            cache.rows.set(row.rowIndex, foldedRow);
          }
          if (!(columnId in foldedRow)) {
            const raw = row.values[columnId] ?? null;
            foldedRow[columnId] = raw === null ? null : raw.toLocaleLowerCase('en-US');
          }
          return foldedRow[columnId] ?? null;
        },
        ...(overrideByRow.size > 0
          ? { overrideFor: (rowIndex: number) => overrideByRow.get(rowIndex) }
          : {}),
        matchLimit: QUERY_MATCH_LIMIT,
        onProgress: (scanned, matched) =>
          post({ type: 'QUERY_PROGRESS', queryId, scanned, matched }),
        isCancelled: () => cancelled,
        ...(transform ? { transform: (row) => transform.process(row) } : {}),
      },
    );

    switch (result.status) {
      case 'done': {
        const message: {
          type: 'QUERY_DONE';
          queryId: string;
          rowIndices: number[];
          matched: number;
          totalRows: number;
          stepSummaries?: StepSummary[];
        } = {
          type: 'QUERY_DONE',
          queryId,
          rowIndices: result.rowIndices,
          matched: result.matched,
          totalRows: result.totalRows,
        };
        if (transform) message.stepSummaries = transform.summaries();
        post(message);
        break;
      }
      case 'limit':
        post({ type: 'QUERY_LIMIT', queryId, matched: result.matched, limit: result.limit });
        break;
      case 'cancelled':
        post({ type: 'QUERY_CANCELLED', queryId });
        break;
    }
  } catch {
    post({
      type: 'ERROR',
      queryId,
      failure: { code: 'QUERY_FAILED', detail: 'The query could not be completed.' },
    });
  } finally {
    if (active?.queryId === queryId) active = null;
    if (queued !== null) {
      const next = queued;
      queued = null;
      void runQuery(next.queryId, next.spec);
    }
  }
}

self.onmessage = (event: MessageEvent<MainToQueryWorker>): void => {
  const message = event.data;
  if (message.type === 'QUERY_START') {
    // One query runs at a time, but a start that arrives while the previous
    // scan is unwinding is queued, never dropped — the client has already
    // resolved the old run as superseded and is awaiting this one.
    if (active !== null) {
      queued = { queryId: message.queryId, spec: message.spec };
      return;
    }
    void runQuery(message.queryId, message.spec);
    return;
  }
  if (message.type === 'CANCEL') {
    if (queued?.queryId === message.queryId) {
      // The client superseded the queued query before it could start.
      queued = null;
      return;
    }
    if (message.queryId === active?.queryId) active.cancel();
  }
};
