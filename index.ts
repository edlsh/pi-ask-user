/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to use built-in TUI primitives (Container/Text/Spacer/SelectList/Editor)
 * and a custom box border instead of manual ANSI box drawing.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	Container,
	type Component,
	decodeKittyPrintable,
	Editor,
	type EditorTheme,
	fuzzyFilter,
	Key,
	type Keybinding,
	type KeybindingsManager,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { renderSingleSelectRows, type QuestionOption } from "./single-select-layout";

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

interface AskUIResult {
	answer: string;
	wasCustom: boolean;
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
	invalidate(): void {}
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
	constructor(color: (s: string) => string) {
		this.color = color;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const inner = Math.max(0, width - 2);
		return [this.color(`╰${"─".repeat(inner)}╯`)];
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

type AskMode = "select" | "freeform";

const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const ASK_OVERLAY_WIDTH = "92%";
const ASK_OVERLAY_MIN_WIDTH = 40;
const SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH = 84;
const SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH = 32;
const SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";

class MultiSelectList implements Component {
	private options: QuestionOption[];
	private allowFreeform: boolean;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private selectedIndex = 0;
	private checked = new Set<number>();
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onCancel?: () => void;
	public onSubmit?: (result: string) => void;
	public onEnterFreeform?: () => void;

	constructor(options: QuestionOption[], allowFreeform: boolean, theme: Theme, keybindings: KeybindingsManager) {
		this.options = options;
		this.allowFreeform = allowFreeform;
		this.theme = theme;
		this.keybindings = keybindings;
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
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}

		const count = this.getItemCount();
		if (count === 0) {
			this.onCancel?.();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.shift("tab"))) {
			this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
			this.invalidate();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.tab)) {
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

		if (this.keybindings.matches(data, "tui.select.confirm")) {
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

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const theme = this.theme;
		const count = this.getItemCount();
		const maxVisible = Math.min(count, 10);

		if (count === 0) {
			this.cachedLines = [theme.fg("warning", "No options")];
			this.cachedWidth = width;
			return this.cachedLines;
		}

		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), count - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, count);

		const lines: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→") : " ";

			if (this.isFreeformRow(i)) {
				const label = theme.fg("text", theme.bold("Type something."));
				const desc = theme.fg("muted", "Enter a custom response");
				const line = `${prefix}   ${label} ${theme.fg("dim", "—")} ${desc}`;
				lines.push(truncateToWidth(line, width, ""));
				continue;
			}

			const option = this.options[i];
			if (!option) continue;

			const checkbox = this.checked.has(i) ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
			const num = theme.fg("dim", `${i + 1}.`);
			const title = isSelected
				? theme.fg("accent", theme.bold(option.title))
				: theme.fg("text", theme.bold(option.title));

			const firstLine = `${prefix} ${num} ${checkbox} ${title}`;
			lines.push(truncateToWidth(firstLine, width, ""));

			if (option.description) {
				const indent = "      ";
				const wrapWidth = Math.max(10, width - indent.length);
				const wrapped = wrapTextWithAnsi(option.description, wrapWidth);
				for (const w of wrapped) {
					lines.push(truncateToWidth(indent + theme.fg("muted", w), width, ""));
				}
			}
		}

		// Scroll indicator
		if (startIndex > 0 || endIndex < count) {
			lines.push(theme.fg("dim", truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, "")));
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

class WrappedSingleSelectList implements Component {
	private options: QuestionOption[];
	private allowFreeform: boolean;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private selectedIndex = 0;
	private searchQuery = "";
	private maxVisibleRows = 12;
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onCancel?: () => void;
	public onSubmit?: (result: string) => void;
	public onEnterFreeform?: () => void;

	constructor(options: QuestionOption[], allowFreeform: boolean, theme: Theme, keybindings: KeybindingsManager) {
		this.options = options;
		this.allowFreeform = allowFreeform;
		this.theme = theme;
		this.keybindings = keybindings;
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
		return filteredOptions.length + (this.allowFreeform ? 1 : 0);
	}

	private isFreeformRow(index: number, filteredOptions: QuestionOption[]): boolean {
		return this.allowFreeform && index === filteredOptions.length;
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

	private styleListLine(line: string, width: number): string {
		const trimmed = line.trim();

		if (trimmed.startsWith("(")) {
			return truncateToWidth(this.theme.fg("dim", line), width, "");
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
		const optionLines = renderSingleSelectRows({
			options: filteredOptions,
			selectedIndex: this.selectedIndex,
			width,
			allowFreeform: this.allowFreeform,
			maxRows,
			hideDescriptions,
		}).map((line) => this.styleListLine(line, width));

		lines.push(...optionLines);
		return lines.slice(0, this.maxVisibleRows);
	}

	private buildPreviewLines(width: number, filteredOptions: QuestionOption[], maxLines: number): string[] {
		if (maxLines <= 0) return [];

		const lines: string[] = [];
		const pushWrapped = (text: string, style: (line: string) => string): void => {
			for (const line of wrapTextWithAnsi(text, Math.max(10, width))) {
				lines.push(truncateToWidth(style(line), width, ""));
			}
		};
		const pushBlank = (): void => {
			if (lines.length === 0 || lines[lines.length - 1] !== "") {
				lines.push("");
			}
		};

		pushWrapped("Details", (line) => this.theme.fg("accent", this.theme.bold(line)));
		pushBlank();

		if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
			pushWrapped("Custom response", (line) => this.theme.fg("text", this.theme.bold(line)));
			pushBlank();
			pushWrapped("Open the editor to write any answer.", (line) => this.theme.fg("text", line));
			pushBlank();
			pushWrapped("Use this when none of the listed options fit.", (line) => this.theme.fg("muted", line));
			if (this.searchQuery) {
				pushBlank();
				pushWrapped(`Current filter: ${this.searchQuery}`, (line) => this.theme.fg("dim", line));
			}
		} else {
			const selected = filteredOptions[this.selectedIndex];
			if (!selected) {
				pushWrapped("No option selected", (line) => this.theme.fg("muted", line));
			} else {
				pushWrapped(selected.title, (line) => this.theme.fg("text", this.theme.bold(line)));
				pushBlank();
				if (selected.description?.trim()) {
					pushWrapped(selected.description, (line) => this.theme.fg("text", line));
				} else {
					pushWrapped("No additional details provided for this option.", (line) => this.theme.fg("muted", line));
				}
				pushBlank();
				pushWrapped("Press Enter to select this option.", (line) => this.theme.fg("dim", line));
				if (this.searchQuery) {
					pushBlank();
					pushWrapped(`Filter: ${this.searchQuery}`, (line) => this.theme.fg("dim", line));
				}
			}
		}

		while (lines.length > 0 && lines[lines.length - 1] === "") {
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

		const filteredOptions = this.getFilteredOptions();
		const count = this.getItemCount(filteredOptions);

		if ((this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.shift("tab"))) && count > 0) {
			this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
			this.invalidate();
			return;
		}

		if ((this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.tab)) && count > 0) {
			this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
			this.invalidate();
			return;
		}

		const numMatch = data.match(/^[1-9]$/);
		if (numMatch && count > 0) {
			const idx = Number.parseInt(numMatch[0], 10) - 1;
			if (idx >= 0 && idx < count) {
				this.selectedIndex = idx;
				this.invalidate();
				return;
			}
		}

		if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
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
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private onDone: (result: AskUIResult | null) => void;

	private mode: AskMode = "select";

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
		if (this.editor && this.mode === "freeform") {
			(this.editor as any).focused = value;
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
		keybindings: KeybindingsManager,
		onDone: (result: AskUIResult | null) => void,
	) {
		super();

		this.question = question;
		this.context = context;
		this.options = options;
		this.allowMultiple = allowMultiple;
		this.allowFreeform = allowFreeform;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
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
			let mdTheme: MarkdownTheme | undefined;
			try {
				mdTheme = getMarkdownTheme();
			} catch {}
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
		this.addChild(new BoxBorderBottom((s: string) => theme.fg("accent", s)));

		this.updateStaticText();
		this.showSelectMode();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateStaticText();
		this.updateHelpText();
	}

	override render(width: number): string[] {
		const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);

		if (this.mode === "select" && !this.allowMultiple) {
			const overlayMaxHeight = Math.max(12, Math.floor(this.tui.terminal.rows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
			const staticLines = this.countStaticLines(innerWidth);
			const availableOptionRows = Math.max(4, overlayMaxHeight - staticLines);
			this.ensureSingleSelectList().setMaxVisibleRows(availableOptionRows);
		}

		// Render children at the inner width (excluding side border characters)
		const rawLines = super.render(innerWidth);

		// First and last lines are the top/bottom box borders — pass through at full width.
		// All inner lines get wrapped with side borders.
		const borderColor = (s: string) => this.theme.fg("accent", s);
		const titleColor = (s: string) => this.theme.fg("dim", this.theme.bold(s));
		return rawLines.map((line, index) => {
			if (index === 0 || index === rawLines.length - 1) {
				// Box top/bottom borders already rendered at innerWidth — re-render at full width
				if (index === 0) return new BoxBorderTop(borderColor, "ask_user", titleColor).render(width)[0];
				return new BoxBorderBottom(borderColor).render(width)[0];
			}
			const padded = truncateToWidth(line, innerWidth, "", true);
			return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
		});
	}

	private countWrappedLines(text: string, width: number): number {
		return Math.max(1, wrapTextWithAnsi(text, Math.max(10, width - 2)).length);
	}

	private countStaticLines(width: number): number {
		const titleLines = 1;
		const questionLines = this.countWrappedLines(this.question, width);
		const contextLines = this.context ? 1 + this.countWrappedLines(this.context, width) : 0;
		const helpLines = 1;
		const borderLines = 2;
		const spacerLines = this.context ? 6 : 5;
		return borderLines + spacerLines + titleLines + questionLines + contextLines + helpLines;
	}

	private updateStaticText(): void {
		const theme = this.theme;
		this.titleText.setText(theme.fg("accent", theme.bold("Question")));
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
		if (this.mode === "freeform") {
			const alternateCancelKeys = this.keybindings
				.getKeys("tui.select.cancel")
				.filter((key) => key !== "escape" && key !== "esc");
			const hints = [
				keybindingHint(theme, this.keybindings, "tui.input.submit", "submit"),
				keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
				literalHint(theme, "esc", "back"),
				alternateCancelKeys.length > 0 ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel") : null,
			]
				.filter((hint): hint is string => !!hint)
				.join(" • ");
			this.helpText.setText(theme.fg("dim", hints));
			return;
		}

		if (this.allowMultiple) {
			const hints = [
				literalHint(theme, "↑↓", "navigate"),
				literalHint(theme, "space", "toggle"),
				keybindingHint(theme, this.keybindings, "tui.select.confirm", "submit"),
				keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
			].join(" • ");
			this.helpText.setText(theme.fg("dim", hints));
		} else {
			const alternateCancelKeys = this.keybindings
				.getKeys("tui.select.cancel")
				.filter((key) => key !== "escape" && key !== "esc");
			const hints = [
				literalHint(theme, "type", "filter"),
				keybindingHint(theme, this.keybindings, "tui.editor.deleteCharBackward", "erase"),
				literalHint(theme, "↑↓", "navigate"),
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

	private ensureSingleSelectList(): WrappedSingleSelectList {
		if (this.singleSelectList) return this.singleSelectList;

		const list = new WrappedSingleSelectList(this.options, this.allowFreeform, this.theme, this.keybindings);
		list.onSubmit = (result) => this.onDone({ answer: result, wasCustom: false });
		list.onCancel = () => this.onDone(null);
		list.onEnterFreeform = () => this.showFreeformMode();

		this.singleSelectList = list;
		return list;
	}

	private ensureMultiSelectList(): MultiSelectList {
		if (this.multiSelectList) return this.multiSelectList;

		const list = new MultiSelectList(this.options, this.allowFreeform, this.theme, this.keybindings);
		list.onCancel = () => this.onDone(null);
		list.onSubmit = (result) => this.onDone({ answer: result, wasCustom: false });
		list.onEnterFreeform = () => this.showFreeformMode();

		this.multiSelectList = list;
		return list;
	}

	private ensureEditor(): Editor {
		if (this.editor) return this.editor;
		const editor = new Editor(this.tui, createEditorTheme(this.theme));
		editor.disableSubmit = false;
		editor.onSubmit = (text: string) => {
			const trimmed = text.trim();
			this.onDone(trimmed ? { answer: trimmed, wasCustom: true } : null);
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
		(editor as any).focused = this._focused;

		this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0));
		this.modeContainer.addChild(new Spacer(1));
		this.modeContainer.addChild(editor);

		this.updateHelpText();
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.mode === "freeform") {
			if (matchesKey(data, Key.escape)) {
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
				Type.Number({ description: "Auto-dismiss after N milliseconds. Returns null (cancelled) when expired." }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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

				pi.events.emit("ask:answered", { question, context: normalizedContext, answer, wasCustom: true });
				return {
					content: [{ type: "text", text: `User answered: ${answer}` }],
					details: { question, context: normalizedContext, options, answer, cancelled: false, wasCustom: true } as AskToolDetails,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: "Waiting for user input..." }],
				details: { question, context: normalizedContext, options, answer: null, cancelled: false },
			});

			let result: AskUIResult | null;
			try {
				result = await ctx.ui.custom<AskUIResult | null>(
					(tui, theme, keybindings, done) => {
						// Wire AbortSignal so agent cancellation auto-dismisses the overlay
						if (signal) {
							const onAbort = () => done(null);
							signal.addEventListener("abort", onAbort, { once: true });
						}

						// Wire timeout for overlay mode
						if (timeout && timeout > 0) {
							setTimeout(() => done(null), timeout);
						}

						return new AskComponent(
							question,
							normalizedContext,
							options,
							allowMultiple,
							allowFreeform,
							tui,
							theme,
							keybindings,
							done,
						);
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: ASK_OVERLAY_WIDTH,
							minWidth: ASK_OVERLAY_MIN_WIDTH,
							maxHeight: "85%",
							margin: 1,
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
				pi.events.emit("ask:cancelled", { question, context: normalizedContext, options });
				return {
					content: [{ type: "text", text: "User cancelled the question" }],
					details: { question, context: normalizedContext, options, answer: null, cancelled: true } as AskToolDetails,
				};
			}

			pi.events.emit("ask:answered", {
				question,
				context: normalizedContext,
				answer: result.answer,
				wasCustom: result.wasCustom,
			});
			return {
				content: [{ type: "text", text: `User answered: ${result.answer}` }],
				details: {
					question,
					context: normalizedContext,
					options,
					answer: result.answer,
					cancelled: false,
					wasCustom: result.wasCustom,
				} as AskToolDetails,
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

		renderResult(result, options, theme) {
			const details = result.details as (AskToolDetails & { error?: string }) | undefined;

			if (details?.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			if (options.isPartial) {
				const waitingText = result.content
					?.filter((part: { type?: string; text?: string }) => part?.type === "text")
					.map((part: { text?: string }) => part.text ?? "")
					.join("\n")
					.trim() || "Waiting for user input...";
				return new Text(theme.fg("muted", waitingText), 0, 0);
			}

			if (!details || details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const answer = details.answer ?? "";
			let text = theme.fg("success", "✓ ");
			if (details.wasCustom) {
				text += theme.fg("muted", "(wrote) ");
			}
			text += theme.fg("accent", answer);

			if (options.expanded) {
				const selectedTitles = new Set(
					answer
						.split(",")
						.map((value) => value.trim())
						.filter(Boolean),
				);
				text += "\n" + theme.fg("dim", `Q: ${details.question}`);
				if (details.context) {
					text += "\n" + theme.fg("dim", details.context);
				}
				if (details.options && details.options.length > 0) {
					text += "\n" + theme.fg("dim", "Options:");
					for (const opt of details.options) {
						const desc = opt.description ? ` — ${opt.description}` : "";
						const isSelected = opt.title === answer || selectedTitles.has(opt.title);
						const marker = isSelected ? theme.fg("success", "●") : theme.fg("dim", "○");
						text += `\n  ${marker} ${theme.fg("dim", opt.title)}${theme.fg("dim", desc)}`;
					}
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
