import assert from "node:assert/strict";
import { findPackageJSON } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEventBus } from "@earendil-works/pi-coding-agent";

const hostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", hostEntry));
const events = createEventBus();
const loaded = await loadExtensions([resolve("index.ts")], process.cwd(), events);
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const tools = loaded.extensions[0].tools;
assert.deepEqual([...tools.keys()], ["ask_user"]);
const tool = tools.get("ask_user").definition;
assert.equal(tool.name, "ask_user");
assert.equal(tool.executionMode, "sequential");
assert.equal(tool.parameters.type, "object");
assert.deepEqual(tool.parameters.required, ["question"]);
assert.equal(tool.parameters.properties.question.type, "string");
assert.equal(tool.parameters.properties.options.items.type, "object");
assert.deepEqual(tool.parameters.properties.options.items.required, ["title"]);
for (const [name, values] of Object.entries({
   displayMode: ["overlay", "inline"],
   singleSelectLayout: ["auto", "list"],
})) {
   const schema = tool.parameters.properties[name];
   assert.equal(schema.type, "string");
   assert.deepEqual(schema.enum, values);
   assert.equal(schema.anyOf, undefined);
   assert.equal(schema.oneOf, undefined);
}

// This process tests the default event policy regardless of the caller's environment.
delete process.env.PI_ASK_USER_EMIT_FULL_EVENTS;
const answered = [];
const blocked = [];
events.on("ask:answered", (event) => answered.push(event));
events.on("herdr:blocked", (event) => blocked.push(event.active));
let selected = false;
const rpcResult = await tool.execute("smoke-rpc", {
   question: "Continue?",
   context: "Private context fixture",
   options: [{ title: "Yes" }, { title: "No" }],
   allowFreeform: false,
   allowComment: false,
}, undefined, undefined, {
   hasUI: true,
   ui: {
      custom: async () => undefined,
      select: async (prompt, choices) => {
         assert.match(prompt, /Continue\?/);
         assert.deepEqual(choices, ["Yes", "No"]);
         selected = true;
         return "Yes";
      },
   },
});
assert.equal(selected, true);
assert.equal(rpcResult.details.cancelled, false);
assert.deepEqual(rpcResult.details.response, { kind: "selection", selections: ["Yes"] });
assert.deepEqual(answered, [{ question: "Continue?", response: { kind: "selection" } }]);
assert.deepEqual(blocked, [true, false]);

await assert.rejects(
   tool.execute("smoke-no-ui", { question: "Continue?" }, undefined, undefined, { hasUI: false }),
   /requires interactive mode/,
);
await assert.rejects(
   tool.execute("smoke-malformed", { question: "Continue?", options: [{ title: " " }] },
      undefined, undefined, { hasUI: true, ui: {} }),
   /option\(s\) were malformed/,
);
for (const failure of [new Error("UI failed"), "UI failed"]) {
   blocked.length = 0;
   await assert.rejects(
      tool.execute("smoke-ui-error", { question: "Continue?", options: [{ title: "Yes" }] },
         undefined, undefined, {
            hasUI: true,
            ui: { custom: async () => { throw failure; } },
         }),
      { name: "Error", message: "UI failed" },
   );
   assert.deepEqual(blocked, [true, false]);
}
assert.equal(answered.length, 1, "Failed calls must not emit an answer");

// Use the host's actual theme, TUI components, key parser, and cell-width calculation.
// Only the terminal scheduling surface is inert; no real terminal is opened.
const tuiPackage = pathToFileURL(findPackageJSON("@earendil-works/pi-tui", hostEntry));
const { getKeybindings, visibleWidth } = await import(new URL("./dist/index.js", tuiPackage));
const { initTheme, theme } = await import(new URL("./modes/interactive/theme/theme.js", hostEntry));
initTheme("dark");
const errorLines = tool.renderResult(
   { content: [{ type: "text", text: "UI failed" }], details: undefined },
   { expanded: false, isPartial: false }, theme, { isError: true },
).render(80).join("\n");
assert.ok(errorLines.includes("UI failed"));
assert.ok(!errorLines.includes("Cancelled"));
for (const title of ["Alpha", "日本語 😀 café"]) {
   const rendered = await tool.execute("smoke-tui", {
      question: "Choose one",
      context: "A **short** context.",
      options: [{ title }, { title: "Beta" }],
      allowFreeform: false,
      allowComment: false,
      displayMode: "inline",
      singleSelectLayout: "list",
   }, undefined, undefined, {
      hasUI: true,
      ui: {
         custom: async (factory) => {
            let response;
            const component = factory(
               { requestRender() {}, terminal: { rows: 40 } },
               theme, getKeybindings(), (value) => { response = value; },
            );
            for (const width of [40, 80]) {
               component.invalidate();
               const lines = component.render(width);
               assert.ok(lines.length > 0);
               assert.ok(lines.some((line) => line.includes(title)), "Option must remain visible");
               for (const line of lines) {
                  assert.ok(visibleWidth(line) <= width, `Rendered line exceeds ${width} columns`);
               }
            }
            component.handleInput("\r");
            assert.deepEqual(response, { kind: "selection", selections: [title] });
            return response;
         },
      },
   });
   assert.deepEqual(rendered.details.response, { kind: "selection", selections: [title] });
}
console.log("Host smoke passed: registration, schema, RPC select, redacted event, thrown errors, error rendering, native TUI.");
