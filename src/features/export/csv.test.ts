import { describe, expect, it } from 'vitest';
import {
  cleanedFileName,
  csvField,
  hasFormulaRisk,
  protectFormulaValue,
  sanitizeCsvFileName,
} from './csv';

describe('csvField quoting', () => {
  it('leaves plain values unquoted', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField('')).toBe('');
    expect(csvField('123')).toBe('123');
    expect(csvField('00123')).toBe('00123'); // leading zeros are data
  });

  it('quotes only when a comma, quote, CR or LF is present', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('a\nb')).toBe('"a\nb"');
    expect(csvField('a\rb')).toBe('"a\rb"');
    expect(csvField('plain')).toBe('plain');
  });

  it('escapes embedded quotes by doubling them', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('""')).toBe('""""""');
  });
});

describe('hasFormulaRisk (OWASP vectors)', () => {
  it('flags the classic formula prefixes', () => {
    expect(hasFormulaRisk('=1+1')).toBe(true);
    expect(hasFormulaRisk('+cmd|/C calc')).toBe(true);
    expect(hasFormulaRisk('-1+2')).toBe(true);
    expect(hasFormulaRisk('@SUM(A1:A2)')).toBe(true);
  });

  it('flags prefixes hidden behind whitespace and control characters', () => {
    expect(hasFormulaRisk(' =1+1')).toBe(true);
    expect(hasFormulaRisk('\t=1+1')).toBe(true);
    expect(hasFormulaRisk('\r\n-2+3')).toBe(true);
    expect(hasFormulaRisk('  \t@cmd')).toBe(true);
  });

  it('does not flag ordinary text or empty values', () => {
    expect(hasFormulaRisk('total')).toBe(false);
    expect(hasFormulaRisk('  padded  ')).toBe(false);
    expect(hasFormulaRisk('')).toBe(false);
    expect(hasFormulaRisk('   ')).toBe(false);
    expect(hasFormulaRisk('result = ok')).toBe(false); // = not the first content char
  });

  it('treats leading hyphens as risky even for plain negative-looking values', () => {
    // Conservative by design: spreadsheets may interpret "-5" as a formula.
    expect(hasFormulaRisk('-5')).toBe(true);
  });
});

describe('protectFormulaValue', () => {
  it('prefixes risky values with the visible protection character', () => {
    expect(protectFormulaValue('=1+1')).toBe("'=1+1");
    expect(protectFormulaValue(' =1+1')).toBe("' =1+1");
  });

  it('leaves safe values untouched', () => {
    expect(protectFormulaValue('plain')).toBe('plain');
    expect(protectFormulaValue('')).toBe('');
  });
});

describe('file name sanitisation', () => {
  it('strips path separators and control characters', () => {
    const name = sanitizeCsvFileName('..\\..\\evil.csv');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('/');
    expect(name.endsWith('.csv')).toBe(true);
    expect(sanitizeCsvFileName('bad\u0007name.tsv')).toBe('badname.csv');
    expect(sanitizeCsvFileName('re/port:2026*?.jsonl')).toBe('re_port_2026__.csv');
  });

  it('replaces any extension with .csv and falls back when empty', () => {
    expect(sanitizeCsvFileName('data.tsv')).toBe('data.csv');
    expect(sanitizeCsvFileName('data.tar.gz')).toBe('data.tar.csv');
    expect(sanitizeCsvFileName('   ')).toBe('rowlens-export.csv');
    expect(sanitizeCsvFileName('...')).toBe('rowlens-export.csv');
  });

  it('derives the default -cleaned name from the dataset file', () => {
    expect(cleanedFileName('tickets 2026.csv')).toBe('tickets 2026-cleaned.csv');
    expect(cleanedFileName('dump.jsonl')).toBe('dump-cleaned.csv');
  });
});
