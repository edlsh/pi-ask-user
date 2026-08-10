# pi-ask-user

A Pi package that adds an interactive `ask_user` tool for collecting user decisions during an agent run.

## Demo

![ask_user demo](./media/ask-user-demo.gif)

High-quality video: [ask-user-demo.mp4](./media/ask-user-demo.mp4)

## Features

- Searchable single-select option lists with wrapped titles and descriptions
- Responsive split-pane details preview on wide terminals, with a persistent single-column preference
- Multi-select option lists
- Batches of independent questions with reviewable answers and an explicit Submit page
- Optional freeform responses
- User-toggleable extra context on structured selections
- Context display support
- Responsive context collapse that keeps the question and choices visible on small terminals without discarding full context
- Configurable display mode: `overlay` (modal, default) or `inline` (rendered directly in the flow)
- Runtime overlay toggle: press the configured overlay-toggle key (`alt+o` by default, configurable per call or via env var) while the prompt is open to temporarily hide/show the popup so you can read prior agent output, then press it again to bring it back
- Pi-TUI-aligned keybinding and editor behavior
- Custom TUI rendering for tool calls and results
- System prompt integration via `promptSnippet` and `promptGuidelines`
- Optional timeout for auto-dismiss in both overlay and fallback input modes
- `herdr:blocked` lifecycle events while waiting for interactive input
- Structured `details` on all results for session state reconstruction
- Graceful fallback when interactive UI is unavailable
- Bundled `ask-user` skill for mandatory decision-gating in high-stakes or ambiguous tasks

## Bundled skill: `ask-user`

This package now ships a skill at `skills/ask-user/SKILL.md` that nudges/mandates the agent to use `ask_user` when:

- architectural trade-offs are high impact
- requirements are ambiguous or conflicting
- assumptions would materially change implementation

The skill follows a "decision handshake" flow:

1. Gather evidence and summarize context
2. Ask one focused question, or a batch of independent questions, via `ask_user`
3. Wait for explicit user choice
4. Confirm the decision, then proceed

See: `skills/ask-user/references/ask-user-skill-extension-spec.md`.

## Install

```bash
pi install npm:pi-ask-user
```

## Tool name

The registered tool name is:

- `ask_user`

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | `string?` | — | One focused question. Use exactly one of `question` or `questions` |
| `questions` | `{id?, question, context?, options?, allowMultiple?, allowFreeform?, allowComment?}[]?` | — | Independent questions answered in one batch. IDs default to `q1`, `q2`, ... |
| `context` | `string?` | — | Relevant context summary shown before the question, or as the fallback context for each batch question |
| `options` | `{title, description?}[]?` | `[]` | Multiple-choice options. The schema is a flat object shape (no `anyOf`, which some provider proxies strip or reject); plain strings and common alias keys (`label`, `text`, `value`, `name`, `option`) are still accepted at runtime |
| `allowMultiple` | `boolean?` | `false` | Enable multi-select mode |
| `allowFreeform` | `boolean?` | `true` | Add a "Type something" freeform option |
| `allowComment` | `boolean?` | env var or `false` | Expose a user-toggleable extra-context option in the custom UI (`ctrl+g` or the toggle row) and collect an optional comment in fallback dialogs |
| `displayMode` | `"overlay" \| "inline"?` | env var or `"overlay"` | Controls custom UI rendering: `overlay` shows the centered modal (current behavior), `inline` renders without overlay framing |
| `singleSelectLayout` | `"auto" \| "list"?` | env var or `"auto"` | Use the responsive details pane automatically or always render descriptions below their options |
| `overlayToggleKey` | `string?` | env var or `"alt+o"` | Shortcut for hiding/showing the overlay popup (overlay mode only). Pi-TUI key spec, e.g. `"alt+o"`, `"ctrl+shift+h"`. Pass `"off"` to disable. |
| `commentToggleKey` | `string?` | env var or `"ctrl+g"` | Shortcut for toggling the optional comment/extra-context row when `allowComment: true`. Pass `"off"` to disable. |
| `timeout` | `number?` | — | Auto-dismiss after N ms and return `null` if the prompt times out |

## Example usage shape

```json
{
  "question": "Which option should we use?",
  "context": "We are choosing a deploy target.",
  "options": [
    { "title": "staging" },
    { "title": "production", "description": "Customer-facing" }
  ],
  "allowMultiple": false,
  "allowFreeform": true,
  "allowComment": true,
  "displayMode": "inline"
}
```

`displayMode: "inline"` uses the same interaction logic but skips overlay mode when calling `ctx.ui.custom(...)`. RPC/headless fallback behavior is unchanged.

### Batch questions

Use `questions` when several independent questions have settled prerequisites. Each question keeps its own picker/editor state while the user moves through the batch with `Tab` and `Shift+Tab`. Confirmed answers remain editable, and no result is returned until every question has an answer and the user presses Enter on the final Submit page.

```json
{
  "context": "Choose defaults for the new project.",
  "questions": [
    {
      "id": "runtime",
      "question": "Which runtime should we use?",
      "options": [{ "title": "Node.js" }, { "title": "Bun" }]
    },
    {
      "id": "tests",
      "question": "Which test runner should we use?",
      "options": [{ "title": "Node test runner" }, { "title": "Vitest" }]
    }
  ]
}
```

Questions that depend on an earlier answer belong in a later `ask_user` call. In RPC fallback mode, batch questions use the existing dialogs sequentially because the rich navigation UI is unavailable.

## Personal preferences via environment variables

Configure your defaults globally by setting these in your shell profile (`~/.zshrc`, `~/.bash_profile`, etc.):

```bash
export PI_ASK_USER_DISPLAY_MODE=inline
export PI_ASK_USER_SINGLE_SELECT_LAYOUT=list
export PI_ASK_USER_ALLOW_COMMENT=true
export PI_ASK_USER_OVERLAY_TOGGLE_KEY=alt+h
export PI_ASK_USER_COMMENT_TOGGLE_KEY=alt+c
```

Environment variables must be present in the process that launches Pi. If Pi is launched from a desktop app or a different shell, changes in `~/.zshrc` may not be inherited; launch Pi from a terminal where `echo $PI_ASK_USER_DISPLAY_MODE` shows the expected value.

### Display mode

Effective order:

1. Per-call `displayMode` parameter (if provided)
2. `PI_ASK_USER_DISPLAY_MODE` (if set to `"overlay"` or `"inline"`)
3. Fallback default: `"overlay"`

Unrecognised values are silently ignored and fall back to `"overlay"`.

### Single-select layout

Effective order:

1. Per-call `singleSelectLayout` parameter (if provided)
2. `PI_ASK_USER_SINGLE_SELECT_LAYOUT` (when set to `list`)
3. Fallback default: `auto`

`auto` shows the details pane on wide terminals. `list` keeps descriptions below their options at every width.

### Optional comments

Effective order:

1. Per-call `allowComment` parameter (if provided)
2. `PI_ASK_USER_ALLOW_COMMENT` (`true`, `1`, `yes`, or `on`; corresponding false values are also accepted)
3. Fallback default: `false`

### Shortcuts

Effective order for both `overlayToggleKey` and `commentToggleKey`:

1. Per-call parameter (if provided)
2. Matching env var (`PI_ASK_USER_OVERLAY_TOGGLE_KEY` / `PI_ASK_USER_COMMENT_TOGGLE_KEY`)
3. Built-in defaults: `alt+o` and `ctrl+g`

Pass `"off"`, `"none"`, or `"disabled"` (at any level) to disable the shortcut entirely. Invalid specs are silently dropped and the next source is used. Specs follow the Pi-TUI [`KeyId`](https://github.com/earendil-works/pi-mono/blob/main/packages/tui/src/keys.ts) format: `[mod+]...key` where modifiers are `ctrl`, `shift`, `alt`, `super`, in any order, joined by `+` (e.g. `ctrl+g`, `alt+shift+x`, `escape`, `tab`).

## Controls

While an `ask_user` prompt is open:

| Key | Action |
|-----|--------|
| `alt+o` (configurable via `overlayToggleKey`) | Hide/show the overlay popup so you can read the agent's prior output. Available in `overlay` mode only. The first time you hide it, a notification reminds you which key brings it back. |
| `ctrl+g` (configurable via `commentToggleKey`) | Toggle the optional comment/extra-context row (when `allowComment: true`). |
| `ctrl+e` | Expand or collapse oversized context while choosing an option. If another configured ask shortcut owns it, the prompt shows `ctrl+x` or `ctrl+y` instead. |
| `enter` | Confirm the focused option, submit a freeform response, submit/skip an optional comment, or submit a completed batch from its Submit page. |
| `tab` / `shift+tab` | In batch mode, move forward/backward through question pages and the final Submit page. |
| `esc` | Clear the search filter, exit freeform/comment mode, or cancel the prompt. |
| `↑` / `↓`, `ctrl+k` / `ctrl+j` | Navigate options. `ctrl+k` / `ctrl+j` (vim-style) work while typing in searchable prompts without disturbing the filter. |

If you prefer never to see the overlay, set `displayMode: "inline"` per call or `PI_ASK_USER_DISPLAY_MODE=inline` globally.

### Mobile-sized terminals

If context wraps beyond the available decision area, `ask_user` collapses it into a one-line summary so the question and at least one choice remain visible. Press the context key shown in the prompt (`ctrl+e` by default) to expand or collapse the complete context; expanded context remains bounded and scrollable with the existing prompt-scroll keys in both display modes.

### Waiting lifecycle event

While an interactive prompt is open, the extension emits `herdr:blocked` with `{ active: true, label: "Waiting for user response" }`. It emits `{ active: false }` in `finally`, including cancellation and error paths. Hosts without a listener are unaffected.

## Known limitations

- **Overlays cannot draw over inline images** ([#8](https://github.com/edlsh/pi-ask-user/issues/8)). Pi-TUI's overlay compositor skips rows occupied by terminal images (Kitty/iTerm2 graphics), so an `ask_user` overlay that intersects an image is partially or fully invisible. This must be fixed upstream in pi-tui (`compositeLineAt` returns image rows unchanged). Until then, `displayMode: "inline"` (or `PI_ASK_USER_DISPLAY_MODE=inline`) sidesteps the overlay compositor entirely and should keep the prompt visible.

## Result details

All tool results include a structured `details` object for rendering and session state reconstruction:

```typescript
type AskResponse =
  | { kind: "selection"; selections: string[]; comment?: string }
  | { kind: "freeform"; text: string };

type BatchResponse = {
  kind: "batch";
  answers: Array<{
    id: string;
    question: string;
    response: AskResponse;
  }>;
};

interface AskToolDetails {
  question: string;
  context?: string;
  options: QuestionOption[];
  response: AskResponse | null;
  cancelled: boolean;
}

interface BatchAskToolDetails {
  questions: Array<{ id: string; question: string }>;
  response: BatchResponse | null;
  cancelled: boolean;
}
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
