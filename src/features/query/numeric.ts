/**
 * Numeric sort: parsing and ordering for the explicit "treat as numbers"
 * mode (ADR-035, data contract §4).
 *
 * The contract forbids type inference — sorting never changes meaning behind
 * the user's back — so this module only runs when the user turns the mode on
 * for one column. Even then it stays conservative about what a number is:
 *
 * - Plain decimals with an optional sign and exponent (`-12`, `+3.5`, `1e3`).
 * - Strict thousands grouping (`1,050`), en-US style: groups of exactly three
 *   digits, so `1,05` is rejected rather than silently reinterpreted.
 * - Everything else — hex, `Infinity`, `NaN`, `N/A`, currency symbols — is
 *   NOT a number. Guessing further (1.050 German? $4?) is the silent
 *   reinterpretation this project refuses.
 *
 * Ordering partitions the column so mixed data stays predictable: numbers
 * first (compared numerically), then values that do not parse (compared as
 * strings among themselves), then empty cells. The partition order is the
 * same in both directions — only comparisons inside a partition reverse —
 * which matches the existing rule that missing values sort last either way.
 * Equal keys keep their original relative order (stability).
 */

/**
 * Parses one cell value for numeric sorting.
 * Returns null when the value is not a number (including empty strings).
 */
export function parseSortableNumber(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // Plain decimal, optional sign and exponent. Number() alone would also
  // accept hex (0x1a), Infinity and NaN, which are not numeric data.
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  // Strict thousands grouping: 1–3 digits, then groups of exactly three.
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed.replaceAll(',', ''));
  }
  return null;
}

type NumericKey =
  { kind: 'number'; value: number } | { kind: 'text'; value: string } | { kind: 'empty' };

function classify(value: string | null): NumericKey {
  const parsed = parseSortableNumber(value);
  if (parsed !== null) return { kind: 'number', value: parsed };
  if (value === null || value.trim() === '') return { kind: 'empty' };
  return { kind: 'text', value };
}

function compareKeys(a: NumericKey, b: NumericKey, sign: 1 | -1): number {
  // Partition order is fixed and never reverses: numbers, then non-numeric
  // text, then empty — the same rule that keeps missing values last in both
  // directions. Only comparisons inside a partition flip with the direction.
  const rank = (key: NumericKey): number =>
    key.kind === 'number' ? 0 : key.kind === 'text' ? 1 : 2;
  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) return rankDiff;
  if (a.kind === 'number' && b.kind === 'number') {
    const order = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    return order * sign;
  }
  if (a.kind === 'text' && b.kind === 'text') {
    // Same string order the plain sort uses.
    const order = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    return order * sign;
  }
  return 0;
}

/**
 * Stably sorts row indices by a column's raw values, treating parseable values
 * as numbers. Ties keep their original relative order, and the direction
 * reverses comparisons inside a partition without moving the partitions
 * themselves — empty cells stay last either way.
 */
export function sortIndicesNumeric(
  indices: readonly number[],
  valueAt: (index: number) => string | null,
  direction: 'asc' | 'desc',
): number[] {
  const sign = direction === 'asc' ? 1 : -1;
  const decorated = indices.map((index) => ({ index, key: classify(valueAt(index)) }));
  const sorted = decorated.sort((a, b) => {
    const order = compareKeys(a.key, b.key, sign);
    if (order !== 0) return order;
    return a.index < b.index ? -1 : a.index > b.index ? 1 : 0;
  });
  return sorted.map((entry) => entry.index);
}
