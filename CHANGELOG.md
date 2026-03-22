# Changelog

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
