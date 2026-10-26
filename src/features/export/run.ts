/**
 * Export execution: streams serialized CSV chunks into a saver. The saver is
 * the File System Access writable when the browser offers it (true
 * streaming, no object URL); otherwise a download fallback collects parts in
 * memory under a strict byte cap and hands the browser one blob URL that is
 * revoked on a delay — never early enough to kill the download, never left
 * alive indefinitely. Cancellation aborts the saver between chunks; failures
 * abort and propagate typed errors without pretending anything was saved.
 */
import { AppError } from '../../app/app-error';
import { EXPORT_FALLBACK_MAX_BYTES, EXPORT_URL_REVOKE_DELAY_MS } from '../dataset/constants';
import { serializeCsv, type CsvSerializerStats } from './serializer';
import type { CsvSafetyMode } from './types';

export interface ExportSaver {
  write(chunk: string): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

type SavePicker = (options: { suggestedName?: string }) => Promise<FileWritableHandle>;
interface FileWritableHandle {
  createWritable(): Promise<WritableStreamLike>;
}
interface WritableStreamLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/** Streaming saver over the File System Access API; null when unsupported. */
export async function createFileSystemSaver(suggestedName: string): Promise<ExportSaver | null> {
  const picker = (globalThis as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker !== 'function') return null;
  try {
    const handle = await picker({ suggestedName });
    const writable = await handle.createWritable();
    return {
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      // The user dismissed the save picker — not an export failure.
      throw new AppError('EXPORT_CANCELLED', 'Save was cancelled.');
    }
    throw error;
  }
}

export type DownloadSaverHooks = {
  /** Replaces the programmatic download click (tests). */
  onStartDownload?: (url: string, fileName: string) => void;
  revokeDelayMs?: number;
  /** Blob MIME type; CSV unless a caller is saving another text format. */
  mimeType?: string;
};

/** Memory-bound fallback: parts accumulate only up to the byte cap. */
export function createDownloadSaver(
  fileName: string,
  maxBytes: number = EXPORT_FALLBACK_MAX_BYTES,
  hooks?: DownloadSaverHooks,
): ExportSaver {
  const parts: string[] = [];
  // Counted in UTF-8 bytes, matching what the Blob will actually hold —
  // chunk.length would undercount non-ASCII data by up to 3x.
  const encoder = new TextEncoder();
  let bytes = 0;
  let closed = false;
  let objectUrl: string | null = null;

  return {
    async write(chunk: string): Promise<void> {
      if (closed) throw new AppError('EXPORT_FAILED', 'The export already finished.');
      bytes += encoder.encode(chunk).length;
      if (bytes > maxBytes) {
        parts.length = 0; // release what we had before refusing
        throw new AppError(
          'EXPORT_TOO_LARGE_FOR_FALLBACK',
          `The export exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB limit for in-browser downloads. Use a browser with the File System Access API for files this large.`,
        );
      }
      parts.push(chunk);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (typeof URL.createObjectURL !== 'function') return; // non-DOM hosts (tests)
      const blob = new Blob(parts, { type: hooks?.mimeType ?? 'text/csv;charset=utf-8' });
      objectUrl = URL.createObjectURL(blob);
      // The click is suppressed only when a hook actually replaced it; passing
      // `hooks` for another field (a MIME type) must still download.
      if (hooks?.onStartDownload) {
        hooks.onStartDownload(objectUrl, fileName);
      } else {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = fileName;
        anchor.rel = 'noopener';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      }
      // Revoke late: too early kills slow downloads; never revoking leaks.
      window.setTimeout(() => {
        if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }, hooks?.revokeDelayMs ?? EXPORT_URL_REVOKE_DELAY_MS);
    },

    async abort(): Promise<void> {
      if (closed && objectUrl === null) return;
      closed = true;
      parts.length = 0;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    },
  };
}

/** Prefer the streaming picker; fall back to the capped download. */
export async function defaultCreateSaver(fileName: string): Promise<ExportSaver> {
  const stream = await createFileSystemSaver(fileName);
  return stream ?? createDownloadSaver(fileName);
}

export type RunExportOptions = {
  fileName: string;
  header: readonly string[];
  rows: AsyncIterable<readonly (string | null)[]>;
  safetyMode: CsvSafetyMode;
  createSaver?: (fileName: string) => Promise<ExportSaver>;
  isCancelled?: () => boolean;
  onProgress?: (rows: number) => void;
};

export type RunExportResult =
  { status: 'done'; stats: CsvSerializerStats } | { status: 'cancelled' };

export async function runExport(options: RunExportOptions): Promise<RunExportResult> {
  const createSaver = options.createSaver ?? defaultCreateSaver;
  const stats: CsvSerializerStats = { rows: 0, protectedCells: 0, bytes: 0 };
  const saver = await createSaver(options.fileName);

  try {
    const serializeOptions: {
      header: readonly string[];
      rows: AsyncIterable<readonly (string | null)[]>;
      safetyMode: CsvSafetyMode;
      onProgress?: (rows: number) => void;
    } = {
      header: options.header,
      rows: options.rows,
      safetyMode: options.safetyMode,
    };
    if (options.onProgress) serializeOptions.onProgress = options.onProgress;
    for await (const chunk of serializeCsv(serializeOptions, stats)) {
      if (options.isCancelled?.()) {
        await saver.abort();
        return { status: 'cancelled' };
      }
      await saver.write(chunk);
    }
    await saver.close();
    return { status: 'done', stats };
  } catch (error) {
    await saver.abort();
    throw error;
  }
}
