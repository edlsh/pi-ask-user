import { describe, expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
   getAskUserSettingsDir,
   getAskUserSettingsPath,
   loadAskUserSettings,
} from "./settings";

function stubEnv(key: string, value: string): void {
   const original = process.env[key];
   process.env[key] = value;
   onTestFinished(() => {
      if (original === undefined) {
         delete process.env[key];
      } else {
         process.env[key] = original;
      }
   });
}

function tempSettingsFile(contents: string): string {
   const dir = mkdtempSync(join(tmpdir(), "ask-user-settings-"));
   const filePath = join(dir, "ask-user.json");
   writeFileSync(filePath, contents, "utf8");
   return filePath;
}

describe("getAskUserSettingsPath", () => {
   test("defaults to ask-user.json in ~/.pi/agent", () => {
      // Other test files may point PI_CODING_AGENT_DIR at an isolation temp
      // dir for the whole process; the default resolution must be checked
      // with the variable explicitly absent.
      const original = process.env.PI_CODING_AGENT_DIR;
      delete process.env.PI_CODING_AGENT_DIR;
      onTestFinished(() => {
         if (original !== undefined) process.env.PI_CODING_AGENT_DIR = original;
      });
      expect(getAskUserSettingsPath().endsWith(join(".pi", "agent", "ask-user.json"))).toBe(true);
   });

   test("respects PI_CODING_AGENT_DIR", () => {
      stubEnv("PI_CODING_AGENT_DIR", "/custom/agent-dir");
      expect(getAskUserSettingsDir()).toBe("/custom/agent-dir");
      expect(getAskUserSettingsPath()).toBe(join("/custom/agent-dir", "ask-user.json"));
   });
});

describe("loadAskUserSettings", () => {
   test("returns empty settings when the file is missing", () => {
      const missing = join(mkdtempSync(join(tmpdir(), "ask-user-settings-")), "ask-user.json");
      expect(loadAskUserSettings(missing)).toEqual({});
   });

   test("loads every supported key", () => {
      const filePath = tempSettingsFile(JSON.stringify({
         displayMode: "inline",
         singleSelectLayout: "list",
         allowComment: true,
         contextExpanded: true,
         overlayToggleKey: "alt+h",
         commentToggleKey: "alt+c",
         emitFullEvents: true,
      }));
      expect(loadAskUserSettings(filePath)).toEqual({
         displayMode: "inline",
         singleSelectLayout: "list",
         allowComment: true,
         contextExpanded: true,
         overlayToggleKey: "alt+h",
         commentToggleKey: "alt+c",
         emitFullEvents: true,
      });
   });

   test("ignores unknown keys", () => {
      const filePath = tempSettingsFile(JSON.stringify({
         displayMode: "inline",
         futureKey: "whatever",
      }));
      expect(loadAskUserSettings(filePath)).toEqual({ displayMode: "inline" });
   });

   test("ignores wrong-typed and unrecognised values", () => {
      const filePath = tempSettingsFile(JSON.stringify({
         displayMode: "fullscreen",
         singleSelectLayout: "compact",
         allowComment: "yes",
         contextExpanded: 1,
         overlayToggleKey: "   ",
         commentToggleKey: 7,
         emitFullEvents: "true",
      }));
      expect(loadAskUserSettings(filePath)).toEqual({});
   });

   test("ignores non-object JSON documents", () => {
      for (const document of ["[]", "\"inline\"", "null", "42"]) {
         const filePath = tempSettingsFile(document);
         expect(loadAskUserSettings(filePath)).toEqual({});
      }
   });

   test("throws with the file path when the JSON is malformed", () => {
      const filePath = tempSettingsFile("{ not json");
      expect(() => loadAskUserSettings(filePath)).toThrow(filePath);
   });
});
