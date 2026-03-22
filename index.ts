/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to use built-in TUI primitives (Container/Text/Spacer/SelectList/Editor)
 * and DynamicBorder instead of manual ANSI box drawing.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	Container,
	type Component,
	Editor,
	type EditorTheme,
	Key,
	getKeybindings,
	Markdown,
	matchesKey,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

interface QuestionOption {
	title: string;
	description?: string;
}

type AskOptionInput = QuestionOption | string;

interface AskParams {
	question: string;
	context?: string;
	options?: AskOptionInput[];
	allowMultiple?: boolean;
	allowFreeform?: boolean;
	timeout?: number;
}

interface AskToolDetails {
	question: string;
	context?: string;
	options: QuestionOption[];
	answer: string | null;
	cancelled: boolean;
	wasCustom?: boolean;
}

function normalizeOptions(options: AskOptionInput[]): QuestionOption[] {
	return options
		.map((option) => {
			if (typeof option === "string") {
				return { title: option };
			}
			if (option && typeof option === "object" && typeof option.title === "string") {
				return { title: option.title, description: option.description };
			}
			return null;
		})
		.filter((option): option is QuestionOption => option !== null);
}

function formatOptionsForMessage(options: QuestionOption[]): string {
	return options
		.map((option, index) => {
			const desc = option.description ? ` — ${option.description}` : "";
			return `${index + 1}. ${option.title}${desc}`;
		})
		.join("\n");
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s: string) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		},
	};
}

type AskMode = "select" | "freeform";

class SingleSelectList implements Component {
	private options: QuestionOption[];
	private allowFreeform: boolean;
	private theme: Theme;
	private selectedIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onCancel?: () => void;
	public onSelect?: (option: QuestionOption) => void;
	public onEnterFreeform?: () => void;

	constructor(options: QuestionOption[], allowFreeform: boolean, theme: Theme) {
		this.options = options;
		this.allowFreeform = allowFreeform;
		this.theme = theme;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private getItemCount(): number {
		return this.options.length + (this.allowFreeform ? 1 : 0);
	}

	private isFreeformRow(index: number): boolean {
		return this.allowFreeform && index === this.options.length;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}

		const count = this.getItemCount();
		if (count === 0) {
			this.onCancel?.();
			return;
		}

		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
			this.invalidate();
			return;
		}

		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
			this.invalidate();
			return;
		}

		// Number keys (1-9) jump to items
		const numMatch = data.match(/^[1-9]$/);
		if (numMatch) {
			const idx = Number.parseInt(numMatch[0], 10) - 1;
			if (idx >= 0 && idx < this.options.length) {
				this.selectedIndex = idx;
				this.invalidate();
			}
			return;
		}

		if (kb.matches(data, "tui.select.confirm")) {
			if (this.isFreeformRow(this.selectedIndex)) {
				this.onEnterFreeform?.();
				return;
			}
			const option = this.options[this.selectedIndex];
			if (option) this.onSelect?.(option);
			else this.onCancel?.();
		}
	}

	private renderItem(i: number, width: number): string[] {
		const theme = this.theme;
		const isSelected = i === this.selectedIndex;
		const prefix = isSelected ? theme.fg("accent", "→") : " ";
		const itemLines: string[] = [];

		if (this.isFreeformRow(i)) {
			const label = theme.fg("text", theme.bold("Type something."));
			const desc = theme.fg("muted", "Enter a custom response");
			itemLines.push(truncateToWidth(`${prefix}   ${label} ${theme.fg("dim", "—")} ${desc}`, width, ""));
			return itemLines;
		}

		const option = this.options[i];
		if (!option) return itemLines;

		const num = theme.fg("dim", `${i + 1}.`);
		const titleIndent = "      ";
		const titleWrapWidth = Math.max(10, width - titleIndent.length);
		const wrappedTitle = wrapTextWithAnsi(option.title, titleWrapWidth);

		for (let j = 0; j < wrappedTitle.length; j++) {
			const titleLine = isSelected
				? theme.fg("accent", theme.bold(wrappedTitle[j]))
				: theme.fg("text", theme.bold(wrappedTitle[j]));
			if (j === 0) {
				itemLines.push(truncateToWidth(`${prefix} ${num} ${titleLine}`, width, ""));
			} else {
				itemLines.push(truncateToWidth(`${titleIndent}${titleLine}`, width, ""));
			}
		}

		if (option.description) {
			const descIndent = "      ";
			const descWrapWidth = Math.max(10, width - descIndent.length);
			const wrappedDesc = wrapTextWithAnsi(option.description, descWrapWidth);
			for (const w of wrappedDesc) {
				itemLines.push(truncateToWidth(descIndent + theme.fg("muted", w), width, ""));
			}
		}

		return itemLines;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const theme = this.theme;
		const count = this.getItemCount();
		const MAX_LINES = 20;

		if (count === 0) {
			this.cachedLines = [theme.fg("warning", "No options")];
			this.cachedWidth = width;
			return this.cachedLines;
		}

		// Expand outward from selectedIndex, bounded by rendered line count
		const itemLineCache = new Map<number, string[]>();
		let startIndex = this.selectedIndex;
		let endIndex = this.selectedIndex;

		const selectedLines = this.renderItem(this.selectedIndex, width);
		itemLineCache.set(this.selectedIndex, selectedLines);
		let totalLines = selectedLines.length;

		let lo = this.selectedIndex - 1;
		let hi = this.selectedIndex + 1;
		while (lo >= 0 || hi < count) {
			if (hi < count) {
				const below = this.renderItem(hi, width);
				if (totalLines + below.length <= MAX_LINES) {
					itemLineCache.set(hi, below);
					totalLines += below.length;
					endIndex = hi;
					hi++;
				} else { hi = count; }
			}
			if (lo >= 0) {
				const above = this.renderItem(lo, width);
				if (totalLines + above.length <= MAX_LINES) {
					itemLineCache.set(lo, above);
					totalLines += above.length;
					startIndex = lo;
					lo--;
				} else { lo = -1; }
			}
			if (lo < 0 && hi >= count) break;
		}

		const lines: string[] = [];
		for (let i = startIndex; i <= endIndex; i++) {
			const cached = itemLineCache.get(i);
			if (cached) lines.push(...cached);
		}

		if (startIndex > 0 || endIndex < count - 1) {
			lines.push(theme.fg("dim", truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, "")));
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

class MultiSelectList implements Component {
	private options: QuestionOption[];
	private allowFreeform: boolean;
	private theme: Theme;
	private selectedIndex = 0;
	private checked = new Set<number>();
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onCancel?: () => void;
	public onSubmit?: (result: string) => void;
	public onEnterFreeform?: () => void;

	constructor(options: QuestionOption[], allowFreeform: boolean, theme: Theme) {
		this.options = options;
		this.allowFreeform = allowFreeform;
		this.theme = theme;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private getItemCount(): number {
		return this.options.length + (this.allowFreeform ? 1 : 0);
	}

	private isFreeformRow(index: number): boolean {
		return this.allowFreeform && index === this.options.length;
	}

	private toggle(index: number): void {
		if (index < 0 || index >= this.options.length) return;
		if (this.checked.has(index)) this.checked.delete(index);
		else this.checked.add(index);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onCancel?.();
			return;
		}

		const count = this.getItemCount();
		if (count === 0) {
			this.onCancel?.();
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) {
			this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
			this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
			this.invalidate();
			return;
		}

		// Number keys (1-9) toggle checkboxes for normal items
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
			if (this.isFreeformRow(this.selectedIndex)) {
				this.onEnterFreeform?.();
				return;
			}
			this.toggle(this.selectedIndex);
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			if (this.isFreeformRow(this.selectedIndex)) {
				this.onEnterFreeform?.();
				return;
			}

			const selectedTitles = Array.from(this.checked)
				.sort((a, b) => a - b)
				.map((i) => this.options[i]?.title)
				.filter((t): t is string => !!t);

			// If nothing checked, fall back to current row
			const fallback = this.options[this.selectedIndex]?.title;
			const result = selectedTitles.length > 0 ? selectedTitles.join(", ") : fallback;

			if (result) this.onSubmit?.(result);
			else this.onCancel?.();
		}
	}

	private renderItem(i: number, width: number): string[] {
		const theme = this.theme;
		const isSelected = i === this.selectedIndex;
		const prefix = isSelected ? theme.fg("accent", "→") : " ";
		const itemLines: string[] = [];

		if (this.isFreeformRow(i)) {
			const label = theme.fg("text", theme.bold("Type something."));
			const desc = theme.fg("muted", "Enter a custom response");
			itemLines.push(truncateToWidth(`${prefix}   ${label} ${theme.fg("dim", "—")} ${desc}`, width, ""));
			return itemLines;
		}

		const option = this.options[i];
		if (!option) return itemLines;

		const checkbox = this.checked.has(i) ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
		const num = theme.fg("dim", `${i + 1}.`);
		const titleIndent = "          ";
		const titleWrapWidth = Math.max(10, width - titleIndent.length);
		const wrappedTitle = wrapTextWithAnsi(option.title, titleWrapWidth);

		for (let j = 0; j < wrappedTitle.length; j++) {
			const titleLine = isSelected
				? theme.fg("accent", theme.bold(wrappedTitle[j]))
				: theme.fg("text", theme.bold(wrappedTitle[j]));
			if (j === 0) {
				itemLines.push(truncateToWidth(`${prefix} ${num} ${checkbox} ${titleLine}`, width, ""));
			} else {
				itemLines.push(truncateToWidth(`${titleIndent}${titleLine}`, width, ""));
			}
		}

		if (option.description) {
			const descIndent = "          ";
			const descWrapWidth = Math.max(10, width - descIndent.length);
			const wrappedDesc = wrapTextWithAnsi(option.description, descWrapWidth);
			for (const w of wrappedDesc) {
				itemLines.push(truncateToWidth(descIndent + theme.fg("muted", w), width, ""));
			}
		}

		return itemLines;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const theme = this.theme;
		const count = this.getItemCount();
		const MAX_LINES = 20;

		if (count === 0) {
			this.cachedLines = [theme.fg("warning", "No options")];
			this.cachedWidth = width;
			return this.cachedLines;
		}

		// Expand outward from selectedIndex, bounded by rendered line count
		const itemLineCache = new Map<number, string[]>();
		let startIndex = this.selectedIndex;
		let endIndex = this.selectedIndex;

		const selectedLines = this.renderItem(this.selectedIndex, width);
		itemLineCache.set(this.selectedIndex, selectedLines);
		let totalLines = selectedLines.length;

		let lo = this.selectedIndex - 1;
		let hi = this.selectedIndex + 1;
		while (lo >= 0 || hi < count) {
			if (hi < count) {
				const below = this.renderItem(hi, width);
				if (totalLines + below.length <= MAX_LINES) {
					itemLineCache.set(hi, below);
					totalLines += below.length;
					endIndex = hi;
					hi++;
				} else { hi = count; }
			}
			if (lo >= 0) {
				const above = this.renderItem(lo, width);
				if (totalLines + above.length <= MAX_LINES) {
					itemLineCache.set(lo, above);
					totalLines += above.length;
					startIndex = lo;
					lo--;
				} else { lo = -1; }
			}
			if (lo < 0 && hi >= count) break;
		}

		const lines: string[] = [];
		for (let i = startIndex; i <= endIndex; i++) {
			const cached = itemLineCache.get(i);
			if (cached) lines.push(...cached);
		}

		if (startIndex > 0 || endIndex < count - 1) {
			lines.push(theme.fg("dim", truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, "")));
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
	private tui: TUI;
	private theme: Theme;
	private onDone: (result: string | null) => void;

	private mode: AskMode = "select";

	// Static layout components
	private titleText: Text;
	private questionText: Text;
	private contextLabel?: Text;
	private contextMarkdown?: Markdown;
	private modeContainer: Container;
	private helpText: Text;

	// Mode components
	private singleSelectList?: SingleSelectList;
	private multiSelectList?: MultiSelectList;
	private editor?: Editor;

	// Focus propagation for IME cursor positioning (Editor is Focusable)
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.editor && this.mode === "freeform") {
			const anyEditor = this.editor as unknown as { focused?: boolean };
			anyEditor.focused = value;
		}
	}

	constructor(
		question: string,
		context: string | undefined,
		options: QuestionOption[],
		allowMultiple: boolean,
		allowFreeform: boolean,
		tui: TUI,
		theme: Theme,
		onDone: (result: string | null) => void,
	) {
		super();

		this.question = question;
		this.context = context;
		this.options = options;
		this.allowMultiple = allowMultiple;
		this.allowFreeform = allowFreeform;
		this.tui = tui;
		this.theme = theme;
		this.onDone = onDone;

		// Layout skeleton
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		this.questionText = new Text("", 1, 0);
		this.addChild(this.questionText);

		if (this.context) {
			this.addChild(new Spacer(1));
			this.contextLabel = new Text("", 1, 0);
			this.addChild(this.contextLabel);
			this.contextMarkdown = new Markdown("", 1, 0, getMarkdownTheme());
			this.addChild(this.contextMarkdown);
		}

		this.addChild(new Spacer(1));

		this.modeContainer = new Container();
		this.addChild(this.modeContainer);

		this.addChild(new Spacer(1));
		this.helpText = new Text("", 1, 0);
		this.addChild(this.helpText);

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		this.updateStaticText();
		this.showSelectMode();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateStaticText();
		this.updateHelpText();
	}

	override render(width: number): string[] {
		// Defensive: ensure no line exceeds width, otherwise pi-tui will hard-crash.
		const lines = super.render(width);
		return lines.map((l) => truncateToWidth(l, width, ""));
	}

	private updateStaticText(): void {
		const theme = this.theme;
		this.titleText.setText(theme.fg("accent", theme.bold("Question")));
		this.questionText.setText(theme.fg("text", theme.bold(this.question)));
		if (this.contextLabel && this.contextMarkdown && this.context) {
			this.contextLabel.setText(theme.fg("accent", theme.bold("Context:")));
			this.contextMarkdown.setText(this.context);
		}
	}

	private updateHelpText(): void {
		const theme = this.theme;
		if (this.mode === "freeform") {
			this.helpText.setText(
				theme.fg(
					"dim",
					"enter submit • shift+enter newline • (ctrl+enter submit if supported) • esc back • ctrl+c cancel",
				),
			);
			return;
		}

		if (this.allowMultiple) {
			this.helpText.setText(theme.fg("dim", "↑↓ navigate • space toggle • enter submit • esc cancel"));
		} else {
			this.helpText.setText(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"));
		}
	}

	private ensureSingleSelectList(): SingleSelectList {
		if (this.singleSelectList) return this.singleSelectList;

		const list = new SingleSelectList(this.options, this.allowFreeform, this.theme);
		list.onSelect = (option) => this.onDone(option.title);
		list.onCancel = () => this.onDone(null);
		list.onEnterFreeform = () => this.showFreeformMode();

		this.singleSelectList = list;
		return list;
	}

	private ensureMultiSelectList(): MultiSelectList {
		if (this.multiSelectList) return this.multiSelectList;

		const list = new MultiSelectList(this.options, this.allowFreeform, this.theme);
		list.onCancel = () => this.onDone(null);
		list.onSubmit = (result) => this.onDone(result);
		list.onEnterFreeform = () => this.showFreeformMode();

		this.multiSelectList = list;
		return list;
	}

	private ensureEditor(): Editor {
		if (this.editor) return this.editor;
		// Note: pi's bundled pi-tui Editor expects (tui, theme, options?)
		const editor = new Editor(this.tui, createEditorTheme(this.theme));
		// Default Editor behavior: Enter submits, Shift+Enter inserts newline.
		// Ctrl+Enter is only distinguishable in terminals with Kitty protocol mappings,
		// so we support it as an *additional* submit shortcut in our wrapper.
		editor.disableSubmit = false;
		editor.onSubmit = (text: string) => {
			const trimmed = text.trim();
			this.onDone(trimmed ? trimmed : null);
		};
		this.editor = editor;
		return editor;
	}

	private showSelectMode(): void {
		this.mode = "select";
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
		this.mode = "freeform";
		this.modeContainer.clear();

		const editor = this.ensureEditor();
		// Ensure focus is propagated immediately when switching modes.
		(editor as unknown as { focused?: boolean }).focused = this._focused;

		this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0));
		this.modeContainer.addChild(new Spacer(1));
		this.modeContainer.addChild(editor);

		this.updateHelpText();
		this.invalidate();
		this.tui.requestRender();
	}

	private submitFreeform(): void {
		const editor = this.ensureEditor();
		const text = editor.getText().trim();
		this.onDone(text ? text : null);
	}

	handleInput(data: string): void {
		if (this.mode === "freeform") {
			if (matchesKey(data, Key.escape)) {
				this.showSelectMode();
				return;
			}

			if (matchesKey(data, Key.ctrl("c"))) {
				this.onDone(null);
				return;
			}

			// Submit on Ctrl+Enter (only works if terminal distinguishes it, e.g. Kitty protocol)
			if (matchesKey(data, Key.ctrl("enter")) || matchesKey(data, "ctrl+enter")) {
				this.submitFreeform();
				return;
			}

			// Let Editor handle everything else (Enter submits, Shift+Enter newline)
			this.ensureEditor().handleInput(data);
			this.tui.requestRender();
			return;
		}

		// Selection mode
		if (this.allowMultiple) {
			this.ensureMultiSelectList().handleInput?.(data);
			this.tui.requestRender();
			return;
		}

		this.ensureSingleSelectList().handleInput?.(data);
		this.tui.requestRender();
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Before calling, gather context with tools (read/exa/ref) and pass a short summary via the context field.",
		promptSnippet:
			"Ask the user a question with optional multiple-choice answers to gather information interactively",
		promptGuidelines: [
			"Before calling ask_user, gather context with tools (read/exa/ref) and pass a short summary via the context field.",
			"Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			context: Type.Optional(
				Type.String({
					description: "Relevant context to show before the question (summary of findings)",
				}),
			),
			options: Type.Optional(
				Type.Array(
					Type.Union([
						Type.String({ description: "Short title for this option" }),
						Type.Object({
							title: Type.String({ description: "Short title for this option" }),
							description: Type.Optional(
								Type.String({ description: "Longer description explaining this option" }),
							),
						}),
					]),
					{ description: "List of options for the user to choose from" },
				),
			),
			allowMultiple: Type.Optional(
				Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
			),
			allowFreeform: Type.Optional(
				Type.Boolean({ description: "Add a freeform text option. Default: true" }),
			),
			timeout: Type.Optional(
				Type.Number({ description: "Auto-dismiss after N milliseconds (applies to fallback input mode when no options are provided)" }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Cancelled" }],
					details: { question: params.question, options: [], answer: null, cancelled: true } as AskToolDetails,
				};
			}

			const {
				question,
				context,
				options: rawOptions = [],
				allowMultiple = false,
				allowFreeform = true,
				timeout,
			} = params as AskParams;
			const options = normalizeOptions(rawOptions);
			const normalizedContext = context?.trim() || undefined;

			if (!ctx.hasUI || !ctx.ui) {
				const optionText = options.length > 0 ? `\n\nOptions:\n${formatOptionsForMessage(options)}` : "";
				const freeformHint = allowFreeform ? "\n\nYou can also answer freely." : "";
				const contextText = normalizedContext ? `\n\nContext:\n${normalizedContext}` : "";
				return {
					content: [
						{
							type: "text",
							text: `Ask requires interactive mode. Please answer:\n\n${question}${contextText}${optionText}${freeformHint}`,
						},
					],
					isError: true,
					details: { question, context: normalizedContext, options, answer: null, cancelled: true } as AskToolDetails,
				};
			}

			// If no options provided, fall back to freeform input prompt.
			if (options.length === 0) {
				const prompt = normalizedContext ? `${question}\n\nContext:\n${normalizedContext}` : question;
				const answer = await ctx.ui.input(prompt, "Type your answer...", timeout ? { timeout } : undefined);

				if (!answer) {
					return {
						content: [{ type: "text", text: "User cancelled the question" }],
						details: { question, context: normalizedContext, options, answer: null, cancelled: true } as AskToolDetails,
					};
				}

				return {
					content: [{ type: "text", text: `User answered: ${answer}` }],
					details: { question, context: normalizedContext, options, answer, cancelled: false, wasCustom: true } as AskToolDetails,
				};
			}

			let result: string | null;
			try {
				result = await ctx.ui.custom<string | null>(
					(tui, theme, _kb, done) => {
						return new AskComponent(
							question,
							normalizedContext,
							options,
							allowMultiple,
							allowFreeform,
							tui,
							theme,
							done,
						);
					},
					{
						overlay: true,
						overlayOptions: {
							maxHeight: "80%",
							width: normalizedContext ? "90%" : "70%",
							minWidth: 50,
						},
					},
				);
			} catch (error) {
				const message =
					error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
				return {
					content: [{ type: "text", text: `Ask tool failed: ${message}` }],
					isError: true,
					details: { error: message },
				};
			}

			if (result === null) {
				return {
					content: [{ type: "text", text: "User cancelled the question" }],
					details: { question, context: normalizedContext, options, answer: null, cancelled: true } as AskToolDetails,
				};
			}

			return {
				content: [{ type: "text", text: `User answered: ${result}` }],
				details: { question, context: normalizedContext, options, answer: result, cancelled: false } as AskToolDetails,
			};
		},

		renderCall(args, theme) {
			const question = (args.question as string) || "";
			const rawOptions = Array.isArray(args.options) ? args.options : [];
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", question);
			if (rawOptions.length > 0) {
				const labels = rawOptions.map((o: unknown) =>
					typeof o === "string" ? o : (o as QuestionOption)?.title ?? "",
				);
				text += "\n" + theme.fg("dim", `  ${rawOptions.length} option(s): ${labels.join(", ")}`);
			}
			if (args.allowMultiple) {
				text += theme.fg("dim", " [multi-select]");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as (AskToolDetails & { error?: string }) | undefined;

			// Error state
			if (details?.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			// Cancelled / no details
			if (!details || details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			// Success
			const answer = details.answer ?? "";
			let text = theme.fg("success", "✓ ");
			if (details.wasCustom) {
				text += theme.fg("muted", "(wrote) ");
			}
			text += theme.fg("accent", answer);
			return new Text(text, 0, 0);
		},
	});
}
