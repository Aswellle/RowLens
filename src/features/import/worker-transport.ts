/**
 * Real worker transport for the import coordinator. The worker is a Vite
 * module worker bundled with the app — no network fetch at runtime.
 */
import type { WorkerTransport } from './coordinator';
import type { ImportWorkerToMain, MainToImportWorker } from './protocol';

export function createImportWorkerTransport(): WorkerTransport {
  const worker = new Worker(new URL('../../workers/import.worker.ts', import.meta.url), {
    type: 'module',
  });
  let handler: ((message: ImportWorkerToMain) => void) | null = null;
  worker.onmessage = (event: MessageEvent<ImportWorkerToMain>) => {
    handler?.(event.data);
  };
  return {
    post(message: MainToImportWorker): void {
      worker.postMessage(message);
    },
    get onMessage(): ((message: ImportWorkerToMain) => void) | null {
      return handler;
    },
    set onMessage(next: ((message: ImportWorkerToMain) => void) | null) {
      handler = next;
    },
    terminate(): void {
      worker.terminate();
    },
  };
}
