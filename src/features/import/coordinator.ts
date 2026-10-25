/**
 * Main-thread import coordinator. Owns exactly one active job at a time:
 * persists worker batches into IndexedDB, ACKs them (backpressure), finalises
 * the dataset only after the worker reports success, and deletes every trace
 * of a partial dataset on cancellation or failure. Messages carrying a stale
 * jobId are ignored so a late reply can never corrupt a newer job's state.
 */
import { AppError, toAppError } from '../../app/app-error';
import type { DatasetMetadata, StoredRow } from '../dataset/types';
import type { DatasetRepository } from '../dataset/repository';
import type { ImportBatch } from './csv-session';
import type {
  ImportJobId,
  ImportStartOptions,
  ImportWorkerToMain,
  MainToImportWorker,
} from './protocol';

export interface WorkerTransport {
  post(message: MainToImportWorker): void;
  onMessage: ((message: ImportWorkerToMain) => void) | null;
  terminate(): void;
}

export type TransportFactory = () => WorkerTransport;

export type ImportProgress = {
  rowsParsed: number;
  bytesProcessed?: number | undefined;
};

export type ImportOutcome =
  | { kind: 'ready'; metadata: DatasetMetadata }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: AppError };

export type ActiveImport = {
  readonly jobId: ImportJobId;
  readonly datasetId: string;
  cancel(): void;
  readonly outcome: Promise<ImportOutcome>;
};

export type CoordinatorDeps = {
  repository: Pick<
    DatasetRepository,
    'insertDataset' | 'putRows' | 'finalizeDataset' | 'deleteDataset' | 'putImportErrors'
  >;
  createTransport: TransportFactory;
  /** Injectable for tests; defaults to crypto.randomUUID. */
  generateId?: () => string;
  onProgress?: (progress: ImportProgress) => void;
  /** Receives each persisted batch (UI write-through cache). */
  onBatch?: (batch: ImportBatch) => void;
};

export class ImportCoordinator {
  private readonly deps: CoordinatorDeps;
  private active: ActiveImport | null = null;

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
  }

  get hasActiveJob(): boolean {
    return this.active !== null;
  }

  async start(file: File, options: ImportStartOptions): Promise<ActiveImport> {
    if (this.active !== null) {
      throw new Error('an import is already running; cancel it first');
    }
    const jobId =
      this.deps.generateId?.() ??
      (typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `job-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const datasetId = jobId;
    const now = Date.now();
    const initialMeta: DatasetMetadata = {
      id: datasetId,
      format: options.format,
      fileName: file.name,
      byteSize: file.size,
      status: 'importing',
      createdAt: now,
      lastTouchedAt: now,
      rowCount: 0,
      columns: [],
      parseErrorCount: 0,
      importWarnings: [],
      schemaVersion: 1,
    };

    let resolveOutcome!: (outcome: ImportOutcome) => void;
    const outcome = new Promise<ImportOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    const transport = this.deps.createTransport();
    let settled = false;
    let cancelRequested = false;

    const settle = (result: ImportOutcome): void => {
      if (settled) return;
      settled = true;
      this.active = null;
      transport.terminate();
      resolveOutcome(result);
    };

    const cleanup = async (): Promise<void> => {
      try {
        await this.deps.repository.deleteDataset(datasetId);
      } catch {
        // Best effort: startup TTL cleanup will retry later.
      }
    };

    const fail = async (error: AppError): Promise<void> => {
      // Tell the worker to stop parsing, then remove every partial trace.
      transport.post({ type: 'CANCEL', jobId });
      await cleanup();
      settle({ kind: 'failed', error });
    };

    const active: ActiveImport = {
      jobId,
      datasetId,
      cancel: () => {
        if (settled || cancelRequested) return; // idempotent
        cancelRequested = true;
        transport.post({ type: 'CANCEL', jobId });
      },
      outcome,
    };

    transport.onMessage = (message: ImportWorkerToMain) => {
      if (message.jobId !== jobId || settled) return; // stale or post-terminal
      void (async () => {
        switch (message.type) {
          case 'BATCH': {
            try {
              const stored: StoredRow[] = message.rows.map((row) => ({
                datasetId,
                rowIndex: row.rowIndex,
                values: row.values,
              }));
              await this.deps.repository.putRows(datasetId, stored);
              const batch: ImportBatch = { rows: message.rows };
              if (message.schemaAppend) batch.schemaAppend = message.schemaAppend;
              this.deps.onBatch?.(batch);
              transport.post({ type: 'ACK', jobId, batchSeq: message.batchSeq });
            } catch (error) {
              await fail(toAppError(error));
            }
            break;
          }
          case 'PROGRESS': {
            this.deps.onProgress?.({
              rowsParsed: message.rowsParsed,
              bytesProcessed: message.bytesProcessed,
            });
            break;
          }
          case 'IMPORT_DONE': {
            try {
              await this.deps.repository.putImportErrors(
                message.warnings.flatMap((warning) =>
                  warning.sampleLineNumbers.map((physicalLineNumber) => ({
                    datasetId,
                    physicalLineNumber,
                    kind: warning.kind,
                  })),
                ),
              );
              const meta: DatasetMetadata = {
                ...initialMeta,
                status: 'ready',
                lastTouchedAt: Date.now(),
                rowCount: message.rowCount,
                columns: message.columns,
                parseErrorCount: message.parseErrorCount,
                importWarnings: message.warnings,
              };
              await this.deps.repository.finalizeDataset(meta);
              settle({ kind: 'ready', metadata: meta });
            } catch (error) {
              await fail(toAppError(error));
            }
            break;
          }
          case 'IMPORT_CANCELLED': {
            await cleanup();
            settle({ kind: 'cancelled' });
            break;
          }
          case 'ERROR': {
            await cleanup();
            settle({
              kind: 'failed',
              error: new AppError(
                message.failure.code,
                message.failure.detail,
                message.failure.physicalLine,
              ),
            });
            break;
          }
        }
      })();
    };

    this.active = active;
    try {
      await this.deps.repository.insertDataset(initialMeta);
      transport.post({ type: 'IMPORT_START', jobId, options, file });
    } catch (error) {
      this.active = null;
      transport.terminate();
      throw toAppError(error);
    }
    return active;
  }
}
