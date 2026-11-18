## What and why

<!-- What does this change, and why? Link the issue it closes, e.g. "Closes #12". -->

## How it was tested

<!-- Tests added or updated, and what you checked by hand (input type, IBM Bob / VS Code version). -->

## Checklist

- [ ] `npm run lint && npm test && npm run build` pass locally
- [ ] Tests cover the change
- [ ] `CHANGELOG.md` has a line under **Unreleased** (for user-visible changes)
- [ ] The extension stays read-only and makes no network requests
- [ ] No new runtime dependency (or it was agreed in an issue first)
- [ ] No BAW exports (`.twx`), output derived from them, customer names, endpoints or personal paths are committed
