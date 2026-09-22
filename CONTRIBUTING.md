# Contributing

## Development setup

Use Node.js 22.19.0 or newer and Bun 1.3.14. Bun runs the unit tests and manages
pinned development dependencies. The extension itself runs in Pi; these are
contributor requirements, not a change to its supported host versions.

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Dependency lifecycle scripts are not needed for these checks. Commit `bun.lock`
when intentionally updating development dependencies.

## Verification

- `bun run test`: fast unit tests (host/UI modules are mocked).
- `bun run typecheck`: strict TypeScript checks for source and tests.
- `bun run check:host`: load the extension through the real installed Pi host and
  verify its schema, dialog fallback, and event contract without a model request.
- `bun run check:package`: verify the npm package contains exactly its intended
  runtime and documentation files.

`bun run check` runs all of these. CI checks Node.js 22 and 24 with Pi 0.74.0
(the supported minimum) and the pinned current host, 0.87.0. Runtime peer ranges
remain unchanged. Updating the current development host also requires updating
the CI matrix and checking the minimum host.

For UI changes, also check a real terminal: overlay and inline mode, narrow and
wide terminals, resize, long context, comments/freeform, timeout and abort, and
non-ASCII text. Automated smoke checks do not replace interactive verification.

## Pull requests

Keep changes small and explain their behavior and tests. Include a regression
test for a bug fix. For cancellation, verify that the dialog closes, owned
listeners/timers are released, and no successful answer is emitted afterward.
For event changes, preserve default payload redaction. Do not combine new API
features with maintenance fixes.

When reporting a bug, include Pi and package versions, terminal, display mode,
relevant environment preferences, the tool arguments, and reproduction steps.
Remove private question/answer content before sharing logs.

## Releases

Publishing runs the same checks before calling npm. A tag-triggered release must
match `package.json`. Keep the changelog current and verify the published package
version, contents, installation, and provenance after a successful run. An
already-published version being skipped is not proof that publishing works.

Do not overwrite published versions or move historical release tags. Changes to
registry authentication, prerelease channels, or release policy need separate
review; they are not covered by local package checks.
