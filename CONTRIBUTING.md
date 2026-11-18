# Contributing to Lanescope

Thanks for your interest in Lanescope. Bug reports, ideas and pull requests are welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, follow [SECURITY.md](SECURITY.md); please don't open a public issue for it.

## Ground rules

- **Read-only.** The extension never writes, changes or deploys a `.bpmn`, `.xsd`, `.zip` or `.twx` file. A change that would break this will not be merged.
- **No network.** The extension and its webview make no network requests and send no telemetry. Webview scripts are bundled locally; no CDN.
- **Dependencies.** The runtime dependencies are `jszip`, `bpmn-moddle`, `fast-xml-parser`, `elkjs` and `bpmn-js`. Please open an issue before adding another one.
- **English** for code, comments, UI text, commit messages and docs.
- Parsing, model, layout and validation code (`src/input`, `src/model`, `src/bpmn`, `src/xsd`, `src/twx`, `src/validate`) does not import `vscode`, so it can be tested in plain Node. ESLint checks this.

## Never commit BAW exports

`.twx` files can contain customer processes, endpoints, user names and IBM toolkit content. **Never commit BAW exports: put them in `test/fixtures/local/`.** That folder is ignored by git.

- Tests against real exports read them from `test/fixtures/local/` under the names in `test/localFixtures.ts`, and are skipped when a file is missing. CI runs without them.
- To test the TWX readers in CI, extend the synthetic export in `test/syntheticTwx.ts`. Write its XML by hand; don't copy it from a real export or an IBM toolkit.
- Don't commit anything derived from a real export either (screenshots, extracted XML, test output), nor customer names, endpoints or personal paths.

## Build and test

Requires Node.js 20 or later (CI uses Node.js 22).

```sh
npm ci           # install the exact locked dependencies
npm run lint     # eslint
npm test         # unit tests (vitest)
npm run build    # type-check, then bundle into dist/
npm run package  # production build, then lanescope-<version>.vsix
```

To run the extension from source, open the folder in VS Code or IBM Bob and press **F5** ("Run Extension").

Tests live in `test/**/*.test.ts`, fixtures in `test/fixtures/`. Add or update tests with every change in behavior.

## Branches and pull requests

1. Fork the repository (or create a branch if you have write access). Branch from `main` with a short descriptive name, for example `fix/empty-lane-height` or `feat/service-variables`.
2. Keep a pull request to one topic. Run `npm run lint && npm test && npm run build` before pushing.
3. Add a line to the **Unreleased** section of `CHANGELOG.md` for any change users will notice.
4. Open the pull request against `main` and fill in the template. CI (lint, tests, build, package) must pass.
5. A maintainer reviews it. Write the title as you would a commit message.

## Releases

Maintainers release by updating `version` in `package.json`, moving the **Unreleased** notes to a `## <version> — <date>` section in `CHANGELOG.md`, and pushing a `v<version>` tag. The release workflow checks that the tag matches `package.json`, runs CI and attaches the `.vsix` to a GitHub Release.
