import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEventBus } from "@earendil-works/pi-coding-agent";

const hostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", hostEntry));
// Resolve from the host so nested and hoisted dependency installs both use its validator.
const aiPackage = pathToFileURL(findPackageJSON("@earendil-works/pi-ai", hostEntry));
const { validateToolArguments } = await import(new URL("./dist/utils/validation.js", aiPackage));
const loaded = await loadExtensions([resolve("index.ts")], process.cwd(), createEventBus());
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const tool = loaded.extensions[0].tools.get("ask_user")?.definition;
assert.ok(tool, "ask_user must be registered");

let checked = 0;
for (const file of [
   "README.md",
   "skills/ask-user/SKILL.md",
   "skills/ask-user/references/ask-user-skill-extension-spec.md",
]) {
   const markdown = readFileSync(file, "utf8");
   const fences = [...markdown.matchAll(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
   assert.ok(fences.length > 0, `${file}: no JSON examples found`);
   for (const fence of fences) {
      const line = markdown.slice(0, fence.index).split("\n").length;
      assert.doesNotThrow(() => {
         const args = JSON.parse(fence[1]);
         validateToolArguments(tool, { id: "doc-example", name: tool.name, arguments: args });
      }, `${file}:${line}: invalid ask_user example`);
      checked++;
      console.log(`${file}:${line} passed`);
   }
}
console.log(`Validated ${checked} JSON examples against the registered ask_user schema.`);
