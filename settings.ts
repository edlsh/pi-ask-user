import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * User-level ask_user preferences read from `ask-user.json`.
 * Mirrors the `PI_ASK_USER_*` environment variables: each value is optional and
 * unrecognised or wrong-typed entries are ignored so a single bad key cannot
 * break the tool.
 */
export interface AskUserSettings {
   displayMode?: "overlay" | "inline";
   singleSelectLayout?: "auto" | "list";
   allowComment?: boolean;
   contextExpanded?: boolean;
   overlayToggleKey?: string;
   commentToggleKey?: string;
   emitFullEvents?: boolean;
}

/** Resolve the agent directory the same way Pi does: override, then default. */
export function getAskUserSettingsDir(): string {
   const override = process.env.PI_CODING_AGENT_DIR?.trim();
   if (override) return override;
   return join(homedir(), ".pi", "agent");
}

/** Path of the optional settings file, `<agent-dir>/ask-user.json`. */
export function getAskUserSettingsPath(): string {
   return join(getAskUserSettingsDir(), "ask-user.json");
}

/**
 * Load user preferences from `ask-user.json`.
 *
 * A missing file yields `{}`. A file that exists but is not valid JSON throws
 * with the path in the message, since silently ignoring a settings file the
 * user deliberately wrote would hide configuration mistakes. Valid JSON with
 * unknown keys or wrong-typed values keeps only the usable entries.
 *
 * Read on every ask_user call so edits apply without restarting Pi.
 */
export function loadAskUserSettings(filePath: string = getAskUserSettingsPath()): AskUserSettings {
   let raw: string;
   try {
      raw = readFileSync(filePath, "utf8");
   } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read ask-user settings at ${filePath}: ${message}`);
   }

   let parsed: unknown;
   try {
      parsed = JSON.parse(raw);
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse ask-user settings at ${filePath}: ${message}`);
   }

   if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
   const source = parsed as Record<string, unknown>;

   const settings: AskUserSettings = {};
   if (source.displayMode === "overlay" || source.displayMode === "inline") {
      settings.displayMode = source.displayMode;
   }
   if (source.singleSelectLayout === "auto" || source.singleSelectLayout === "list") {
      settings.singleSelectLayout = source.singleSelectLayout;
   }
   if (typeof source.allowComment === "boolean") settings.allowComment = source.allowComment;
   if (typeof source.contextExpanded === "boolean") settings.contextExpanded = source.contextExpanded;
   if (typeof source.overlayToggleKey === "string" && source.overlayToggleKey.trim().length > 0) {
      settings.overlayToggleKey = source.overlayToggleKey;
   }
   if (typeof source.commentToggleKey === "string" && source.commentToggleKey.trim().length > 0) {
      settings.commentToggleKey = source.commentToggleKey;
   }
   if (typeof source.emitFullEvents === "boolean") settings.emitFullEvents = source.emitFullEvents;
   return settings;
}
