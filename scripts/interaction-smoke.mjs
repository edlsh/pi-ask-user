import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

test("ask_user interactions", { timeout: 30000 }, async (t) => {
  const hostPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const require = createRequire(hostPath);
  const { createJiti } = require("jiti");
  let typeboxPath;
  try { typeboxPath = require.resolve("typebox"); }
  catch { typeboxPath = require.resolve("@sinclair/typebox"); }
  const { visibleWidth } = require("@earendil-works/pi-tui");
  const { KeybindingsManager } = await import(new URL("./core/keybindings.js", pathToFileURL(hostPath)));
  const { SettingsManager } = await import(pathToFileURL(hostPath));
  const tuiModule = await import(new URL("./tui.js", pathToFileURL(require.resolve("@earendil-works/pi-tui"))));
  class OverlayTui extends (tuiModule.TuiBase ?? tuiModule.TUI) {
    mode = "regular";
    doRender() {}
    requestRender() {}
    draw() { return this.compositeOverlays([], this.terminal.columns, this.terminal.rows); }
  }
  const register = await createJiti(import.meta.url, {
    fsCache: false,
    alias: {
      "@sinclair/typebox": typeboxPath,
      "@earendil-works/pi-coding-agent": hostPath,
      "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    },
  }).import(extensionPath, { default: true });
  const description = Array.from({ length: 40 }, (_, i) => `DETAIL_${String(i).padStart(2, "0")} 日本語 😀 café`).join("\n");
  const context = Array.from({ length: 40 }, (_, i) => `CONTEXT_${String(i).padStart(2, "0")}`).join("\n");

  function open(params = {}, rows = 24, host = {}) {
    let tool;
    register({ registerTool: (value) => { tool = value; }, events: { emit() {} } });
    let component;
    let complete;
    const terminal = { rows, columns: host.columns ?? 140, hideCursor() {}, write() {} };
    const nativeTui = host.nativeOverlay ? new OverlayTui(terminal) : undefined;
    let overlayHandle;
    const controller = new AbortController();
    const calls = [];
    const notifications = [];
    let resumed;
    let resume;
    const result = tool.execute("scroll-test", {
      question: "Choose an option",
      context: "Short context",
      options: [{ title: "First", description }, { title: "Second", description: description.replaceAll("DETAIL", "SECOND") }],
      displayMode: "overlay",
      singleSelectLayout: "auto",
      contextExpanded: false,
      allowFreeform: true,
      allowComment: false,
      overlayToggleKey: "off",
      ...params,
    }, controller.signal, undefined, {
      cwd: host.cwd ?? process.cwd(),
      isProjectTrusted: () => host.trusted ?? false,
      hasUI: true,
      ui: {
        input: async () => undefined,
        notify: (message) => notifications.push(message),
        custom: (factory, options) => new Promise((done) => {
          let closed = false;
          complete = (value) => { closed = true; overlayHandle?.hide(); done(value); };
          component = factory(
            nativeTui ?? {
              terminal,
              requestRender() {},
              stop() { calls.push("stop"); resumed = new Promise((resolve) => { resume = resolve; }); },
              start() { calls.push("start"); resume?.(); },
            },
            { fg: (_, text) => text, bg: (_, text) => text, bold: (text) => text },
            new KeybindingsManager(host.bindings),
            complete,
          );
          if (nativeTui && options?.overlay && !closed) {
            const layout = typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
            overlayHandle = nativeTui.showOverlay(component, layout);
            options.onHandle?.(overlayHandle);
          }
        }),
      },
    });
    assert.ok(component, "The extension must open its custom UI");
    return {
      component,
      terminal,
      result,
      tool,
      controller,
      calls,
      notifications,
      frame() {
        assert.ok(nativeTui);
        const lines = nativeTui.draw().map(stripVTControlCharacters);
        const top = lines.findIndex((line) => line.includes("╭"));
        const bottom = lines.findLastIndex((line) => line.includes("╰"));
        assert.ok(top >= 0 && bottom >= top, "The actual overlay must have both borders");
        const col = lines[top].indexOf("╭");
        const width = lines[top].lastIndexOf("╮") - col + 1;
        return { text: lines.join("\n"), width, height: bottom - top + 1, row: top, col };
      },
      render: (width = 120) => component.render(width).join("\n"),
      press(key, width = 120) {
        component.handleInput(key);
        return this.render(width);
      },
      async waitForEditor() {
        await nextTurn();
        assert.ok(resumed, "The external editor must stop the TUI");
        await resumed;
        await nextTurn();
      },
      close() { controller.abort(); complete(null); return result; },
    };
  }

  const paste = (text) => `\x1b[200~${text}\x1b[201~`;
  const shortOptions = [{ title: "First", description: "First summary" }, { title: "Second", description: "Second summary" }];

  function editorFixture(t, behavior = 'writeFileSync(file, "Edited answer\\n");') {
    const cwd = mkdtempSync(join(tmpdir(), "ask-user-editor-test-"));
    const script = join(cwd, "editor.mjs");
    const capture = join(cwd, "capture.json");
    writeFileSync(script, `import { readFileSync, writeFileSync, statSync } from "node:fs";\n`
      + `const file = process.argv.at(-1);\n`
      + `writeFileSync(${JSON.stringify(capture)}, JSON.stringify({file, text: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777}));\n`
      + behavior);
    const command = `${process.execPath} ${script}`;
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ externalEditor: command }));
    const previous = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
    process.env.VISUAL = command;
    process.env.EDITOR = command;
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(cwd, { recursive: true, force: true });
    });
    return { cwd, capture, command };
  }

  await t.test("checked options and a custom answer are submitted together", async (t) => {
    const prompt = open({ allowMultiple: true, options: shortOptions });
    t.after(() => prompt.close());
    prompt.press("1");
    prompt.press("2");
    prompt.press("\x1b[B");
    prompt.press("\r");
    prompt.press(paste("Another approach"));
    assert.match(prompt.render(), /First, Second/);
    prompt.press("\r");
    assert.deepEqual((await prompt.result).details.response, {
      kind: "selection", selections: ["First", "Second", "Another approach"],
    });
  });

  await t.test("backtracking keeps checkmarks and the expanded custom draft", async (t) => {
    const prompt = open({ allowMultiple: true, options: shortOptions });
    t.after(() => prompt.close());
    const draft = "A long custom answer. ".repeat(150).trim();
    prompt.press("1");
    prompt.press("2");
    prompt.press("\x1b[B");
    prompt.press("\r");
    prompt.press(paste(draft));
    assert.equal((prompt.press("\x1b").match(/\[✓\]/g) ?? []).length, 2);
    prompt.press("\r");
    prompt.press("\r");
    assert.deepEqual((await prompt.result).details.response.selections, ["First", "Second", draft]);
  });

  await t.test("an empty custom answer keeps checks, and custom-only answers stay freeform", async (t) => {
    for (const checked of [true, false]) {
      const prompt = open({ allowMultiple: true, options: shortOptions });
      t.after(() => prompt.close());
      if (checked) prompt.press("1");
      prompt.press("\x1b[A");
      prompt.press("\r");
      if (!checked) prompt.press(paste("Only my answer"));
      prompt.press("\r");
      assert.deepEqual((await prompt.result).details.response, checked
        ? { kind: "selection", selections: ["First"] }
        : { kind: "freeform", text: "Only my answer" });
    }
  });

  await t.test("combined checkbox/custom answers can carry an optional comment", async (t) => {
    const prompt = open({ allowMultiple: true, allowComment: true, options: shortOptions });
    t.after(() => prompt.close());
    prompt.press("\x07");
    prompt.press("1");
    prompt.press("\r");
    prompt.press(paste("Keep this constraint"));
    prompt.press("\x1b");
    prompt.press("\x1b[A");
    prompt.press("\r");
    prompt.press(paste("Another approach"));
    assert.match(prompt.press("\r"), /Keep this constraint/);
    prompt.press("\x1b");
    assert.match(prompt.press("\r"), /Another approach/);
    assert.match(prompt.press("\r"), /Keep this constraint/);
    prompt.press("\r");
    assert.deepEqual((await prompt.result).details.response, {
      kind: "selection", selections: ["First", "Another approach"], comment: "Keep this constraint",
    });
  });

  await t.test("changing a choice preserves a long pasted comment draft", async (t) => {
    const prompt = open({ allowComment: true, options: shortOptions });
    t.after(() => prompt.close());
    const note = "Keep this constraint. ".repeat(150).trim();
    prompt.press("\x07");
    prompt.press("\r");
    prompt.press(paste(note));
    prompt.press("\x1b");
    prompt.press("\x1b[B");
    prompt.press("\r");
    prompt.press("\r");
    assert.deepEqual((await prompt.result).details.response, {
      kind: "selection", selections: ["Second"], comment: note,
    });
  });

  await t.test("short descriptions and separate previews stay readable in wide and stacked layouts", async (t) => {
    for (const [width, singleSelectLayout] of [[120, "auto"], [70, "auto"], [120, "list"]]) {
      const preview = Array.from({ length: 30 }, (_, i) => `PREVIEW_${String(i).padStart(2, "0")}`).join("\n");
      const prompt = open({ singleSelectLayout, options: [{ title: "First", description: "Brief summary", preview }] });
      t.after(() => prompt.close());
      assert.equal(prompt.tool.parameters.properties.options.items.properties.preview.type, "string");
      const seen = new Set();
      for (let i = 0; i < 100; i++) {
        const screen = prompt.render(width);
        assert.match(screen, /Brief summary/);
        assert.ok(screen.split("\n").every((line) => visibleWidth(line) <= width));
        assert.ok(screen.split("\n").length <= 20);
        for (const line of screen.match(/PREVIEW_\d+/g) ?? []) seen.add(line);
        prompt.press("\x1b[C", width);
      }
      assert.equal(seen.size, 30);
      prompt.press("\r", width);
      assert.equal((await prompt.result).details.options[0].preview, preview);
    }
  });

  await t.test("Ctrl+G edits the full custom draft without submitting it", async (t) => {
    const fixture = editorFixture(t);
    const prompt = open({ options: shortOptions }, 24, { cwd: fixture.cwd, trusted: true });
    t.after(() => prompt.close());
    const draft = "Full pasted answer. ".repeat(150).trim();
    prompt.press("\x1b[A");
    prompt.press("\r");
    prompt.press(paste(draft));
    assert.match(prompt.render(), /ctrl\+g external editor/);
    prompt.press("\x07");
    prompt.press("\x07");
    await prompt.waitForEditor();
    const capture = JSON.parse(readFileSync(fixture.capture, "utf8"));
    assert.equal(capture.text, draft);
    if (process.platform !== "win32") assert.equal(capture.mode, 0o600);
    assert.equal(existsSync(capture.file), false);
    assert.deepEqual(prompt.calls, ["stop", "start"]);
    let answered = false;
    prompt.result.then(() => { answered = true; });
    await nextTurn();
    assert.equal(answered, false);
    prompt.press("\r");
    assert.deepEqual((await prompt.result).details.response, { kind: "freeform", text: "Edited answer" });
  });

  await t.test("Ctrl+G edits comments and works for questions without options", async (t) => {
    const fixture = editorFixture(t);
    for (const comment of [true, false]) {
      const prompt = open({ options: comment ? shortOptions : [], allowComment: comment }, 24, { cwd: fixture.cwd, trusted: true });
      t.after(() => prompt.close());
      if (comment) {
        prompt.press("\x07");
        prompt.press("\r");
      }
      prompt.press("\x07");
      await prompt.waitForEditor();
      prompt.press("\r");
      assert.deepEqual((await prompt.result).details.response, comment
        ? { kind: "selection", selections: ["First"], comment: "Edited answer" }
        : { kind: "freeform", text: "Edited answer" });
    }
  });

  await t.test("failed external editors preserve the draft and restore the TUI", async (t) => {
    const fixture = editorFixture(t, 'writeFileSync(file, "Incomplete edit"); process.exit(2);');
    const prompt = open({ options: shortOptions }, 24, { cwd: fixture.cwd, trusted: true });
    t.after(() => prompt.close());
    prompt.press("\x1b[A");
    prompt.press("\r");
    prompt.press(paste("Original answer"));
    prompt.press("\x07");
    await prompt.waitForEditor();
    assert.deepEqual(prompt.calls, ["stop", "start"]);
    assert.equal(prompt.notifications.length, 1);
    assert.equal(existsSync(JSON.parse(readFileSync(fixture.capture, "utf8")).file), false);
    prompt.press("\r");
    assert.deepEqual((await prompt.result).details.response, { kind: "freeform", text: "Original answer" });
  });

  await t.test("aborting an external edit stops the child before the tool finishes", async (t) => {
    const fixture = editorFixture(t, 'setTimeout(() => {}, 10000);');
    const prompt = open({ options: shortOptions }, 24, { cwd: fixture.cwd, trusted: true });
    t.after(() => prompt.close());
    prompt.press("\x1b[A");
    prompt.press("\r");
    prompt.press("\x07");
    for (let i = 0; i < 100 && !existsSync(fixture.capture); i++) await delay(10);
    assert.ok(existsSync(fixture.capture), "The editor must start before cancellation");
    prompt.controller.abort();
    assert.equal((await prompt.result).details.cancelled, true);
    assert.deepEqual(prompt.calls, ["stop", "start"]);
    assert.equal(existsSync(JSON.parse(readFileSync(fixture.capture, "utf8")).file), false);
  });

  await t.test("external editing honors configured keys and project trust", async (t) => {
    const fixture = editorFixture(t);
    const environmentEditor = join(fixture.cwd, "environment-editor.mjs");
    writeFileSync(environmentEditor, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv.at(-1), "Environment answer\\n");');
    process.env.VISUAL = `${process.execPath} ${environmentEditor}`;
    process.env.EDITOR = process.env.VISUAL;
    for (const trusted of [false, true]) {
      const prompt = open({ options: shortOptions }, 24, {
        cwd: fixture.cwd, trusted, bindings: { "app.editor.external": "ctrl+x" },
      });
      t.after(() => prompt.close());
      prompt.press("\x1b[A");
      prompt.press("\r");
      assert.match(prompt.render(), /ctrl\+x external editor/);
      prompt.press("\x18");
      await prompt.waitForEditor();
      prompt.press("\r");
      const configured = trusted && typeof SettingsManager.prototype.getExternalEditorCommand === "function";
      assert.equal((await prompt.result).details.response.text, configured ? "Edited answer" : "Environment answer");
    }
  });

  await t.test("prompt timeouts also close an active external editor", async (t) => {
    const fixture = editorFixture(t, 'setTimeout(() => {}, 10000);');
    const prompt = open({ options: shortOptions, timeout: 1500 }, 24, { cwd: fixture.cwd, trusted: true });
    t.after(() => prompt.close());
    prompt.press("\x1b[A");
    prompt.press("\r");
    prompt.press("\x07");
    assert.equal((await prompt.result).details.cancelled, true);
    assert.equal(prompt.controller.signal.aborted, false);
    assert.deepEqual(prompt.calls, ["stop", "start"]);
    assert.equal(existsSync(JSON.parse(readFileSync(fixture.capture, "utf8")).file), false);
  });

  await t.test("free-text questions still use the native input fallback outside the custom UI", async (t) => {
    const prompt = open();
    t.after(() => prompt.close());
    for (const custom of [undefined, async () => undefined]) {
      const result = await prompt.tool.execute("rpc-freeform", { question: "Your answer?" }, undefined, undefined, {
        hasUI: true,
        ui: { custom, input: async () => "Native dialog answer" },
      });
      assert.deepEqual(result.details.response, { kind: "freeform", text: "Native dialog answer" });
    }
  });

  await t.test("batch questions keep checked options alongside an externally edited answer", async (t) => {
    const fixture = editorFixture(t);
    const prompt = open({
      question: undefined, context: undefined, options: undefined, allowFreeform: undefined,
      questions: [
        { question: "Choose several", options: shortOptions, allowMultiple: true },
        { question: "Choose another", options: shortOptions },
      ],
    }, 24, { cwd: fixture.cwd, trusted: true });
    t.after(() => prompt.close());
    prompt.press("1");
    prompt.press("2");
    prompt.press("\x1b[B");
    prompt.press("\r");
    prompt.press("\x07");
    await prompt.waitForEditor();
    prompt.press("\r");
    prompt.press("\r");
    prompt.press("\r");
    assert.deepEqual((await prompt.result).details.answers, [
      { status: "answered", response: { kind: "selection", selections: ["First", "Second", "Edited answer"] } },
      { status: "answered", response: { kind: "selection", selections: ["First"] } },
    ]);
  });

  await t.test("Ctrl+A resize mode changes the mounted popup and gives details more height", async (t) => {
    const prompt = open({}, 40, { nativeOverlay: true, columns: 150 });
    t.after(() => prompt.close());
    const initial = prompt.frame();
    assert.match(initial.text, /ctrl\+a resize/);
    prompt.component.handleInput("\x01");
    let before = prompt.frame();
    assert.match(before.text, /h\/l width/);
    assert.equal(before.height, initial.height);
    for (const [key, columns, rows] of [["h", -2, 0], ["l", 2, 0], ["j", 0, 1], ["k", 0, -1]]) {
      prompt.component.handleInput(key);
      const after = prompt.frame();
      assert.equal(after.width, before.width + columns, `${key} width`);
      assert.equal(after.height, before.height + rows, `${key} height`);
      if (key === "j") assert.ok((after.text.match(/DETAIL_\d+/g) ?? []).length > (before.text.match(/DETAIL_\d+/g) ?? []).length);
      before = after;
    }
    let answered = false;
    prompt.result.then(() => { answered = true; });
    prompt.component.handleInput("\x1b");
    assert.doesNotMatch(prompt.frame().text, /h\/l width/);
    await nextTurn();
    assert.equal(answered, false);
    prompt.component.handleInput("\r");
    assert.deepEqual((await prompt.result).details.response, { kind: "selection", selections: ["First"] });
  });

  await t.test("resize clamps to terminal bounds and handles repeated keys between renders", async (t) => {
    const prompt = open({}, 20, { nativeOverlay: true, columns: 80 });
    t.after(() => prompt.close());
    prompt.frame();
    prompt.component.handleInput("\x01");
    prompt.frame();
    for (let i = 0; i < 150; i++) prompt.component.handleInput("h");
    assert.equal(prompt.frame().width, 40);
    for (let i = 0; i < 100; i++) prompt.component.handleInput("k");
    assert.equal(prompt.frame().height, 8);
    for (let i = 0; i < 150; i++) prompt.component.handleInput("l");
    for (let i = 0; i < 100; i++) prompt.component.handleInput("j");
    const maximum = prompt.frame();
    assert.equal(maximum.width, 78);
    assert.equal(maximum.height, 18);
    assert.ok(maximum.col >= 1 && maximum.row >= 1);
    prompt.terminal.columns = 55;
    prompt.terminal.rows = 12;
    assert.equal(prompt.frame().width, 53);
    assert.equal(prompt.frame().height, 10);
    prompt.component.handleInput("k");
    assert.equal(prompt.frame().height, 9);
    prompt.component.handleInput("\x03");
    assert.equal((await prompt.result).details.cancelled, true);
  });

  await t.test("resizing preserves checked choices, custom text, and comments", async (t) => {
    const prompt = open({ options: shortOptions, allowMultiple: true, allowComment: true });
    t.after(() => prompt.close());
    prompt.press("\x07");
    prompt.press("1");
    prompt.press("2");
    prompt.press("\x01");
    for (const key of ["h", "j", "k", "l"]) prompt.press(key);
    assert.equal((prompt.press("\x1b").match(/\[✓\]/g) ?? []).length, 3);
    prompt.press("\x1b[B");
    prompt.press("\x1b[B");
    prompt.press("\r");
    prompt.press(paste("My own answer"));
    prompt.press("\x01");
    for (const key of ["h", "j", "k", "l"]) prompt.press(key);
    prompt.press("\r");
    assert.match(prompt.render(), /My own answer/);
    prompt.press("\r");
    prompt.press(paste("Keep my comment"));
    prompt.press("\x01");
    prompt.press("j");
    prompt.press("\x1b");
    prompt.press("\r");
    assert.deepEqual((await prompt.result).details.response, {
      kind: "selection", selections: ["First", "Second", "My own answer"], comment: "Keep my comment",
    });
  });

  await t.test("batch pages and the review screen share popup dimensions", async (t) => {
    const prompt = open({
      question: undefined, context: undefined, options: undefined, allowFreeform: undefined,
      questions: [
        { question: "First question", options: shortOptions },
        { question: "Second question", options: shortOptions },
      ],
    }, 35, { nativeOverlay: true, columns: 150 });
    t.after(() => prompt.close());
    prompt.frame();
    prompt.component.handleInput("\x01");
    prompt.frame();
    prompt.component.handleInput("j");
    const resized = prompt.frame();
    prompt.component.handleInput("\r");
    prompt.component.handleInput("\r");
    assert.equal(prompt.frame().height, resized.height);
    prompt.component.handleInput("\r");
    assert.match(prompt.frame().text, /Review answers/);
    prompt.component.handleInput("\x01");
    prompt.frame();
    prompt.component.handleInput("j");
    assert.equal(prompt.frame().height, resized.height + 1);
    prompt.component.handleInput("\r");
    assert.match(prompt.frame().text, /Review answers/);
    prompt.component.handleInput("\r");
    assert.equal((await prompt.result).details.answers.length, 2);
  });

  await t.test("Ctrl+A repeat/release events do not toggle resize mode twice", async (t) => {
    const prompt = open();
    t.after(() => prompt.close());
    prompt.render();
    assert.match(prompt.press("\x1b[97;5:1u"), /h\/l width/);
    assert.match(prompt.press("\x1b[97;5:2u"), /h\/l width/);
    assert.match(prompt.press("\x1b[97;5:3u"), /h\/l width/);
    assert.doesNotMatch(prompt.press("\x01"), /h\/l width/);
    let answered = false;
    prompt.result.then(() => { answered = true; });
    for (const [exitKey, repeated] of [["\r", "\x1b[13;1:2u"], ["\x1b", "\x1b[27;1:2u"]]) {
      prompt.press("\x01");
      prompt.press(exitKey);
      prompt.press(repeated);
      await nextTurn();
      assert.equal(answered, false, "Holding the resize-exit key must not submit or cancel");
    }
  });

  await t.test("collapsing context gives its spare rows to details in a resized popup", async (t) => {
    const prompt = open({ context, contextExpanded: true }, 40, { nativeOverlay: true, columns: 150 });
    t.after(() => prompt.close());
    prompt.frame();
    prompt.component.handleInput("\x01");
    prompt.frame();
    for (let i = 0; i < 4; i++) prompt.component.handleInput("j");
    prompt.frame();
    prompt.component.handleInput("\x1b");
    const before = prompt.frame();
    prompt.component.handleInput("\x05");
    const after = prompt.frame();
    assert.equal(after.height, before.height);
    assert.ok((after.text.match(/DETAIL_\d+/g) ?? []).length > (before.text.match(/DETAIL_\d+/g) ?? []).length + 5);
  });

  await t.test("inline editors retain Ctrl+A line-start behavior", async (t) => {
    const prompt = open({ options: shortOptions, displayMode: "inline" });
    t.after(() => prompt.close());
    assert.doesNotMatch(prompt.render(), /ctrl\+a resize/);
    prompt.press("\x1b[A");
    prompt.press("\r");
    prompt.press(paste("original"));
    prompt.press("\x01");
    prompt.press("X");
    prompt.press("\r");
    assert.deepEqual((await prompt.result).details.response, { kind: "freeform", text: "Xoriginal" });
  });
});
