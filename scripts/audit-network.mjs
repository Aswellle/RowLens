/**
 * Network audit for the production build (security doc §2, §9).
 *
 * Fails when any shipped asset contains network-capable calls or references
 * a non-local URL. Every exception is pinned to its exact library context
 * and documented — a stray application-level network call can never ride
 * them. Run after `npm run build`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/**
 * Reviewed fetch exception: Vite's modulepreload polyfill fetches ONLY the
 * app's own preloaded module URLs (same origin) — framework boilerplate, no
 * user data. The full context is matched so an application-level fetch can
 * never ride the exemption.
 */
const FETCH_ALLOWLIST = [/modulepreload[\s\S]{0,600}fetch\(e\.href,n\)/];

/**
 * Reviewed XHR exception: Papa Parse ships a network-URL input mode used by
 * its remote-file API. RowLens only ever passes File objects, so the branch
 * is dead code in this bundle — the library context is matched exactly.
 */
const XHR_ALLOWLIST = [/Papa Parse[\s\S]{0,20}v5\.7\.0[\s\S]{0,4000}new XMLHttpRequest/];

/**
 * Reviewed URL exceptions — identifiers and message strings, not endpoints:
 * - www.w3.org: the SVG/XML namespace baked into markup, never dereferenced.
 * - react.dev/errors: documentation links inside React error message
 *   strings; React never requests them.
 */
/**
 * Reviewed URL exceptions. REMOTE_URL captures bare domains (no path), so
 * these are domain-granular; each is reviewed as an identifier or message
 * string, never an endpoint:
 * - www.w3.org: the SVG/XML namespace baked into markup, never dereferenced.
 * - react.dev: documentation links inside React error message strings.
 * - github.com: the Papa Parse license header text in the bundled library.
 */
const URL_ALLOWLIST = [
  /^https?:\/\/www\.w3\.org\/?$/i,
  /^https?:\/\/react\.dev\/?$/i,
  /^https?:\/\/github\.com\/?$/i,
];

/** Patterns that must not appear in any shipped asset. */
const FORBIDDEN = [
  { name: 'fetch()', pattern: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { name: 'sendBeacon', pattern: /\bsendBeacon\s*\(/ },
  { name: 'WebSocket', pattern: /new\s+WebSocket\s*\(/ },
  { name: 'EventSource', pattern: /\bEventSource\s*\(/ },
  { name: 'remote dynamic import', pattern: /import\s*\(\s*['"]https?:\/\// },
  { name: 'remote script tag', pattern: /<script[^>]+src=["']https?:\/\// },
];

/** Non-localhost absolute URLs anywhere in the assets. */
const REMOTE_URL = /https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/gi;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let scanned = 0;
let failed = false;

for await (const file of walk(DIST)) {
  const ext = extname(file);
  if (!['.js', '.css', '.html'].includes(ext)) continue;
  scanned += 1;
  const content = await readFile(file, 'utf8');
  const short = file.slice(DIST.length + 1);

  for (const { name, pattern } of FORBIDDEN) {
    if (!pattern.test(content)) continue;
    if (name === 'fetch()' && FETCH_ALLOWLIST.some((m) => m.test(content))) {
      continue;
    }
    if (name === 'XMLHttpRequest' && XHR_ALLOWLIST.some((m) => m.test(content))) {
      continue;
    }
    console.error(`FAIL ${short}: ${name}`);
    failed = true;
  }

  for (const match of content.matchAll(REMOTE_URL)) {
    const url = match[0];
    if (URL_ALLOWLIST.some((pattern) => pattern.test(url))) continue;
    console.error(`FAIL ${short}: remote URL ${url}`);
    failed = true;
  }
}

if (scanned === 0) {
  console.error('FAIL: no assets scanned — did `npm run build` run first?');
  process.exit(1);
}
if (failed) {
  process.exit(1);
}
console.log(
  `network audit: OK (${scanned} assets scanned, no network-capable code or remote URLs)`,
);
