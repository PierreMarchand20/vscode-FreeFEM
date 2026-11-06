// Loads the compiled extension (out/extension.js) against a mock of the
// `vscode` API and checks the debugger wiring: the freefem.debugFile command,
// the debug configuration provider, the adapter factory and the tracker.
// Needs no FreeFEM install (a fake FreeFem++ is put on PATH).
// Usage: npm run compile && node test/debugger/extension-mock.test.js
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");

const log = { commands: {}, messages: [], out: [], debugStarts: [], providers: {}, factories: {}, trackers: {}, executed: [] };
const cfg = { executable: "", ffglut: "" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ff mock "));
const edp = path.join(tmp, "my script.edp");
fs.writeFileSync(edp, "cout << 1;\n");
const fakeBin = path.join(tmp, "bin");
fs.mkdirSync(fakeBin);
const fakeExe = path.join(fakeBin, process.platform === "win32" ? "FreeFem++.exe" : "FreeFem++");
fs.writeFileSync(fakeExe, "#!/bin/sh\n", { mode: 0o755 });
process.env.PATH = fakeBin + path.delimiter + process.env.PATH;

let saved = false;
const vscode = {
  commands: {
    registerCommand: (id, fn) => { log.commands[id] = fn; return { dispose() {} }; },
    executeCommand: async (id) => (log.commands[id] ? log.commands[id]() : log.executed.push(id)),
  },
  window: {
    activeTextEditor: { document: { isUntitled: false, languageId: "freefem", uri: { fsPath: edp }, save: async () => { saved = true; } } },
    createOutputChannel: () => ({ dispose() {}, appendLine: (l) => log.out.push(l) }),
    showWarningMessage: async (m) => log.messages.push(m),
    showErrorMessage: async (m) => log.messages.push(m),
  },
  workspace: { getConfiguration: () => ({ get: (k) => cfg[k] }) },
  debug: {
    registerDebugConfigurationProvider: (type, p) => { log.providers[type] = p; return { dispose() {} }; },
    registerDebugAdapterDescriptorFactory: (type, f) => { log.factories[type] = f; return { dispose() {} }; },
    registerDebugAdapterTrackerFactory: (type, f) => { log.trackers[type] = f; return { dispose() {} }; },
    startDebugging: async (folder, c) => { log.debugStarts.push(c); return true; },
  },
  EventEmitter: class { constructor() { this.ls = []; this.event = (l) => { this.ls.push(l); return { dispose() {} }; }; } fire(x) { this.ls.forEach((l) => l(x)); } },
  DebugAdapterInlineImplementation: class { constructor(impl) { this.impl = impl; } },
};
const shiki = { getHighlighter: async () => ({ codeToHtml: () => "" }) };
const orig = Module._load;
Module._load = function (req, ...a) {
  if (req === "vscode") { return vscode; }
  if (req === "shiki") { return shiki; }
  return orig.call(this, req, ...a);
};

(async () => {
  const ext = require(path.join(__dirname, "..", "..", "out", "extension.js"));
  await ext.activate({ extensionPath: path.join(__dirname, "..", ".."), subscriptions: [], asAbsolutePath: (p) => p });
  assert.ok("freefem.runFile" in log.commands && "freefem.debugFile" in log.commands, "run and debug commands registered");

  // ---- freefem.debugFile starts a session on the active file ----
  await log.commands["freefem.debugFile"]();
  assert.ok(saved, "saves the document first");
  assert.strictEqual(log.debugStarts.length, 1);
  assert.strictEqual(log.debugStarts[0].type, "freefem");
  assert.strictEqual(log.debugStarts[0].program, edp);

  // ---- F5 with no launch.json, then variable substitution ----
  const prov = log.providers["freefem"];
  const empty = prov.resolveDebugConfiguration(undefined, {});
  assert.ok(empty.type === "freefem" && empty.request === "launch" && empty.program === "${file}", JSON.stringify(empty));
  const full = prov.resolveDebugConfigurationWithSubstitutedVariables(undefined, { type: "freefem", request: "launch", program: edp });
  assert.strictEqual(full.executable, fakeExe, JSON.stringify(full));
  assert.strictEqual(prov.resolveDebugConfigurationWithSubstitutedVariables(undefined, { type: "freefem", request: "launch" }), undefined, "no program -> refused");

  // ---- an explicit but missing interpreter is reported, not run ----
  const n0 = log.messages.length;
  const bad = prov.resolveDebugConfigurationWithSubstitutedVariables(undefined, { type: "freefem", request: "launch", program: edp, executable: "/nonexistent/FreeFem++" });
  assert.strictEqual(bad, undefined);
  assert.ok(log.messages.length === n0 + 1 && /not found/.test(log.messages[n0]), "missing interpreter is reported");
  cfg.executable = fakeExe;
  assert.strictEqual(prov.resolveDebugConfigurationWithSubstitutedVariables(undefined, { type: "freefem", request: "launch", program: edp }).executable, fakeExe, "freefem.executable setting is used");
  cfg.executable = "";

  // ---- the adapter built by the factory speaks DAP ----
  const desc = log.factories["freefem"].createDebugAdapterDescriptor({});
  const got = [];
  desc.impl.onDidSendMessage((m) => got.push(m));
  desc.impl.handleMessage({ seq: 1, type: "request", command: "initialize", arguments: { supportsRunInTerminalRequest: true } });
  assert.ok(got.some((m) => m.type === "response" && m.success && m.body.supportsConfigurationDoneRequest), "initialize answered");
  assert.ok(got.some((m) => m.type === "event" && m.event === "initialized"), "initialized event sent");
  desc.impl.dispose();

  // ---- stopping at a breakpoint brings the Debug Console input forward ----
  const trk = log.trackers["freefem"].createDebugAdapterTracker({});
  trk.onDidSendMessage({ type: "event", event: "stopped", body: { reason: "step" } });
  assert.deepStrictEqual(log.executed, [], "a plain step does not steal focus");
  trk.onDidSendMessage({ type: "event", event: "stopped", body: { reason: "breakpoint" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(log.executed, ["workbench.debug.action.focusRepl"], "a breakpoint stop focuses the Debug Console");

  fs.rmSync(tmp, { recursive: true });
  console.log("extension-mock.test.js: all assertions passed");
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
