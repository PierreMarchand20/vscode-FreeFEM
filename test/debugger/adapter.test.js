// Plays VSCode's role against adapter.js and a real interpreter, headlessly:
// the DAP requests below are exactly what the UI sends when you click the
// gutter, press F5, then use Continue/Step/Variables/Debug Console.
// Usage: node adapter.test.js        (FF_BIN overrides the interpreter)
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const { spawn } = require("child_process");
const { FreeFemDebugAdapter } = require("../../out/debug/adapter");
const EXE = process.env.FF_BIN || "FreeFem++";
const PROG = path.join(__dirname, "adaptertest.edp");
const LOOP = path.join(__dirname, "loop.edp");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond, detail) => { if (!cond) { console.log("FAIL " + name + (detail ? "  -> " + JSON.stringify(detail) : "")); process.exitCode = 1; throw new Error(name); } passed++; console.log("PASS " + name); };

class Client {
  constructor() {
    this.seq = 1; this.resp = new Map(); this.events = []; this.waiters = []; this.child = null; this.exit = null;
    this.out = path.join(os.tmpdir(), "ffadapter-test-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".log");
    this.adapter = new FreeFemDebugAdapter((m) => this.onMessage(m), { executable: EXE, ffglut: null });
  }
  onMessage(m) {
    if (m.type === "response") { const r = this.resp.get(m.request_seq); if (r) { this.resp.delete(m.request_seq); r(m); } }
    else if (m.type === "event") { this.events.push(m); this.waiters = this.waiters.filter((w) => !w(m)); }
    else if (m.type === "request" && m.command === "runInTerminal") {
      const a = m.arguments; this.rit = a;
      const fd = fs.openSync(this.out, "w");
      this.child = spawn(a.args[0], a.args.slice(1), { cwd: a.cwd, env: Object.assign({}, process.env, a.env), stdio: ["ignore", fd, fd] });
      this.child.on("exit", (code, sig) => { this.exit = { code, sig }; });
      this.adapter.handleMessage({ seq: 1000 + this.seq++, type: "response", request_seq: m.seq, success: true, command: "runInTerminal", body: { processId: this.child.pid } });
    }
  }
  request(command, args) {
    return new Promise((res) => { const seq = this.seq++; this.resp.set(seq, res); this.adapter.handleMessage({ seq, type: "request", command, arguments: args }); });
  }
  event(name, ms = 25000) {
    const i = this.events.findIndex((e) => e.event === name);
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting for event " + name)), ms);
      this.waiters.push((e) => { if (e.event !== name) return false; clearTimeout(t); this.events.splice(this.events.indexOf(e), 1); res(e); return true; });
    });
  }
  async frames() { const r = await this.request("stackTrace", { threadId: 1 }); return r.body.stackFrames; }
  async start(program, { stopOnEntry = false, args = ["-nw"] } = {}) {
    const init = await this.request("initialize", { adapterID: "freefem", supportsRunInTerminalRequest: true });
    check("initialize succeeds with configurationDone support", init.success && init.body.supportsConfigurationDoneRequest, init);
    await this.event("initialized");
    const l = await this.request("launch", { program, stopOnEntry, args });
    check("launch asks the client to run the interpreter in a terminal", l.success && this.rit && this.rit.args.includes(program) && this.rit.args.includes("-cd") && this.rit.env.FF_DEBUG_SOCKET, l);
  }
  async finish() {
    try { await this.request("disconnect", {}); } catch (e) { /* ignore */ }
    for (let i = 0; i < 50 && this.child && this.exit === null; i++) await sleep(100);
    if (this.child && this.exit === null) this.child.kill("SIGKILL");
    this.adapter.dispose();
    this.output = fs.existsSync(this.out) ? fs.readFileSync(this.out, "utf8") : "";
    try { fs.unlinkSync(this.out); } catch (e) { /* none */ }
  }
}

(async () => {
  // ---- 1. the user clicks the gutter, presses F5, steps, inspects, continues ----
  let c = new Client();
  await c.start(PROG);
  const sb = await c.request("setBreakpoints", { source: { path: PROG }, breakpoints: [{ line: 4 }, { line: 13 }] });
  check("breakpoint on a comment line moves to the next code line (4 -> 5), line 13 stays",
    sb.success && sb.body.breakpoints[0].line === 5 && sb.body.breakpoints[0].verified && sb.body.breakpoints[1].line === 13, sb.body);
  await c.request("setExceptionBreakpoints", { filters: [] });
  check("configurationDone", (await c.request("configurationDone", {})).success);
  let st = await c.event("stopped");
  check("stops at the breakpoint", st.body.reason === "breakpoint" && st.body.threadId === 1, st.body);
  const ann = await c.event("output");
  check("variables are listed in the Debug Console automatically at the breakpoint",
    /^-- Breakpoint at adaptertest\.edp:5 --\n/.test(ann.body.output) && /\n  x : real = 2\n/.test(ann.body.output) && /\n  y : real = 0\n/.test(ann.body.output), ann.body.output);
  check("...without the internal [..] entries", !/\[/.test(ann.body.output), ann.body.output);
  let fr = await c.frames();
  check("stack frame is the script at line 5, with its source", fr.length === 1 && fr[0].name === "(script)" && fr[0].line === 5 && fs.realpathSync(fr[0].source.path) === fs.realpathSync(PROG), fr);
  const sc = await c.request("scopes", { frameId: 0 });
  const vs = (await c.request("variables", { variablesReference: sc.body.scopes[0].variablesReference })).body.variables;
  const vx = vs.find((v) => v.name === "x");
  check("Variables panel shows x = 2 (real)", vx && vx.value === "2" && vx.type === "real", vs);
  let ev = await c.request("evaluate", { expression: "vars;", context: "repl" });
  check("'vars;' typed in the Debug Console lists the variables", ev.success && /  x : real = 2/.test(ev.body.result) && /  sq : func/.test(ev.body.result), ev);
  ev = await c.request("evaluate", { expression: "cout << x*10 << endl;", context: "repl" });
  check("Debug Console statement runs against the live state", ev.success && ev.body.result === "20", ev);
  ev = await c.request("evaluate", { expression: "x+1", context: "watch" });
  check("watch expression is evaluated as a value", ev.success && ev.body.result === "3", ev);
  ev = await c.request("evaluate", { expression: "nosuchvar", context: "hover" });
  check("an error in an expression is reported, not fatal", !ev.success && /nosuchvar/.test(ev.message), ev);
  ev = await c.request("evaluate", { expression: "cout << y << endl;", context: "repl" });
  check("session still usable after the error", ev.success && ev.body.result === "0", ev);   // y not assigned yet
  check("next", (await c.request("next", { threadId: 1 })).success);
  st = await c.event("stopped"); fr = await c.frames();
  check("next stops on line 10 (the func definition has no statement of its own)", st.body.reason === "step" && fr[0].line === 10, fr);
  check("stepIn", (await c.request("stepIn", { threadId: 1 })).success);
  st = await c.event("stopped"); fr = await c.frames();
  check("stepIn enters sq: frames [sq line 8, (script) line 10]", fr.length === 2 && fr[0].name === "sq" && fr[0].line === 8 && fr[1].name === "(script)" && fr[1].line === 10, fr);
  ev = await c.request("evaluate", { expression: "cout << y << endl;", context: "repl" });
  check("a script variable is visible from inside the function", ev.success && ev.body.result === "6", ev);
  check("stepOut", (await c.request("stepOut", { threadId: 1 })).success);
  st = await c.event("stopped"); fr = await c.frames();
  check("stepOut returns to the script (the for statement, line 11)", fr.length === 1 && fr[0].line === 11, fr);
  check("continue", (await c.request("continue", { threadId: 1 })).success);
  st = await c.event("stopped"); fr = await c.frames();
  check("breakpoint inside the loop body (line 13), first iteration", st.body.reason === "breakpoint" && fr[0].line === 13, fr);
  await c.request("continue", { threadId: 1 });
  st = await c.event("stopped"); fr = await c.frames();
  check("...and second iteration", fr[0].line === 13, fr);
  await c.request("setBreakpoints", { source: { path: PROG }, breakpoints: [] });
  await c.request("continue", { threadId: 1 });
  await c.event("terminated");
  check("terminated event when the script ends", true);
  await c.finish();
  check("script produced its normal output (z=37)", /\nz=37/.test(c.output), c.output.slice(-200));

  // ---- 2. stop on entry ----
  c = new Client(); await c.start(PROG, { stopOnEntry: true });
  await c.request("configurationDone", {});
  st = await c.event("stopped"); fr = await c.frames();
  check("stopOnEntry stops before the first statement, shown at its code line (2)", st.body.reason === "entry" && fr[0].line === 2, [st.body, fr]);
  const ann2 = await c.event("output");
  check("variables are listed on entry too", /^-- Stopped on entry at adaptertest\.edp:2 --/.test(ann2.body.output), ann2.body.output);
  ev = await c.request("evaluate", { expression: "resume;", context: "repl" });
  check("'resume;' in the Debug Console continues the program", ev.success, ev);
  await c.event("continued"); await c.event("terminated"); await c.finish();

  // ---- 3. Pause button on a running program, then Stop ----
  c = new Client(); await c.start(LOOP);
  await c.request("configurationDone", {});
  await sleep(500);
  const pr = await c.request("pause", { threadId: 1 });
  st = await c.event("stopped");
  check("Pause stops a running loop", pr.success && st.body.reason === "pause", st.body);
  const ann3 = await c.event("output");
  check("variables are listed when paused", /^-- Paused at loop\.edp:\d+ --\n/.test(ann3.body.output) && /  s : real = /.test(ann3.body.output), ann3.body.output);
  ev = await c.request("evaluate", { expression: "s", context: "watch" });
  check("loop variable has advanced", ev.success && parseFloat(ev.body.result) > 0, ev);
  ev = await c.request("evaluate", { expression: "kill;", context: "repl" });
  for (let i = 0; i < 60 && c.exit === null; i++) await sleep(100);
  check("'kill;' in the Debug Console ends the interpreter process", ev.success && c.exit !== null, c.exit);
  await c.event("terminated");
  await c.finish();

  console.log("\nadapter.test.js: " + passed + " checks passed");
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
