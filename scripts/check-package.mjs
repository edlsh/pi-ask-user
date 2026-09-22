import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [tarball] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
}));
const expectedFiles = [
  "LICENSE",
  "README.md",
  "index.ts",
  "package.json",
  "single-select-layout.ts",
  "skills/ask-user/SKILL.md",
  "skills/ask-user/references/ask-user-skill-extension-spec.md",
];
assert.deepEqual(tarball.files.map(({ path }) => path).sort(), expectedFiles.sort());
console.log(`Package contents verified: ${tarball.files.length} files (${tarball.size} bytes packed)`);
