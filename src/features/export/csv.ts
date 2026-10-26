/**
 * Pure CSV cell-level rules (data contract §9 and security doc §5):
 * quoting only when necessary, CRLF line endings, double-quote escaping, and
 * OWASP-aligned formula-injection detection with an explicit protection
 * strategy. No function here touches the DOM, storage or state.
 */

/**
 * Characters that force a field to be wrapped in double quotes. One precompiled
 * regex: csvField runs for every exported cell, and a code-point array spread per
 * cell was avoidable allocation in the hot path.
 */
const QUOTE_TRIGGER_PATTERN = /[,"\r\n]/;

/**
 * Risky leading characters per the OWASP CSV injection guidance: formulas can
 * start with =, +, -, @, a tab or a carriage return — including when they are
 * preceded by whitespace or other control characters.
 */
const RISKY_FORMULA_STARTS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Whitespace/control characters skipped before the prefix check. */
function isSkippablePrefix(code: number): boolean {
  // Space, tab, LF, CR and other C0 control characters.
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0 && code <= 0x08) ||
    code === 0x0b ||
    code === 0x0c
  );
}

/** True when the value could be interpreted as a formula by a spreadsheet. */
export function hasFormulaRisk(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const char = value[i] as string;
    if (isSkippablePrefix(char.charCodeAt(0))) continue;
    return RISKY_FORMULA_STARTS.has(char);
  }
  return false; // empty or all-skippable: nothing to interpret
}

/**
 * Spreadsheet-safe protection: prefix risky values with a single quote so
 * spreadsheet apps treat the cell as text. The prefix is present in the file
 * (and can be removed by whoever needs the raw value) — no strategy is
 * claimed to be safe in every spreadsheet, which the export UI states.
 */
export const FORMULA_PROTECTION_PREFIX = "'";

export function protectFormulaValue(value: string): string {
  return hasFormulaRisk(value) ? FORMULA_PROTECTION_PREFIX + value : value;
}

/** Encode one field, quoting only when the content requires it. */
export function csvField(value: string): string {
  if (!QUOTE_TRIGGER_PATTERN.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

/** Encode one full line (CRLF terminator is added by the serializer). */
export function csvLine(values: readonly string[]): string {
  return values.map(csvField).join(',');
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const PATH_SEPARATORS = /[\\/:*?"<>|]/g;

/**
 * Build a safe download file name: strip path separators and control
 * characters, replace any extension with `.csv`, and fall back to a default
 * when nothing usable remains. Never touches the filesystem.
 */
export function sanitizeCsvFileName(input: string, fallback = 'rowlens-export.csv'): string {
  const cleaned = input
    .replace(PATH_SEPARATORS, '_')
    .replace(CONTROL_CHARS, '')
    .trim()
    .replace(/^\.+/, '');
  if (cleaned === '') return fallback;
  const withoutExtension = cleaned.includes('.')
    ? cleaned.slice(0, cleaned.lastIndexOf('.'))
    : cleaned;
  const base = withoutExtension === '' ? fallback.replace(/\.csv$/, '') : withoutExtension;
  return `${base}.csv`;
}

/** Default export name derived from the imported file name. */
export function cleanedFileName(datasetFileName: string): string {
  return `${sanitizeCsvFileName(datasetFileName).replace(/\.csv$/, '')}-cleaned.csv`;
}
