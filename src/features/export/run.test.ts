// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AppError } from '../../app/app-error';
import { createDownloadSaver, runExport } from './run';
import type { ExportSaver } from './run';

async function* rowsOf(table: (string | null)[][]): AsyncGenerator<(string | null)[]> {
  for (const row of table) yield row;
}

class RecordingSaver implements ExportSaver {
  readonly chunks: string[] = [];
  written: number = 0;
  closed = 0;
  aborted = 0;

  async write(chunk: string): Promise<void> {
    this.written += 1;
    this.chunks.push(chunk);
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  async abort(): Promise<void> {
    this.aborted += 1;
  }
}

describe('runExport', () => {
  const table = [
    ['a', 'b'],
    ['1', '=x'],
  ];

  it('streams chunks into the saver and returns stats', async () => {
    const saver = new RecordingSaver();
    const result = await runExport({
      fileName: 'out.csv',
      header: ['h1', 'h2'],
      rows: rowsOf(table),
      safetyMode: 'spreadsheet-safe',
      createSaver: async () => saver,
    });
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.stats.rows).toBe(2);
    expect(result.stats.protectedCells).toBe(1);
    expect(saver.closed).toBe(1);
    expect(saver.aborted).toBe(0);
    expect(saver.chunks.join('')).toContain("'=x");
  });

  it('cancels between chunks, aborting the saver without closing it', async () => {
    const saver = new RecordingSaver();
    let cancelled = false;
    const result = await runExport({
      fileName: 'out.csv',
      header: ['h'],
      rows: (async function* () {
        for (let i = 0; i < 3000; i++) {
          yield [String(i)];
          if (i === 600) cancelled = true; // flip after some chunks are due
        }
      })(),
      safetyMode: 'raw',
      createSaver: async () => saver,
      isCancelled: () => cancelled,
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(saver.aborted).toBe(1);
    expect(saver.closed).toBe(0);
  });

  it('aborts and rethrows typed errors from the saver', async () => {
    const failing: ExportSaver = {
      write: async () => {
        throw new AppError('EXPORT_FAILED', 'disk on fire');
      },
      close: async () => {},
      abort: async () => {},
    };
    let aborted = false;
    const saver: ExportSaver = {
      ...failing,
      abort: async () => {
        aborted = true;
      },
    };
    await expect(
      runExport({
        fileName: 'out.csv',
        header: ['h'],
        rows: rowsOf([['x']]),
        safetyMode: 'raw',
        createSaver: async () => saver,
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_FAILED' });
    expect(aborted).toBe(true);
  });
});

describe('createDownloadSaver', () => {
  it('refuses writes beyond the byte cap with an actionable error', async () => {
    const saver = createDownloadSaver('big.csv', 10);
    await saver.write('0123456789'); // exactly at cap
    await expect(saver.write('x')).rejects.toMatchObject({
      code: 'EXPORT_TOO_LARGE_FOR_FALLBACK',
    });
    await saver.close(); // resolves without starting a download (no blob parts left)
  });

  it('starts the download through the injected hook and revokes later', async () => {
    vi_useFakeTimers();
    const downloads: string[] = [];
    const saver = createDownloadSaver('ok.csv', 1000, {
      onStartDownload: (url) => downloads.push(url),
      revokeDelayMs: 50,
    });
    await saver.write('a,b\r\n');
    await saver.close();
    expect(downloads).toHaveLength(1);
    vi_advance(50);
    expect(downloads).toHaveLength(1); // URL string captured; revoke is fire-and-forget
  });

  it('still downloads when hooks only supply a MIME type', async () => {
    // Regression guard: suppressing the click whenever *any* hook is present
    // would silently break a caller that only overrides the blob type.
    const clicks: string[] = [];
    const original = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = original(tag) as HTMLElement;
      if (tag === 'a') {
        (element as HTMLAnchorElement).click = () => {
          clicks.push((element as HTMLAnchorElement).download);
        };
      }
      return element;
    });
    try {
      const saver = createDownloadSaver('presets.json', 1000, { mimeType: 'application/json' });
      await saver.write('{"format":1}');
      await saver.close();
      expect(clicks).toEqual(['presets.json']);
    } finally {
      spy.mockRestore();
    }
  });
});

// Tiny helpers keep vitest import out of the describe bodies.
import { vi } from 'vitest';
function vi_useFakeTimers(): void {
  vi.useFakeTimers();
}
function vi_advance(ms: number): void {
  vi.advanceTimersByTime(ms);
  vi.useRealTimers();
}
