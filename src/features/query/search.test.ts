import { describe, expect, it } from 'vitest';
import type { SearchTerm } from './search';
import { isNoopTerm, parseSearchQuery } from './search';

const COLUMNS = [
  { id: 'c0', label: 'Ticket' },
  { id: 'c1', label: 'Status' },
  { id: 'c2', label: 'First response (h)' },
];

function all(text: string): SearchTerm {
  return { kind: 'all', text };
}

function columns(indexes: number[], text: string): SearchTerm {
  return { kind: 'columns', columnIndexes: indexes, text };
}

describe('parseSearchQuery', () => {
  it('treats a plain term as a search across every column', () => {
    expect(parseSearchQuery('north', COLUMNS)).toEqual([all('north')]);
  });

  it('splits on whitespace and ANDs the terms', () => {
    expect(parseSearchQuery('  open   P1  ', COLUMNS)).toEqual([all('open'), all('P1')]);
  });

  it('returns no terms for empty input', () => {
    expect(parseSearchQuery('', COLUMNS)).toEqual([]);
    expect(parseSearchQuery('   ', COLUMNS)).toEqual([]);
  });

  it('scopes a term when the prefix names a column exactly', () => {
    expect(parseSearchQuery('Status:open', COLUMNS)).toEqual([columns([1], 'open')]);
  });

  it('matches column names case-insensitively', () => {
    expect(parseSearchQuery('status:open', COLUMNS)).toEqual([columns([1], 'open')]);
  });

  it('supports headers that contain spaces and punctuation when quoted', () => {
    expect(parseSearchQuery('"First response (h)":14', COLUMNS)).toEqual([columns([2], '14')]);
  });

  it('cannot scope a multi-word header without quotes — the tokens split', () => {
    // Documented limitation: without quotes this is three ordinary terms.
    expect(parseSearchQuery('First response (h):14', COLUMNS)).toEqual([
      all('First'),
      all('response'),
      all('(h):14'),
    ]);
  });

  it('keeps quotes literal outside the header position', () => {
    expect(parseSearchQuery('open"foo bar"', COLUMNS)).toEqual([all('open"foo bar"')]);
    expect(parseSearchQuery('"no colon', COLUMNS)).toEqual([all('"no colon')]);
  });

  it('searches a quoted header whose name contains a colon', () => {
    const odd = [{ id: 'c0', label: 'a:b' }];
    expect(parseSearchQuery('"a:b":x', odd)).toEqual([columns([0], 'x')]);
  });

  it('drops a quoted scoped term with no value', () => {
    expect(parseSearchQuery('"First response (h)":', COLUMNS)).toEqual([]);
  });

  it('keeps a quoted unknown header as an ordinary substring', () => {
    expect(parseSearchQuery('"No such":x', COLUMNS)).toEqual([all('"No such":x')]);
  });

  it('keeps the value literal, colons included', () => {
    expect(parseSearchQuery('Status:http://x', COLUMNS)).toEqual([columns([1], 'http://x')]);
  });

  it('treats an unknown column prefix as an ordinary substring', () => {
    // A typo must not silently widen to "no restriction".
    expect(parseSearchQuery('Stat:open', COLUMNS)).toEqual([all('Stat:open')]);
  });

  it('treats URLs and times as ordinary substrings', () => {
    expect(parseSearchQuery('http://example.com', COLUMNS)).toEqual([all('http://example.com')]);
    expect(parseSearchQuery('12:30', COLUMNS)).toEqual([all('12:30')]);
  });

  it('treats a leading colon as an ordinary substring', () => {
    expect(parseSearchQuery(':open', COLUMNS)).toEqual([all(':open')]);
  });

  it('searches every column that shares a header name', () => {
    const duplicated = [
      { id: 'c0', label: 'Note' },
      { id: 'c1', label: 'City' },
      { id: 'c2', label: 'Note' },
    ];
    // Picking one of two same-named columns would hide half the matches.
    expect(parseSearchQuery('Note:urgent', duplicated)).toEqual([columns([0, 2], 'urgent')]);
  });

  it('mixes scoped and global terms in one query', () => {
    expect(parseSearchQuery('Status:open emea', COLUMNS)).toEqual([
      columns([1], 'open'),
      all('emea'),
    ]);
  });

  it('drops a scoped term with no value, like an empty filter input', () => {
    expect(parseSearchQuery('Status:', COLUMNS)).toEqual([]);
  });

  it('keeps a global term that is only punctuation', () => {
    expect(parseSearchQuery('-', COLUMNS)).toEqual([all('-')]);
  });
});

describe('isNoopTerm', () => {
  it('flags terms that can never exclude a row', () => {
    expect(isNoopTerm(all(''))).toBe(true);
    expect(isNoopTerm(columns([], 'x'))).toBe(true);
    expect(isNoopTerm(all('x'))).toBe(false);
    expect(isNoopTerm(columns([0], ''))).toBe(true);
    expect(isNoopTerm(columns([0], 'x'))).toBe(false);
  });
});
