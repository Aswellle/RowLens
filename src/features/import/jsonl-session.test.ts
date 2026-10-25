import { describe, expect, it } from 'vitest';
import type { ColumnDefinition } from '../dataset/types';
import type { ImportBatch } from './csv-session';
import { runJsonlImport, sourceFromChunks, valueToDisplay } from './jsonl-session';
import { WarningAggregator } from './warnings';

const encoder = new TextEncoder();

function chunksOf(text: string, splitAt: number[]): Uint8Array[] {
  const bytes = encoder.encode(text);
  const cuts = [0, ...splitAt.filter((n) => n > 0 && n < bytes.length), bytes.length];
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    chunks.push(bytes.slice(cuts[i]!, cuts[i + 1]!));
  }
  return chunks;
}

async function importChunks(chunks: Uint8Array[]) {
  const batches: ImportBatch[] = [];
  const warnings = new WarningAggregator();
  const session = runJsonlImport(
    sourceFromChunks(chunks),
    {
      onBatch: async (batch) => {
        batches.push(batch);
      },
    },
    warnings,
  );
  const result = await session.done;
  const rows = batches.flatMap((b) => b.rows.map((r) => r.values));
  return { result, rows, batches };
}

describe('JSONL import contract', () => {
  it('parses objects, grows the schema in first-seen key order, and keeps nested values as JSON text', async () => {
    const text = [
      JSON.stringify({ name: 'Ada', meta: { lang: 'en', tags: ['a', 'b'] } }),
      JSON.stringify({ id: 7, name: 'Grace' }),
      '',
    ].join('\n');
    const { result, rows } = await importChunks(chunksOf(text, []));
    expect(result.status).toBe('done');
    expect(result.rowCount).toBe(2);
    expect(result.columns.map((c: ColumnDefinition) => c.sourceKey)).toEqual([
      'name',
      'meta',
      'id',
    ]);
    expect(rows[0]?.k0).toBe('Ada');
    expect(JSON.parse(rows[0]?.k1 ?? '')).toEqual({ lang: 'en', tags: ['a', 'b'] });
    // Row 0 predates the id column: the key is legitimately absent (missing).
    expect('k2' in (rows[0] ?? {})).toBe(false);
    expect(rows[1]?.k2).toBe('7');
  });

  it('keeps JSON null visible as the string "null" and distinct from missing keys', async () => {
    const { rows } = await importChunks(chunksOf('{"a":null,"b":1}\n{"b":2}\n', []));
    expect(rows[0]?.k0).toBe('null');
    expect('k0' in (rows[1] ?? {})).toBe(false);
    expect(rows[1]?.k1).toBe('2');
    expect(valueToDisplay(null)).toBe('null');
  });

  it('rejects top-level arrays, primitives and null as invalid lines but keeps parsing', async () => {
    const text = '{"a":1}\n[1,2]\n"str"\n42\nnull\n{"b":2}\n';
    const { result } = await importChunks(chunksOf(text, []));
    expect(result.rowCount).toBe(2);
    const invalid = result.warnings.find((w) => w.kind === 'invalid-json-line');
    expect(invalid?.count).toBe(4);
    expect(invalid?.sampleLineNumbers).toEqual([2, 3, 4, 5]);
  });

  it('records malformed JSON lines with line numbers without stopping', async () => {
    const text = '{"a":1}\n{not json}\n{"a":3}\n';
    const { result, rows } = await importChunks(chunksOf(text, []));
    expect(result.rowCount).toBe(2);
    expect(rows[1]?.k0).toBe('3');
    const invalid = result.warnings.find((w) => w.kind === 'invalid-json-line');
    expect(invalid?.sampleLineNumbers).toEqual([2]);
  });

  it('reassembles UTF-8 multibyte characters split across chunk boundaries', async () => {
    const text = '{"名前":"追跡番号12345","note":"благодарим 🚚"}\n{"x":"行2"}\n';
    const bytes = encoder.encode(text);
    // Cut inside the first multibyte sequence (after 1 byte of '名') and
    // inside the emoji surrogate-pair region later in the line.
    const { rows } = await importChunks([bytes.slice(0, 9), bytes.slice(9, 40), bytes.slice(40)]);
    expect(rows[0]?.k0).toBe('追跡番号12345');
    expect(rows[0]?.k1).toBe('благодарим 🚚');
    expect(rows[1]?.k2).toBe('行2'); // "x" is a new key -> third column
  });

  it('supports CRLF endings and a final record without a newline', async () => {
    const crlf = await importChunks(chunksOf('{"a":1}\r\n{"a":2}\r\n', []));
    expect(crlf.result.rowCount).toBe(2);
    expect(crlf.rows[0]?.k0).toBe('1');

    const noFinal = await importChunks(chunksOf('{"a":1}\n{"a":2}', []));
    expect(noFinal.result.rowCount).toBe(2);
    expect(noFinal.rows[1]?.k0).toBe('2');
  });

  it('skips blank lines with a warning instead of counting them as records', async () => {
    const { result } = await importChunks(chunksOf('{"a":1}\n\n   \n{"a":2}\n', []));
    expect(result.rowCount).toBe(2);
    const blank = result.warnings.find((w) => w.kind === 'blank-line-skipped');
    expect(blank?.count).toBe(2);
    expect(blank?.sampleLineNumbers).toEqual([2, 3]);
  });

  it('strips a leading BOM but not similar characters inside values', async () => {
    const bom = '\uFEFF';
    const text = `${bom}{"a":"x"}\n{"a":"\uFEFFinside"}\n`;
    const { rows } = await importChunks(chunksOf(text, []));
    expect(rows[0]?.k0).toBe('x'); // BOM stripped before the first record
    expect(rows[1]?.k0).toBe('\uFEFFinside'); // in-value occurrence untouched
  });

  it('drops oversized lines as errors and continues at the next newline', async () => {
    const filler = 'x'.repeat(5 * 1024 * 1024 + 10); // over the 5 MiB cap
    const text = `{"a":"before"}\n{"pad":"${filler}"}\n{"a":"after"}\n`;
    const { result, rows } = await importChunks(chunksOf(text, [1024 * 1024, 3 * 1024 * 1024]));
    expect(result.rowCount).toBe(2);
    expect(rows[0]?.k0).toBe('before');
    expect(rows[1]?.k0).toBe('after');
    const overlong = result.warnings.find((w) => w.kind === 'line-too-long');
    expect(overlong?.count).toBe(1);
    expect(overlong?.sampleLineNumbers).toEqual([2]);
  });
});

describe('JSONL backpressure and cancellation', () => {
  it('stops reading until the current batch is persisted', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 1200; i++) lines.push(JSON.stringify({ n: i }));
    const chunks = chunksOf(`${lines.join('\n')}\n`, []);
    let reads = 0;
    const gated = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          reads++;
          yield chunk;
        }
      },
    };
    const gates: Array<() => void> = [];
    const batches: ImportBatch[] = [];
    const session = runJsonlImport(
      gated,
      {
        onBatch: (batch) => {
          batches.push(batch);
          return new Promise<void>((resolve) => gates.push(resolve));
        },
      },
      new WarningAggregator(),
    );

    // Single-chunk source yields once; batches gate further work internally.
    const outcome = await Promise.race([
      session.done.then((r) => r.status),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 30)),
    ]);
    expect(outcome).toBe('pending');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.rows).toHaveLength(500);

    // Release gates as they appear until the import finishes.
    let final: Awaited<typeof session.done> | 'pending' = 'pending';
    for (let i = 0; i < 100 && final === 'pending'; i++) {
      for (const gate of gates.splice(0)) gate();
      final = await Promise.race([
        session.done,
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10)),
      ]);
    }
    if (final === 'pending') throw new Error('import never finished');
    expect(final.rowCount).toBe(1200);
    expect(final.status).toBe('done');
  });

  it('settles as cancelled when aborted mid-batch', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 1200; i++) lines.push(JSON.stringify({ n: i }));
    const gates: Array<() => void> = [];
    const session = runJsonlImport(
      sourceFromChunks(chunksOf(`${lines.join('\n')}\n`, [])),
      {
        onBatch: () => new Promise<void>((resolve) => gates.push(resolve)),
      },
      new WarningAggregator(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.abort();
    for (const gate of gates) gate();
    const result = await session.done;
    expect(result.status).toBe('cancelled');
    expect(result.warnings).toEqual([]);
  });
});
