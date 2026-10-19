import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
}));
// npm 11 and older print an array of tarballs; npm 12 prints an object keyed by package name.
const [tarball] = Array.isArray(packed) ? packed : Object.values(packed);
const expectedFiles = [
  "LICENSE",
  "README.md",
  "index.ts",
  "settings.ts",
  "package.json",
  "single-select-layout.ts",
  "skills/ask-user/SKILL.md",
  "skills/ask-user/references/ask-user-skill-extension-spec.md",
  "tern.ts",
];
assert.deepEqual(tarball.files.map(({ path }) => path).sort(), expectedFiles.sort());
console.log(`Package contents verified: ${tarball.files.length} files (${tarball.size} bytes packed)`);
