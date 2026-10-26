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

let active: ActiveQuery | null = null;

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
 */
const foldedCache = new Map<
  string,
  { rowCount: number; rows: Map<number, Record<string, string | null>> }
>();

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
  }
}

self.onmessage = (event: MessageEvent<MainToQueryWorker>): void => {
  const message = event.data;
  if (message.type === 'QUERY_START') {
    if (active !== null) return; // one query at a time per worker
    void runQuery(message.queryId, message.spec);
    return;
  }
  if (message.type === 'CANCEL' && message.queryId === active?.queryId) {
    active.cancel();
  }
};
