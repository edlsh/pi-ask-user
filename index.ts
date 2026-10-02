/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to use built-in TUI primitives (Container/Text/Spacer/SelectList/Editor)
 * and a custom box border instead of manual ANSI box drawing.
 */

import type {
   AgentToolResult,
   AgentToolUpdateCallback,
   ExtensionAPI,
   ExtensionContext,
   ExtensionUIContext,
   Theme,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";
import {
   Container,
   type Component,
   CURSOR_MARKER,
   decodeKittyPrintable,
   Editor,
   type EditorTheme,
   fuzzyFilter,
   isKeyRelease,
   isKeyRepeat,
   Key,
   type Keybinding,
   type KeybindingsManager,
   Markdown,
   type MarkdownTheme,
   matchesKey,
   type OverlayHandle,
   type OverlayOptions,
   Spacer,
   Text,
   type TUI,
   truncateToWidth,
   wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderSingleSelectRows, type QuestionOption } from "./single-select-layout";

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const ASK_USER_VERSION: string = (_require("./package.json") as { version: string }).version;

/**
 * Emit a flat `{ type: "string", enum: [...] }` JSON Schema instead of the
 * `anyOf`/`oneOf` shape that `Type.Union([Type.Literal()])` produces. Google's
 * function-calling API rejects the union form. Local copy of pi-ai's StringEnum
 * to avoid a peer dependency for one helper.
 *
 * Some hosts (oh-my-pi) alias `@sinclair/typebox` to a shim whose `Type.Unsafe`
 * returns a plain object that `Type.Optional` cannot wrap (issue #38). On those
 * hosts a union of literals is a real runtime schema *and* already collapses to
 * the flat enum form, so we probe the builder and pick whichever path it
 * supports. `builder` is injectable for tests only.
 */
export type StringEnumBuilder = Pick<typeof Type, "Unsafe" | "Optional" | "Union" | "Literal">;

export function StringEnum<const T extends readonly string[]>(
   values: T,
   options?: { description?: string; default?: T[number] },
   builder: StringEnumBuilder = Type,
): TUnsafe<T[number]> {
   const meta = {
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.default !== undefined ? { default: options.default } : {}),
   };
   try {
      builder.Optional(builder.Unsafe<string>({ type: "string" }));
      return builder.Unsafe<T[number]>({ type: "string", enum: [...values], ...meta });
   } catch {
      // fall through to the union path below
   }
   // Shim path: the union is a runtime schema, so `Type.Optional` works and the
   // enclosing `Type.Object` keeps every optional key optional. Chainable
   // `.describe()`/`.default()` are the shim's way to attach metadata; the
   // options argument covers builders that take it positionally instead.
   let schema = builder.Union(values.map((value) => builder.Literal(value)), meta) as unknown as {
      describe?: (text: string) => unknown;
      default?: (value: unknown) => unknown;
   };
   if (options?.description && typeof schema.describe === "function") {
      schema = schema.describe(options.description) as typeof schema;
   }
   if (options?.default !== undefined && typeof schema.default === "function") {
      schema = schema.default(options.default) as typeof schema;
   }
   return schema as unknown as TUnsafe<T[number]>;
}

/**
 * `getMarkdownTheme()` returns a bag of closures that read through a Proxy
 * over the host's theme singleton. The Proxy only throws on property access,
 * not when the bag itself is constructed — so a naive
 * `try { getMarkdownTheme() } catch {}` silently lets a broken bag escape
 * and crashes mid-render the first time pi-tui's Markdown calls
 * `mdTheme.bold(...)`.
 *
 * That broken-bag scenario shows up whenever this extension's bundled copy
 * of `@earendil-works/pi-coding-agent` is a different module instance than
 * the host's — e.g. an older Pi still on the legacy
 * `@mariozechner/pi-coding-agent` scope (≤ 0.73.1) where npm cannot dedupe
 * across scopes, so our copy's theme singleton is never initialised
 * (`globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` is
 * undefined). See https://github.com/edlsh/pi-ask-user/issues/17.
 *
 * Probe `bold("")` to force the Proxy lookup eagerly; on throw, callers
 * fall back to plain `Text` rendering for context blocks.
 */
function safeMarkdownTheme(): MarkdownTheme | undefined {
   try {
      const md = getMarkdownTheme();
      if (!md) return undefined;
      md.bold("");
      return md;
   } catch {
      return undefined;
   }
}

type AskOptionInput = QuestionOption | string;

type AskDisplayMode = "overlay" | "inline";
type AskSingleSelectLayout = "auto" | "list";

interface BatchQuestionInput {
   question: string;
   context?: string;
   options?: AskOptionInput[];
   allowMultiple?: boolean;
   allowFreeform?: boolean;
}

interface AskParams {
   question?: string;
   questions?: BatchQuestionInput[];
   context?: string;
   options?: AskOptionInput[];
   allowMultiple?: boolean;
   allowFreeform?: boolean;
   allowComment?: boolean;
   displayMode?: AskDisplayMode;
   singleSelectLayout?: AskSingleSelectLayout;
   contextExpanded?: boolean;
   overlayToggleKey?: string | null;
   commentToggleKey?: string | null;
   timeout?: number;
}

type AskResponse =
   | {
      kind: "selection";
      selections: string[];
      comment?: string;
   }
   | {
      kind: "freeform";
      text: string;
   };

interface AskToolDetails {
   question: string;
   context?: string;
   options: QuestionOption[];
   response: AskResponse | null;
   cancelled: boolean;
}

/** One validated entry of a `questions` batch. */
interface BatchQuestion {
   question: string;
   context?: string;
   options: QuestionOption[];
   allowMultiple: boolean;
   allowFreeform: boolean;
}

type BatchAnswer = { status: "answered"; response: AskResponse } | { status: "skipped" };

/** Result details of a `questions` batch. Single-question results keep AskToolDetails. */
interface AskBatchDetails {
   kind: "batch";
   questions: Array<{ question: string; context?: string; options: QuestionOption[] }>;
   /** Index-aligned with `questions`; empty when the batch was cancelled. */
   answers: BatchAnswer[];
   cancelled: boolean;
}

function isBatchDetails<T extends AskToolDetails | AskBatchDetails>(details: T): details is Extract<T, AskBatchDetails> {
   return (details as AskBatchDetails).kind === "batch";
}

const BATCH_MIN_QUESTIONS = 2;
const BATCH_MAX_QUESTIONS = 4;
// Single-question fields that a batch sets per entry instead of at the top level.
const BATCH_ENTRY_FIELDS = ["context", "options", "allowMultiple", "allowFreeform"] as const;

type AskUIResult = AskResponse;

// Key aliases models fall back to when a schema-mangling proxy (Google
// function calling, Codex-style backends, cmux) strips the option shape and
// the model has to guess. See issue #22.
const OPTION_TITLE_KEYS = ["title", "label", "text", "value", "name", "option"] as const;

function coerceOption(option: unknown): QuestionOption | null {
   if (typeof option === "string" || typeof option === "number" || typeof option === "boolean") {
      const title = String(option).trim();
      return title ? { title } : null;
   }
   if (option && typeof option === "object") {
      const record = option as Record<string, unknown>;
      for (const key of OPTION_TITLE_KEYS) {
         const value = record[key];
         if (typeof value === "string" && value.trim()) {
            const description =
               typeof record.description === "string" && record.description.trim() ? record.description : undefined;
            return description ? { title: value.trim(), description } : { title: value.trim() };
         }
      }
   }
   return null;
}

function formatOptionsForMessage(options: QuestionOption[]): string {
   return options
      .map((option, index) => {
         const desc = option.description ? ` — ${option.description}` : "";
         return `${index + 1}. ${option.title}${desc}`;
      })
      .join("\n");
}

function normalizeOptionalComment(text: string | null | undefined): string | undefined {
   const trimmed = text?.trim();
   return trimmed ? trimmed : undefined;
}

function parseBooleanPreference(value: string | undefined): boolean | undefined {
   if (value === undefined) return undefined;
   switch (value.trim().toLowerCase()) {
      case "1":
      case "true":
      case "yes":
      case "on":
         return true;
      case "0":
      case "false":
      case "no":
      case "off":
         return false;
      default:
         return undefined;
   }
}

function createFreeformResponse(text: string | null | undefined): AskResponse | null {
   const trimmed = text?.trim();
   return trimmed ? { kind: "freeform", text: trimmed } : null;
}

function createSelectionResponse(selections: string[], comment?: string | null): AskResponse | null {
   const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
   if (normalizedSelections.length === 0) return null;

   const normalizedComment = normalizeOptionalComment(comment);
   return normalizedComment
      ? { kind: "selection", selections: normalizedSelections, comment: normalizedComment }
      : { kind: "selection", selections: normalizedSelections };
}

function formatResponseSummary(response: AskResponse): string {
   if (response.kind === "freeform") return response.text;

   const selections = response.selections.join(", ");
   return response.comment ? `${selections} — ${response.comment}` : selections;
}

function buildCommentPrompt(prompt: string, selections: string[]): string {
   const label = selections.length === 1 ? "Selected option" : "Selected options";
   const lines = selections.map((selection) => `- ${selection}`).join("\n");
   return `${prompt}\n\n${label}:\n${lines}`;
}

function parseDialogSelections(input: string): string[] {
   return input
      .split(",")
      .map((selection) => selection.trim())
      .filter(Boolean);
}

function isCancelledInput(value: unknown): value is null | undefined {
   return value === null || value === undefined;
}

function isSelectionResponse(response: AskResponse): response is Extract<AskResponse, { kind: "selection" }> {
   return response.kind === "selection";
}

function createSelectListTheme(theme: Theme) {
   return {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
   };
}

function createEditorTheme(theme: Theme): EditorTheme {
   return {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: createSelectListTheme(theme),
   };
}

const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

class BoxBorderTop implements Component {
   private color: (s: string) => string;
   private title?: string;
   private titleColor?: (s: string) => string;
   constructor(color: (s: string) => string, title?: string, titleColor?: (s: string) => string) {
      this.color = color;
      this.title = title;
      this.titleColor = titleColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.title || inner < this.title.length + 4) {
         return [this.color(`╭${"─".repeat(inner)}╮`)];
      }
      const label = ` ${this.title} `;
      const remaining = inner - 1 - label.length;
      const titleStyle = this.titleColor ?? this.color;
      return [
         this.color("╭─") + titleStyle(label) + this.color("─".repeat(Math.max(0, remaining)) + "╮"),
      ];
   }
}

class BoxBorderBottom implements Component {
   private color: (s: string) => string;
   private label?: string;
   private labelColor?: (s: string) => string;
   constructor(color: (s: string) => string, label?: string, labelColor?: (s: string) => string) {
      this.color = color;
      this.label = label;
      this.labelColor = labelColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.label || inner < this.label.length + 4) {
         return [this.color(`╰${"─".repeat(inner)}╯`)];
      }
      const tag = ` ${this.label} `;
      const leftDashes = inner - tag.length - 1;
      const style = this.labelColor ?? this.color;
      return [
         this.color("╰" + "─".repeat(Math.max(0, leftDashes))) + style(tag) + this.color("─╯"),
      ];
   }
}

function formatKeyList(keys: string[]): string {
   return keys.join("/");
}

function keybindingHint(
   theme: Theme,
   keybindings: KeybindingsManager,
   keybinding: Keybinding,
   description: string,
): string {
   return `${theme.fg("dim", formatKeyList(keybindings.getKeys(keybinding)))}${theme.fg("muted", ` ${description}`)}`;
}

function literalHint(theme: Theme, key: string, description: string): string {
   return `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}`;
}

type ResolvedShortcut =
   | { disabled: false; spec: string; matches: (data: string) => boolean }
   | { disabled: true; spec: null; matches: (data: string) => false };

interface ResolvedAskShortcuts {
   overlayToggle: ResolvedShortcut;
   commentToggle: ResolvedShortcut;
}

const DISABLED_SHORTCUT: ResolvedShortcut = {
   disabled: true,
   spec: null,
   matches: ((_data: string) => false) as (data: string) => false,
};

const SHORTCUT_DISABLE_VALUES = new Set(["off", "none", "disabled", ""]);

function normalizeShortcutSpec(value: string | null | undefined): string | null | undefined {
   if (value === undefined) return undefined;
   if (value === null) return null;
   const trimmed = value.trim().toLowerCase();
   if (SHORTCUT_DISABLE_VALUES.has(trimmed)) return null;
   return trimmed;
}

function isValidShortcutSpec(spec: string): boolean {
   // KeyId is canonical lowercase: modifiers (`ctrl|shift|alt|super`) joined by `+`,
   // plus a base key. We do a light syntactic sanity check; matchesKey() does the rest.
   if (!spec) return false;
   if (!/^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i.test(spec)) return false;
   if (spec.startsWith("+") || spec.endsWith("+")) return false;
   if (spec.includes("++")) return false;
   return true;
}

function buildShortcut(spec: string): ResolvedShortcut {
   return {
      disabled: false,
      spec,
      matches: (data: string) => matchesKey(data, spec as any),
   };
}

function resolveShortcut(
   paramValue: string | null | undefined,
   envValue: string | undefined,
   defaultSpec: string,
): ResolvedShortcut {
   const candidates: Array<string | null | undefined> = [paramValue, envValue, defaultSpec];
   for (const raw of candidates) {
      const normalized = normalizeShortcutSpec(raw);
      if (normalized === undefined) continue; // not provided, fall through
      if (normalized === null) return DISABLED_SHORTCUT; // explicit disable
      if (isValidShortcutSpec(normalized)) return buildShortcut(normalized);
      // Invalid spec: silently fall through to next candidate.
   }
   return DISABLED_SHORTCUT;
}

type AskMode = "select" | "freeform" | "comment";

const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const ASK_OVERLAY_MIN_RENDER_LINES = 8;
const ASK_OVERLAY_WIDTH = "92%";
const ASK_OVERLAY_MIN_WIDTH = 40;
const SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH = 84;
const SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH = 32;
const SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";
const FREEFORM_SENTINEL = "\u270f\ufe0f Type custom response...";
const COMMENT_TOGGLE_LABEL = "Add extra context after selection";
const DEFAULT_OVERLAY_TOGGLE_KEY = "alt+o";
const DEFAULT_COMMENT_TOGGLE_KEY = "ctrl+g";
const CONTEXT_TOGGLE_KEYS = [Key.ctrl("e"), Key.ctrl("x"), Key.ctrl("y")];
const INLINE_CONTEXT_MAX_ROWS = 3;

// Vim-style aliases for navigating option lists. ctrl+j/k are safe in the
// searchable single-select because they don't collide with fuzzy-search input.
const VIM_SELECT_UP_KEY = Key.ctrl("k");
const VIM_SELECT_DOWN_KEY = Key.ctrl("j");
const PROMPT_SCROLL_PAGE_UP_KEY = Key.pageUp;
const PROMPT_SCROLL_PAGE_DOWN_KEY = Key.pageDown;
const PROMPT_SCROLL_HOME_KEY = Key.home;
const PROMPT_SCROLL_END_KEY = Key.end;
const PROMPT_SCROLL_HALF_PAGE_UP_KEY = Key.ctrl("u");
const PROMPT_SCROLL_HALF_PAGE_DOWN_KEY = Key.ctrl("d");

function getOverlayMaxRenderLinesForRows(rows: number): number {
   const normalizedRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
   const availableRows = Math.max(1, normalizedRows - 2);
   const ratioRows = Math.max(1, Math.floor(normalizedRows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
   const minimumRows = Math.min(ASK_OVERLAY_MIN_RENDER_LINES, availableRows);
   return Math.min(availableRows, Math.max(minimumRows, ratioRows));
}

function matchesSelectUp(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, Key.shift("tab")) ||
      matchesKey(data, VIM_SELECT_UP_KEY)
   );
}

function matchesSelectDown(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, VIM_SELECT_DOWN_KEY)
   );
}

function buildCustomUIOptions(
   displayMode: AskDisplayMode,
   onHandle?: (handle: OverlayHandle) => void,
): { overlay?: boolean; overlayOptions?: OverlayOptions; onHandle?: (handle: OverlayHandle) => void } | undefined {
   switch (displayMode) {
      case "inline":
         return undefined;
      case "overlay":
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: ASK_OVERLAY_WIDTH,
               minWidth: ASK_OVERLAY_MIN_WIDTH,
               maxHeight: "85%",
               margin: 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      default: {
         const _exhaustive: never = displayMode;
         void _exhaustive;
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: ASK_OVERLAY_WIDTH,
               minWidth: ASK_OVERLAY_MIN_WIDTH,
               maxHeight: "85%",
               margin: 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      }
   }
}

class MultiSelectList implements Component {
   private options: QuestionOption[];
   private allowFreeform: boolean;
   private allowComment: boolean;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private commentToggle: ResolvedShortcut;
   private selectedIndex = 0;
   private checked = new Set<number>();
   private commentEnabled = false;
   private maxVisibleRows = 10;
   private cachedWidth?: number;
   private cachedLines?: string[];

   public onCancel?: () => void;
   public onSubmit?: (result: string[]) => void;
   public onEnterFreeform?: () => void;

   constructor(
      options: QuestionOption[],
      allowFreeform: boolean,
      allowComment: boolean,
      theme: Theme,
      keybindings: KeybindingsManager,
      commentToggle: ResolvedShortcut,
   ) {
      this.options = options;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.theme = theme;
      this.keybindings = keybindings;
      this.commentToggle = commentToggle;
   }

   public isCommentEnabled(): boolean {
      return this.commentEnabled;
   }

   setMaxVisibleRows(rows: number): void {
      const next = Math.max(1, Math.floor(rows));
      if (next !== this.maxVisibleRows) {
         this.maxVisibleRows = next;
         this.invalidate();
      }
   }

   invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
   }

   private getItemCount(): number {
      return this.options.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
   }

   private getCommentToggleIndex(): number | null {
      return this.allowComment ? this.options.length : null;
   }

   private getFreeformIndex(): number {
      return this.options.length + (this.allowComment ? 1 : 0);
   }

   private isCommentToggleRow(index: number): boolean {
      const toggleIndex = this.getCommentToggleIndex();
      return toggleIndex !== null && index === toggleIndex;
   }

   private isFreeformRow(index: number): boolean {
      return this.allowFreeform && index === this.getFreeformIndex();
   }

   private toggle(index: number): void {
      if (index < 0 || index >= this.options.length) return;
      if (this.checked.has(index)) this.checked.delete(index);
      else this.checked.add(index);
   }

   private toggleComment(): void {
      if (!this.allowComment) return;
      this.commentEnabled = !this.commentEnabled;
      this.invalidate();
   }

   handleInput(data: string): void {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onCancel?.();
         return;
      }

      const count = this.getItemCount();
      if (count === 0) {
         this.onCancel?.();
         return;
      }

      if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
         this.toggleComment();
         return;
      }

      if (matchesSelectUp(data, this.keybindings)) {
         this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
         this.invalidate();
         return;
      }

      if (matchesSelectDown(data, this.keybindings)) {
         this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
         this.invalidate();
         return;
      }

      const numMatch = data.match(/^[1-9]$/);
      if (numMatch) {
         const idx = Number.parseInt(numMatch[0], 10) - 1;
         if (idx >= 0 && idx < this.options.length) {
            this.toggle(idx);
            this.selectedIndex = Math.min(idx, count - 1);
            this.invalidate();
         }
         return;
      }

      if (matchesKey(data, Key.space)) {
         if (this.isCommentToggleRow(this.selectedIndex)) {
            this.toggleComment();
            return;
         }
         if (this.isFreeformRow(this.selectedIndex)) {
            this.onEnterFreeform?.();
            return;
         }
         this.toggle(this.selectedIndex);
         this.invalidate();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm")) {
         if (this.isCommentToggleRow(this.selectedIndex)) {
            this.toggleComment();
            return;
         }
         if (this.isFreeformRow(this.selectedIndex)) {
            this.onEnterFreeform?.();
            return;
         }

         const selectedTitles = Array.from(this.checked)
            .sort((a, b) => a - b)
            .map((i) => this.options[i]?.title)
            .filter((t): t is string => !!t);

         const fallback = this.options[this.selectedIndex]?.title;
         const result = selectedTitles.length > 0 ? selectedTitles : fallback ? [fallback] : [];

         if (result.length > 0) this.onSubmit?.(result);
         else this.onCancel?.();
      }
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
         return this.cachedLines;
      }

      const theme = this.theme;
      const count = this.getItemCount();

      if (count === 0) {
         this.cachedLines = [theme.fg("warning", "No options")];
         this.cachedWidth = width;
         return this.cachedLines;
      }

      const blocks: string[][] = [];

      for (let i = 0; i < count; i++) {
         const isSelected = i === this.selectedIndex;
         const prefix = isSelected ? theme.fg("accent", "→") : " ";
         const block: string[] = [];

         if (this.isCommentToggleRow(i)) {
            const checkbox = this.commentEnabled ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
            const label = isSelected
               ? theme.fg("accent", theme.bold(COMMENT_TOGGLE_LABEL))
               : theme.fg("text", theme.bold(COMMENT_TOGGLE_LABEL));
            block.push(truncateToWidth(`${prefix}   ${checkbox} ${label}`, width, ""));
            blocks.push(block);
            continue;
         }

         if (this.isFreeformRow(i)) {
            const label = theme.fg("text", theme.bold("Type something."));
            const desc = theme.fg("muted", "Enter a custom response");
            const line = `${prefix}   ${label} ${theme.fg("dim", "—")} ${desc}`;
            block.push(truncateToWidth(line, width, ""));
            blocks.push(block);
            continue;
         }

         const option = this.options[i]!;

         const checkbox = this.checked.has(i) ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
         const num = theme.fg("dim", `${i + 1}.`);
         const title = isSelected
            ? theme.fg("accent", theme.bold(option.title))
            : theme.fg("text", theme.bold(option.title));

         const firstLine = `${prefix} ${num} ${checkbox} ${title}`;
         block.push(truncateToWidth(firstLine, width, ""));

         if (option.description) {
            const indent = "      ";
            const wrapWidth = Math.max(10, width - indent.length);
            const wrapped = wrapTextWithAnsi(option.description, wrapWidth);
            for (const w of wrapped) {
               block.push(truncateToWidth(indent + theme.fg("muted", w), width, ""));
            }
         }

         blocks.push(block);
      }

      const maxRows = this.maxVisibleRows;
      const totalRows = blocks.reduce((sum, block) => sum + block.length, 0);
      let lines: string[];

      if (totalRows <= maxRows) {
         lines = blocks.flat();
      } else {
         const availableRows = maxRows > 1 ? maxRows - 1 : 1;
         const selectedBlock = blocks[this.selectedIndex] ?? blocks[0] ?? [];

         if (selectedBlock.length >= availableRows) {
            lines = selectedBlock.slice(0, availableRows);
         } else {
            let startIndex = this.selectedIndex;
            let endIndex = this.selectedIndex + 1;
            let usedRows = selectedBlock.length;

            while (true) {
               const nextBlock = blocks[endIndex];
               if (nextBlock && usedRows + nextBlock.length <= availableRows) {
                  usedRows += nextBlock.length;
                  endIndex += 1;
                  continue;
               }

               const previousBlock = blocks[startIndex - 1];
               if (previousBlock && usedRows + previousBlock.length <= availableRows) {
                  startIndex -= 1;
                  usedRows += previousBlock.length;
                  continue;
               }

               break;
            }

            lines = blocks.slice(startIndex, endIndex).flat();
         }

         if (maxRows > 1) {
            lines.push(theme.fg("dim", truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, "")));
         }
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }
}

class WrappedSingleSelectList implements Component {
   private options: QuestionOption[];
   private allowFreeform: boolean;
   private allowComment: boolean;
   private theme: Theme;
   private singleSelectLayout: AskSingleSelectLayout;
   private keybindings: KeybindingsManager;
   private commentToggle: ResolvedShortcut;
   private selectedIndex = 0;
   private searchQuery = "";
   private commentEnabled = false;
   private maxVisibleRows = 12;
   private cachedWidth?: number;
   private cachedLines?: string[];

   public onCancel?: () => void;
   public onSubmit?: (result: string) => void;
   public onEnterFreeform?: () => void;

   constructor(
      options: QuestionOption[],
      allowFreeform: boolean,
      allowComment: boolean,
      theme: Theme,
      singleSelectLayout: AskSingleSelectLayout,
      keybindings: KeybindingsManager,
      commentToggle: ResolvedShortcut,
   ) {
      this.options = options;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.theme = theme;
      this.singleSelectLayout = singleSelectLayout;
      this.keybindings = keybindings;
      this.commentToggle = commentToggle;
   }

   public isCommentEnabled(): boolean {
      return this.commentEnabled;
   }

   setMaxVisibleRows(rows: number): void {
      const next = Math.max(1, Math.floor(rows));
      if (next !== this.maxVisibleRows) {
         this.maxVisibleRows = next;
         this.invalidate();
      }
   }

   invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
   }

   private getFilteredOptions(): QuestionOption[] {
      return fuzzyFilter(this.options, this.searchQuery, (option) => `${option.title} ${option.description ?? ""}`);
   }

   private getItemCount(filteredOptions: QuestionOption[]): number {
      return filteredOptions.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
   }

   private isCommentToggleRow(index: number, filteredOptions: QuestionOption[]): boolean {
      return this.allowComment && index === filteredOptions.length;
   }

   private isFreeformRow(index: number, filteredOptions: QuestionOption[]): boolean {
      return this.allowFreeform && index === filteredOptions.length + (this.allowComment ? 1 : 0);
   }

   private toggleComment(): void {
      if (!this.allowComment) return;
      this.commentEnabled = !this.commentEnabled;
      this.invalidate();
   }

   private setSearchQuery(query: string): void {
      this.searchQuery = query;
      this.selectedIndex = 0;
      this.invalidate();
   }

   private popSearchCharacter(): void {
      if (!this.searchQuery) return;
      const characters = [...this.searchQuery];
      characters.pop();
      this.setSearchQuery(characters.join(""));
   }

   private getPrintableInput(data: string): string | null {
      const kittyPrintable = decodeKittyPrintable(data);
      if (kittyPrintable !== undefined) return kittyPrintable;

      const characters = [...data];
      if (characters.length !== 1) return null;

      const [character] = characters;
      if (!character) return null;

      const code = character.charCodeAt(0);
      if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
         return null;
      }

      return character;
   }

   private styleListLine(line: string, width: number, isSelected: boolean): string {
      const trimmed = line.trim();

      if (trimmed.startsWith("(")) {
         return truncateToWidth(this.theme.fg("dim", line), width, "");
      }

      if (isSelected) {
         return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
      }

      if (line.startsWith("      ")) {
         return truncateToWidth(this.theme.fg("muted", line), width, "");
      }

      if (line.startsWith("→")) {
         return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
      }

      return truncateToWidth(this.theme.fg("text", line), width, "");
   }

   private getSplitPaneWidths(width: number): { left: number; right: number } | null {
      if (this.singleSelectLayout === "list") return null;
      if (width < SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH) return null;

      const availableWidth = width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length;
      if (availableWidth < SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH + SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) {
         return null;
      }

      const preferredLeftWidth = Math.floor(availableWidth * 0.42);
      const left = Math.max(
         SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH,
         Math.min(preferredLeftWidth, availableWidth - SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH),
      );
      const right = availableWidth - left;

      if (right < SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
      return { left, right };
   }

   private buildListLines(width: number, filteredOptions: QuestionOption[], hideDescriptions = false): string[] {
      const lines: string[] = [];
      const count = this.getItemCount(filteredOptions);
      const searchValue = this.searchQuery ? this.theme.fg("text", this.searchQuery) : this.theme.fg("dim", "type to filter");
      lines.push(truncateToWidth(`${this.theme.fg("accent", "Filter:")} ${searchValue}`, width, ""));

      if (this.searchQuery && filteredOptions.length === 0) {
         lines.push(truncateToWidth(this.theme.fg("warning", "No matching options"), width, ""));
      }

      if (count === 0) {
         if (!this.searchQuery) {
            lines.push(truncateToWidth(this.theme.fg("warning", "No options"), width, ""));
         }
         return lines.slice(0, this.maxVisibleRows);
      }

      const maxRows = Math.max(1, this.maxVisibleRows - lines.length);
      const optionRows = renderSingleSelectRows({
         options: filteredOptions,
         selectedIndex: this.selectedIndex,
         width,
         allowFreeform: this.allowFreeform,
         allowComment: this.allowComment,
         commentEnabled: this.commentEnabled,
         maxRows,
         hideDescriptions,
      });
      const optionLines = optionRows.map((row) => this.styleListLine(row.line, width, row.selected));

      lines.push(...optionLines);
      return lines.slice(0, this.maxVisibleRows);
   }

   private buildPreviewLines(width: number, filteredOptions: QuestionOption[], maxLines: number): string[] {
      if (maxLines <= 0) return [];

      const mdTheme = safeMarkdownTheme();

      let md = "";

      if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
         md += "## Additional context\n\n";
         md += `Currently: **${this.commentEnabled ? "Enabled" : "Disabled"}**\n\n`;
         md += "Turn this on when the selected option needs extra explanation before the tool submits.\n";
      } else if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
         md += "## Custom response\n\n";
         md += "Open the editor to write **any** answer.\n\n";
         md += "*Use this when none of the listed options fit.*\n";
         if (this.searchQuery) {
            md += `\n> Current filter: \`${this.searchQuery}\`\n`;
         }
      } else {
         const selected = filteredOptions[this.selectedIndex];
         if (!selected) {
            md += "*No option selected*\n";
         } else {
            md += `## ${selected.title}\n\n`;
            if (selected.description?.trim()) {
               md += `${selected.description}\n`;
            } else {
               md += "*No additional details provided for this option.*\n";
            }
            md += `\n---\n\nPress \`Enter\` to select this option.\n`;
            if (this.searchQuery) {
               md += `\n> Filter: \`${this.searchQuery}\`\n`;
            }
         }
      }

      let lines: string[];
      if (mdTheme) {
         const mdComponent = new Markdown(md.trim(), 0, 0, mdTheme);
         lines = mdComponent.render(width);
      } else {
         lines = [];
         for (const line of wrapTextWithAnsi(md.trim(), Math.max(10, width))) {
            lines.push(truncateToWidth(line, width, ""));
         }
      }

      while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
         lines.pop();
      }

      if (lines.length <= maxLines) return lines;
      if (maxLines === 1) return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];

      const visibleLines = lines.slice(0, maxLines - 1);
      visibleLines.push(truncateToWidth(this.theme.fg("dim", "…"), width, ""));
      return visibleLines;
   }

   handleInput(data: string): void {
      if (this.searchQuery && matchesKey(data, Key.escape)) {
         this.setSearchQuery("");
         return;
      }

      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onCancel?.();
         return;
      }

      if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
         this.toggleComment();
         return;
      }

      const filteredOptions = this.getFilteredOptions();
      const count = this.getItemCount(filteredOptions);

      if (matchesSelectUp(data, this.keybindings) && count > 0) {
         this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
         this.invalidate();
         return;
      }

      if (matchesSelectDown(data, this.keybindings) && count > 0) {
         this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
         this.invalidate();
         return;
      }

      const numMatch = data.match(/^[1-9]$/);
      if (numMatch && filteredOptions.length > 0) {
         const idx = Number.parseInt(numMatch[0], 10) - 1;
         if (idx >= 0 && idx < filteredOptions.length) {
            this.selectedIndex = idx;
            this.invalidate();
            return;
         }
      }

      if (matchesKey(data, Key.space) && count > 0 && this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
         this.toggleComment();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
         if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
            this.toggleComment();
            return;
         }
         if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
            this.onEnterFreeform?.();
            return;
         }

         const result = filteredOptions[this.selectedIndex]?.title;
         if (result) this.onSubmit?.(result);
         else this.onCancel?.();
         return;
      }

      if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace)) {
         this.popSearchCharacter();
         return;
      }

      const printableInput = this.getPrintableInput(data);
      if (printableInput) {
         this.setSearchQuery(this.searchQuery + printableInput);
      }
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
         return this.cachedLines;
      }

      const filteredOptions = this.getFilteredOptions();
      const count = this.getItemCount(filteredOptions);
      this.selectedIndex = count > 0 ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;

      const splitPane = this.getSplitPaneWidths(width);
      let lines: string[];

      if (!splitPane) {
         lines = this.buildListLines(width, filteredOptions);
      } else {
         const listLines = this.buildListLines(splitPane.left, filteredOptions, true);
         const previewLines = this.buildPreviewLines(splitPane.right, filteredOptions, this.maxVisibleRows);
         const rowCount = Math.min(this.maxVisibleRows, Math.max(listLines.length, previewLines.length));
         const separator = this.theme.fg("dim", SINGLE_SELECT_SPLIT_PANE_SEPARATOR);
         lines = Array.from({ length: rowCount }, (_, index) => {
            const left = truncateToWidth(listLines[index] ?? "", splitPane.left, "", true);
            const right = truncateToWidth(previewLines[index] ?? "", splitPane.right, "");
            return `${left}${separator}${right}`;
         });
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }
}

/**
 * Interactive ask UI. Uses a root Container for layout and swaps the center
 * component between SelectList/MultiSelectList and an Editor (freeform mode).
 */
class AskComponent extends Container {
   private question: string;
   private context?: string;
   private options: QuestionOption[];
   private allowMultiple: boolean;
   private allowFreeform: boolean;
   private allowComment: boolean;
   private displayMode: AskDisplayMode;
   private singleSelectLayout: AskSingleSelectLayout;
   private preferExpandedContext: boolean;
   private tui: TUI;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private shortcuts: ResolvedAskShortcuts;
   private onDone: (result: AskUIResult | null) => void;

   private mode: AskMode = "select";
   private pendingSelections: string[] = [];
   private freeformDraft = "";
   private commentDraft = "";
   private promptScrollOffset = 0;
   private promptMaxScrollOffset = 0;
   private promptViewportRows = 0;
   private contextIsCollapsible = false;
   private contextExpanded = false;
   // A batch page shows its position in the frame title and a navigation hint.
   private frameTitle = "ask_user";
   private navigationHint: string | null = null;

   // Static layout components
   private titleText: Text;
   private questionText: Text;
   private contextComponent?: Component;
   private modeContainer: Container;
   private helpText: Text;

   // Mode components
   private singleSelectList?: WrappedSingleSelectList;
   private multiSelectList?: MultiSelectList;
   private editor?: Editor;

   // Focusable - propagate to Editor for IME cursor positioning
   private _focused = false;
   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      if (this.editor && (this.mode === "freeform" || this.mode === "comment")) {
         (this.editor as any).focused = value;
      }
   }

   constructor(
      question: string,
      context: string | undefined,
      options: QuestionOption[],
      allowMultiple: boolean,
      allowFreeform: boolean,
      allowComment: boolean,
      displayMode: AskDisplayMode,
      singleSelectLayout: AskSingleSelectLayout,
      contextExpanded: boolean,
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      shortcuts: ResolvedAskShortcuts,
      onDone: (result: AskUIResult | null) => void,
   ) {
      super();

      this.question = question;
      this.context = context;
      this.options = options;
      this.allowMultiple = allowMultiple;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.displayMode = displayMode;
      this.singleSelectLayout = singleSelectLayout;
      this.preferExpandedContext = contextExpanded;
      this.tui = tui;
      this.theme = theme;
      this.keybindings = keybindings;
      this.shortcuts = shortcuts;
      this.onDone = onDone;

      // Layout skeleton
      this.addChild(new BoxBorderTop(
         (s: string) => theme.fg("accent", s),
         "ask_user",
         (s: string) => theme.fg("dim", theme.bold(s)),
      ));
      this.addChild(new Spacer(1));

      this.titleText = new Text("", 1, 0);
      this.addChild(this.titleText);
      this.addChild(new Spacer(1));

      this.questionText = new Text("", 1, 0);
      this.addChild(this.questionText);

      if (this.context) {
         this.addChild(new Spacer(1));
         const mdTheme = safeMarkdownTheme();
         if (mdTheme) {
            this.contextComponent = new Markdown("", 1, 0, mdTheme);
         } else {
            this.contextComponent = new Text("", 1, 0);
         }
         this.addChild(this.contextComponent);
      }

      this.addChild(new Spacer(1));

      this.modeContainer = new Container();
      this.addChild(this.modeContainer);

      this.addChild(new Spacer(1));
      this.helpText = new Text("", 1, 0);
      this.addChild(this.helpText);

      this.addChild(new Spacer(1));
      this.addChild(new BoxBorderBottom(
         (s: string) => theme.fg("accent", s),
         `v${ASK_USER_VERSION}`,
         (s: string) => theme.fg("dim", s),
      ));

      this.updateStaticText();
      // Batch questions without options open straight in the editor, like
      // the input dialog a single question without options uses.
      if (this.options.length === 0) {
         this.showFreeformMode();
      } else {
         this.showSelectMode();
      }
   }

   override invalidate(): void {
      super.invalidate();
      this.updateStaticText();
      this.updateHelpText();
   }

   override render(width: number): string[] {
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);

      if (this.displayMode === "overlay") {
         return this.renderOverlayLayout(width, innerWidth);
      }

      if (this.mode === "select" && !this.allowMultiple) {
         this.ensureSingleSelectList().setMaxVisibleRows(12);
      }

      return this.renderInlineLayout(width, innerWidth);
   }

   private renderInlineLayout(width: number, innerWidth: number): string[] {
      const fullContextLines = this.buildFullContextLines(innerWidth);
      this.setContextIsCollapsible(fullContextLines.length > INLINE_CONTEXT_MAX_ROWS);
      if (this.contextExpanded) {
         return this.renderOverlayLayout(width, innerWidth);
      }
      const bodyLines = [
         ...this.buildPromptLines(innerWidth, fullContextLines),
         "",
         ...this.modeContainer.render(innerWidth),
         "",
         ...this.helpText.render(innerWidth),
      ];
      return this.frameBodyLines(bodyLines, width, innerWidth);
   }

   private getOverlayMaxRenderLines(): number {
      const rows = Number.isFinite(this.tui.terminal.rows) ? Math.floor(this.tui.terminal.rows) : 24;
      return getOverlayMaxRenderLinesForRows(rows);
   }

   private renderOverlayLayout(width: number, innerWidth: number): string[] {
      const maxLines = this.getOverlayMaxRenderLines();
      if (maxLines <= 1) return [this.renderTopBorder(width)];
      if (maxLines === 2) return [this.renderTopBorder(width), this.renderBottomBorder(width)];

      const bodyCapacity = Math.max(0, maxLines - 2);
      let helpFullLines = this.helpText.render(innerWidth);
      const questionLines = this.buildQuestionLines(innerWidth);
      const fullContextLines = this.buildFullContextLines(innerWidth);
      const shouldCollapse = this.displayMode === "inline"
         ? this.contextIsCollapsible
         : this.mode === "select"
            ? this.shouldCollapseContextForOverlay(
               questionLines.length,
               fullContextLines.length,
               bodyCapacity,
               helpFullLines.length,
            )
            : this.contextIsCollapsible;
      this.setContextIsCollapsible(shouldCollapse);
      helpFullLines = this.helpText.render(innerWidth);
      const promptLines = this.buildPromptLines(innerWidth, fullContextLines);
      const helpBudget = this.getOverlayHelpBudget(bodyCapacity, helpFullLines.length);
      const contentRows = Math.max(0, bodyCapacity - helpBudget);

      let promptBudget = 0;
      let modeBudget = 0;
      let separatorRows = 0;

      if (this.mode === "select") {
         separatorRows = contentRows >= 4 ? 1 : 0;
         const promptAndModeRows = Math.max(0, contentRows - separatorRows);
         promptBudget = promptAndModeRows;

         if (promptAndModeRows > 0) {
            const promptMinRows = promptLines.length > 0 ? 1 : 0;
            const maximumModeRows = Math.max(0, promptAndModeRows - promptMinRows);
            const modeMinRows = Math.min(this.getMinimumModeRows(), maximumModeRows);
            modeBudget = Math.min(this.getPreferredModeRows(), maximumModeRows);
            modeBudget = Math.max(modeMinRows, modeBudget);
            promptBudget = promptAndModeRows - modeBudget;

            const usefulPromptTarget = this.contextIsCollapsible && !this.contextExpanded ? 3 : 2;
            const usefulPromptRows = Math.min(
               promptLines.length,
               promptAndModeRows >= modeMinRows + usefulPromptTarget ? usefulPromptTarget : promptMinRows,
            );
            if (promptBudget < usefulPromptRows && modeBudget > modeMinRows) {
               const shiftedRows = Math.min(usefulPromptRows - promptBudget, modeBudget - modeMinRows);
               modeBudget -= shiftedRows;
               promptBudget += shiftedRows;
            }
         }
      } else {
         modeBudget = Math.min(this.getPreferredModeRows(), contentRows);
         modeBudget = Math.max(Math.min(this.getMinimumModeRows(), contentRows), modeBudget);
         promptBudget = Math.max(0, contentRows - modeBudget);
         if (promptBudget > 0 && modeBudget > 0) {
            separatorRows = 1;
            promptBudget = Math.max(0, promptBudget - separatorRows);
         }
      }

      const modeLines = this.renderModeLines(innerWidth, modeBudget);
      if (modeLines.length < modeBudget) {
         promptBudget += modeBudget - modeLines.length;
      }

      const promptPaneLines = this.renderPromptPane(promptLines, promptBudget, innerWidth);
      const helpLines = this.limitLines(helpFullLines, helpBudget, innerWidth, false);
      const bodyLines = [
         ...promptPaneLines,
         ...(separatorRows > 0 && promptPaneLines.length > 0 && modeLines.length > 0 ? [""] : []),
         ...modeLines,
         ...helpLines,
      ];

      return this.frameBodyLines(bodyLines.slice(0, bodyCapacity), width, innerWidth);
   }

   private buildQuestionLines(width: number): string[] {
      return this.questionText.render(width);
   }

   private buildFullContextLines(width: number): string[] {
      if (!this.contextComponent) return [];
      return this.contextComponent.render(width);
   }

   private setContextIsCollapsible(value: boolean): void {
      if (this.contextIsCollapsible === value) return;
      this.contextIsCollapsible = value;
      // Whenever context becomes collapsible (first render, or a resize that
      // shrinks the viewport) start in the user's preferred state; ctrl+e still
      // toggles from there.
      this.contextExpanded = value && this.preferExpandedContext;
      this.updateHelpText();
   }

   private getContextToggleKey(): string {
      const reserved = new Set(
         [this.shortcuts.overlayToggle, this.shortcuts.commentToggle]
            .filter((shortcut) => !shortcut.disabled)
            .map((shortcut) => shortcut.spec),
      );
      return CONTEXT_TOGGLE_KEYS.find((key) => !reserved.has(key)) ?? CONTEXT_TOGGLE_KEYS[0]!;
   }

   private buildContextDisplayLines(fullContextLines: string[], width: number): string[] {
      if (fullContextLines.length === 0) return [];
      if (!this.contextIsCollapsible || this.contextExpanded) return fullContextLines;
      const label = `Context (${fullContextLines.length} lines) — ${this.getContextToggleKey()} expand`;
      return [truncateToWidth(this.theme.fg("dim", label), width, "")];
   }

   private buildPromptLines(width: number, fullContextLines: string[]): string[] {
      const questionLines = this.buildQuestionLines(width);
      const contextLines = this.buildContextDisplayLines(fullContextLines, width);
      const contextSeparator = this.contextIsCollapsible && !this.contextExpanded ? [] : [""];
      return [
         ...questionLines,
         ...(contextLines.length > 0 ? [...contextSeparator, ...contextLines] : []),
      ];
   }

   private shouldCollapseContextForOverlay(
      questionRows: number,
      contextRows: number,
      bodyCapacity: number,
      helpRows: number,
   ): boolean {
      if (contextRows === 0) return false;
      const helpBudget = this.getOverlayHelpBudget(bodyCapacity, helpRows);
      const contentRows = Math.max(0, bodyCapacity - helpBudget);
      const separatorRows = contentRows >= 4 ? 1 : 0;
      const promptCapacity = Math.max(
         0,
         contentRows - separatorRows - this.getMinimumModeRows(),
      );
      return questionRows + 1 + contextRows > promptCapacity;
   }

   private getOverlayHelpBudget(bodyCapacity: number, renderedHelpRows: number): number {
      if (renderedHelpRows <= 0 || bodyCapacity <= 0) return 0;
      if (bodyCapacity >= 12) return Math.min(2, renderedHelpRows);
      return 1;
   }

   private getMinimumModeRows(): number {
      if (this.mode === "freeform") return 5;
      if (this.mode === "comment") return 6;
      return 3;
   }

   private getPreferredModeRows(): number {
      if (this.mode === "freeform") return 10;
      if (this.mode === "comment") return 11;
      return 8;
   }

   private renderModeLines(width: number, budget: number): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];

      if (this.mode === "select") {
         if (this.allowMultiple) {
            this.ensureMultiSelectList().setMaxVisibleRows(Math.max(1, safeBudget));
         } else {
            this.ensureSingleSelectList().setMaxVisibleRows(Math.max(1, safeBudget));
         }
         return this.limitLines(this.modeContainer.render(width), safeBudget, width, true);
      }

      return this.renderEditorModeLines(width, safeBudget);
   }

   private renderEditorModeLines(width: number, budget: number): string[] {
      const headerLines = this.buildEditorModeHeaderLines(width);
      const minimumEditorRows = Math.min(3, budget);
      const headerBudget = Math.max(0, budget - minimumEditorRows);
      const visibleHeaderLines = this.limitLines(headerLines, headerBudget, width, true);
      const editorBudget = Math.max(0, budget - visibleHeaderLines.length);

      return [
         ...visibleHeaderLines,
         ...this.limitEditorLines(this.ensureEditor().render(width), editorBudget, width),
      ];
   }

   private buildEditorModeHeaderLines(width: number): string[] {
      if (this.mode === "comment") {
         const selectedLabel = this.pendingSelections.length === 1 ? "Selected option:" : "Selected options:";
         return [
            ...new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0).render(width),
            ...new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0).render(width),
            "",
         ];
      }

      return [
         ...new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0).render(width),
         "",
      ];
   }

   private limitEditorLines(lines: string[], budget: number, width: number): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];
      if (lines.length <= safeBudget) {
         return lines.map((line) => truncateToWidth(line, width, "", true));
      }
      if (safeBudget === 1) return [this.theme.fg("dim", "…")];

      const topBorder = truncateToWidth(lines[0] ?? "", width, "", true);
      const bottomBorder = truncateToWidth(lines[lines.length - 1] ?? "", width, "", true);
      if (safeBudget === 2) return [topBorder, bottomBorder];

      const contentLines = lines.slice(1, -1);
      const contentBudget = safeBudget - 2;
      // Locate the cursor row: prefer the zero-width CURSOR_MARKER the editor
      // emits while focused (the same mechanism pi-tui core uses for hardware
      // cursor placement), falling back to the inverse-video fake cursor.
      const cursorLineIndex = contentLines.findIndex(
         (line) => line.includes(CURSOR_MARKER) || line.includes("\x1b[7m"),
      );
      const maxStart = Math.max(0, contentLines.length - contentBudget);
      const start = cursorLineIndex >= 0
         ? Math.max(0, Math.min(cursorLineIndex - contentBudget + 1, maxStart))
         : maxStart;
      const visibleContentLines = contentLines.slice(start, start + contentBudget);
      const markedContentLines = this.applyPromptOverflowMarkers(
         visibleContentLines,
         width,
         start > 0,
         start + contentBudget < contentLines.length,
      );

      return [topBorder, ...markedContentLines, bottomBorder];
   }

   private renderPromptPane(promptLines: string[], budget: number, width: number): string[] {
      const viewportRows = Math.max(0, Math.floor(budget));
      this.promptViewportRows = viewportRows;

      if (viewportRows <= 0 || promptLines.length === 0) {
         this.promptMaxScrollOffset = 0;
         this.promptScrollOffset = 0;
         return [];
      }

      this.promptMaxScrollOffset = Math.max(0, promptLines.length - viewportRows);
      this.promptScrollOffset = Math.max(0, Math.min(this.promptScrollOffset, this.promptMaxScrollOffset));

      const visibleLines = promptLines.slice(this.promptScrollOffset, this.promptScrollOffset + viewportRows);
      const hasHiddenAbove = this.promptScrollOffset > 0;
      const hasHiddenBelow = this.promptScrollOffset + viewportRows < promptLines.length;
      return this.applyPromptOverflowMarkers(visibleLines, width, hasHiddenAbove, hasHiddenBelow);
   }

   private applyPromptOverflowMarkers(
      lines: string[],
      width: number,
      hasHiddenAbove: boolean,
      hasHiddenBelow: boolean,
   ): string[] {
      if (lines.length === 0) return lines;

      const marked = [...lines];
      if (hasHiddenAbove && hasHiddenBelow && marked.length === 1) {
         marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↕", width);
         return marked;
      }

      if (hasHiddenAbove) {
         marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↑", width);
      }
      if (hasHiddenBelow) {
         const lastIndex = marked.length - 1;
         marked[lastIndex] = this.addPromptOverflowMarker(marked[lastIndex] ?? "", "↓", width);
      }
      return marked;
   }

   private addPromptOverflowMarker(line: string, marker: string, width: number): string {
      return truncateToWidth(`${this.theme.fg("dim", marker)} ${line}`, width, "", true);
   }

   private limitLines(lines: string[], budget: number, width: number, showOverflowMarker: boolean): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];
      if (lines.length <= safeBudget) {
         return lines.map((line) => truncateToWidth(line, width, "", true));
      }
      if (!showOverflowMarker) {
         return lines.slice(0, safeBudget).map((line) => truncateToWidth(line, width, "", true));
      }
      if (safeBudget === 1) return [this.theme.fg("dim", "…")];
      return [
         ...lines.slice(0, safeBudget - 1).map((line) => truncateToWidth(line, width, "", true)),
         this.theme.fg("dim", "…"),
      ];
   }

   private renderTopBorder(width: number): string {
      return new BoxBorderTop(
         (s: string) => this.theme.fg("accent", s),
         this.frameTitle,
         (s: string) => this.theme.fg("dim", this.theme.bold(s)),
      ).render(width)[0] ?? "";
   }

   private renderBottomBorder(width: number): string {
      return new BoxBorderBottom(
         (s: string) => this.theme.fg("accent", s),
         `v${ASK_USER_VERSION}`,
         (s: string) => this.theme.fg("dim", s),
      ).render(width)[0] ?? "";
   }

   private frameBodyLines(bodyLines: string[], width: number, innerWidth: number): string[] {
      const borderColor = (s: string) => this.theme.fg("accent", s);
      return [
         this.renderTopBorder(width),
         ...bodyLines.map((line) => {
            const padded = truncateToWidth(line, innerWidth, "", true);
            return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
         }),
         this.renderBottomBorder(width),
      ];
   }

   private frameRawLines(rawLines: string[], width: number, innerWidth: number): string[] {
      const borderColor = (s: string) => this.theme.fg("accent", s);
      return rawLines.map((line, index) => {
         if (index === 0) return this.renderTopBorder(width);
         if (index === rawLines.length - 1) return this.renderBottomBorder(width);
         const padded = truncateToWidth(line, innerWidth, "", true);
         return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
      });
   }

   private updateStaticText(): void {
      const theme = this.theme;
      const title = this.mode === "comment" ? "Optional comment" : "Question";
      this.titleText.setText(theme.fg("accent", theme.bold(title)));
      this.questionText.setText(theme.fg("text", theme.bold(this.question)));
      if (this.contextComponent && this.context) {
         if (this.contextComponent instanceof Markdown) {
            (this.contextComponent as Markdown).setText(
               `**Context:**\n${this.context}`,
            );
         } else {
            (this.contextComponent as Text).setText(
               `${theme.fg("accent", theme.bold("Context:"))}\n${theme.fg("dim", this.context)}`,
            );
         }
      }
   }

   private updateHelpText(): void {
      const theme = this.theme;
      const overlayHint = this.displayMode === "overlay" && !this.shortcuts.overlayToggle.disabled
         ? literalHint(theme, this.shortcuts.overlayToggle.spec, "hide")
         : null;
      const promptScrollHint = this.displayMode === "overlay" || this.contextExpanded
         ? literalHint(theme, "PgUp/PgDn", "prompt")
         : null;
      const commentHint = this.allowComment && !this.shortcuts.commentToggle.disabled
         ? literalHint(theme, this.shortcuts.commentToggle.spec, "toggle context")
         : null;
      const contextHint = this.contextIsCollapsible
         ? literalHint(
            theme,
            this.getContextToggleKey(),
            this.contextExpanded ? "collapse context" : "expand context",
         )
         : null;
      if (this.mode === "freeform" || this.mode === "comment") {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const hints = [
            this.navigationHint,
            keybindingHint(theme, this.keybindings, "tui.input.submit", this.mode === "comment" ? "submit/skip" : "submit"),
            keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
            literalHint(theme, "esc", this.options.length === 0 ? "cancel" : "back"),
            overlayHint,
            alternateCancelKeys.length > 0 ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel") : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
         return;
      }

      if (this.allowMultiple) {
         const hints = [
            this.navigationHint,
            literalHint(theme, "↑↓", "navigate"),
            literalHint(theme, "space", "toggle"),
            commentHint,
            contextHint,
            promptScrollHint,
            overlayHint,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "submit"),
            keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      } else {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const hints = [
            this.navigationHint,
            literalHint(theme, "type", "filter"),
            commentHint,
            contextHint,
            promptScrollHint,
            keybindingHint(theme, this.keybindings, "tui.editor.deleteCharBackward", "erase"),
            literalHint(theme, "↑↓", "navigate"),
            overlayHint,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
            literalHint(theme, "esc", "clear/cancel"),
            alternateCancelKeys.length > 0
               ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
               : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      }
   }

   /** Batch pages: show the question strip in the frame title and the page-navigation hint. */
   setBatchChrome(frameTitle: string, navigationHint: string): void {
      this.frameTitle = frameTitle;
      this.navigationHint = navigationHint;
      this.updateHelpText();
   }

   private ensureSingleSelectList(): WrappedSingleSelectList {
      if (this.singleSelectList) return this.singleSelectList;

      const list = new WrappedSingleSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.singleSelectLayout,
         this.keybindings,
         this.shortcuts.commentToggle,
      );
      list.onSubmit = (result) => this.handleSelectionSubmit([result], list.isCommentEnabled());
      list.onCancel = () => this.onDone(null);
      list.onEnterFreeform = () => this.showFreeformMode();

      this.singleSelectList = list;
      return list;
   }

   private ensureMultiSelectList(): MultiSelectList {
      if (this.multiSelectList) return this.multiSelectList;

      const list = new MultiSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.keybindings,
         this.shortcuts.commentToggle,
      );
      list.onCancel = () => this.onDone(null);
      list.onSubmit = (result) => this.handleSelectionSubmit(result, list.isCommentEnabled());
      list.onEnterFreeform = () => this.showFreeformMode();

      this.multiSelectList = list;
      return list;
   }

   private ensureEditor(): Editor {
      if (this.editor) return this.editor;
      const editor = new Editor(this.tui, createEditorTheme(this.theme));
      editor.disableSubmit = false;
      editor.onSubmit = (text: string) => {
         this.handleEditorSubmit(text);
      };
      this.editor = editor;
      return editor;
   }

   private saveEditorDraft(): void {
      if (!this.editor) return;
      const getText = (this.editor as any).getText;
      if (typeof getText !== "function") return;

      const currentText = String(getText.call(this.editor) ?? "");
      if (this.mode === "freeform") {
         this.freeformDraft = currentText;
      } else if (this.mode === "comment") {
         this.commentDraft = currentText;
      }
   }

   private setEditorText(text: string): void {
      const editor = this.ensureEditor();
      const setText = (editor as any).setText;
      if (typeof setText === "function") {
         setText.call(editor, text);
      }
   }

   private handleSelectionSubmit(selections: string[], wantsComment: boolean): void {
      if (this.allowComment && wantsComment) {
         this.pendingSelections = selections;
         this.commentDraft = "";
         this.showCommentMode();
         return;
      }

      this.onDone(createSelectionResponse(selections));
   }

   private handleEditorSubmit(text: string): void {
      if (this.mode === "freeform") {
         this.onDone(createFreeformResponse(text));
         return;
      }

      if (this.mode === "comment") {
         this.commentDraft = text;
         this.onDone(createSelectionResponse(this.pendingSelections, text));
      }
   }

   private showSelectMode(): void {
      if (this.mode === "freeform" || this.mode === "comment") {
         this.saveEditorDraft();
      }

      this.mode = "select";
      this.pendingSelections = [];
      this.modeContainer.clear();

      if (this.allowMultiple) {
         this.modeContainer.addChild(this.ensureMultiSelectList());
      } else {
         this.modeContainer.addChild(this.ensureSingleSelectList());
      }

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private showFreeformMode(): void {
      if (this.mode === "comment") {
         this.saveEditorDraft();
      }

      this.mode = "freeform";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.freeformDraft);
      (editor as any).focused = this._focused;

      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private showCommentMode(): void {
      if (this.mode === "freeform") {
         this.saveEditorDraft();
      }

      this.mode = "comment";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.commentDraft);
      (editor as any).focused = this._focused;

      const selectedLabel = this.pendingSelections.length === 1 ? "Selected option:" : "Selected options:";
      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0));
      this.modeContainer.addChild(new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private toggleContext(): boolean {
      if (this.mode !== "select" || !this.contextIsCollapsible) return false;
      this.contextExpanded = !this.contextExpanded;
      this.promptScrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return true;
   }

   private setPromptScrollOffset(nextOffset: number): boolean {
      if (this.displayMode !== "overlay" && !this.contextExpanded) return false;
      if (this.promptMaxScrollOffset <= 0) return false;
      const clamped = Math.max(0, Math.min(Math.floor(nextOffset), this.promptMaxScrollOffset));
      const changed = clamped !== this.promptScrollOffset;
      this.promptScrollOffset = clamped;
      return changed;
   }

   private handlePromptScrollInput(data: string): boolean {
      if (this.displayMode !== "overlay" && !this.contextExpanded) return false;
      if (this.promptMaxScrollOffset <= 0) return false;
      // Prompt scrolling is select-mode only: in freeform/comment modes the
      // editor owns PageUp/PageDown (tui.editor.pageUp/pageDown) for paging
      // through long input, so intercepting them here would steal editor keys.
      if (this.mode !== "select") return false;

      const pageRows = Math.max(1, this.promptViewportRows - 1);
      const halfPageRows = Math.max(1, Math.floor(this.promptViewportRows / 2));
      let handled = false;

      if (matchesKey(data, PROMPT_SCROLL_PAGE_UP_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset - pageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_PAGE_DOWN_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset + pageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_HOME_KEY)) {
         handled = true;
         this.setPromptScrollOffset(0);
      } else if (matchesKey(data, PROMPT_SCROLL_END_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptMaxScrollOffset);
      } else if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_UP_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset - halfPageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_DOWN_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset + halfPageRows);
      }

      return handled;
   }

   handleInput(data: string): void {
      if (matchesKey(data, this.getContextToggleKey() as any) && this.toggleContext()) {
         return;
      }
      if (this.handlePromptScrollInput(data)) {
         this.tui.requestRender();
         return;
      }
      if (this.mode === "freeform" || this.mode === "comment") {
         if (matchesKey(data, Key.escape)) {
            // Without options there is no list to go back to, so esc cancels.
            if (this.options.length === 0) {
               this.onDone(null);
               return;
            }
            this.showSelectMode();
            return;
         }

         if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.onDone(null);
            return;
         }

         this.ensureEditor().handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.allowMultiple) {
         this.ensureMultiSelectList().handleInput?.(data);
         this.tui.requestRender();
         return;
      }

      this.ensureSingleSelectList().handleInput?.(data);
      this.tui.requestRender();
   }
}

/** Frame body lines in the ask_user box with the given title. */
function frameBox(theme: Theme, title: string, bodyLines: string[], width: number): string[] {
   const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
   const borderColor = (s: string) => theme.fg("accent", s);
   return [
      new BoxBorderTop(borderColor, title, (s: string) => theme.fg("dim", theme.bold(s))).render(width)[0] ?? "",
      ...bodyLines.map((line) => `${borderColor(BOX_BORDER_LEFT)}${truncateToWidth(line, innerWidth, "", true)}${borderColor(BOX_BORDER_RIGHT)}`),
      new BoxBorderBottom(borderColor, `v${ASK_USER_VERSION}`, (s: string) => theme.fg("dim", s)).render(width)[0] ?? "",
   ];
}

/**
 * One prompt for a whole `questions` batch: a page per question plus a review
 * page. Each page is an AskComponent that stays alive, so filters, drafts, and
 * checkboxes survive moving between pages. Answers are recorded per page and
 * only the review page submits; esc that would cancel a page cancels the batch.
 */
class BatchAskComponent implements Component {
   private pages: AskComponent[];
   private answers: Array<AskResponse | undefined>;
   private current = 0;
   private title = "";
   private confirmingSkips = false;
   private reviewScrollOffset = 0;
   private reviewMaxScrollOffset = 0;
   private _focused = false;

   constructor(
      private questions: BatchQuestion[],
      private settings: PromptSettings,
      private tui: TUI,
      private theme: Theme,
      private keybindings: KeybindingsManager,
      private onDone: (answers: BatchAnswer[] | null) => void,
   ) {
      this.answers = questions.map(() => undefined);
      this.pages = questions.map((entry, index) => new AskComponent(
         entry.question,
         entry.context,
         entry.options,
         entry.allowMultiple,
         entry.allowFreeform,
         settings.allowComment,
         settings.displayMode,
         settings.singleSelectLayout,
         settings.contextExpanded,
         tui,
         theme,
         keybindings,
         settings.shortcuts,
         (result) => this.handlePageDone(index, result),
      ));
      this.updateChrome();
   }

   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      const page = this.pages[this.current];
      if (page) page.focused = value;
   }

   invalidate(): void {
      for (const page of this.pages) page.invalidate();
   }

   render(width: number): string[] {
      const page = this.pages[this.current];
      return page ? page.render(width) : this.renderReview(width);
   }

   handleInput(data: string): void {
      const pageCount = this.questions.length + 1;
      // Tab and shift+tab move between pages here; inside a page, arrows and
      // ctrl+j/k still move the option selection.
      if (matchesKey(data, Key.tab)) {
         this.goTo((this.current + 1) % pageCount);
         return;
      }
      if (matchesKey(data, Key.shift("tab"))) {
         this.goTo((this.current + pageCount - 1) % pageCount);
         return;
      }
      const page = this.pages[this.current];
      if (page) {
         page.handleInput(data);
         return;
      }
      this.handleReviewInput(data);
   }

   private handlePageDone(index: number, result: AskUIResult | null): void {
      if (result === null) {
         this.onDone(null);
         return;
      }
      this.answers[index] = result;
      const count = this.questions.length;
      for (let step = 1; step <= count; step++) {
         const next = (index + step) % count;
         if (!this.answers[next]) {
            this.goTo(next);
            return;
         }
      }
      this.goTo(count);
   }

   private goTo(target: number): void {
      const previous = this.pages[this.current];
      if (previous) previous.focused = false;
      this.current = target;
      this.confirmingSkips = false;
      this.reviewScrollOffset = 0;
      const next = this.pages[target];
      if (next) next.focused = this._focused;
      this.updateChrome();
      this.tui.requestRender();
   }

   private updateChrome(): void {
      const labels = this.questions.map((_, index) => {
         const label = `${index + 1}${this.answers[index] ? "✓" : ""}`;
         return index === this.current ? `[${label}]` : label;
      });
      const review = this.current === this.questions.length ? "[review]" : "review";
      this.title = `ask_user ${labels.join(" ")} · ${review}`;
      const hint = literalHint(this.theme, "tab/shift+tab", "questions");
      for (const page of this.pages) page.setBatchChrome(this.title, hint);
   }

   private unansweredCount(): number {
      return this.answers.filter((answer) => !answer).length;
   }

   private handleReviewInput(data: string): void {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onDone(null);
         return;
      }
      if (this.keybindings.matches(data, "tui.select.confirm")) {
         if (this.unansweredCount() > 0 && !this.confirmingSkips) {
            this.confirmingSkips = true;
            this.tui.requestRender();
            return;
         }
         this.onDone(this.answers.map((response): BatchAnswer =>
            response ? { status: "answered", response } : { status: "skipped" }));
         return;
      }
      const jump = Number.parseInt(data, 10);
      if (data.length === 1 && jump >= 1 && jump <= this.questions.length) {
         this.goTo(jump - 1);
         return;
      }
      const pageRows = Math.max(1, getOverlayMaxRenderLinesForRows(this.tui.terminal.rows) - 4);
      const scrollBy = matchesSelectUp(data, this.keybindings) ? -1
         : matchesSelectDown(data, this.keybindings) ? 1
            : matchesKey(data, PROMPT_SCROLL_PAGE_UP_KEY) ? -pageRows
               : matchesKey(data, PROMPT_SCROLL_PAGE_DOWN_KEY) ? pageRows
                  : 0;
      if (scrollBy !== 0) {
         this.reviewScrollOffset = Math.max(0, Math.min(this.reviewScrollOffset + scrollBy, this.reviewMaxScrollOffset));
         this.tui.requestRender();
      }
   }

   private renderReview(width: number): string[] {
      const theme = this.theme;
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
      const wrap = (text: string) => wrapTextWithAnsi(text, innerWidth);
      const contentLines = [
         ...wrap(theme.fg("accent", theme.bold("Review answers"))),
         "",
      ];
      this.questions.forEach((entry, index) => {
         const response = this.answers[index];
         const marker = response ? theme.fg("success", "✓") : theme.fg("warning", "○");
         contentLines.push(...wrap(`${marker} ${theme.fg("text", `${index + 1}. ${entry.question}`)}`));
         contentLines.push(...wrap(response
            ? `   ${theme.fg("dim", "→")} ${theme.fg("accent", formatResponseSummary(response))}`
            : `   ${theme.fg("warning", "unanswered")}`));
      });

      const unanswered = this.unansweredCount();
      const overlayToggle = this.settings.shortcuts.overlayToggle;
      const hints = [
         keybindingHint(theme, this.keybindings, "tui.select.confirm", unanswered > 0 ? "submit with skips" : "submit"),
         literalHint(theme, this.questions.length > 1 ? `1-${this.questions.length}` : "1", "edit"),
         literalHint(theme, "tab/shift+tab", "questions"),
         this.settings.displayMode === "overlay" && !overlayToggle.disabled
            ? literalHint(theme, overlayToggle.spec, "hide")
            : null,
         keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
      ].filter((hint): hint is string => !!hint).join(" • ");
      const footerLines = [
         "",
         ...(this.confirmingSkips
            ? wrap(theme.fg("warning", `${unanswered} unanswered — press ${formatKeyList(this.keybindings.getKeys("tui.select.confirm"))} again to submit with skips`))
            : []),
         ...wrap(theme.fg("dim", hints)),
      ];

      // Inline prompts grow with their content; overlays are capped, so the
      // answers scroll while the footer stays visible.
      let visibleContent = contentLines;
      if (this.settings.displayMode === "overlay") {
         const bodyCapacity = Math.max(1, getOverlayMaxRenderLinesForRows(this.tui.terminal.rows) - 2);
         const contentBudget = Math.max(1, bodyCapacity - footerLines.length);
         this.reviewMaxScrollOffset = Math.max(0, contentLines.length - contentBudget);
         this.reviewScrollOffset = Math.min(this.reviewScrollOffset, this.reviewMaxScrollOffset);
         visibleContent = contentLines.slice(this.reviewScrollOffset, this.reviewScrollOffset + contentBudget);
         if (this.reviewScrollOffset > 0) {
            visibleContent[0] = theme.fg("dim", "↑ more");
         }
         if (this.reviewScrollOffset < this.reviewMaxScrollOffset) {
            visibleContent[visibleContent.length - 1] = theme.fg("dim", "↓ more");
         }
      } else {
         this.reviewMaxScrollOffset = 0;
      }
      return frameBox(theme, this.title, [...visibleContent, ...footerLines], width);
   }
}

type DialogOptions = { signal?: AbortSignal; timeout?: number };

/**
 * Options for the next dialog stage. A batch shares one deadline across every
 * stage, so each stage gets only the time that is left (null once it has
 * passed); a single question keeps its fixed per-dialog timeout.
 */
function dialogStageOptions(
   dialogOpts: DialogOptions | undefined,
   deadline: number | undefined,
): DialogOptions | undefined | null {
   if (deadline === undefined) return dialogOpts;
   const remaining = deadline - Date.now();
   return remaining > 0 ? { ...dialogOpts, timeout: remaining } : null;
}

/**
 * RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
 * ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
 */
async function askViaDialogs(
   ui: { select: Function; input: Function },
   question: string,
   context: string | undefined,
   options: QuestionOption[],
   allowMultiple: boolean,
   allowFreeform: boolean,
   allowComment: boolean,
   dialogOpts?: DialogOptions,
   deadline?: number,
): Promise<AskUIResult | null> {
   if (dialogOpts?.signal?.aborted) return null;
   const prompt = context ? `${question}\n\nContext:\n${context}` : question;

   if (allowMultiple) {
      const optionList = formatOptionsForMessage(options);
      const selectionOpts = dialogStageOptions(dialogOpts, deadline);
      if (selectionOpts === null) return null;
      const rawSelections = await ui.input(
         `${prompt}\n\nOptions (select one or more):\n${optionList}`,
         "Type your selection(s)...",
         selectionOpts,
      ) as string | undefined;
      if (dialogOpts?.signal?.aborted || isCancelledInput(rawSelections)) return null;

      const selections = parseDialogSelections(rawSelections);
      if (selections.length === 0) return null;

      if (!allowComment) {
         return createSelectionResponse(selections);
      }

      const commentOpts = dialogStageOptions(dialogOpts, deadline);
      if (commentOpts === null) return null;
      const comment = await ui.input(
         buildCommentPrompt(prompt, selections),
         "Optional comment (press Enter to skip)...",
         commentOpts,
      ) as string | undefined;
      if (dialogOpts?.signal?.aborted || isCancelledInput(comment)) return null;
      return createSelectionResponse(selections, comment);
   }

   const selectOptions = options.map((o) => o.title);
   if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);

   const selectOpts = dialogStageOptions(dialogOpts, deadline);
   if (selectOpts === null) return null;
   const selected = await ui.select(prompt, selectOptions, selectOpts) as string | undefined;
   if (dialogOpts?.signal?.aborted || isCancelledInput(selected)) return null;

   if (selected === FREEFORM_SENTINEL) {
      const answerOpts = dialogStageOptions(dialogOpts, deadline);
      if (answerOpts === null) return null;
      const answer = await ui.input(prompt, "Type your answer...", answerOpts) as string | undefined;
      if (dialogOpts?.signal?.aborted || isCancelledInput(answer)) return null;
      return createFreeformResponse(answer);
   }

   if (!allowComment) {
      return createSelectionResponse([selected]);
   }

   const commentOpts = dialogStageOptions(dialogOpts, deadline);
   if (commentOpts === null) return null;
   const comment = await ui.input(
      buildCommentPrompt(prompt, [selected]),
      "Optional comment (press Enter to skip)...",
      commentOpts,
   ) as string | undefined;
   if (dialogOpts?.signal?.aborted || isCancelledInput(comment)) return null;
   return createSelectionResponse([selected], comment);
}

/**
 * RPC/headless fallback for a `questions` batch: ask each question in turn
 * with the select()/input() dialogs. There is no review step here, so
 * cancelling any question cancels the whole batch, and every dialog stage
 * shares one deadline.
 */
async function askBatchViaDialogs(
   ui: { select: Function; input: Function },
   questions: BatchQuestion[],
   allowComment: boolean,
   signal: AbortSignal | undefined,
   deadline: number | undefined,
): Promise<BatchAnswer[] | null> {
   const dialogOpts = signal ? { signal } : undefined;
   const answers: BatchAnswer[] = [];
   for (const [index, entry] of questions.entries()) {
      if (signal?.aborted) return null;
      const title = `(${index + 1}/${questions.length}) ${entry.question}`;
      let response: AskResponse | null;
      if (entry.options.length === 0) {
         // Same as a single question without options: a plain text answer.
         const prompt = entry.context ? `${title}\n\nContext:\n${entry.context}` : title;
         const answerOpts = dialogStageOptions(dialogOpts, deadline);
         if (answerOpts === null) return null;
         const answer = await ui.input(prompt, "Type your answer...", answerOpts) as string | undefined;
         response = signal?.aborted ? null : createFreeformResponse(answer);
      } else {
         response = await askViaDialogs(
            ui,
            title,
            entry.context,
            entry.options,
            entry.allowMultiple,
            entry.allowFreeform,
            allowComment,
            dialogOpts,
            deadline,
         );
      }
      if (!response) return null;
      answers.push({ status: "answered", response });
   }
   return answers;
}

interface PromptSettings {
   displayMode: AskDisplayMode;
   singleSelectLayout: AskSingleSelectLayout;
   allowComment: boolean;
   contextExpanded: boolean;
   shortcuts: ResolvedAskShortcuts;
}

/** Resolve presentation preferences: call parameter, then env var, then built-in default. */
function resolvePromptSettings(params: AskParams): PromptSettings {
   const envMode = process.env.PI_ASK_USER_DISPLAY_MODE?.trim().toLowerCase();
   const envDisplayMode: AskDisplayMode | undefined =
      envMode === "overlay" || envMode === "inline" ? envMode : undefined;
   const envSingleSelectLayout = process.env.PI_ASK_USER_SINGLE_SELECT_LAYOUT?.trim().toLowerCase();
   return {
      displayMode: params.displayMode ?? envDisplayMode ?? "overlay",
      singleSelectLayout: params.singleSelectLayout ?? (envSingleSelectLayout === "list" ? "list" : "auto"),
      allowComment: params.allowComment
         ?? parseBooleanPreference(process.env.PI_ASK_USER_ALLOW_COMMENT)
         ?? false,
      contextExpanded: params.contextExpanded
         ?? parseBooleanPreference(process.env.PI_ASK_USER_CONTEXT_EXPANDED)
         ?? false,
      shortcuts: {
         overlayToggle: resolveShortcut(
            params.overlayToggleKey,
            process.env.PI_ASK_USER_OVERLAY_TOGGLE_KEY,
            DEFAULT_OVERLAY_TOGGLE_KEY,
         ),
         commentToggle: resolveShortcut(
            params.commentToggleKey,
            process.env.PI_ASK_USER_COMMENT_TOGGLE_KEY,
            DEFAULT_COMMENT_TOGGLE_KEY,
         ),
      },
   };
}

/** Report the session as blocked on the user (`herdr:blocked`) for the duration of `run`. */
async function whileBlocked<T>(pi: ExtensionAPI, run: () => Promise<T>): Promise<T> {
   pi.events.emit("herdr:blocked", { active: true, label: "Waiting for user response" });
   try {
      return await run();
   } finally {
      pi.events.emit("herdr:blocked", { active: false });
   }
}

interface CustomPromptRequest<T> {
   signal?: AbortSignal;
   timeout?: number;
   displayMode: AskDisplayMode;
   overlayToggle: ResolvedShortcut;
   createComponent: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      complete: (value: T | null) => void,
   ) => Component;
   /** RPC/headless mode: ctx.ui.custom() returns undefined, so degrade to the select()/input() dialogs. */
   fallback: () => Promise<T | null>;
}

/**
 * Show one custom-UI prompt and own every resource it needs: the abort
 * listener, the timeout timer, and the overlay-toggle terminal listener.
 * Completion is guarded so a late timer, abort, or keypress cannot resolve
 * twice, and every resource is released however the prompt ends.
 */
async function runCustomPrompt<T>(ui: ExtensionUIContext, request: CustomPromptRequest<T>): Promise<T | null> {
   const { signal, timeout, displayMode, overlayToggle } = request;
   let overlayHandle: OverlayHandle | undefined;
   let removeOverlayInputListener: (() => void) | undefined;
   let customTimer: ReturnType<typeof setTimeout> | undefined;
   let onCustomAbort: (() => void) | undefined;
   let customCompleted = false;
   let hasAnnouncedHide = false;
   try {
      const customFactory = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T | null) => void) => {
         const complete = (value: T | null) => {
            if (customCompleted) return;
            customCompleted = true;
            done(signal?.aborted ? null : value);
         };
         if (signal) {
            onCustomAbort = () => complete(null);
            signal.addEventListener("abort", onCustomAbort, { once: true });
         }

         if (signal?.aborted) {
            complete(null);
         } else if (timeout && timeout > 0) {
            customTimer = setTimeout(() => complete(null), timeout);
         }

         return request.createComponent(tui, theme, keybindings, complete);
      };

      // Register a raw terminal input listener for the overlay-toggle key so the
      // overlay can be toggled even while it is hidden (hidden overlays do not
      // receive input). Inline mode does not need this because the prompt is
      // already non-modal. Skipped entirely if the user disabled the shortcut.
      if (
         displayMode === "overlay"
         && !overlayToggle.disabled
         && typeof ui.onTerminalInput === "function"
      ) {
         removeOverlayInputListener = ui.onTerminalInput((data) => {
            if (!overlayToggle.matches(data) || !overlayHandle) return undefined;
            // Kitty's progressive keyboard protocol reports press, repeat,
            // and release as separate events. Toggle only on the initial
            // press; otherwise one physical keypress can immediately hide
            // and re-show the overlay. Still consume repeat/release events
            // so they do not reach the component focused behind it.
            if (isKeyRepeat(data) || isKeyRelease(data)) return { consume: true };
            const nextHidden = !overlayHandle.isHidden();
            overlayHandle.setHidden(nextHidden);
            if (nextHidden && !hasAnnouncedHide) {
               hasAnnouncedHide = true;
               ui.notify?.(`ask_user hidden — press ${overlayToggle.spec} to reopen`, "info");
            }
            return { consume: true };
         });
      }

      const customResult = signal?.aborted ? null : await ui.custom<T | null>(
         customFactory,
         buildCustomUIOptions(displayMode, (handle) => {
            overlayHandle = handle;
         }),
      );

      if (signal?.aborted) return null;
      if (customResult !== undefined) return customResult;
      return await request.fallback();
   } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
   } finally {
      customCompleted = true;
      if (customTimer !== undefined) clearTimeout(customTimer);
      if (onCustomAbort) signal?.removeEventListener("abort", onCustomAbort);
      removeOverlayInputListener?.();
   }
}

/**
 * Validate and normalize a `questions` batch. Every problem throws before any
 * UI opens or event fires (#67), with a message that tells the model how to
 * correct the call.
 */
function normalizeBatchQuestions(params: AskParams): BatchQuestion[] {
   const { questions } = params;
   if (typeof params.question === "string" && params.question.trim()) {
      throw new Error(
         "Use exactly one of question or questions. Put every question in questions, or ask a single question with question.",
      );
   }
   const misplaced = BATCH_ENTRY_FIELDS.filter((field) => params[field] != null);
   if (misplaced.length > 0) {
      throw new Error(
         `${misplaced.join(", ")} cannot be set at the top level together with questions. Set them on each questions entry instead.`,
      );
   }
   if (!Array.isArray(questions)) {
      throw new Error(`questions must be an array of ${BATCH_MIN_QUESTIONS}-${BATCH_MAX_QUESTIONS} question objects.`);
   }
   if (questions.length < BATCH_MIN_QUESTIONS) {
      throw new Error(
         `questions needs ${BATCH_MIN_QUESTIONS}-${BATCH_MAX_QUESTIONS} entries but got ${questions.length}. To ask one question, use question instead.`,
      );
   }
   if (questions.length > BATCH_MAX_QUESTIONS) {
      throw new Error(
         `questions accepts at most ${BATCH_MAX_QUESTIONS} entries but got ${questions.length}. Ask the rest in a later ask_user call.`,
      );
   }

   const seen = new Set<string>();
   return questions.map((entry, index) => {
      const label = `questions[${index}]`;
      const question = typeof entry?.question === "string" ? entry.question.trim() : "";
      if (!question) throw new Error(`${label}.question must be a non-empty string.`);
      const key = question.toLowerCase();
      if (seen.has(key)) {
         throw new Error(`${label} repeats the question "${question}". Each question in a batch must be distinct.`);
      }
      seen.add(key);

      const rawOptions = entry.options ?? [];
      if (!Array.isArray(rawOptions)) throw new Error(`${label}.options must be an array.`);
      const options = rawOptions.map(coerceOption).filter((option): option is QuestionOption => option !== null);
      if (rawOptions.length > 0 && options.length === 0) {
         throw new Error(
            `All ${rawOptions.length} option(s) in ${label} were malformed, so nothing could be shown to the user. `
            + `Each option must be a plain string or an object like { "title": "Short label", "description": "Optional detail" }. `
            + `Call ask_user again with corrected options.`,
         );
      }

      return {
         question,
         context: typeof entry.context === "string" ? entry.context.trim() || undefined : undefined,
         options,
         allowMultiple: entry.allowMultiple ?? false,
         allowFreeform: entry.allowFreeform ?? true,
      };
   });
}

interface AskEventSubject {
   question: string;
   context?: string;
   options: QuestionOption[];
}

/** Position of a question inside a `questions` batch, attached to its ask:* events. */
interface BatchPosition {
   index: number;
   total: number;
}

function createAskEventEmitter(pi: ExtensionAPI) {
   // Every installed extension receives these events. By default only the
   // question and the response kind are broadcast; the context and the
   // user's actual selections/comment/freeform text stay inside the tool
   // result unless the user opts in (#51).
   const emitFullEvents = parseBooleanPreference(process.env.PI_ASK_USER_EMIT_FULL_EVENTS) ?? false;
   return {
      answered(subject: AskEventSubject, response: AskResponse, batch?: BatchPosition): void {
         const position = batch ? { batch } : {};
         pi.events.emit(
            "ask:answered",
            emitFullEvents
               ? { question: subject.question, context: subject.context, response, ...position }
               : { question: subject.question, response: { kind: response.kind }, ...position },
         );
      },
      cancelled(subject: AskEventSubject, batch?: BatchPosition): void {
         const position = batch ? { batch } : {};
         pi.events.emit(
            "ask:cancelled",
            emitFullEvents
               ? { question: subject.question, context: subject.context, options: subject.options, ...position }
               : { question: subject.question, ...position },
         );
      },
   };
}

function formatBatchAnswers(details: AskBatchDetails): string {
   const lines = details.questions.map((subject, index) => {
      const answer = details.answers[index]!;
      const summary = answer.status === "answered" ? formatResponseSummary(answer.response) : "(skipped)";
      return `${index + 1}. ${subject.question} → ${summary}`;
   });
   const answered = details.answers.filter((answer) => answer.status === "answered").length;
   return [`User answered ${answered} of ${details.questions.length} questions:`, ...lines].join("\n");
}

function formatBatchForMessage(questions: BatchQuestion[], allowComment: boolean): string {
   const blocks = questions.map((entry, index) => {
      const lines = [`${index + 1}. ${entry.question}`];
      if (entry.context) lines.push(`   Context: ${entry.context.replace(/\n/g, "\n   ")}`);
      if (entry.options.length > 0) {
         lines.push(`   Options${entry.allowMultiple ? " (choose one or more)" : ""}:`);
         lines.push(...formatOptionsForMessage(entry.options).split("\n").map((line) => `   ${line}`));
         if (entry.allowFreeform) lines.push("   You can also answer freely.");
      }
      return lines.join("\n");
   });
   const commentHint = allowComment ? "\n\nAfter choosing an option, you may add an optional comment." : "";
   return `Ask requires interactive mode. Please answer these questions:\n\n${blocks.join("\n\n")}${commentHint}`;
}

async function executeBatch(
   pi: ExtensionAPI,
   params: AskParams,
   signal: AbortSignal | undefined,
   onUpdate: AgentToolUpdateCallback<AskBatchDetails> | undefined,
   ctx: ExtensionContext,
): Promise<AgentToolResult<AskBatchDetails>> {
   const questions = normalizeBatchQuestions(params);
   const settings = resolvePromptSettings(params);
   const events = createAskEventEmitter(pi);
   const subjects = questions.map(({ question, context, options }) => ({ question, context, options }));
   const details = (answers: BatchAnswer[], cancelled: boolean): AskBatchDetails => ({
      kind: "batch",
      questions: subjects,
      answers,
      cancelled,
   });

   if (!ctx.hasUI || !ctx.ui) {
      throw new Error(formatBatchForMessage(questions, settings.allowComment));
   }

   onUpdate?.({
      content: [{ type: "text", text: "Waiting for user input..." }],
      details: details([], false),
   });

   const deadline = params.timeout && params.timeout > 0 ? Date.now() + params.timeout : undefined;
   // One timer owns the batch deadline. It aborts the signal that every prompt
   // and dialog already listens to, so an open dialog closes exactly on time
   // (native dialog countdowns round up to whole seconds) and a late answer
   // cancels the batch. The caller's abort is forwarded to the same signal.
   const batch = new AbortController();
   const forwardAbort = () => batch.abort();
   signal?.addEventListener("abort", forwardAbort, { once: true });
   // An abort that already fired (for example inside onUpdate above) is not replayed.
   if (signal?.aborted) batch.abort();
   const deadlineTimer = deadline === undefined ? undefined : setTimeout(() => batch.abort(), params.timeout);
   let answers: BatchAnswer[] | null;
   try {
      answers = await whileBlocked(pi, () => runCustomPrompt<BatchAnswer[]>(ctx.ui, {
         signal: batch.signal,
         displayMode: settings.displayMode,
         overlayToggle: settings.shortcuts.overlayToggle,
         createComponent: (tui, theme, keybindings, complete) =>
            new BatchAskComponent(questions, settings, tui, theme, keybindings, complete),
         fallback: () => askBatchViaDialogs(ctx.ui, questions, settings.allowComment, batch.signal, deadline),
      }));
   } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", forwardAbort);
   }

   if (batch.signal.aborted || answers === null) {
      subjects.forEach((subject, index) => events.cancelled(subject, { index, total: subjects.length }));
      return {
         content: [{ type: "text", text: "User cancelled the questions" }],
         details: details([], true),
      };
   }

   // Skipped questions emit nothing; each answered one emits its usual event.
   answers.forEach((answer, index) => {
      if (answer.status === "answered") {
         events.answered(subjects[index]!, answer.response, { index, total: subjects.length });
      }
   });
   const result = details(answers, false);
   return {
      content: [{ type: "text", text: formatBatchAnswers(result) }],
      details: result,
   };
}

/** Expanded-result block: every option with the selected ones marked, then the comment. */
function formatOptionMarkers(
   theme: Theme,
   options: QuestionOption[],
   response: Extract<AskResponse, { kind: "selection" }>,
   indent = "",
): string {
   const selectedTitles = new Set(response.selections);
   let text = `\n${indent}` + theme.fg("dim", "Options:");
   for (const opt of options) {
      const desc = opt.description ? ` — ${opt.description}` : "";
      const marker = selectedTitles.has(opt.title) ? theme.fg("success", "●") : theme.fg("dim", "○");
      text += `\n${indent}  ${marker} ${theme.fg("dim", opt.title)}${theme.fg("dim", desc)}`;
   }
   if (response.comment) {
      text += `\n${indent}${theme.fg("dim", "Comment:")} ${theme.fg("dim", response.comment)}`;
   }
   return text;
}

function formatBatchResult(theme: Theme, details: AskBatchDetails, expanded: boolean): string {
   if (details.cancelled) return theme.fg("warning", "Cancelled");
   const answered = details.answers.filter((answer) => answer.status === "answered").length;
   let text = theme.fg("success", "✓ ")
      + theme.fg("accent", `${answered} of ${details.questions.length} answered`);
   details.questions.forEach((subject, index) => {
      const answer = details.answers[index]!;
      text += `\n${theme.fg("dim", `${index + 1}.`)} ${theme.fg("muted", subject.question)}${theme.fg("dim", " → ")}`;
      if (answer.status === "skipped") {
         text += theme.fg("warning", "(skipped)");
         return;
      }
      const response = answer.response;
      if (response.kind === "freeform") {
         text += theme.fg("muted", "(wrote) ");
      }
      text += theme.fg("accent", formatResponseSummary(response));
      if (!expanded) return;
      if (subject.context) {
         text += `\n   ${theme.fg("dim", subject.context)}`;
      }
      if (isSelectionResponse(response) && subject.options.length > 0) {
         text += formatOptionMarkers(theme, subject.options, response, "   ");
      }
   });
   return text;
}

export default function(pi: ExtensionAPI) {
   // Flat object shape: union item schemas get stripped or rejected
   // by several providers/proxies (Google function calling,
   // Codex-style backends, cmux), leaving the model to guess the shape
   // and produce empty options. Plain strings are still accepted at
   // runtime for older transcripts. See issue #22.
   const optionSchema = Type.Object({
      title: Type.String({ description: "Short title for this option" }),
      description: Type.Optional(
         Type.String({ description: "Longer description explaining this option" }),
      ),
   });

   pi.registerTool({
      name: "ask_user",
      label: "Ask User",
      description:
         "Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Ask one focused question per call, or 2-4 independent questions together through questions. Before calling, gather context with tools (read/web/ref) and pass a short summary via the context field.",
      promptSnippet:
         "Ask the user one focused question (or 2-4 independent ones together) with optional multiple-choice answers to gather information interactively",
      promptGuidelines: [
         "Before calling ask_user, gather context with tools (read/web/ref) and pass a short summary via the context field.",
         "Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
         "Ask one focused question per ask_user call by default.",
         "Use questions (2-4 entries) only for independent decisions whose prerequisites are already settled; ask anything that depends on another answer in a later ask_user call.",
         "Do not combine multiple numbered, multipart, or unrelated questions into one question's text.",
      ],
      // Block other tool calls in the same assistant turn until the user answers,
      // so the model can't batch ask_user with bash/edit/write and let those run
      // (potentially with side effects) before the user sees the prompt.
      executionMode: "sequential",
      parameters: Type.Object({
         question: Type.Optional(
            Type.String({ description: "The question to ask the user. Omit when using questions." }),
         ),
         questions: Type.Optional(
            Type.Array(
               Type.Object({
                  question: Type.String({ description: "One question in the batch" }),
                  context: Type.Optional(
                     Type.String({ description: "Relevant context to show with this question (summary of findings)" }),
                  ),
                  options: Type.Optional(
                     Type.Array(optionSchema, { description: "List of options for this question" }),
                  ),
                  allowMultiple: Type.Optional(
                     Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
                  ),
                  allowFreeform: Type.Optional(
                     Type.Boolean({ description: "Add a freeform text option. Default: true" }),
                  ),
               }),
               {
                  minItems: BATCH_MIN_QUESTIONS,
                  maxItems: BATCH_MAX_QUESTIONS,
                  description: "2-4 independent questions shown together, used instead of question. Set context, options, allowMultiple, and allowFreeform on each entry; the remaining parameters apply to the whole batch.",
               },
            ),
         ),
         context: Type.Optional(
            Type.String({
               description: "Relevant context to show before the question (summary of findings)",
            }),
         ),
         options: Type.Optional(
            Type.Array(optionSchema, { description: "List of options for the user to choose from" }),
         ),
         allowMultiple: Type.Optional(
            Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
         ),
         allowFreeform: Type.Optional(
            Type.Boolean({ description: "Add a freeform text option. Default: true" }),
         ),
         allowComment: Type.Optional(
            Type.Boolean({ description: "Collect an optional comment after selecting one or more options. Default: PI_ASK_USER_ALLOW_COMMENT env var if set, otherwise false." }),
         ),
         displayMode: Type.Optional(
            StringEnum(["overlay", "inline"] as const, {
               description: "UI rendering mode. 'overlay' shows a centered modal, 'inline' renders in-place. Default: PI_ASK_USER_DISPLAY_MODE env var if set, otherwise 'overlay'. Omit to respect the user's configured preference.",
            }),
         ),
         singleSelectLayout: Type.Optional(
            StringEnum(["auto", "list"] as const, {
               description: "Single-select layout. 'auto' uses a details pane on wide terminals; 'list' always keeps descriptions below options. Default: PI_ASK_USER_SINGLE_SELECT_LAYOUT if set, otherwise 'auto'.",
            }),
         ),
         contextExpanded: Type.Optional(
            Type.Boolean({
               description: "Start with oversized context expanded instead of collapsed behind a one-line summary. Default: PI_ASK_USER_CONTEXT_EXPANDED env var if set, otherwise false.",
            }),
         ),
         overlayToggleKey: Type.Optional(
            Type.String({
               description:
                  "Shortcut for hiding/showing the overlay popup (overlay mode only), e.g. 'alt+o' or 'ctrl+shift+h'. Pass 'off' to disable. Default: PI_ASK_USER_OVERLAY_TOGGLE_KEY env var if set, otherwise 'alt+o'.",
            }),
         ),
         commentToggleKey: Type.Optional(
            Type.String({
               description:
                  "Shortcut for toggling the optional comment/extra-context row when allowComment is true, e.g. 'ctrl+g'. Pass 'off' to disable. Default: PI_ASK_USER_COMMENT_TOGGLE_KEY env var if set, otherwise 'ctrl+g'.",
            }),
         ),
         timeout: Type.Optional(
            Type.Number({ description: "Auto-dismiss after N milliseconds. Returns null (cancelled) when expired." }),
         ),
      }),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         if ((params as AskParams).questions != null) {
            if (signal?.aborted) {
               return {
                  content: [{ type: "text", text: "Cancelled" }],
                  details: { kind: "batch", questions: [], answers: [], cancelled: true } as AskBatchDetails,
               };
            }
            return executeBatch(pi, params as AskParams, signal, onUpdate, ctx);
         }

         if (signal?.aborted) {
            return {
               content: [{ type: "text", text: "Cancelled" }],
               details: { question: params.question, options: [], response: null, cancelled: true } as AskToolDetails,
            };
         }

         if (typeof params.question !== "string") {
            throw new Error(
               "ask_user needs question (one focused question) or questions (2-4 independent questions).",
            );
         }

         const question = params.question;
         const {
            context,
            options: rawOptions = [],
            allowMultiple = false,
            allowFreeform = true,
            timeout,
         } = params as AskParams;
         const settings = resolvePromptSettings(params as AskParams);
         const { allowComment } = settings;
         const options = rawOptions.map(coerceOption).filter((option): option is QuestionOption => option !== null);
         const normalizedContext = context?.trim() || undefined;
         const dialogOpts = signal
            ? (timeout ? { signal, timeout } : { signal })
            : (timeout ? { timeout } : undefined);
         const events = createAskEventEmitter(pi);
         const subject: AskEventSubject = { question, context: normalizedContext, options };

         if (rawOptions.length > 0 && options.length === 0) {
            throw new Error(
               `All ${rawOptions.length} option(s) were malformed, so nothing could be shown to the user. `
               + `Each option must be a plain string or an object like { "title": "Short label", "description": "Optional detail" }. `
               + `Call ask_user again with corrected options.`,
            );
         }

         if (!ctx.hasUI || !ctx.ui) {
            const optionText = options.length > 0 ? `\n\nOptions:\n${formatOptionsForMessage(options)}` : "";
            const freeformHint = allowFreeform ? "\n\nYou can also answer freely." : "";
            const commentHint = allowComment ? "\n\nAfter choosing an option, you may add an optional comment." : "";
            const contextText = normalizedContext ? `\n\nContext:\n${normalizedContext}` : "";
            throw new Error(
               `Ask requires interactive mode. Please answer:\n\n${question}${contextText}${optionText}${freeformHint}${commentHint}`,
            );
         }

         if (options.length === 0) {
            const prompt = normalizedContext ? `${question}\n\nContext:\n${normalizedContext}` : question;
            const answer = await whileBlocked(pi, () => ctx.ui.input(prompt, "Type your answer...", dialogOpts));
            const response = signal?.aborted ? null : createFreeformResponse(answer);

            if (!response) {
               events.cancelled(subject);
               return {
                  content: [{ type: "text", text: "User cancelled the question" }],
                  details: { question, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails,
               };
            }

            events.answered(subject, response);
            return {
               content: [{ type: "text", text: `User answered: ${formatResponseSummary(response)}` }],
               details: { question, context: normalizedContext, options, response, cancelled: false } as AskToolDetails,
            };
         }

         onUpdate?.({
            content: [{ type: "text", text: "Waiting for user input..." }],
            details: { question, context: normalizedContext, options, response: null, cancelled: false },
         });

         const result = await whileBlocked(pi, () => runCustomPrompt<AskUIResult>(ctx.ui, {
            signal,
            timeout,
            displayMode: settings.displayMode,
            overlayToggle: settings.shortcuts.overlayToggle,
            createComponent: (tui, theme, keybindings, complete) => new AskComponent(
               question,
               normalizedContext,
               options,
               allowMultiple,
               allowFreeform,
               allowComment,
               settings.displayMode,
               settings.singleSelectLayout,
               settings.contextExpanded,
               tui,
               theme,
               keybindings,
               settings.shortcuts,
               complete,
            ),
            fallback: () => askViaDialogs(
               ctx.ui,
               question,
               normalizedContext,
               options,
               allowMultiple,
               allowFreeform,
               allowComment,
               dialogOpts,
            ),
         }));

         if (signal?.aborted || result === null) {
            events.cancelled(subject);
            return {
               content: [{ type: "text", text: "User cancelled the question" }],
               details: { question, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails,
            };
         }

         events.answered(subject, result);
         return {
            content: [{ type: "text", text: `User answered: ${formatResponseSummary(result)}` }],
            details: {
               question,
               context: normalizedContext,
               options,
               response: result,
               cancelled: false,
            } as AskToolDetails,
         };
      },

      renderCall(args, theme) {
         if (Array.isArray(args.questions)) {
            const entries: unknown[] = args.questions;
            let text = theme.fg("toolTitle", theme.bold("ask_user "));
            text += theme.fg("muted", `${entries.length} questions`);
            if (args.allowComment) {
               text += theme.fg("dim", " [optional comment]");
            }
            entries.forEach((entry, index) => {
               const record = (entry ?? {}) as { question?: unknown; options?: unknown; allowMultiple?: unknown };
               const question = typeof record.question === "string" ? record.question : "";
               const optionCount = Array.isArray(record.options) ? record.options.length : 0;
               const notes = [
                  optionCount > 0 ? `${optionCount} option(s)` : "",
                  record.allowMultiple ? "multi-select" : "",
               ].filter(Boolean).join(", ");
               text += "\n" + theme.fg("dim", `  ${index + 1}. ${question}${notes ? ` (${notes})` : ""}`);
            });
            return new Text(text, 0, 0);
         }

         const question = (args.question as string) || "";
         const rawOptions = Array.isArray(args.options) ? args.options : [];
         let text = theme.fg("toolTitle", theme.bold("ask_user "));
         text += theme.fg("muted", question);
         if (rawOptions.length > 0) {
            const labels = rawOptions.map((o: unknown) => coerceOption(o)?.title ?? "<invalid>");
            text += "\n" + theme.fg("dim", `  ${rawOptions.length} option(s): ${labels.join(", ")}`);
         }
         if (args.allowMultiple) {
            text += theme.fg("dim", " [multi-select]");
         }
         if (args.allowComment) {
            text += theme.fg("dim", " [optional comment]");
         }
         return new Text(text, 0, 0);
      },

      renderResult(result, options, theme, context) {
         const details = result.details as ((AskToolDetails | AskBatchDetails) & { error?: string }) | undefined;

         if (details?.error || context?.isError) {
            const message = details?.error ?? (
               result.content
                  ?.map((part) => part.type === "text" ? part.text : "")
                  .join("\n")
                  .trim() || "ask_user failed"
            );
            return new Text(theme.fg("error", `✗ ${message}`), 0, 0);
         }

         if (options.isPartial) {
            const waitingText = result.content
               ?.map((part) => part.type === "text" ? part.text : "")
               .join("\n")
               .trim() || "Waiting for user input...";
            return new Text(theme.fg("muted", waitingText), 0, 0);
         }

         if (details && isBatchDetails(details)) {
            return new Text(formatBatchResult(theme, details, options.expanded), 0, 0);
         }

         if (!details || details.cancelled || !details.response) {
            return new Text(theme.fg("warning", "Cancelled"), 0, 0);
         }

         const response = details.response;
         let text = theme.fg("success", "✓ ");
         if (response.kind === "freeform") {
            text += theme.fg("muted", "(wrote) ");
         }
         text += theme.fg("accent", formatResponseSummary(response));

         if (options.expanded) {
            text += "\n" + theme.fg("dim", `Q: ${details.question}`);
            if (details.context) {
               text += "\n" + theme.fg("dim", details.context);
            }

            if (isSelectionResponse(response) && details.options.length > 0) {
               text += formatOptionMarkers(theme, details.options, response);
            }
         }

         return new Text(text, 0, 0);
      },
   });
}
