/**
 * Generates `public/demo-support-tickets.csv` — the synthetic sample file
 * offered for download/drag-in demos. Fully deterministic (seeded), no
 * personal or real-world data. Run with: `node scripts/generate-demo.mjs`
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'demo-support-tickets.csv',
);
const ROWS = 2_000;

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const random = lcg(0x0a11ce5);
const pick = (items) => items[Math.floor(random() * items.length)];
const STATUS = ['open', 'pending', 'closed'];
const PRIORITY = ['P1', 'P2', 'P3'];
const CHANNEL = ['email', 'chat', 'web form'];
const REGION = ['emea', 'apac', 'amer', 'latam'];
const NOTE = [
  'Customer asked about invoice re-issue.',
  'Escalated: SLA at risk.',
  'Contains "quoted words" and, commas',
  'Multibyte: 追跡番号 12345 / благодарим / 🚚',
  '  padded values  ',
  '',
];

mkdirSync(dirname(OUT), { recursive: true });
const stream = createWriteStream(OUT, { encoding: 'utf8' });
stream.write('ticket,status,priority,channel,region,opened,first_response_hours,note\n');

const rows = [];
for (let i = 0; i < ROWS; i++) {
  const cells = [
    `T-${String(i + 1).padStart(5, '0')}`,
    pick(STATUS),
    i % 3 === 0 ? 'P2' : pick(PRIORITY),
    pick(CHANNEL),
    pick(REGION),
    `2026-10-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`,
    String(Math.floor(random() * 72)),
    pick(NOTE),
  ];
  rows.push(
    cells.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(','),
  );
}
stream.write(rows.join('\n') + '\n');
await new Promise((resolve) => stream.end(resolve));

const { size } = await stat(OUT);
console.log(`wrote ${OUT} (${(size / 1024).toFixed(1)} KiB, ${ROWS} rows)`);
