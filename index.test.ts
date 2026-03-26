import { beforeAll, describe, expect, mock, test } from "bun:test";

let editorInputs: string[] = [];
let editorText = "";
let emittedEvents: Array<{ name: string; payload: any }> = [];

class MockText {
	constructor(private text: string) {}
	render() {
		return [this.text];
	}
	setText(text: string) {
		this.text = text;
	}
}

class MockContainer {
	addChild() {}
	clear() {}
	invalidate() {}
	render() {
		return [];
	}
}

class MockEditor {
	disableSubmit = false;
	onSubmit?: (text: string) => void;

	constructor(_tui: any, theme: any) {
		if (!theme?.borderColor) {
			throw new TypeError("Cannot read properties of undefined (reading 'borderColor')");
		}
	}

	handleInput(data?: string) {
		if (typeof data === "string") {
			editorInputs.push(data);
		}
		if (data === "enter") {
			this.onSubmit?.(editorText);
		}
	}
	getText() {
		return editorText;
	}
	setText(text = "") {
		editorText = text;
	}
}

function createKeybindings(overrides: Partial<Record<string, string[]>> = {}) {
	const bindings: Record<string, string[]> = {
		"tui.input.submit": ["enter"],
		"tui.input.newLine": ["shift+enter"],
		"tui.select.confirm": ["enter"],
		"tui.select.cancel": ["escape", "ctrl+c"],
		"tui.select.up": ["up"],
		"tui.select.down": ["down"],
		"tui.editor.deleteCharBackward": ["backspace"],
		...overrides,
	};

	return {
		matches(data: string, keybinding: string) {
			return (bindings[keybinding] ?? []).includes(data);
		},
		getKeys(keybinding: string) {
			return bindings[keybinding] ?? [];
		},
	};
}

beforeAll(() => {
	mock.module("@mariozechner/pi-coding-agent", () => ({
		DynamicBorder: class {},
		getMarkdownTheme: () => undefined,
		rawKeyHint: (key: string, description: string) => `${key} ${description}`,
	}));

	mock.module("@mariozechner/pi-tui", () => ({
		Container: MockContainer,
		Editor: MockEditor,
		Key: {
			escape: "escape",
			enter: "enter",
			up: "up",
			down: "down",
			space: "space",
			backspace: "backspace",
			ctrl: (key: string) => `ctrl+${key}`,
			shift: (key: string) => `shift+${key}`,
			tab: "tab",
		},
		Markdown: class extends MockText {},
		matchesKey: (data: string, key: string) => data === key,
		Spacer: class {},
		Text: MockText,
		truncateToWidth: (text: string) => text,
		wrapTextWithAnsi: (text: string) => [text],
		decodeKittyPrintable: (data: string) => (data.length === 1 ? data : undefined),
		fuzzyFilter: <T>(items: T[], query: string, getText: (item: T) => string) => {
			const normalized = query.trim().toLowerCase();
			if (!normalized) return items;
			return items.filter((item) => getText(item).toLowerCase().includes(normalized));
		},
	}));

	mock.module("@sinclair/typebox", () => ({
		Type: {
			Object: (value: unknown) => value,
			String: (value?: unknown) => value,
			Optional: (value: unknown) => value,
			Array: (value: unknown) => value,
			Union: (value: unknown) => value,
			Boolean: (value?: unknown) => value,
			Number: (value?: unknown) => value,
		},
	}));
});

type RegisteredTool = {
	execute: (...args: any[]) => Promise<any>;
	renderResult: (result: any, options: any, theme: any) => any;
};

async function setupTool(): Promise<RegisteredTool> {
	const { default: askUserExtension } = await import("./index");
	let registeredTool: RegisteredTool | undefined;
	emittedEvents = [];
	const pi = {
		registerTool(tool: RegisteredTool) {
			registeredTool = tool;
		},
		events: {
			emit(name: string, payload: any) {
				emittedEvents.push({ name, payload });
			},
		},
	} as any;

	askUserExtension(pi);

	if (!registeredTool) {
		throw new Error("Tool was not registered");
	}

	return registeredTool;
}

function createTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

describe("ask_user", () => {
	test("does not hide the overlay on narrow terminals", async () => {
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				},
			},
		);

		expect(capturedOptions.overlay).toBe(true);
		expect(capturedOptions.overlayOptions.visible).toBeUndefined();
	});

	test("renders partial updates as waiting state instead of a successful empty answer", async () => {
		const tool = await setupTool();
		let partialUpdate: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			(update: any) => {
				partialUpdate = update;
			},
			{
				hasUI: true,
				ui: {
					custom: async () => null,
				},
			},
		);

		const component = tool.renderResult(partialUpdate, { expanded: false, isPartial: true }, createTheme()) as any;
		const rendered = component.render(120).join("\n");

		expect(rendered).toContain("Waiting for user input...");
		expect(rendered).not.toContain("✓");
	});

	test("marks each selected option in expanded multi-select results", async () => {
		const tool = await setupTool();
		const component = tool.renderResult(
			{
				content: [{ type: "text", text: "User answered: A, B" }],
				details: {
					question: "Choose one or more",
					options: [{ title: "A" }, { title: "B" }, { title: "C" }],
					answer: "A, B",
					cancelled: false,
				},
			},
			{ expanded: true, isPartial: false },
			createTheme(),
		) as any;

		const rendered = component.render(120).join("\n");

		expect(rendered).toContain("● A");
		expect(rendered).toContain("● B");
		expect(rendered).toContain("○ C");
	});

	test("enters freeform mode without editor theme crashes", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				allowFreeform: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);

						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("enter");

						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.cancelled).toBe(true);
	});

	test("uses shared confirm keybinding in single-select mode", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings({ "tui.select.confirm": ["x"] }),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("x");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.answer).toBe("A");
		expect(result.details.cancelled).toBe(false);
	});

	test("forwards ctrl+enter to the editor instead of submitting freeform mode", async () => {
		const tool = await setupTool();
		editorInputs = [];
		editorText = "draft answer";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				allowFreeform: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("enter");
						component.handleInput("ctrl+enter");

						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.cancelled).toBe(true);
		expect(editorInputs).toEqual(["ctrl+enter"]);
	});

	test("filters single-select options from typed search before confirming", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta", "Gamma"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("b");
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.answer).toBe("Beta");
		expect(result.details.cancelled).toBe(false);
	});

	test("treats out-of-range number keys as search input in single-select mode", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta 7", "Gamma"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("7");
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.answer).toBe("Beta 7");
		expect(result.details.cancelled).toBe(false);
	});

	test("keeps freeform available when search filters out every option", async () => {
		const tool = await setupTool();
		editorInputs = [];
		editorText = "custom from editor";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowFreeform: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("z");
						component.handleInput("z");
						component.handleInput("z");
						component.handleInput("enter");
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		const answeredEvent = emittedEvents.find((event) => event.name === "ask:answered");

		expect(result.isError).not.toBe(true);
		expect(result.details.answer).toBe("custom from editor");
		expect(result.details.wasCustom).toBe(true);
		expect(result.details.cancelled).toBe(false);
		expect(answeredEvent?.payload.wasCustom).toBe(true);
		expect(editorInputs).toEqual(["enter"]);
	});

	test("shows the remapped cancel key in freeform help text", async () => {
		const tool = await setupTool();
		let helpText = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowFreeform: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings({ "tui.select.cancel": ["q"] }),
							() => {},
						);

						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("enter");
						helpText = (component as any).helpText.render().join("\n");
						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(helpText).toContain("q cancel");
		expect(helpText).not.toContain("ctrl+c cancel");
	});

	test("renders a details pane for wide single-select layouts", async () => {
		const tool = await setupTool();
		let rendered = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: [
					{ title: "Alpha", description: "The alpha option keeps the rollout conservative." },
					{ title: "Beta", description: "The beta option favors faster iteration." },
				],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);
						rendered = ((component as any).singleSelectList as any).render(120).join("\n");
						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(rendered).toContain("Details");
		expect(rendered).toContain("The alpha option keeps the rollout conservative.");
	});

	test("shows a custom response preview in the wide details pane", async () => {
		const tool = await setupTool();
		let rendered = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowFreeform: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);
						component.handleInput("down");
						component.handleInput("down");
						rendered = ((component as any).singleSelectList as any).render(120).join("\n");
						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(rendered).toContain("Custom response");
		expect(rendered).toContain("Open the editor to write any answer.");
	});

	test("falls back to the single-column list on narrow widths", async () => {
		const tool = await setupTool();
		let rendered = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: [
					{ title: "Alpha", description: "The alpha option keeps the rollout conservative." },
					{ title: "Beta", description: "The beta option favors faster iteration." },
				],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);
						rendered = ((component as any).singleSelectList as any).render(60).join("\n");
						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(rendered).not.toContain("Details");
		expect(rendered).not.toContain(" │ ");
		expect(rendered).toContain("The alpha option keeps the rollout conservative.");
	});
});
