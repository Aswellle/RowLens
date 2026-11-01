// ESLint flat config. The React hooks rules are the point of this setup:
// App.tsx's query hub derives its effect dependencies by hand, and the one
// silent failure it has already produced (a sort key missing the numeric
// flag, ADR-035) is exactly what react-hooks/exhaustive-deps exists to catch.
// Deviations stay inline as `eslint-disable-next-line` with a reason.
//
// The parser is @babel/eslint-parser with the TypeScript and JSX syntax
// plugins: typescript-eslint's released line refuses to run on the
// TypeScript 7 this repo compiles with (its support is tracked upstream),
// and the hooks rules need syntax only — no type information, which
// `tsc --noEmit` already owns.
import babelParser from '@babel/eslint-parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['dist/', 'coverage/', 'node_modules/', 'playwright-report/', 'test-results/'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { parserOpts: { plugins: ['typescript', 'jsx'] } },
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The three compiler-era rules below flag patterns this codebase uses
      // deliberately and tests: render-time ref writes are the documented
      // latest-view bridge and the persistence-marker seeds; the export
      // dialog re-asks its estimate through an effect; TanStack Virtual's
      // API is third-party. They assume a memoized React-Compiler world
      // this app does not live in yet — revisit if the Compiler is adopted.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/incompatible-library': 'off',
    },
  },
];
