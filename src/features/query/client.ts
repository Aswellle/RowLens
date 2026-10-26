/**
 * Query client: runs query specs through a worker, guarding against stale
 * results. Starting a new run supersedes the previous one (the client posts
 * CANCEL for it and resolves it as superseded), and messages carrying an
 * outdated queryId are ignored — a slow scan can never overwrite a newer
 * query's state. A no-worker fallback runs the same engine over repository
 * windows on the main thread for environments without module Worker support.
 */
import { AppError } from '../../app/app-error';
import type { StepSummary } from '../cleaning/types';
import { createCleaningTransform } from '../cleaning/transform';
import type { DatasetRepository } from '../dataset/repository';
import { QUERY_MATCH_LIMIT } from '../dataset/constants';
import { requestToEngineSpec, runQueryEngine } from './engine';
import { scanDatasetRows } from './scan';
import type { MainToQueryWorker, QueryId, QueryRequestSpec, QueryWorkerToMain } from './protocol';

export type QueryOutcome =
  | {
      kind: 'done';
      rowIndices: number[];
      matched: number;
      totalRows: number;
      stepSummaries?: StepSummary[];
    }
  | { kind: 'limit'; matched: number; limit: number }
  | { kind: 'cancelled' }
  | { kind: 'superseded' }
  | { kind: 'failed'; error: AppError };

export interface QueryTransport {
  post(message: MainToQueryWorker): void;
  onMessage: ((message: QueryWorkerToMain) => void) | null;
  terminate(): void;
}

export type QueryRun = {
  cancel(): void;
  readonly done: Promise<QueryOutcome>;
};

export type { QueryRequestSpec };

export class QueryClient {
  private readonly createTransport: () => QueryTransport;
  private transport: QueryTransport | null = null;
  private currentId: QueryId | null = null;
  private currentResolve: ((outcome: QueryOutcome) => void) | null = null;
  private generateId: () => string;

  constructor(options: { createTransport: () => QueryTransport; generateId?: () => string }) {
    this.createTransport = options.createTransport;
    this.generateId =
      options.generateId ??
      (() =>
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `q-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  run(spec: QueryRequestSpec): QueryRun {
    this.supersedeCurrent();

    const transport = (this.transport ??= this.createTransport());
    const queryId = this.generateId();
    this.currentId = queryId;

    let settled = false;

    let resolveOutcome!: (outcome: QueryOutcome) => void;
    const done = new Promise<QueryOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    this.currentResolve = resolveOutcome;

    const settle = (outcome: QueryOutcome): void => {
      if (settled) return;
      settled = true;
      if (this.currentId === queryId) {
        this.currentId = null;
        this.currentResolve = null;
      }
      resolveOutcome(outcome);
    };

    transport.onMessage = (message: QueryWorkerToMain) => {
      if (message.queryId !== this.currentId) return; // stale
      switch (message.type) {
        case 'QUERY_DONE':
          settle({
            kind: 'done',
            rowIndices: message.rowIndices,
            matched: message.matched,
            totalRows: message.totalRows,
            ...(message.stepSummaries ? { stepSummaries: message.stepSummaries } : {}),
          });
          break;
        case 'QUERY_LIMIT':
          settle({ kind: 'limit', matched: message.matched, limit: message.limit });
          break;
        case 'QUERY_CANCELLED':
          settle({ kind: 'cancelled' });
          break;
        case 'QUERY_PROGRESS':
          break; // progress reporting is a later concern for this client
        case 'ERROR':
          settle({
            kind: 'failed',
            error: new AppError(message.failure.code, message.failure.detail),
          });
          break;
      }
    };

    transport.post({ type: 'QUERY_START', queryId, spec });

    return {
      cancel: () => {
        if (!settled) transport.post({ type: 'CANCEL', queryId });
      },
      done,
    };
  }

  private supersedeCurrent(): void {
    if (this.currentId === null) return;
    this.transport?.post({ type: 'CANCEL', queryId: this.currentId });
    this.currentResolve?.({ kind: 'superseded' });
    this.currentId = null;
    this.currentResolve = null;
  }

  dispose(): void {
    this.supersedeCurrent();
    this.transport?.terminate();
    this.transport = null;
  }
}

/** Real worker transport over a bundled Vite module worker. */
export function createQueryWorkerTransport(): QueryTransport {
  const worker = new Worker(new URL('../../workers/query.worker.ts', import.meta.url), {
    type: 'module',
  });
  let handler: ((message: QueryWorkerToMain) => void) | null = null;
  worker.onmessage = (event: MessageEvent<QueryWorkerToMain>) => {
    handler?.(event.data);
  };
  return {
    post(message: MainToQueryWorker): void {
      worker.postMessage(message);
    },
    get onMessage(): ((message: QueryWorkerToMain) => void) | null {
      return handler;
    },
    set onMessage(next: ((message: QueryWorkerToMain) => void) | null) {
      handler = next;
    },
    terminate(): void {
      worker.terminate();
    },
  };
}

/**
 * No-worker fallback: the same engine over the same windowed repository
 * reads, executed on the main thread. Each window read awaits an IndexedDB
 * transaction, so the event loop keeps breathing between batches.
 */
export async function runLocalQuery(
  spec: QueryRequestSpec,
  repository: Pick<DatasetRepository, 'readRows' | 'getDataset'>,
): Promise<Exclude<QueryOutcome, { kind: 'superseded' }>> {
  const dataset = await repository.getDataset(spec.datasetId);
  if (dataset === undefined) {
    return {
      kind: 'failed',
      error: new AppError('DATASET_NOT_FOUND', 'The dataset is no longer stored.'),
    };
  }
  const hasActiveFilter = Object.values(spec.columnFilters).some((value) => value !== '');
  const hasActiveCleaning = (spec.cleaning ?? []).some((step) => step.enabled);
  if (spec.searchTerms.length === 0 && !hasActiveFilter && !spec.sort && !hasActiveCleaning) {
    // Every row matches by definition; the finalized row count already knows
    // it — skip the scan entirely (the worker keeps its scan-based path).
    const rowIndices = Array.from({ length: dataset.rowCount }, (_, i) => i);
    return { kind: 'done', rowIndices, matched: rowIndices.length, totalRows: rowIndices.length };
  }
  try {
    // Larger windows than the import batch size: fewer transactions on the
    // fallback path, same engine semantics.
    const transform = spec.cleaning
      ? createCleaningTransform(spec.cleaning, spec.columns)
      : undefined;
    // The fallback has no folded cache, so overrides reach the engine directly.
    const overrideByRow = new Map<number, Record<string, string>>();
    for (const override of spec.edits ?? []) {
      overrideByRow.set(override.rowIndex, override.values);
    }
    const result = await runQueryEngine(
      scanDatasetRows(repository, spec.datasetId, 2000),
      requestToEngineSpec(spec),
      {
        matchLimit: QUERY_MATCH_LIMIT,
        ...(overrideByRow.size > 0
          ? { overrideFor: (rowIndex: number) => overrideByRow.get(rowIndex) }
          : {}),
        ...(transform ? { transform: (row) => transform.process(row) } : {}),
      },
    );
    switch (result.status) {
      case 'done':
        return {
          kind: 'done',
          rowIndices: result.rowIndices,
          matched: result.matched,
          totalRows: result.totalRows,
          ...(transform ? { stepSummaries: transform.summaries() } : {}),
        };
      case 'limit':
        return { kind: 'limit', matched: result.matched, limit: result.limit };
      case 'cancelled':
        return { kind: 'cancelled' };
    }
  } catch {
    return {
      kind: 'failed',
      error: new AppError('QUERY_FAILED', 'The query could not be completed.'),
    };
  }
}
