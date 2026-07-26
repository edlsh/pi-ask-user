import { describe, expect, test } from "bun:test";
import { getCenteredBlockWindow, renderSingleSelectRows } from "./single-select-layout";

describe("renderSingleSelectRows", () => {
	test("wraps long option titles instead of truncating them away", () => {
		const rows = renderSingleSelectRows({
			options: [
				{
					title:
						"I want help with a coding or implementation task that involves changing, creating, reviewing, refactoring, or understanding code in a project",
				},
			],
			selectedIndex: 0,
			width: 40,
			allowFreeform: false,
		});

		expect(rows.length).toBeGreaterThan(1);
		expect(rows.map((r) => r.line).join(" ")).toContain("implementation task");
		expect(rows.map((r) => r.line).join(" ")).toContain("understanding code");
	});

	test("wraps long descriptions under their option instead of clipping them", () => {
		const rows = renderSingleSelectRows({
			options: [
				{
					title: "Planning help",
					description:
						"Choose this if you are still deciding what to do, want a plan first, need architecture guidance, or want to evaluate alternatives before touching code.",
				},
			],
			selectedIndex: 0,
			width: 44,
			allowFreeform: false,
		});

		const rendered = rows.map((r) => r.line).join(" ").replace(/\s+/g, " ").trim();
		expect(rendered).toContain("want a plan first");
		expect(rendered).toContain("before touching code");
		expect(rows.length).toBeGreaterThan(2);
	});

	test("caps the rendered rows and keeps the selected option visible when content is taller than the viewport", () => {
		const rows = renderSingleSelectRows({
			options: [
				{
					title:
						"I want help with a coding or implementation task that involves changing, creating, reviewing, refactoring, or understanding code in a project",
					description:
						"Choose this if your main goal is to build something, fix code, understand existing code, add a feature, improve architecture, write tests, or get help with development work.",
				},
				{
					title:
						"I want help troubleshooting, debugging, diagnosing, reproducing, isolating, or explaining a bug, failure, regression, flaky test, unexpected behavior, runtime error, build issue, deployment problem, configuration mistake, performance bottleneck, or environment-specific issue",
					description:
						"Choose this if something is broken, inconsistent, failing, slow, confusing, or behaving differently than expected and you want systematic help narrowing it down.",
				},
			],
			selectedIndex: 1,
			width: 44,
			allowFreeform: false,
			maxRows: 6,
		});

		expect(rows.length).toBeLessThanOrEqual(6);
		expect(rows.map((r) => r.line).join(" ").replace(/\s+/g, " ")).toContain("troubleshooting");
	});

	test("does not duplicate a short word after wrapping an exact-width long word", () => {
		const rows = renderSingleSelectRows({
			options: [
				{
					title: "Alpha",
					description: "hi aaaaaaaaaaaaaaaa",
				},
			],
			selectedIndex: 0,
			width: 12,
			allowFreeform: false,
		});

		expect(rows.map((r) => r.line).filter((line) => line.trim() === "hi")).toHaveLength(1);
		expect(rows.map((r) => r.line).filter((line) => line.trim() === "aaaaaaaa")).toHaveLength(2);
	});

	test("marks selected item rows as selected in annotated output", () => {
		const rows = renderSingleSelectRows({
			options: [
				{ title: "Alpha" },
				{ title: "Beta with a very long title that should wrap to multiple lines when rendered" },
				{ title: "Gamma" },
			],
			selectedIndex: 1,
			width: 30,
			allowFreeform: false,
		});

		const selectedRows = rows.filter((r) => r.selected);
		const nonSelectedRows = rows.filter((r) => !r.selected);

		expect(selectedRows.length).toBeGreaterThan(1);
		for (const row of selectedRows) {
			expect(row.line).not.toContain("Alpha");
			expect(row.line).not.toContain("Gamma");
		}
		expect(nonSelectedRows.length).toBeGreaterThan(0);
	});

	test("keeps an equal-height viewport stable until focus reaches its center", () => {
		const options = Array.from({ length: 10 }, (_, index) => ({ title: `Option ${index + 1}` }));
		const render = (selectedIndex: number) => renderSingleSelectRows({
			options,
			selectedIndex,
			width: 40,
			allowFreeform: false,
			maxRows: 6,
		}).map((row) => row.line);

		const content = (selectedIndex: number) => render(selectedIndex)
			.slice(0, -1)
			.map((line) => line.replace("→", " "))
			.join("\n");
		const first = content(0);
		expect(content(1)).toBe(first);
		expect(content(2)).toBe(first);
		expect(content(3)).not.toBe(first);
		expect(content(3)).toContain("Option 6");
		for (let selectedIndex = 0; selectedIndex < options.length; selectedIndex++) {
			expect(render(selectedIndex)).toHaveLength(6);
		}
	});

	test("anchors variable-height helper windows at the top and bottom boundaries", () => {
		const blocks = [1, 1, 4, 1, 1].map((height) => ({ lines: Array.from({ length: height }) }));

		expect(getCenteredBlockWindow(blocks, 1, 6)).toEqual({
			startIndex: 0,
			endIndex: 2,
			contentRows: 5,
			paddingBeforeRows: 0,
			paddingAfterRows: 3,
			overflow: true,
		});
		expect(getCenteredBlockWindow(blocks, 2, 6)).toEqual({
			startIndex: 1,
			endIndex: 3,
			contentRows: 5,
			paddingBeforeRows: 0,
			paddingAfterRows: 0,
			overflow: true,
		});
		expect(getCenteredBlockWindow(blocks, 3, 6)).toEqual({
			startIndex: 3,
			endIndex: 5,
			contentRows: 5,
			paddingBeforeRows: 3,
			paddingAfterRows: 0,
			overflow: true,
		});
	});

	test("places variable-height single-select padding on the anchored edge", () => {
		const options = [
			{ title: "Option 1" },
			{ title: "Option 2" },
			{ title: "aaaaaaaa bbbbbbbb cccccccc dddddddd" },
			{ title: "Option 4" },
			{ title: "Option 5" },
		];
		const render = (selectedIndex: number) => renderSingleSelectRows({
			options,
			selectedIndex,
			width: 12,
			allowFreeform: false,
			maxRows: 6,
		});

		const early = render(1);
		expect(early).toHaveLength(6);
		expect(early[0]?.line).toContain("Option 1");
		expect(early[1]).toMatchObject({ selected: true });
		expect(early[1]?.line).toContain("Option 2");
		expect(early.slice(2, 5).map((row) => row.line)).toEqual(["", "", ""]);
		expect(early[5]?.line).toBe("  (2/5)");

		const middle = render(2);
		expect(middle).toHaveLength(6);
		expect(middle.filter((row) => row.selected)).toHaveLength(4);
		expect(middle.slice(0, 5).map((row) => row.line).join(" ")).toContain("dddddddd");

		const late = render(3);
		expect(late).toHaveLength(6);
		expect(late.slice(0, 3).map((row) => row.line)).toEqual(["", "", ""]);
		expect(late[3]).toMatchObject({ selected: true });
		expect(late[3]?.line).toContain("Option 4");
		expect(late[4]?.line).toContain("Option 5");
		expect(late[5]?.line).toBe("  (4/5)");
	});
});
