# FreeFEM debugger

The extension contains a debug adapter for FreeFEM scripts (`.edp`): breakpoints
in the gutter, step over / into / out, call stack, variables, a Debug Console
that runs FreeFEM statements against the live state, and Pause.

## Requirements

A `FreeFem++` built with the debugger support: the `debugger` branch of
[FreeFem-sources](https://github.com/FreeFem/FreeFem-sources/tree/debugger). A
stock FreeFEM has no debug channel; launching it under the debugger ends, after
30 seconds, with "The interpreter did not connect to the debugger".

`FreeFem++` must be on `PATH`, or set the `freefem.executable` setting. Other
setting: `freefem.ffglut` (plot viewer, passed as `-glut`; empty = let
`FreeFem++` find its own).

## Use

1. Open a `.edp` file and click in the margin just left of a line number: a red
   dot appears (click again to remove it). Breakpoints can be added and removed
   while the program is running.
2. Start the program under the debugger: **F5**, the **Debug current FreeFEM
   file** button in the editor title bar, or the command of the same name. It
   runs in a terminal called "FreeFEM debug", so `cin`, `ffglut` and Ctrl-C work as
   usual.
3. At a breakpoint the line is highlighted. **Variables** lists the script's
   top-level variables (scalars with their values), **Call Stack** shows the
   functions and the line each was called from, and the **Debug Console** takes
   FreeFEM statements to run against the live state: `plot(u);`,
   `cout << u[].max << endl;`, `a = 7;`. Hovering a variable, or a Watch, evaluates
   it too. The toolbar has Continue (F5), Step Over (F10), Step Into (F11), Step
   Out (⇧F11), **Pause** (stops a running program at its next statement) and Stop.

A plain **Run** (`freefem.runFile`) ignores breakpoints; only a debug session
honours them.

`"stopOnEntry": true` in a launch configuration stops before the first statement;
`launch.json` also accepts `args`, `cwd`, `executable` and `ffglut`:

```json
{
    "type": "freefem",
    "request": "launch",
    "name": "FreeFEM: debug current file",
    "program": "${file}",
    "stopOnEntry": false
}
```

When the program stops at a breakpoint or on Pause the Debug Console prints the
variable listing by itself (`-- Breakpoint at exemple.edp:104 --`, then
`name : type = value` lines; meshes, fespaces, arrays and matrices show their kind
instead of a value). The `pause>` console commands also work in the Debug
Console: `vars` lists them again, `resume` continues, `kill` ends the program.

A breakpoint on a blank or comment line moves down to the next code line. A
breakpoint on a line *inside* a `for`/`if`/block stops at that inner statement,
once per execution; on the header line it stops at the header. Conditional
breakpoints, logpoints and hit counts are not supported yet. Pause waits for the
current statement to finish, so a long single `solve` delays it.

## Debug channel (interpreter side)

Implemented in FreeFem-sources, `src/fflib/AFunction.cpp` (search for "VSCode
debugger support"), hooked into `ListOfInst::operator()` in `AFunction2.cpp`; the
lexer and the `instructions` rule of the grammar record each statement's first
line. **Off by default**: it is activated only when the environment variable
`FF_DEBUG_SOCKET` names a Unix socket that a debug adapter is already listening
on; otherwise the only cost is one `bool` test per statement. A Unix socket (rather
than inherited pipes) lets the interpreter run in a real terminal with its own
stdin/stdout, and `ffglut`/`system()` children never inherit the connection. Not
available on Windows (compiled out).

The interpreter connects at its first statement and stops there (`entry`).

Wire format: one message per line, fields separated by TAB; free text escaped
as `\\ \n \t \r`.

| interpreter → adapter | meaning |
|---|---|
| `hello 1 <pid>` | protocol version and process id (so the adapter can signal it) |
| `stopped <reason> <path> <lo> <hi>` | stopped; `reason` = `entry`, `breakpoint`, `step`, `pause`. The statement covers source lines `lo..hi` of the (canonical) `path` |
| `frame <i> <name> <path> <lo> <hi>` … `end` | reply to `stack`; frame 0 is innermost, the last is `(script)` |
| `var <name> <type> <value>` … `end` | reply to `vars`; value only for `int`/`real`/`bool`/`complex` |
| `result <rc> <text>` `end` | reply to `eval`; `rc` 0 = ok, `text` = captured output/errors |
| `exited` | the top-level statement list finished |

| adapter → interpreter | meaning |
|---|---|
| `setbreaks <path> <l1,l2,…>` | replace the breakpoints of one file (empty list clears). Accepted while stopped **and** while running |
| `go` / `stepin` / `next` / `stepout` | resume; `next` stays at the current call depth, `stepout` stops in the caller |
| `stack` / `vars` | ask for frames / variables (only while stopped) |
| `eval <statement>` | run a FreeFEM statement against the stopped state, e.g. `cout << u[].max << endl;` (only while stopped) |
| `pause` | stop at the next statement (polled every 64 statements; a long single statement such as a big `solve` delays it) |
| `quit` | end the process |

Closing the socket also ends the process, so a vanished adapter never leaves a
paused interpreter behind. The adapter is `src/debug/adapter.ts`; it translates
the Debug Adapter Protocol to the lines above and has no dependency on `vscode`.

### Semantics worth knowing

- **Granularity is the statement**, as recorded when the script was parsed
  (FreeFEM parses the whole script first, then executes it). A statement's range
  `lo..hi` is exact for simple, multi-line and compound statements (`for`,
  `if`/`else`, blocks).
- A statement that is the direct body of an `if`/`for`/`while` **without braces**
  is not a separate stop; use braces to be able to stop inside.
- A `for` loop is reported once (FreeFEM wraps it in an extra one-statement
  scope; the duplicate stop is suppressed).
- `vars` lists the **top-level scope** only (not locals of functions or loop
  variables), and values only for scalars: reading a mesh or finite-element
  function that has not been constructed yet would dereference garbage. Use
  `eval` for those, e.g. `cout << u[].max << endl;`.
- `eval` runs through the same nested-compile machinery as `pause()`: each
  snippet gets its own scope (a variable declared there disappears afterwards),
  and a snippet that fails to parse is cleaned up completely so it cannot affect
  the next one.
- Statements from `include`d files carry their own file and line numbers.

## Tests

The tests are in `test/debugger/` and are not part of the packaged extension.

```sh
npm run test:debugger              # extension wiring against a mocked `vscode` API; needs no FreeFEM
npm run test:debugger:interpreter  # adapter + protocol tests; need a debugger-enabled FreeFem++
```

`FF_BIN=/path/to/FreeFem++` selects the interpreter (default: `FreeFem++` from
`PATH`). `suite.py` (Python 3 only) plays the adapter's role against the real
interpreter and checks the whole protocol (handshake, breakpoints and line moves,
variables, eval and error recovery, step in/out/over with frames, async pause,
quit, includes, exit notification). `adapter.test.js` plays VSCode against the
compiled adapter and the real interpreter, headlessly (the requests the UI sends
for a gutter click, F5, step, variables, Debug Console, Pause, Stop).
`varfblock.edp` is a regression script for a grammar fix that the debugger needs;
its last line must be `varf block OK`.
