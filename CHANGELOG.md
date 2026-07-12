# Changelog

## [0.13.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.13.0) - 2026-07-12

### Added

- `PI_ASK_USER_ALLOW_COMMENT` preference for globally enabling optional comments while preserving per-call precedence and the existing `false` default. Closes #26.

### Changed

- Display mode environment values now tolerate surrounding whitespace and capitalization, and the documentation clarifies that Pi must inherit `PI_ASK_USER_*` variables from its launching process. Diagnostic hardening related to #24; the reported reproduction (a valid lowercase `inline`) is not resolved by this entry.
- Documented that pi-tui's overlay compositor skips image rows, leaving overlay prompts invisible where inline images are on screen, with `displayMode: "inline"` as the workaround. Root cause is upstream in pi-tui; related to #8.

## [0.12.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.12.0) - 2026-07-06

### Fixed

- `ask_user` failing under schema-mangling hosts/proxies (cmux, Google function calling, Codex-style backends) that strip or reject the `anyOf` union in the `options` items schema. Models behind such proxies could not see the option shape, guessed keys like `{ "text": … }` or sent empty objects, and every option was silently dropped — the tool then fell into an empty freeform prompt that ended in `Cancelled`. Closes #22. Three changes:
  - The `options` schema is now a flat `{ title, description? }` object array with no `anyOf`, so every provider sees a concrete shape. Plain strings remain accepted at runtime.
  - Option normalization now salvages common alias keys (`label`, `text`, `value`, `name`, `option`) and coerces primitive entries, instead of dropping anything without a `title`.
  - When every option is malformed, the tool returns an error result telling the model the expected shape so it can retry, instead of silently showing a freeform prompt.

## [0.11.2](https://github.com/edlsh/pi-ask-user/releases/tag/v0.11.2) - 2026-06-03

### Changed

- Declare `executionMode: "sequential"` on the `ask_user` tool so the agent loop awaits the user's answer before running any other tool call in the same assistant turn. Without this, hosts running the default `"parallel"` tool-execution mode could batch `ask_user` with `bash`/`edit`/`write` calls and let those execute — potentially with irreversible side effects — before the user even sees the prompt. Requires no peer-dep bump; `executionMode` has been part of `ToolDefinition` since `@earendil-works/pi-coding-agent@0.74.0`.

## [0.11.1](https://github.com/edlsh/pi-ask-user/releases/tag/v0.11.1) - 2026-05-23

### Fixed

- Crash with `Theme not initialized. Call initTheme() first.` on hosts still using the legacy `@mariozechner/pi-coding-agent` scope (Pi ≤ 0.73.1). When npm cannot dedupe across package scopes the extension brings its own copy of `@earendil-works/pi-coding-agent`, whose theme singleton is never initialised; pi-tui's `Markdown.render` then threw on the first `theme.bold` access. The existing `try { getMarkdownTheme() } catch {}` guard never fired because the bag of closures returned by `getMarkdownTheme` only proxies the singleton lazily. A new `safeMarkdownTheme()` helper now eagerly probes `bold("")` and falls back to plain `Text` rendering when the probe throws. Closes #17.

### Changed

- Tightened `peerDependencies` on `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` from `"*"` to `">=0.74.0"` so npm refuses to install this version against legacy `@mariozechner/*` hosts at install time instead of crashing at render time

## [0.11.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.11.0) - 2026-05-09

### Added

- Vim-style navigation aliases for option lists: `ctrl+j` moves to the next option and `ctrl+k` moves to the previous option in both single-select (with active fuzzy search) and multi-select prompts. Bare `j`/`k` continue to feed the fuzzy filter so search behavior is unchanged. Closes #16.

## [0.10.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.10.0) - 2026-05-07

### Changed

- Updated peer dependencies and references for the move to `earendil-works/pi-mono` and `@earendil-works/*` package scopes. `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peer deps are now `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

## [0.9.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.9.0) - 2026-05-04

### Added

- Configurable shortcuts: new `overlayToggleKey` and `commentToggleKey` parameters on `ask_user` accept any Pi-TUI [`KeyId`](https://github.com/earendil-works/pi-mono/blob/main/packages/tui/src/keys.ts) spec (e.g. `"alt+o"`, `"ctrl+shift+h"`)
- Matching env vars `PI_ASK_USER_OVERLAY_TOGGLE_KEY` and `PI_ASK_USER_COMMENT_TOGGLE_KEY` for setting personal defaults globally; per-call parameter wins over env var, which wins over the built-in defaults `alt+o` and `ctrl+g`
- Pass `"off"`, `"none"`, or `"disabled"` at any level to disable a shortcut entirely; invalid specs silently fall through to the next source
- Defaults preserved: existing `alt+o` overlay-toggle and `ctrl+g` comment-toggle continue to work unchanged. Closes #13.

## [0.8.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.8.0) - 2026-05-01

### Added

- Runtime overlay toggle: in `overlay` mode, press `alt+o` while the prompt is open to temporarily hide/show the popup so you can read prior agent output. Press again to restore. Implemented via `OverlayHandle.setHidden()` and a global `ctx.ui.onTerminalInput` listener so the overlay can be revived even while hidden. A one-shot info notification on first hide reminds the user how to restore. Closes #11.

## [0.7.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.7.0) - 2026-05-01

### Added

- `displayMode` parameter on `ask_user` (`"overlay"` | `"inline"`) controlling whether the custom UI renders as a centered modal or in the conversation flow
- `PI_ASK_USER_DISPLAY_MODE` environment variable for setting a personal default display mode; per-call `displayMode` always wins over the env var, which always wins over the built-in `"overlay"` fallback
- Skill guidance documenting when to override `displayMode` per call vs. respect the user's env-var preference

### Changed

- Tool schema now uses a flat `{ type: "string", enum: [...] }` JSON Schema for `displayMode` (Google function-calling compatible) via a small local helper rather than `Type.Union([Type.Literal()])`

## [0.6.1](https://github.com/edlsh/pi-ask-user/releases/tag/v0.6.1) - 2026-04-07

### Changed

- Clarified the registered `ask_user` tool guidance so agents are instructed to ask exactly one focused question per call and avoid multipart or unrelated prompts

## [0.6.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.6.0) - 2026-04-07

### Added

- `allowComment` parameter for collecting optional notes after structured selections, including a user-toggleable overlay row, direct `ctrl+g` keybind, and fallback dialog prompt

### Changed

- `ask_user` result details and emitted `ask:answered` events now use a structured `response` union instead of flattening everything into `answer` / `wasCustom`
- Expanded result rendering now shows selection comments separately from chosen options


## [0.5.2](https://github.com/edlsh/pi-ask-user/releases/tag/v0.5.2) - 2026-04-06

### Fixed

- Multi-line selected option highlighting — when an option title wraps across multiple lines, all lines now highlight with accent styling instead of only the first line with the `→` pointer

### Changed

- `renderSingleSelectRows()` now returns `AnnotatedRow[]` (`{ line, selected }`) instead of plain strings, enabling callers to apply per-block styling

## [0.5.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.5.0) - 2026-03-25

### Added

- Searchable single-select option lists — type to filter titles and descriptions without leaving the overlay
- Responsive split-pane preview for wide terminals — selected options show a details pane while narrow terminals fall back to the single-column list
- Regression coverage for searchable selection, split-pane rendering, narrow-width fallback, overlay freeform metadata, and wrapping edge cases

### Changed

- Single-select overlay help text now reflects actual Pi-TUI keybindings, including remapped cancel keys and delete/backspace behavior
- Freeform mode now follows Pi-TUI editor semantics more closely by delegating newline behavior to the shared editor and forwarding Ctrl+Enter to the editor instead of treating it as submit

### Fixed

- Freeform overlay crash caused by constructing `Editor` without the required `tui` argument
- Overlay freeform answers now preserve `wasCustom: true` in both emitted events and returned `details` metadata
- Out-of-range number keys in searchable single-select now fall through to filtering instead of being silently swallowed
- Exact-width word wrapping no longer duplicates preceding short text in wrapped descriptions


## [0.4.1](https://github.com/edlsh/pi-ask-user/releases/tag/v0.4.1) - 2026-03-22

### Added

- Markdown rendering for context sections — uses `Markdown` component with `getMarkdownTheme` when available, falls back to plain `Text`
- `rawKeyHint()` integration for consistent key hint styling in help text
- Event emission via `pi.events.emit()` — `ask:answered` and `ask:cancelled` events for external listeners
- Partial update (`onUpdate`) emitted before showing the overlay, so `renderResult` can display a waiting state while the dialog is open
- `minWidth` overlay option (40 chars) to prevent the overlay from collapsing on narrow terminals
- AbortSignal wiring in overlay mode — agent cancellation auto-dismisses the dialog
- Timeout support in overlay mode (previously only worked in fallback input mode)
- Expanded result rendering in `renderResult` — shows question, context, and per-option markers (● selected / ○ unselected)
- `index.test.ts` — test suite covering narrow-terminal overlay, partial-update rendering, and expanded multi-select markers

### Changed

- `Editor` constructor no longer receives `tui` as first argument
- `timeout` parameter description clarified: returns `null` (cancelled) when expired
- Removed unused `FREEFORM_VALUE` constant and standalone `submitFreeform()` method (logic inlined into `handleInput`)

### Fixed

- Keep the ask overlay accessible on narrow terminals by removing the visibility gate that could leave prompts hidden and unresolved
- Render partial `ask_user` updates as a waiting state instead of a successful empty answer, and correctly mark selected options in expanded multi-select results

## [0.4.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.4.0) - 2026-03-22

### Changed

- Replace pi-tui `SelectList` with custom `WrappedSingleSelectList` that wraps long option titles and descriptions instead of truncating them ([`7a4c239`](https://github.com/edlsh/pi-ask-user/commit/7a4c239))
- Configure centered overlay at 92% width / 85% max height with dynamic row calculation based on terminal size ([`7a4c239`](https://github.com/edlsh/pi-ask-user/commit/7a4c239))

### Added

- `single-select-layout.ts` — pure rendering logic with text wrapping, numbered items, viewport scrolling, and position indicators ([`7a4c239`](https://github.com/edlsh/pi-ask-user/commit/7a4c239))

## [0.3.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.3.0) - 2026-03-13

### Added

- `promptSnippet` for inline prompt integration ([`c9e0df0`](https://github.com/edlsh/pi-ask-user/commit/c9e0df0))
- `renderCall` / `renderResult` hooks for custom tool-call rendering ([`c9e0df0`](https://github.com/edlsh/pi-ask-user/commit/c9e0df0))
- Overlay mode for the ask UI ([`c9e0df0`](https://github.com/edlsh/pi-ask-user/commit/c9e0df0))
- Timeout support with auto-dismiss ([`c9e0df0`](https://github.com/edlsh/pi-ask-user/commit/c9e0df0))
- Structured details in tool results ([`c9e0df0`](https://github.com/edlsh/pi-ask-user/commit/c9e0df0))

## [0.2.1](https://github.com/edlsh/pi-ask-user/releases/tag/v0.2.1) - 2026-02-16

### Fixed

- Documentation improvements — moved demo section to top of README, simplified skill spec ([`e2f6a57`](https://github.com/edlsh/pi-ask-user/commit/e2f6a57), [`e09d130`](https://github.com/edlsh/pi-ask-user/commit/e09d130), [`0fc7f99`](https://github.com/edlsh/pi-ask-user/commit/0fc7f99))

## [0.2.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.2.0) - 2026-02-16

### Added

- Bundled ask-user decision-gate skill ([`38add68`](https://github.com/edlsh/pi-ask-user/commit/38add68))
- npm publish CI workflow ([`da10d70`](https://github.com/edlsh/pi-ask-user/commit/da10d70))

## [0.1.0](https://github.com/edlsh/pi-ask-user/releases/tag/v0.1.0) - 2026-02-16

### Added

- Initial public release — interactive `ask_user` tool with multi-select and freeform input UI ([`9077284`](https://github.com/edlsh/pi-ask-user/commit/9077284))
