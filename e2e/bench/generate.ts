/**
 * Deterministic synthetic CSV generator for performance benchmarks
 * (testing doc §4). Output sizes target P1 ≈ 10 MiB, P2 ≈ 50 MiB and
 * P3 just under the 100 MiB import cap. ~0.5% of rows carry a PERFNEEDLE
 * marker in the first column so searches have a known, small match set.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type BenchProfile = {
  name: string;
  rows: number;
  columns: number;
  /** Average field length used to steer the file toward its target size. */
  fieldChars: number;
};

export const PROFILES: BenchProfile[] = [
  { name: 'P1-10MB-20kx20', rows: 20_000, columns: 20, fieldChars: 22 },
  { name: 'P2-50MB-100kx30', rows: 100_000, columns: 30, fieldChars: 14 },
  { name: 'P3-95MB-250kx40', rows: 250_000, columns: 40, fieldChars: 4 },
];

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const WORDS = [
  'alpha',
  'bravo',
  'delta',
  'orbit',
  'quartz',
  'signal',
  'vector',
  'ember',
  'harbor',
  'ledger',
  'nimbus',
  'cobalt',
  'tundra',
  'zephyr',
  'matrix',
];

/** Proper CSV field encoding: quote only when needed, double inner quotes. */
function csvEscape(value: string): string {
  return value.includes(',') || value.includes('"') || value.includes('\n')
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

function filler(random: () => number, chars: number): string {
  const word = WORDS[Math.floor(random() * WORDS.length)] ?? 'alpha';
  const repeats = Math.max(1, Math.round(chars / (word.length + 1)));
  const text = Array.from({ length: repeats }, () => word).join('-');
  // Vary the length so the file is not artificially uniform.
  const trim = Math.floor(random() * 5) - 2;
  return trim > 0 ? text.slice(0, text.length - trim) : text;
}

export async function generateProfile(
  profile: BenchProfile,
  outDir: string,
): Promise<{ path: string; bytes: number; markerRows: number }> {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, `${profile.name}.csv`);
  const random = lcg(0x50455246); // "PERF"
  let markerRows = 0;

  const header = Array.from({ length: profile.columns }, (_, i) => `col_${i}`).join(',');
  const stream = createWriteStream(path, { encoding: 'utf8' });
  stream.write(`${header}\n`);

  const CHUNK = 2000;
  let buffer = '';
  for (let row = 0; row < profile.rows; row++) {
    const cells: string[] = [];
    for (let column = 0; column < profile.columns; column++) {
      if (column === 0) {
        const isMarker = random() < 0.005;
        if (isMarker) markerRows += 1;
        cells.push(isMarker ? `PERFNEEDLE-${row}` : `R${row}`);
      } else if (column === 1) {
        cells.push(
          `2026-10-${String((row % 28) + 1).padStart(2, '0')}T${String(row % 24).padStart(2, '0')}:00:00Z`,
        );
      } else if (column % 7 === 3) {
        // Occasionally a long field with a comma and an inner quote.
        cells.push(csvEscape(`${filler(random, profile.fieldChars * 3)}, "deep" note`));
      } else {
        cells.push(filler(random, profile.fieldChars));
      }
    }
    buffer += `${cells.join(',')}\n`;
    if ((row + 1) % CHUNK === 0) {
      const canContinue = stream.write(buffer);
      buffer = '';
      if (!canContinue) await new Promise<void>((resolve) => stream.once('drain', resolve));
    }
  }
  if (buffer !== '') stream.write(buffer);
  await new Promise<void>((resolve, reject) => {
    stream.end(resolve);
    stream.on('error', reject);
  });

  const { stat } = await import('node:fs/promises');
  const bytes = (await stat(path)).size;
  if (bytes > 100 * 1024 * 1024) {
    throw new Error(`${profile.name} generated ${bytes} bytes, over the import cap`);
  }
  return { path, bytes, markerRows };
}
