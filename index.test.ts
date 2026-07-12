import { beforeAll, describe, expect, mock, onTestFinished, test } from "bun:test";

let editorInputs: string[] = [];
let editorText = "";
let emittedEvents: Array<{ name: string; payload: any }> = [];

function wrapPlainText(text: string, width = 80): string[] {
   const lines: string[] = [];
   for (const rawLine of text.split("\n")) {
      if (rawLine.length <= width) {
         lines.push(rawLine);
         continue;
      }
      for (let i = 0; i < rawLine.length; i += width) {
         lines.push(rawLine.slice(i, i + width));
      }
   }
   return lines.length > 0 ? lines : [""];
}

class MockText {
   constructor(private text: string) { }
   render(width = 80) {
      return wrapPlainText(this.text, width);
   }
   setText(text: string) {
      this.text = text;
   }
}

class MockContainer {
   private children: any[] = [];
   addChild(child?: any) {
      if (child) this.children.push(child);
   }
   clear() {
      this.children = [];
   }
   invalidate() { }
   render(width = 80) {
      return this.children.flatMap((child) => {
         if (typeof child?.render === "function") return child.render(width);
         return [];
      });
   }
}

class MockEditor {
   disableSubmit = false;
   onSubmit?: (text: string) => void;

   constructor(_tui: any, theme: any) {
      if (!theme?.borderColor) {
         throw new TypeError("Cannot read properties of undefined (reading 'borderColor')");
      }
   }

   handleInput(data?: string) {
      if (typeof data === "string") {
         editorInputs.push(data);
      }
      if (data === "enter") {
         this.onSubmit?.(editorText);
      }
   }
   getText() {
      return editorText;
   }
   setText(text = "") {
      editorText = text;
   }
   render(width = 80) {
      return [
         "─".repeat(width),
         ...wrapPlainText(editorText, Math.max(1, width - 1)),
         "─".repeat(width),
      ];
   }
}

function createKeybindings(overrides: Partial<Record<string, string[]>> = {}) {
   const bindings: Record<string, string[]> = {
      "tui.input.submit": ["enter"],
      "tui.input.newLine": ["shift+enter"],
      "tui.select.confirm": ["enter"],
      "tui.select.cancel": ["escape", "ctrl+c"],
      "tui.select.up": ["up"],
      "tui.select.down": ["down"],
      "tui.editor.deleteCharBackward": ["backspace"],
      ...overrides,
   };

   return {
      matches(data: string, keybinding: string) {
         return (bindings[keybinding] ?? []).includes(data);
      },
      getKeys(keybinding: string) {
         return bindings[keybinding] ?? [];
      },
   };
}

type AskComponentFactory = (
   tui: unknown,
   theme: unknown,
   keybindings: unknown,
   done: (value: unknown) => void,
) => { handleInput(data: string): void };

beforeAll(() => {
   // Model the failure mode from https://github.com/edlsh/pi-ask-user/issues/17.
   // `getMarkdownTheme()` returns a bag of closures that read through a Proxy
   // over the host's theme singleton. When the extension's bundled copy of
   // `@earendil-works/pi-coding-agent` is a different module instance than
   // the host's (e.g. legacy `@mariozechner/*` host ≤ Pi 0.73.1, where npm
   // cannot dedupe across scopes), our copy's singleton is never initialised
   // and any property read throws "Theme not initialized. Call initTheme()
   // first." Constructing the bag itself succeeds; the throw surfaces lazily
   // on `mdTheme.bold(...)` from inside pi-tui's `Markdown.render`. The
   // extension MUST detect this and fall back to plain `Text` rendering.
   const uninitialisedTheme = new Proxy({}, {
      get(_target, prop) {
         throw new Error(`Theme not initialized. Call initTheme() first. (read ${String(prop)})`);
      },
   });
   const brokenMarkdownTheme = {
      bold: (text: string) => (uninitialisedTheme as any).bold(text),
      italic: (text: string) => (uninitialisedTheme as any).italic(text),
      heading: (text: string) => (uninitialisedTheme as any).fg("mdHeading", text),
   };

   mock.module("@earendil-works/pi-coding-agent", () => ({
      DynamicBorder: class { },
      getMarkdownTheme: () => brokenMarkdownTheme,
      rawKeyHint: (key: string, description: string) => `${key} ${description}`,
   }));

   mock.module("@earendil-works/pi-tui", () => ({
      Container: MockContainer,
      CURSOR_MARKER: "\x1b_pi:c\x07",
      Editor: MockEditor,
      Key: {
         escape: "escape",
         enter: "enter",
         up: "up",
         down: "down",
         pageUp: "pageUp",
         pageDown: "pageDown",
         home: "home",
         end: "end",
         space: "space",
         backspace: "backspace",
         ctrl: (key: string) => `ctrl+${key}`,
         alt: (key: string) => `alt+${key}`,
         shift: (key: string) => `shift+${key}`,
         tab: "tab",
      },
      Markdown: class extends MockText {
         private mdTheme: any;
         constructor(text: string, _a: number, _b: number, theme: any) {
            super(text);
            this.mdTheme = theme;
         }
         render() {
            // Mirror pi-tui Markdown.render: invoke theme.bold during render
            // so #17-style regressions surface as render-time crashes in
            // tests instead of silently passing.
            return super.render().map((line) => this.mdTheme.bold(line));
         }
      },
      matchesKey: (data: string, key: string) => data === key,
      Spacer: class {
         render() {
            return [""];
         }
      },
      Text: MockText,
      truncateToWidth: (text: string) => text,
      wrapTextWithAnsi: (text: string, width = 80) => wrapPlainText(text, width),
      decodeKittyPrintable: (data: string) => (data.length === 1 ? data : undefined),
      fuzzyFilter: <T>(items: T[], query: string, getText: (item: T) => string) => {
         const normalized = query.trim().toLowerCase();
         if (!normalized) return items;
         return items.filter((item) => getText(item).toLowerCase().includes(normalized));
      },
   }));

   mock.module("@sinclair/typebox", () => ({
      Type: {
         Object: (value: unknown) => value,
         String: (value?: unknown) => value,
         Optional: (value: unknown) => value,
         Array: (value: unknown) => value,
         Union: (value: unknown) => value,
         Literal: (value: unknown) => value,
         Boolean: (value?: unknown) => value,
         Number: (value?: unknown) => value,
         Unsafe: (value: unknown) => value,
      },
   }));
});

type RegisteredTool = {
   execute: (...args: any[]) => Promise<any>;
   renderResult: (result: any, options: any, theme: any) => any;
};

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

async function setupTool(): Promise<RegisteredTool> {
   const { default: askUserExtension } = await import("./index");
   let registeredTool: RegisteredTool | undefined;
   emittedEvents = [];
   const pi = {
      registerTool(tool: RegisteredTool) {
         registeredTool = tool;
      },
      events: {
         emit(name: string, payload: any) {
            emittedEvents.push({ name, payload });
         },
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
   test("registers with executionMode 'sequential' so the agent loop awaits the user's answer before other tool calls run", async () => {
      const tool = await setupTool();
      expect((tool as any).executionMode).toBe("sequential");
   });

   test("uses overlay mode by default", async () => {
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

   test("uses non-overlay custom UI when displayMode is inline", async () => {
      const tool = await setupTool();
      let capturedOptions: any;

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["A", "B"],
            displayMode: "inline",
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

      expect(capturedOptions).toBeUndefined();
      expect(result.details.cancelled).toBe(true);
   });

   test("inline mode resolves with the user's selection", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["A", "B"],
            displayMode: "inline",
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) =>
                  await new Promise((resolve) => {
                     factory(
                        { requestRender() { }, terminal: { rows: 24 } },
                        createTheme(),
                        createKeybindings(),
                        resolve,
                     );
                     resolve({ kind: "selection", selections: ["A"] });
                  }),
            },
         },
      );

      expect(result.details.cancelled).toBe(false);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["A"] });
   });

   test("inline mode still respects timeout cancellation", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["A", "B"],
            displayMode: "inline",
            timeout: 5,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) =>
                  await new Promise((resolve) => {
                     factory(
                        { requestRender() { }, terminal: { rows: 24 } },
                        createTheme(),
                        createKeybindings(),
                        resolve,
                     );
                  }),
            },
         },
      );

      expect(result.details.cancelled).toBe(true);
      expect(result.details.response).toBeNull();
   });

   test("uses PI_ASK_USER_DISPLAY_MODE env var when call-level displayMode is omitted", async () => {
      stubEnv("PI_ASK_USER_DISPLAY_MODE", "inline");
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

      expect(capturedOptions).toBeUndefined();
   });

   test("normalizes PI_ASK_USER_DISPLAY_MODE before applying it", async () => {
      stubEnv("PI_ASK_USER_DISPLAY_MODE", " INLINE ");
      const tool = await setupTool();
      let capturedOptions: unknown;

      await tool.execute(
         "tool-call-id",
         { question: "Which option should we use?", options: ["A", "B"] },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (_factory: unknown, options: unknown) => {
                  capturedOptions = options;
                  return null;
               },
            },
         },
      );

      expect(capturedOptions).toBeUndefined();
   });

   test("call-level displayMode overrides PI_ASK_USER_DISPLAY_MODE env var", async () => {
      stubEnv("PI_ASK_USER_DISPLAY_MODE", "inline");
      const tool = await setupTool();
      let capturedOptions: any;

      await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["A", "B"],
            displayMode: "overlay",
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
   });

   test("ignores unrecognised PI_ASK_USER_DISPLAY_MODE value and falls back to overlay", async () => {
      stubEnv("PI_ASK_USER_DISPLAY_MODE", "fullscreen");
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
   });

   describe("overlay hide/show toggle (alt+o)", () => {
      function createOverlayHandle() {
         let hidden = false;
         const calls: boolean[] = [];
         return {
            handle: {
               hide() { },
               setHidden(value: boolean) {
                  hidden = value;
                  calls.push(value);
               },
               isHidden() {
                  return hidden;
               },
               focus() { },
               unfocus() { },
               isFocused() {
                  return false;
               },
            },
            calls,
         };
      }

      test("registers an onTerminalInput listener and passes onHandle in overlay mode", async () => {
         const tool = await setupTool();
         let capturedOptions: any;
         let inputHandler: ((data: string) => any) | undefined;
         let unsubscribed = false;

         await tool.execute(
            "tool-call-id",
            { question: "Q", options: ["A"] },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async (_factory: any, options: any) => {
                     capturedOptions = options;
                     return null;
                  },
                  onTerminalInput: (handler: (data: string) => any) => {
                     inputHandler = handler;
                     return () => {
                        unsubscribed = true;
                     };
                  },
                  notify: () => { },
               },
            },
         );

         expect(typeof capturedOptions.onHandle).toBe("function");
         expect(typeof inputHandler).toBe("function");
         expect(unsubscribed).toBe(true);
      });

      test("does not register onTerminalInput in inline mode", async () => {
         const tool = await setupTool();
         let registered = false;

         await tool.execute(
            "tool-call-id",
            { question: "Q", options: ["A"], displayMode: "inline" },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => null,
                  onTerminalInput: () => {
                     registered = true;
                     return () => { };
                  },
               },
            },
         );

         expect(registered).toBe(false);
      });

      test("alt+o toggles overlay visibility via OverlayHandle.setHidden", async () => {
         const tool = await setupTool();
         const { handle, calls } = createOverlayHandle();
         let inputHandler: ((data: string) => any) | undefined;
         const notifications: Array<{ message: string; type?: string }> = [];

         await tool.execute(
            "tool-call-id",
            { question: "Q", options: ["A"] },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async (_factory: any, options: any) => {
                     options.onHandle?.(handle);
                     // Simulate the user pressing alt+o twice while the overlay is shown.
                     const firstResult = inputHandler?.("alt+o");
                     const secondResult = inputHandler?.("alt+o");
                     expect(firstResult).toEqual({ consume: true });
                     expect(secondResult).toEqual({ consume: true });
                     return null;
                  },
                  onTerminalInput: (handler: (data: string) => any) => {
                     inputHandler = handler;
                     return () => { };
                  },
                  notify: (message: string, type?: string) => {
                     notifications.push({ message, type });
                  },
               },
            },
         );

         expect(calls).toEqual([true, false]);
         expect(notifications).toHaveLength(1);
         expect(notifications[0]?.message).toContain("alt+o");
         expect(notifications[0]?.type).toBe("info");
      });

      test("does not consume ctrl+o from the terminal listener", async () => {
         const tool = await setupTool();
         const { handle, calls } = createOverlayHandle();
         let inputHandler: ((data: string) => any) | undefined;

         await tool.execute(
            "tool-call-id",
            { question: "Q", options: ["A"] },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async (_factory: any, options: any) => {
                     options.onHandle?.(handle);
                     const result = inputHandler?.("ctrl+o");
                     expect(result).toBeUndefined();
                     return null;
                  },
                  onTerminalInput: (handler: (data: string) => any) => {
                     inputHandler = handler;
                     return () => { };
                  },
                  notify: () => { },
               },
            },
         );

         expect(calls).toEqual([]);
      });

      test("does not force a hidden overlay visible during cleanup", async () => {
         const tool = await setupTool();
         const { handle, calls } = createOverlayHandle();
         let inputHandler: ((data: string) => any) | undefined;

         await tool.execute(
            "tool-call-id",
            { question: "Q", options: ["A"] },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async (_factory: any, options: any) => {
                     options.onHandle?.(handle);
                     // Hide and resolve while still hidden.
                     inputHandler?.("alt+o");
                     return null;
                  },
                  onTerminalInput: (handler: (data: string) => any) => {
                     inputHandler = handler;
                     return () => { };
                  },
                  notify: () => { },
               },
            },
         );

         expect(calls).toEqual([true]);
      });

      test("per-call overlayToggleKey replaces the default alt+o binding", async () => {
         const tool = await setupTool();
         const { handle, calls } = createOverlayHandle();
         let inputHandler: ((data: string) => any) | undefined;
         const notifications: Array<{ message: string; type?: string }> = [];

         await tool.execute(
            "tool-call-id",
            { question: "Q", options: ["A"], overlayToggleKey: "alt+h" },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async (_factory: any, options: any) => {
                     options.onHandle?.(handle);
                     const ignored = inputHandler?.("alt+o");
                     const consumed = inputHandler?.("alt+h");
                     expect(ignored).toBeUndefined();
                     expect(consumed).toEqual({ consume: true });
                     return null;
                  },
                  onTerminalInput: (handler: (data: string) => any) => {
                     inputHandler = handler;
                     return () => { };
                  },
                  notify: (message: string, type?: string) => {
                     notifications.push({ message, type });
                  },
               },
            },
         );

         expect(calls).toEqual([true]);
         expect(notifications).toHaveLength(1);
         expect(notifications[0]?.message).toContain("alt+h");
      });

      test("PI_ASK_USER_OVERLAY_TOGGLE_KEY env var overrides default", async () => {
         stubEnv("PI_ASK_USER_OVERLAY_TOGGLE_KEY", "alt+h");
         const tool = await setupTool();
         const { handle, calls } = createOverlayHandle();
         let inputHandler: ((data: string) => any) | undefined;

         await tool.execute(
            "tool-call-id",
            { question: "Q", options: ["A"] },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async (_factory: any, options: any) => {
                     options.onHandle?.(handle);
                     const ignored = inputHandler?.("alt+o");
                     const consumed = inputHandler?.("alt+h");
                     expect(ignored).toBeUndefined();
                     expect(consumed).toEqual({ consume: true });
                     return null;
                  },
                  onTerminalInput: (handler: (data: string) => any) => {
                     inputHandler = handler;
                     return () => { };
                  },
                  notify: () => { },
               },
            },
         );

         expect(calls).toEqual([true]);
      });

      test("per-call overlayToggleKey wins over env var", async () => {
         stubEnv("PI_ASK_USER_OVERLAY_TOGGLE_KEY", "alt+h");
         const tool = await setupTool();
         const { handle, calls } = createOverlayHandle();
         let inputHandler: ((data: string) => any) | undefined;

         await tool.execute(
            "tool-call-id",
            { question: "Q", options: ["A"], overlayToggleKey: "alt+x" },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async (_factory: any, options: any) => {
                     options.onHandle?.(handle);
                     const ignoredEnv = inputHandler?.("alt+h");
                     const consumed = inputHandler?.("alt+x");
                     expect(ignoredEnv).toBeUndefined();
                     expect(consumed).toEqual({ consume: true });
                     return null;
                  },
                  onTerminalInput: (handler: (data: string) => any) => {
                     inputHandler = handler;
                     return () => { };
                  },
                  notify: () => { },
               },
            },
         );

         expect(calls).toEqual([true]);
      });

      test("overlayToggleKey 'off' disables the listener entirely", async () => {
         const tool = await setupTool();
         let registered = false;

         await tool.execute(
            "tool-call-id",
            { question: "Q", options: ["A"], overlayToggleKey: "off" },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => null,
                  onTerminalInput: () => {
                     registered = true;
                     return () => { };
                  },
               },
            },
         );

         expect(registered).toBe(false);
      });

      test("invalid overlayToggleKey falls through to env var", async () => {
         stubEnv("PI_ASK_USER_OVERLAY_TOGGLE_KEY", "alt+h");
         const tool = await setupTool();
         const { handle, calls } = createOverlayHandle();
         let inputHandler: ((data: string) => any) | undefined;

         await tool.execute(
            "tool-call-id",
            { question: "Q", options: ["A"], overlayToggleKey: "++bad++" },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async (_factory: any, options: any) => {
                     options.onHandle?.(handle);
                     const consumed = inputHandler?.("alt+h");
                     expect(consumed).toEqual({ consume: true });
                     return null;
                  },
                  onTerminalInput: (handler: (data: string) => any) => {
                     inputHandler = handler;
                     return () => { };
                  },
                  notify: () => { },
               },
            },
         );

         expect(calls).toEqual([true]);
      });
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
               response: { kind: "selection", selections: ["A", "B"] },
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

   test("renders selection comments separately in expanded results", async () => {
      const tool = await setupTool();
      const component = tool.renderResult(
         {
            content: [{ type: "text", text: "User answered: Blue" }],
            details: {
               question: "Pick a color",
               options: [{ title: "Red" }, { title: "Blue" }, { title: "Green" }],
               response: { kind: "selection", selections: ["Blue"], comment: "Match the current brand palette." },
               cancelled: false,
            },
         },
         { expanded: true, isPartial: false },
         createTheme(),
      ) as any;

      const rendered = component.render(120).join("\n");

      expect(rendered).toContain("● Blue");
      expect(rendered).toContain("Comment:");
      expect(rendered).toContain("Match the current brand palette.");
   });


   test("enters freeform mode without editor theme crashes", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["A", "B"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );

                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("enter");

                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.cancelled).toBe(true);
   });

   test("uses shared confirm keybinding in single-select mode", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
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
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings({ "tui.select.confirm": ["x"] }),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("x");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["A"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("forwards ctrl+enter to the editor instead of submitting freeform mode", async () => {
      const tool = await setupTool();
      editorInputs = [];
      editorText = "draft answer";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["A", "B"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("enter");
                  component.handleInput("ctrl+enter");

                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.cancelled).toBe(true);
      expect(editorInputs).toEqual(["ctrl+enter"]);
   });

   test("filters single-select options from typed search before confirming", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta", "Gamma"],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("b");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("navigates single-select options with ctrl+j (vim down)", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta", "Gamma"],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("ctrl+j");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("wraps to last option when ctrl+k (vim up) is pressed at the top", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta", "Gamma"],
            allowFreeform: false,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("ctrl+k");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Gamma"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("treats bare j as fuzzy-search input rather than navigation", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "June", "Gamma"],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("j");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["June"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("navigates multi-select options with ctrl+j before toggling", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which options should we use?",
            options: ["Alpha", "Beta", "Gamma"],
            allowMultiple: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("ctrl+j");
                  component.handleInput("space");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("keeps single-select search usable when comment toggling is enabled", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Chrome", "Firefox", "Safari"],
            allowComment: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("c");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Chrome"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("uses PI_ASK_USER_ALLOW_COMMENT when allowComment is omitted", async () => {
      stubEnv("PI_ASK_USER_ALLOW_COMMENT", "true");
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         { question: "Which option should we use?", options: ["Chrome", "Firefox"] },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: AskComponentFactory) => {
                  let resolved: unknown;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value) => { resolved = value; },
                  );
                  component.handleInput("ctrl+g");
                  component.handleInput("enter");
                  // Discriminator: with the env preference applied, the first
                  // enter enters comment mode instead of resolving.
                  expect(resolved).toBeUndefined();
                  editorText = "Prefer the default browser everywhere.";
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.details.response).toEqual({
         kind: "selection",
         selections: ["Chrome"],
         comment: "Prefer the default browser everywhere.",
      });
   });

   test("call-level allowComment false overrides PI_ASK_USER_ALLOW_COMMENT", async () => {
      stubEnv("PI_ASK_USER_ALLOW_COMMENT", "true");
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         { question: "Which option should we use?", options: ["Chrome", "Firefox"], allowComment: false },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: AskComponentFactory) => {
                  let resolved: unknown;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value) => { resolved = value; },
                  );
                  component.handleInput("ctrl+g");
                  component.handleInput("enter");
                  // Discriminator: per-call false wins, so ctrl+g is a no-op
                  // and the first enter resolves the selection immediately.
                  expect(resolved).not.toBeUndefined();
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.details.response).toEqual({ kind: "selection", selections: ["Chrome"] });
   });

   test("treats out-of-range number keys as search input in single-select mode", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta 7", "Gamma"],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("7");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta 7"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("keeps freeform available when search filters out every option", async () => {
      const tool = await setupTool();
      editorInputs = [];

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("z");
                  component.handleInput("z");
                  component.handleInput("z");
                  component.handleInput("enter");
                  editorText = "custom from editor";
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      const answeredEvent = emittedEvents.find((event) => event.name === "ask:answered");

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "freeform", text: "custom from editor" });
      expect(result.details.cancelled).toBe(false);
      expect(answeredEvent?.payload.response).toEqual({ kind: "freeform", text: "custom from editor" });
      expect(editorInputs).toEqual(["enter"]);
   });

   test("shows the remapped cancel key in freeform help text", async () => {
      const tool = await setupTool();
      let helpText = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings({ "tui.select.cancel": ["q"] }),
                     () => { },
                  );

                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("enter");
                  helpText = (component as any).helpText.render().join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(helpText).toContain("alt+o hide");
      expect(helpText).toContain("q cancel");
      expect(helpText).not.toContain("ctrl+c cancel");
   });

   test("renders a details pane for wide single-select layouts", async () => {
      const tool = await setupTool();
      let rendered = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: [
               { title: "Alpha", description: "The alpha option keeps the rollout conservative." },
               { title: "Beta", description: "The beta option favors faster iteration." },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  rendered = ((component as any).singleSelectList as any).render(120).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(rendered).toContain("## Alpha");
      expect(rendered).toContain("The alpha option keeps the rollout conservative.");
   });

   test("shows a custom response preview in the wide details pane", async () => {
      const tool = await setupTool();
      let rendered = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  component.handleInput("down");
                  component.handleInput("down");
                  rendered = ((component as any).singleSelectList as any).render(120).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(rendered).toContain("Custom response");
      expect(rendered).toContain("Open the editor to write **any** answer.");
   });

   test("falls back to the single-column list on narrow widths", async () => {
      const tool = await setupTool();
      let rendered = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: [
               { title: "Alpha", description: "The alpha option keeps the rollout conservative." },
               { title: "Beta", description: "The beta option favors faster iteration." },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  rendered = ((component as any).singleSelectList as any).render(60).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(rendered).not.toContain("Details");
      expect(rendered).not.toContain(" │ ");
      expect(rendered).toContain("The alpha option keeps the rollout conservative.");
   });

   test("keeps the top prompt, answers, and help visible when a long overlay prompt overflows", async () => {
      const tool = await setupTool();
      let rendered: string[] = [];
      let capturedOptions: any;

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "This is a very long question. ".repeat(80),
            context: "Context detail. ".repeat(80),
            options: ["Alpha", "Beta"],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any, options: any) => {
                  capturedOptions = options;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 12 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  rendered = component.render(50);
                  return null;
               },
            },
         },
      );

      const joined = rendered.join("\n");
      expect(result.isError).not.toBe(true);
      expect(capturedOptions.overlay).toBe(true);
      expect(rendered.length).toBeLessThanOrEqual(10);
      expect(joined).toContain("Question");
      expect(joined).toContain("This is a very long question.");
      expect(joined).toContain("Alpha");
      expect(joined).toContain("PgUp/PgDn prompt");
      expect(joined).toContain("↓");
   });

   test("scrolls the prompt pane without hiding answers or help", async () => {
      const tool = await setupTool();
      let initialRendered: string[] = [];
      let scrolledRendered: string[] = [];
      let restoredRendered: string[] = [];

      const question = Array.from({ length: 18 }, (_, index) => `Question line ${index}`).join("\n");
      const context = Array.from({ length: 8 }, (_, index) => `Context line ${index}`).join("\n");

      const result = await tool.execute(
         "tool-call-id",
         {
            question,
            context,
            options: ["Alpha", "Beta"],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 12 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  initialRendered = component.render(50);
                  component.handleInput("end");
                  scrolledRendered = component.render(50);
                  component.handleInput("home");
                  restoredRendered = component.render(50);
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(initialRendered.join("\n")).toContain("Question line 0");
      expect(scrolledRendered.join("\n")).toContain("Context line 7");
      expect(scrolledRendered.join("\n")).toContain("Alpha");
      expect(scrolledRendered.join("\n")).toContain("PgUp/PgDn prompt");
      expect(restoredRendered.join("\n")).toContain("Question line 0");
   });

   test("keeps multiple freeform editor rows visible in a constrained overlay", async () => {
      const tool = await setupTool();
      let rendered: string[] = [];

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            context: "Short context that should give way to the editor once freeform mode is active.",
            options: ["Alpha", "Beta"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 12 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("enter");
                  (component as any).editor.setText(
                     Array.from({ length: 6 }, (_, index) => `editor line ${index}`).join("\n"),
                  );
                  rendered = component.render(50);
                  return null;
               },
            },
         },
      );

      const joined = rendered.join("\n");
      expect(result.isError).not.toBe(true);
      expect(rendered.length).toBeLessThanOrEqual(10);
      expect(joined).toContain("Custom response");
      expect(joined).toContain("editor line 4");
      expect(joined).toContain("editor line 5");
      expect(joined).toContain("enter submit");
   });

   test("routes PageUp/PageDown to the editor in freeform mode instead of prompt scrolling", async () => {
      const tool = await setupTool();
      editorInputs = [];

      const question = Array.from({ length: 18 }, (_, index) => `Question line ${index}`).join("\n");

      const result = await tool.execute(
         "tool-call-id",
         {
            question,
            context: "Long overlay context so the prompt pane has scrollable overflow.",
            options: ["Alpha", "Beta"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 12 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  // Render once so the prompt pane computes a scrollable overflow.
                  component.render(50);
                  // Enter freeform mode (last option is the freeform sentinel).
                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("enter");
                  component.render(50);
                  // These must reach the editor, not the prompt-scroll intercept.
                  component.handleInput("pageUp");
                  component.handleInput("pageDown");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(editorInputs).toContain("pageUp");
      expect(editorInputs).toContain("pageDown");
   });

   test("does not apply overlay viewport clipping in inline mode", async () => {
      const tool = await setupTool();
      let rendered: string[] = [];

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "This is a very long question. ".repeat(80),
            context: "Context detail. ".repeat(80),
            options: ["Alpha", "Beta"],
            displayMode: "inline",
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 12 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  rendered = component.render(50);
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(rendered.length).toBeGreaterThan(10);
   });

   test("submits immediately when the comment toggle is off", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowComment: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Alpha"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("toggles extra context with the ctrl+g key and shows it in help text", async () => {
      const tool = await setupTool();
      let renderedBefore = "";
      let renderedAfter = "";
      let helpText = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowComment: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );

                  renderedBefore = ((component as any).singleSelectList as any).render(80).join("\n");
                  helpText = (component as any).helpText.render().join("\n");
                  component.handleInput("ctrl+g");
                  renderedAfter = ((component as any).singleSelectList as any).render(80).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(renderedBefore).toContain("[ ] Add extra context after selection");
      expect(renderedAfter).toContain("[✓] Add extra context after selection");
      expect(helpText).toContain("ctrl+g toggle context");
   });

   test("uses custom commentToggleKey for comment toggling and help text", async () => {
      const tool = await setupTool();
      let renderedBefore = "";
      let renderedAfterIgnored = "";
      let renderedAfterCustom = "";
      let helpText = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowComment: true,
            commentToggleKey: "alt+c",
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );

                  renderedBefore = ((component as any).singleSelectList as any).render(80).join("\n");
                  helpText = (component as any).helpText.render().join("\n");
                  // Default ctrl+g should no longer toggle.
                  component.handleInput("ctrl+g");
                  renderedAfterIgnored = ((component as any).singleSelectList as any).render(80).join("\n");
                  // Configured alt+c should toggle.
                  component.handleInput("alt+c");
                  renderedAfterCustom = ((component as any).singleSelectList as any).render(80).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(renderedBefore).toContain("[ ] Add extra context after selection");
      expect(renderedAfterIgnored).toContain("[ ] Add extra context after selection");
      expect(renderedAfterCustom).toContain("[✓] Add extra context after selection");
      expect(helpText).toContain("alt+c toggle context");
      expect(helpText).not.toContain("ctrl+g toggle context");
   });

   test("commentToggleKey 'off' hides the toggle hint and ignores ctrl+g", async () => {
      const tool = await setupTool();
      let renderedBefore = "";
      let renderedAfter = "";
      let helpText = "";

      await tool.execute(
         "tool-call-id",
         {
            question: "Q",
            options: ["Alpha", "Beta"],
            allowComment: true,
            commentToggleKey: "off",
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  renderedBefore = ((component as any).singleSelectList as any).render(80).join("\n");
                  helpText = (component as any).helpText.render().join("\n");
                  component.handleInput("ctrl+g");
                  renderedAfter = ((component as any).singleSelectList as any).render(80).join("\n");
                  return null;
               },
            },
         },
      );

      expect(renderedBefore).toContain("[ ] Add extra context after selection");
      expect(renderedAfter).toContain("[ ] Add extra context after selection");
      expect(helpText).not.toContain("toggle context");
   });


   test("collects an optional comment after a single selection before resolving", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowComment: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("ctrl+g");
                  component.handleInput("enter");
                  expect(resolved).toBeUndefined();
                  editorText = "Needs audit logging before rollout.";
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({
         kind: "selection",
         selections: ["Alpha"],
         comment: "Needs audit logging before rollout.",
      });
      expect(result.details.cancelled).toBe(false);
   });

   test("collects an optional comment for multi-select answers", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which options should we use?",
            options: ["Alpha", "Beta", "Gamma"],
            allowMultiple: true,
            allowComment: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("space");
                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("space");
                  component.handleInput("ctrl+g");
                  component.handleInput("enter");
                  expect(resolved).toBeUndefined();
                  editorText = "Roll out both behind the same flag.";
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({
         kind: "selection",
         selections: ["Alpha", "Gamma"],
         comment: "Roll out both behind the same flag.",
      });
      expect(result.details.cancelled).toBe(false);
   });


   test("does not crash when host theme singleton is uninitialised (regression for #17)", async () => {
      // The shared `getMarkdownTheme` mock above returns a bag of closures
      // that throw on every property read of the underlying theme proxy,
      // mirroring what happens on pre-rename hosts where our bundled copy of
      // pi-coding-agent has its own (uninitialised) `globalThis` slot. The
      // `Markdown` mock above also calls `theme.bold` during render. So if
      // the extension ever stops gating through `safeMarkdownTheme()`, the
      // throw surfaces at one of the two callsites: the constructor's
      // context branch, or the split-pane preview built by
      // `buildPreviewLines` — both must remain quiet.
      const tool = await setupTool();
      let constructionError: unknown;
      let previewError: unknown;
      let preview = "";

      await tool.execute(
         "tool-call-id",
         {
            question: "Pick one",
            context: "Some **markdown** context",
            options: [
               { title: "Alpha", description: "First **emphasised** option" },
               { title: "Beta", description: "Second option" },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let component: any;
                  try {
                     component = factory(
                        { requestRender() { }, terminal: { rows: 24 } },
                        createTheme(),
                        createKeybindings(),
                        () => { },
                     );
                  } catch (err) {
                     constructionError = err;
                     return null;
                  }
                  try {
                     // Width 120 forces the split-pane preview, which is the
                     // path that constructs and renders the Markdown
                     // component over the option description.
                     preview = (component.singleSelectList as any).render(120).join("\n");
                  } catch (err) {
                     previewError = err;
                  }
                  return null;
               },
            },
         },
      );

      expect(constructionError).toBeUndefined();
      expect(previewError).toBeUndefined();
      // Confirm the raw markdown fell through to plain Text rendering rather
      // than getting silently dropped when the theme proxy was unavailable.
      expect(preview).toContain("## Alpha");
      expect(preview).toContain("First **emphasised** option");
   });



   describe("issue #22 option normalization", () => {
      test("salvages common option title aliases when schema proxies mangle the shape", async () => {
         const tool = await setupTool();
         let selectOptions: string[] = [];

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick one",
               options: [
                  { label: "A" },
                  { text: "B" },
                  { value: "C" },
                  { name: "D" },
                  { option: "E" },
               ],
               allowFreeform: false,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async (_title: string, opts: string[]) => {
                     selectOptions = opts;
                     return "C";
                  },
                  input: async () => undefined,
               },
            },
         );

         expect(selectOptions).toEqual(["A", "B", "C", "D", "E"]);
         expect(result.details.response).toEqual({ kind: "selection", selections: ["C"] });
         expect(result.details.options.map((option: { title: string }) => option.title)).toEqual(["A", "B", "C", "D", "E"]);
      });

      test("filters blank labels, coerces primitive options, and keeps only non-blank descriptions", async () => {
         const tool = await setupTool();
         let selectOptions: string[] = [];

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick one",
               options: [
                  "  ",
                  "",
                  42,
                  true,
                  "Real",
                  { title: "A", description: "  " },
                  { label: "B", description: "why" },
               ],
               allowFreeform: false,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async (_title: string, opts: string[]) => {
                     selectOptions = opts;
                     return "B";
                  },
                  input: async () => undefined,
               },
            },
         );

         expect(selectOptions).toEqual(["42", "true", "Real", "A", "B"]);
         expect(result.details.options).toEqual([
            { title: "42" },
            { title: "true" },
            { title: "Real" },
            { title: "A" },
            { title: "B", description: "why" },
         ]);
      });

      test("returns an error instead of opening UI when every supplied option is malformed", async () => {
         const tool = await setupTool();
         let calls = 0;

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick one",
               options: [{}, { foo: "x" }, "   "],
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => {
                     calls += 1;
                     return undefined;
                  },
                  select: async () => {
                     calls += 1;
                     return undefined;
                  },
                  input: async () => {
                     calls += 1;
                     return undefined;
                  },
               },
            },
         );

         const text = result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
         expect(result.isError).toBe(true);
         expect(text).toContain("option(s) were malformed");
         expect(text).toContain("{ \"title\": \"Short label\", \"description\": \"Optional detail\" }");
         expect(result.details.error).toBe("Malformed options: no entry had a usable title");
         expect(calls).toBe(0);
      });

      test("keeps the registered options schema flat without union combinators", async () => {
         const source = await Bun.file("index.ts").text();
         const start = source.indexOf("options: Type.Optional(");
         const end = source.indexOf("allowMultiple: Type.Optional(", start);
         const optionSchema = source.slice(start, end);

         expect(start).toBeGreaterThanOrEqual(0);
         expect(end).toBeGreaterThan(start);
         expect(optionSchema).toContain("Type.Array(");
         expect(optionSchema).toContain("Type.Object({");
         expect(optionSchema).toContain("title: Type.String");
         expect(optionSchema).not.toContain("Type.Union");
         expect(optionSchema).not.toContain("anyOf");
         expect(optionSchema).not.toContain("oneOf");
      });
   });

   describe("RPC fallback (custom() returns undefined)", () => {
      test("single-select falls back to ctx.ui.select()", async () => {
         const tool = await setupTool();
         let selectTitle = "";
         let selectOptions: string[] = [];

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
               allowFreeform: false,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async (title: string, opts: string[]) => {
                     selectTitle = title;
                     selectOptions = opts;
                     return "Blue";
                  },
                  input: async () => undefined,
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(result.details.response).toEqual({ kind: "selection", selections: ["Blue"] });
         expect(result.details.cancelled).toBe(false);
         expect(selectTitle).toContain("Pick a color");
         expect(selectOptions).toEqual(["Red", "Blue"]);
      });

      test("single-select with freeform appends sentinel option", async () => {
         const tool = await setupTool();
         let selectOptions: string[] = [];

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
               allowFreeform: true,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async (_title: string, opts: string[]) => {
                     selectOptions = opts;
                     return "Red";
                  },
                  input: async () => undefined,
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(result.details.response).toEqual({ kind: "selection", selections: ["Red"] });
         // Last option should be the freeform sentinel
         expect(selectOptions).toHaveLength(3);
         expect(selectOptions[2]).toContain("Type custom response");
      });

      test("selecting freeform sentinel follows up with input()", async () => {
         const tool = await setupTool();
         let inputCalled = false;
         const sentinel = "\u270f\ufe0f Type custom response...";

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
               allowFreeform: true,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async () => sentinel,
                  input: async () => {
                     inputCalled = true;
                     return "Purple";
                  },
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(inputCalled).toBe(true);
         expect(result.details.response).toEqual({ kind: "freeform", text: "Purple" });
      });

      test("multi-select degrades to input() with options in prompt", async () => {
         const tool = await setupTool();
         let inputTitle = "";

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick colors",
               options: ["Red", "Blue", "Green"],
               allowMultiple: true,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async () => undefined,
                  input: async (title: string) => {
                     inputTitle = title;
                     return "Red, Green";
                  },
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(result.details.response).toEqual({ kind: "selection", selections: ["Red", "Green"] });
         // Prompt should list the options for the user
         expect(inputTitle).toContain("1. Red");
         expect(inputTitle).toContain("2. Blue");
         expect(inputTitle).toContain("3. Green");
      });

      test("single-select can collect an optional comment after choosing an option", async () => {
         const tool = await setupTool();
         let inputCalls = 0;

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
               allowComment: true,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async () => "Blue",
                  input: async () => {
                     inputCalls += 1;
                     return "Keep it aligned with the settings screen.";
                  },
               },
            },
         );

         expect(inputCalls).toBe(1);
         expect(result.isError).not.toBe(true);
         expect(result.details.response).toEqual({
            kind: "selection",
            selections: ["Blue"],
            comment: "Keep it aligned with the settings screen.",
         });
         expect(result.details.cancelled).toBe(false);
      });


      test("returns cancelled when select() returns undefined", async () => {
         const tool = await setupTool();

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async () => undefined,
                  input: async () => undefined,
               },
            },
         );

         expect(result.details.cancelled).toBe(true);
         expect(result.details.response).toBeNull();
      });

      test("passes context into the dialog prompt", async () => {
         const tool = await setupTool();
         let selectTitle = "";

         await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               context: "The sky is blue today.",
               options: ["Red", "Blue"],
               allowFreeform: false,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async (title: string) => {
                     selectTitle = title;
                     return "Blue";
                  },
                  input: async () => undefined,
               },
            },
         );

         expect(selectTitle).toContain("Pick a color");
         expect(selectTitle).toContain("The sky is blue today.");
      });

      test("passes timeout to dialog methods", async () => {
         const tool = await setupTool();
         let capturedOpts: any;

         await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
               allowFreeform: false,
               timeout: 5000,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async (_title: string, _opts: string[], opts: any) => {
                     capturedOpts = opts;
                     return "Red";
                  },
                  input: async () => undefined,
               },
            },
         );

         expect(capturedOpts).toEqual({ timeout: 5000 });
      });
   });
});
