# Changelog

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
