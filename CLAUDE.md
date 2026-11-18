# CLAUDE.md

Standing rules for working on **Lanescope** (`lanescope`), a read-only VS Code extension that renders IBM BAW processes as BPMN diagrams inside IBM Bob (a VS Code based IDE). Not affiliated with IBM: keep IBM names out of the extension's title and branding.

## Language

All code, comments, UI text, commit messages and docs are written in English.

## Read-only

- The extension is strictly read-only. It never modifies, writes, or deploys `.bpmn`, `.xsd`, `.zip` or `.twx` files.
- Exports (images, reports, etc.) go to **new** files only and never overwrite an input.

## Inputs

1. Bob output: a single `.bpmn` file, or a `.zip` containing one `.bpmn` and its `.xsd`.
2. IBM BAW `.twx` exports.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/input/` | File and zip readers |
| `src/model/` | Shared intermediate model |
| `src/bpmn/` | BPMN reading and layout |
| `src/xsd/` | XSD handling |
| `src/twx/` | TWX import |
| `src/validate/` | Validation |
| `src/views/` | Custom editor |
| `webview/` | bpmn-js UI |

Parsing, model, layout and validation code (`src/input`, `src/model`, `src/bpmn`, `src/xsd`, `src/twx`, `src/validate`) must **not** import the `vscode` module, so it is unit-testable in plain Node. ESLint enforces this.

## Libraries

Approved runtime dependencies: `jszip`, `bpmn-moddle`, `fast-xml-parser`, `elkjs`, `bpmn-js` (NavigatedViewer only). **Ask before adding any other runtime dependency.**

## Webview

- Strict Content Security Policy.
- Only bundled local scripts (`dist/webview/`); no CDN, no inline scripts.
- No network requests.

## Build

`node esbuild.mjs` produces two bundles:
- `dist/extension.js`: extension host (platform `node`, format `cjs`, `vscode` external).
- `dist/webview/main.js`: webview UI (platform `browser`, format `iife`).

## Tests

- vitest. Tests live in `test/**/*.test.ts`, fixtures in `test/fixtures/`.
- TWX readers are covered in CI by the in-memory synthetic export in `test/syntheticTwx.ts`. Write its XML by hand; never copy from a real export or an IBM toolkit.
- Tests against real BAW exports take their paths from `test/localFixtures.ts` and are skipped (`describe.skipIf` / `it.skipIf`) when the file is not in `test/fixtures/local/`.
- Run `npm test` and `npm run build` before finishing any task.

## Fixtures

BAW exports never go to the repo: `.twx` files may contain customer data and IBM toolkit content. They live on the developer machine in `test/fixtures/local/`, which `.gitignore` excludes. Never commit a `.twx` file, an output derived from one, or customer names, endpoints, user names or personal paths.
