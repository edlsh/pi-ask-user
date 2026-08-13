import { describe, expect, test } from "bun:test";
import { renderSingleSelectRows } from "./single-select-layout";

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

	test("numbers the freeform response after the canned options", () => {
		const rows = renderSingleSelectRows({
			options: [{ title: "Alpha" }, { title: "Beta" }],
			selectedIndex: 3,
			width: 60,
			allowFreeform: true,
			allowComment: true,
		});

		const rendered = rows.map((row) => row.line).join("\n");
		expect(rendered).toContain("3. Type something.");
		expect(rendered).not.toContain("4. Type something.");
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
});
