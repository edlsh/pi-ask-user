import { beforeAll, describe, expect, mock, test } from "bun:test";

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

beforeAll(() => {
	mock.module("@mariozechner/pi-coding-agent", () => ({
		DynamicBorder: class {},
		getMarkdownTheme: () => undefined,
		rawKeyHint: (key: string, description: string) => `${key} ${description}`,
	}));

	mock.module("@mariozechner/pi-tui", () => ({
		Container: MockContainer,
		Editor: class {
			disableSubmit = false;
			onSubmit?: (text: string) => void;
			handleInput() {}
			getText() {
				return "";
			}
			setText() {}
		},
		Key: {
			escape: "escape",
			enter: "enter",
			up: "up",
			down: "down",
			space: "space",
			ctrl: (key: string) => `ctrl+${key}`,
			shift: (key: string) => `shift+${key}`,
			tab: "tab",
		},
		Markdown: class extends MockText {},
		matchesKey: () => false,
		Spacer: class {},
		Text: MockText,
		truncateToWidth: (text: string) => text,
		wrapTextWithAnsi: (text: string) => [text],
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
	const pi = {
		registerTool(tool: RegisteredTool) {
			registeredTool = tool;
		},
		events: {
			emit() {},
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
});
