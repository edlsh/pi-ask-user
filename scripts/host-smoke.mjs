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
// Every top-level field is optional: a call carries either question or questions.
assert.deepEqual(tool.parameters.required ?? [], []);
assert.equal(tool.parameters.properties.question.type, "string");
const batchSchema = tool.parameters.properties.questions;
assert.equal(batchSchema.type, "array");
assert.equal(batchSchema.minItems, 2);
assert.equal(batchSchema.maxItems, 4);
assert.equal(batchSchema.items.type, "object");
assert.deepEqual(batchSchema.items.required, ["question"]);
for (const optionList of [tool.parameters.properties.options, batchSchema.items.properties.options]) {
   assert.equal(optionList.type, "array");
   assert.equal(optionList.items.type, "object");
   assert.deepEqual(optionList.items.required, ["title"]);
}
// Union combinators get stripped or rejected by several providers/proxies (Google
// function calling, Codex-style backends, cmux), so the whole schema stays flat (#22).
assert.doesNotMatch(JSON.stringify(tool.parameters), /"(anyOf|oneOf|allOf)"/);
// The unit tests mock TypeBox, so the nested questions schema meets a real validator only here.
const aiPackage = pathToFileURL(findPackageJSON("@earendil-works/pi-ai", hostEntry));
const { validateToolArguments } = await import(new URL("./dist/utils/validation.js", aiPackage));
const validate = (args) => validateToolArguments(tool, { id: "smoke-validate", name: tool.name, arguments: args });
assert.doesNotThrow(() => validate({
   questions: [
      { question: "Ship it?", options: [{ title: "Yes" }, { title: "No", description: "Wait for review" }] },
      { question: "Notes?", allowFreeform: true },
   ],
   timeout: 60000,
}));
assert.throws(() => validate({ questions: [{ question: "Only one?" }] }), "questions needs at least 2 entries");
assert.throws(
   () => validate({ questions: ["A?", "B?", "C?", "D?", "E?"].map((question) => ({ question })) }),
   "questions accepts at most 4 entries",
);
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
// The batch prompt: its pages (strip in the frame title) and review page must fit
// the width with the host's real wrapping, in both display modes.
for (const displayMode of ["inline", "overlay"]) {
   const batch = await tool.execute("smoke-batch-tui", {
      questions: [
         { question: "Choose one", context: "A **short** context.", options: [{ title: "日本語 😀 café" }, { title: "Beta" }] },
         { question: "Pick another", options: [{ title: "Gamma" }], allowFreeform: false },
      ],
      allowComment: false,
      displayMode,
   }, undefined, undefined, {
      hasUI: true,
      ui: {
         custom: async (factory) => {
            let response;
            const component = factory(
               { requestRender() {}, terminal: { rows: 16 } },
               theme, getKeybindings(), (value) => { response = value; },
            );
            const assertFits = (step) => {
               for (const width of [40, 80]) {
                  component.invalidate();
                  for (const line of component.render(width)) {
                     assert.ok(visibleWidth(line) <= width, `${displayMode} ${step} line exceeds ${width} columns`);
                  }
               }
            };
            assertFits("page");
            component.handleInput("\r");
            component.handleInput("\r");
            assertFits("review");
            assert.ok(component.render(80).some((line) => line.includes("Review answers")));
            component.handleInput("\r");
            return response;
         },
      },
   });
   assert.deepEqual(batch.details.answers, [
      { status: "answered", response: { kind: "selection", selections: ["日本語 😀 café"] } },
      { status: "answered", response: { kind: "selection", selections: ["Gamma"] } },
   ]);
}
console.log("Host smoke passed: registration, schema, batch schema validation, RPC select, redacted event, thrown errors, error rendering, native TUI, batch TUI.");
