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
- `bun run check:docs`: validate all documented JSON examples against the schema
  registered by the real host.
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

This project does not accept outside pull requests. Please open an issue for
bugs or feature requests instead; changes are made by the maintainer.

Keep changes small and explain their behavior and tests. Include a regression
test for a bug fix. For cancellation, verify that the dialog closes, owned
listeners/timers are released, and no successful answer is emitted afterward.
For event changes, preserve default payload redaction. Do not combine new API
features with maintenance fixes.

When reporting a bug, include Pi and package versions, terminal, display mode,
relevant environment preferences, the tool arguments, and reproduction steps.
Remove private question/answer content before sharing logs.

## Releases

Releases are cut by release-please from Conventional Commit messages: `fix:`
bumps the patch version, `feat:` the minor version (also for breaking changes
while below 1.0), and other types do not release. It keeps a release PR open
with the version bump and the generated `CHANGELOG.md` entry; merging that PR
tags `vX.Y.Z`, creates the GitHub release, and dispatches `publish.yml` on the
tag.

Publishing runs the same checks before calling npm. `publish.yml` authenticates
through npm trusted publishing (OIDC); there is no npm token secret, and the
trusted publisher on npmjs.com must keep naming `edlsh/pi-ask-user` and
`publish.yml`. The release tag must match `package.json`. Verify the published
package version, contents, installation, and provenance after a successful run. An
already-published version being skipped is not proof that publishing works.

Do not overwrite published versions or move historical release tags. Changes to
registry authentication, prerelease channels, or release policy need separate
review; they are not covered by local package checks.
