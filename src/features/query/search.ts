/**
 * Search-box syntax for targeted column search (ADR-034).
 *
 * The contract (docs/03-data-processing-contracts.md §4) fixes the baseline:
 * a search term is a literal case-insensitive substring, never a regular
 * expression. This module adds exactly one piece of syntax on top — a term of
 * the form `column:value` restricts that one term to the named column — and
 * keeps every other character literal.
 *
 * Rules, all chosen so the box never surprises:
 *
 * 1. Terms are whitespace-separated; every term must match (AND).
 * 2. `column:value` only means a column reference when the text before the
 *    FIRST colon is exactly a column header (case-insensitive). Anything else
 *    — `http://…`, `12:30`, a misspelled header — stays a plain substring, so
 *    ordinary text with a colon keeps working.
 * 3. A header containing spaces is written in double quotes:
 *    `"First response (h)":14`. Quotes are significant ONLY in that position —
 *    anywhere else (`open"foo bar"`) they are searched literally, so a user
 *    looking for actual quote characters still finds them.
 * 4. Duplicate headers stay separate columns by design. A label shared by
 *    several columns therefore searches **all** of them; picking one silently
 *    would hide half the data behind a match.
 * 5. `column:` with nothing after the colon restricts nothing (the same rule
 *    as the per-column filter inputs), so it is dropped rather than scanned.
 */
import type { ColumnId } from '../dataset/types';

/** One parsed search term. `text` is matched as a literal substring. */
export type SearchTerm =
  | { kind: 'all'; text: string }
  | { kind: 'columns'; columnIndexes: readonly number[]; text: string };

/**
 * Splits on whitespace runs, but whitespace inside double quotes does not end
 * a term — that is what lets `"First response (h)"` stay one term.
 */
function splitTerms(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of input) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

/** True when the parsed term could never exclude a row. */
export function isNoopTerm(term: SearchTerm): boolean {
  return term.text === '' || (term.kind === 'columns' && term.columnIndexes.length === 0);
}

/**
 * Parses the raw search input into terms.
 *
 * `columns` is the dataset's column list in display order; the returned
 * indexes refer to that same order, which is what the query spec carries.
 */
export function parseSearchQuery(
  input: string,
  columns: readonly { id: ColumnId; label: string }[],
): SearchTerm[] {
  const trimmed = input.trim();
  if (trimmed === '') return [];

  const foldedLabels = new Map<string, number[]>();
  columns.forEach((column, index) => {
    const folded = column.label.toLocaleLowerCase('en-US');
    const existing = foldedLabels.get(folded);
    if (existing === undefined) foldedLabels.set(folded, [index]);
    else existing.push(index);
  });

  const terms: SearchTerm[] = [];
  for (const token of splitTerms(trimmed)) {
    if (token.startsWith('"')) {
      const closing = token.indexOf('"', 1);
      const rest = closing === -1 ? '' : token.slice(closing + 1);
      if (closing > 1 && rest.startsWith(':')) {
        const header = token.slice(1, closing);
        const indexes = foldedLabels.get(header.toLocaleLowerCase('en-US'));
        if (indexes !== undefined) {
          // `"Header":` with no value restricts nothing; dropped like the
          // unquoted empty form.
          if (rest.length > 1) {
            terms.push({ kind: 'columns', columnIndexes: indexes, text: rest.slice(1) });
          }
          continue;
        }
      }
      // Unmatched quote, no colon after the header, or no such column: the
      // token keeps its quotes and is searched literally.
      terms.push({ kind: 'all', text: token });
      continue;
    }

    const colon = token.indexOf(':');
    if (colon > 0) {
      const prefix = token.slice(0, colon).toLocaleLowerCase('en-US');
      const indexes = foldedLabels.get(prefix);
      if (indexes !== undefined) {
        terms.push({ kind: 'columns', columnIndexes: indexes, text: token.slice(colon + 1) });
        continue;
      }
    }
    // No colon, a leading colon, or a prefix that names no column: the whole
    // token is an ordinary substring, colon included.
    terms.push({ kind: 'all', text: token });
  }
  // A term that cannot exclude a row would only force a full scan, so the
  // "no restriction" reading is applied here instead of in the engine.
  return terms.filter((term) => !isNoopTerm(term));
}
