# Security Policy

## Supported versions

| Version | Supported                                  |
| ------- | ------------------------------------------ |
| 0.1.x   | Security fixes while the project is active |

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub's
"Report a vulnerability" (Security → Advisories) rather than a public issue.
Include a minimal reproduction (synthetic data only — never attach real
files) and the browser/OS.

You can expect an initial response within two weeks. Please do not test
against accounts or data you do not own.

## Scope and invariants

RowLens is a fully client-side application. The security model rests on
invariants that we treat as release blockers when broken:

1. **No data exfiltration.** File contents, field values, file names and
   derived statistics must never leave the browser. The codebase must not
   contain `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or external
   resource loads (the network audit in CI enforces the build artifact).
2. **Text-only rendering.** File content is rendered as React text nodes;
   no `dangerouslySetInnerHTML`, no Markdown/HTML interpretation.
3. **Read-only sources.** Imported files are never modified; output goes to
   a new export file only.
4. **Bounded memory.** Imports are capped (100 MiB) and streams are chunked;
   oversize inputs fail with actionable errors instead of exhausting memory.
5. **Local storage transparency.** IndexedDB caches parsed records only for
   the working session's datasets; removal, the 24-hour TTL cleanup, and
   "clear site data" all delete them.

Known residual limitations (browser storage persistence on abnormal
shutdown, spreadsheet formula behaviour on export, per-browser memory
limits) are documented in the README's "Known limitations" section rather
than claimed away.
