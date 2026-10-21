/**
 * Native presentation in Tern through pi-tern's optional, versioned hooks. Both
 * contracts are global symbols, so this works when pi-tern is installed and
 * costs nothing when it is not; nothing here imports pi-tern.
 *
 * - Prompts implement `Symbol.for("pi-tern.component.v1")` and return a native
 *   picker sheet (selection) or overlay (custom response, comment). Pointer
 *   events call the prompt's own state transitions; keys still go to pi.
 * - The ask_user tool card registers in `Symbol.for("pi-tern.tools.v1")`: the
 *   question over every option, the chosen ones checked, like omp's ask card.
 *
 * Every renderer returns a tree of `{ k, p, c, key }` nodes in Tern's element
 * vocabulary; pi's ANSI renderers stay as they are for every other terminal.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const NATIVE_COMPONENT = Symbol.for("pi-tern.component.v1");
const NATIVE_TOOLS = Symbol.for("pi-tern.tools.v1");

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

/** A pointer or action event from Tern: `ev`, the emitting node's `id`, and `item`, `act` or `value`. */
export type TernEvent = Readonly<Record<string, Json>>;

/**
 * The key a node id ends in: events name the emitting node (`id`) and, for a
 * list, the clicked child (`item`) by full id (`layer.dialog.sheet.options.o1`).
 */
export function nodeKey(id: Json): string {
   return String(id).split(".").pop() ?? "";
}

export interface TernNode {
   readonly k: string;
   readonly key?: string;
   readonly p: { readonly [key: string]: Json };
   readonly c: readonly TernNode[];
}

/** A pi-tui Editor or Input whose text Tern's native edits replace. */
export type TernField = { getText(): string; setText(text: string): void };

export interface TernContext {
   requestRender(): void;
   onEvent(handler: (event: TernEvent) => void): void;
   field(target: TernField): void;
}

export interface TernToolCall {
   readonly name: string;
   readonly args: Readonly<Record<string, Json>>;
   readonly result: { readonly details?: AskCardDetails; readonly content?: readonly { type: string; text?: string }[] } | undefined;
   readonly status: "pending" | "running" | "done" | "error" | "cancelled";
}

type TernToolRenderer = (call: TernToolCall) => TernNode | undefined;

export function n(k: string, p: TernNode["p"] = {}, c: readonly (TernNode | null | undefined)[] = [], key?: string): TernNode {
   const children = c.filter((child): child is TernNode => child != null);
   return key === undefined ? { k, p, c: children } : { k, key, p, c: children };
}

/**
 * Register a native tool card. pi-tern reads its registry at render time, so
 * load order does not matter; the entry is re-added on session start and
 * removed on shutdown or reload, unless a newer owner replaced it.
 */
export function registerTernTool(pi: Pick<ExtensionAPI, "on">, name: string, renderer: TernToolRenderer): void {
   const registry = globalThis as typeof globalThis & { [NATIVE_TOOLS]?: Map<string, TernToolRenderer> };
   const tools = (registry[NATIVE_TOOLS] ??= new Map());
   tools.set(name, renderer);
   pi.on("session_start", () => {
      tools.set(name, renderer);
   });
   pi.on("session_shutdown", () => {
      if (tools.get(name) === renderer) tools.delete(name);
   });
}

// ── Prompt sheets ────────────────────────────────────────────────────────────
//
// The same structure and element roles as omp's ask dialog (`omp.overlay.ask`,
// `omp.ask.*`, `omp.actions`), so Tern's built-in stylesheet draws them alike:
// a bottom sheet over the composer with the question tabs, the question as
// markdown, the answers as a list, and an action bar.

/** One row of a selection list, in the list's own order (so indices match its keyboard state). */
export interface ChoiceRow {
   readonly id: string;
   readonly kind: "option" | "comment" | "freeform";
   readonly label: string;
   readonly detail?: string;
   /** A ticked option (multi-select), or the comment toggle when on. */
   readonly on?: boolean;
}

export interface QuestionTabs {
   readonly tabs: readonly { id: string; label: string }[];
   readonly tab: string;
   /** A batch's optional heading (the top-level question sent with questions), shown above every sheet. */
   readonly heading?: string;
}

/** A selection list's state as its sheet shows it: rows in the list's order, the selected row, the filter. */
export interface ChoiceList {
   readonly rows: ChoiceRow[];
   readonly selected: number;
   /** The single-select filter text, retained when leaving filter typing mode. */
   readonly query?: string;
   readonly filtering?: boolean;
}

export interface ChoiceSheet extends ChoiceList {
   readonly question: string;
   readonly context?: string;
   readonly multiple: boolean;
   readonly tabs?: QuestionTabs;
}

/** The key of the answer list under the sheet; list events carry it as the last segment of their id. */
export const CHOICE_LIST_KEY = "options";

function button(label: string, act: string, keys: string, tone?: string): TernNode {
   return n("row", { role: "omp.btn", gap: "xs", align: "center", actions: { click: act }, title: `${label}  ${keys}`, tone }, [
      n("text", { text: label }),
      n("kbd", { keys: [keys] }),
   ], act);
}

/** Buttons end-aligned in omp's action bar. */
function actionBar(buttons: readonly TernNode[]): TernNode {
   return n("row", { role: "omp.actions", gap: "sm", align: "center" }, [n("spacer", { grow: 1 }), ...buttons], "actions");
}

function askSheet(tabs: QuestionTabs | undefined, children: readonly (TernNode | null)[]): TernNode {
   const head = tabs
      ? n("row", { role: "omp.ask.head", gap: "sm", align: "center" }, [
         n("tabs", { items: tabs.tabs.map((tab) => ({ ...tab })), active: tabs.tab, role: "omp.ask.questions", actions: { click: "select" } }, [], "tabs"),
      ], "head")
      : null;
   const heading = tabs?.heading ? n("md", { text: tabs.heading, role: "omp.ask.heading" }, [], "heading") : null;
   return n("overlay", { role: "omp.overlay.ask", anchor: "bottom", size: "md", modal: true }, [
      n("col", { gap: "md" }, [head, heading, ...children], "sheet"),
   ]);
}

function questionNodes(question: string, context: string | undefined): TernNode[] {
   return [
      n("md", { text: question, role: "omp.ask.question" }, [], "question"),
      ...(context ? [n("md", { text: context, role: "omp.tool.context" }, [], "context")] : []),
   ];
}

/** A question's answers as a list: radio rows, check rows for multi-select, then the comment toggle and "Other". */
export function choiceSheet(sheet: ChoiceSheet): TernNode {
   const items = sheet.rows.map((row) => {
      const role = row.kind === "freeform" ? "omp.ask.other" : sheet.multiple && row.kind === "option" ? "omp.ask.check" : "omp.ask.option";
      return n("item", {
         // Spans, as omp sends them: the ask stylesheet lays out the radio/check mark beside span labels.
         label: [{ t: row.label }],
         detail: row.detail ? [{ t: row.detail }] : row.kind === "freeform" ? [{ t: "Type your own answer", s: "dim" }] : undefined,
         role,
         icon: row.on ? "check" : undefined,
         tone: row.on ? "success" : undefined,
      }, [], row.id);
   });
   return askSheet(sheet.tabs, [
      ...questionNodes(sheet.question, sheet.context),
      !sheet.multiple ? n("text", { spans: [
         { t: sheet.filtering ? "Filter (typing): " : "Filter: ", s: "muted" },
         { t: sheet.query || (sheet.filtering ? "type to filter" : "press i to filter"), s: "accent" },
         { t: sheet.filtering ? " · esc navigate" : " · j/k navigate", s: "muted" },
      ] }, [], "filter") : null,
      n("list", { selected: sheet.rows[sheet.selected]?.id ?? null, role: "omp.ask.options", empty: "No matching options" }, items, CHOICE_LIST_KEY),
      actionBar([button("Cancel", "cancel", "esc"), button(sheet.multiple ? "Submit" : "Select", "submit", "enter", "accent")]),
   ]);
}

export interface TextSheet {
   readonly question: string;
   readonly context?: string;
   /** Shown above the field (the selections a comment follows). */
   readonly lead?: string;
   readonly text: string;
   readonly cursor: number;
   readonly placeholder: string;
   /** What esc does: back to the options, or cancel when there are none. */
   readonly escape: "back" | "cancel";
   readonly tabs?: QuestionTabs;
}

/** A custom response or comment: the question over a native editor bound to pi's. */
export function textSheet(sheet: TextSheet): TernNode {
   return askSheet(sheet.tabs, [
      ...questionNodes(sheet.question, sheet.context),
      sheet.lead ? n("text", { spans: [{ t: sheet.lead, s: "muted" }], wrap: "word" }, [], "lead") : null,
      n("editor", { text: sheet.text, cursor: sheet.cursor, maxLines: 8, placeholder: sheet.placeholder }, [], "field"),
      actionBar([button(sheet.escape === "back" ? "Back" : "Cancel", "cancel", "esc"), button("Submit", "submit", "enter", "accent")]),
   ]);
}

export interface ReviewSheet {
   readonly rows: readonly { question: string; answer?: string }[];
   readonly tabs: QuestionTabs;
   /** Unanswered questions after a first submit: the next submit sends them as skipped. */
   readonly confirmSkips: boolean;
}

/** The batch review page: every answer as key/value pairs; Submit sends the batch. */
export function reviewSheet(sheet: ReviewSheet): TernNode {
   const unanswered = sheet.rows.filter((row) => row.answer === undefined).length;
   const noun = `question${unanswered === 1 ? "" : "s"}`;
   return askSheet(sheet.tabs, [
      unanswered > 0
         ? n("text", {
            spans: [{ t: sheet.confirmSkips ? `${unanswered} unanswered ${noun} — submit again to skip ${unanswered === 1 ? "it" : "them"}.` : `${unanswered} unanswered ${noun}.`, s: "warning" }],
         }, [], "warning")
         : null,
      n("kv", {
         items: sheet.rows.map((row, index) => ({
            k: `${index + 1}. ${row.question}`,
            v: row.answer === undefined ? [{ t: "unanswered", s: "warning" }] : [{ t: row.answer }],
         })),
      }, [], "answers"),
      actionBar([button("Cancel", "cancel", "esc"), button(unanswered > 0 && sheet.confirmSkips ? "Submit with skips" : "Submit", "submit", "enter", "accent")]),
   ]);
}

// ── Tool card ────────────────────────────────────────────────────────────────

/** The parts of ask_user's result details the card reads (single and batch shapes). */
export interface AskCardDetails {
   readonly kind?: "batch";
   readonly heading?: string;
   readonly question?: string;
   readonly context?: string;
   readonly options?: readonly { title: string }[];
   readonly response?: AskCardResponse | null;
   readonly cancelled?: boolean;
   readonly questions?: readonly { question: string; context?: string; options: readonly { title: string }[] }[];
   readonly answers?: readonly ({ status: "answered"; response: AskCardResponse } | { status: "skipped" })[];
}

type AskCardResponse = { kind: "selection"; selections: readonly string[]; comment?: string } | { kind: "freeform"; text: string };

function firstLine(text: string): string {
   return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/** One answered question: every option, a check on the chosen ones, then a custom answer or comment. */
function answerRows(options: readonly { title: string }[], response: AskCardResponse | null | undefined, keyPrefix: string): TernNode[] {
   if (!response) return [n("text", { text: "Cancelled", tone: "warning" }, [], `${keyPrefix}cancelled`)];
   const chosen = new Set(response.kind === "selection" ? response.selections : []);
   const row = (label: string, on: boolean, key: string): TernNode =>
      n("row", { gap: "sm", align: "baseline", role: on ? "omp.tool.answer" : "omp.tool.answer.off" }, [
         on ? n("icon", { name: "check", tone: "success" }) : null,
         n("text", { spans: [{ t: label, s: on ? "strong" : "muted" }], wrap: "word" }),
      ], key);
   const rows = options.map((option, index) => row(option.title, chosen.has(option.title), `${keyPrefix}o${index}`));
   if (response.kind === "freeform") rows.push(row(`“${response.text}”`, true, `${keyPrefix}custom`));
   if (response.kind === "selection" && response.comment) {
      rows.push(n("text", { spans: [{ t: response.comment, s: "muted" }], wrap: "word", role: "omp.tool.context" }, [], `${keyPrefix}comment`));
   }
   return rows;
}

/** Options from the call's arguments while the question is open (titles only; models may send strings). */
function argOptions(value: Json): { title: string }[] {
   if (!Array.isArray(value)) return [];
   return value.flatMap((option) => {
      if (option === null || option === undefined || Array.isArray(option)) return [];
      if (option instanceof Object) return option.title ? [{ title: String(option.title) }] : [];
      return [{ title: String(option) }];
   });
}

/** ask_user's card: `Ask` with the question as its target, then each question over its answers. */
export function askToolCard(call: TernToolCall): TernNode | undefined {
   if (call.status === "error") return undefined;
   const details = call.result?.details;
   const settled = call.status === "done" && details !== undefined;
   const batch = details?.kind === "batch" || Array.isArray(call.args.questions);

   if (batch) {
      const questions = details?.questions ?? (Array.isArray(call.args.questions) ? call.args.questions : []).flatMap((entry) =>
         entry instanceof Object && !Array.isArray(entry) && entry.question ? [{ question: String(entry.question), options: argOptions(entry.options) }] : []);
      const answers = details?.answers ?? [];
      const sections = questions.map((entry, index) => {
         const answer = answers[index];
         const body = !settled
            ? entry.options.map((option, at) => n("text", { spans: [{ t: option.title, s: "muted" }] }, [], `o${at}`))
            : details?.cancelled
               ? [n("text", { text: "Cancelled", tone: "warning" }, [], "cancelled")]
               : answer?.status === "answered"
                  ? answerRows(entry.options, answer.response, "")
                  : [n("text", { text: "Skipped", tone: "muted" }, [], "skipped")];
         return n("section", { head: [{ t: `${index + 1}. `, s: "muted" }, { t: entry.question }] }, body, `q${index}`);
      });
      return n("tool", {
         title: "Ask",
         target: firstLine(details?.heading ?? (call.args.question ? String(call.args.question) : questions[0]?.question ?? "")),
         targetKind: "text",
         meta: [`${questions.length} questions`],
      }, [...sections, settled ? null : n("text", { spans: [{ t: "Waiting for your answers…", s: "muted" }] }, [], "waiting")]);
   }

   const question = details?.question ?? String(call.args.question ?? "");
   const context = details?.context ?? (call.args.context ? String(call.args.context) : undefined);
   const options = details?.options ?? argOptions(call.args.options);
   return n("tool", { title: "Ask", target: firstLine(question), targetKind: "text" }, [
      // The head shows the first line; a longer question is shown whole.
      question.trim() !== firstLine(question) ? n("md", { text: question }, [], "question") : null,
      context ? n("md", { text: context, role: "omp.tool.context" }, [], "context") : null,
      ...(settled
         ? answerRows(options, details?.cancelled ? null : details?.response, "")
         : [
            ...options.map((option, index) => n("text", { spans: [{ t: option.title, s: "muted" }] }, [], `o${index}`)),
            n("text", { spans: [{ t: "Waiting for your answer…", s: "muted" }] }, [], "waiting"),
         ]),
   ]);
}
