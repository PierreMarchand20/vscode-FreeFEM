// Debug adapter: translates VSCode's Debug Adapter Protocol (DAP) to the
// interpreter's line protocol (see docs/debugger.md, "Debug channel"). It does
// not import `vscode`, so it can be driven and tested from plain Node
// (test/debugger/adapter.test.js).
//
//   new FreeFemDebugAdapter(send, opts)
//     send(message)      called with every outgoing DAP message (responses,
//                        events, and the reverse request `runInTerminal`)
//     handleMessage(m)   feed it every incoming DAP message (requests and the
//                        response to runInTerminal)
//
// The interpreter runs in a real terminal (DAP `runInTerminal`) so cin, ffglut
// and Ctrl-C keep working; it connects back over a Unix socket named in the
// environment variable FF_DEBUG_SOCKET.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

// DAP messages are plain JSON objects; their shape is checked by VSCode.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = any;

export interface AdapterOptions {
    log?: (s: string) => void;
    executable?: string;
    ffglut?: string;
}

interface Stop { reason: string; path: string; lo: number; hi: number }
interface Pending { rows: string[][]; cb: (rows: string[][]) => void }

export const esc = (s: unknown): string =>
    String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');

export const unesc = (s: string): string => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) {
            const c = s[++i];
            out += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
        } else {
            out += s[i];
        }
    }
    return out;
};

let socketCounter = 0;
const THREAD_ID = 1;

export class FreeFemDebugAdapter {
    private send: (m: Msg) => void;
    private opts: AdapterOptions;
    private log: (s: string) => void;
    private _seq = 1;
    private _reverse = new Map<number, (m: Msg) => void>();   // request_seq -> resolve(response)
    private _pending: Pending[] = [];                         // replies awaited from the interpreter, FIFO
    private _breaks = new Map<string, Set<number>>();         // path -> breakpoint lines
    private _files = new Map<string, { mtime: number; code: boolean[] }>();
    private _buf = '';
    private _sock: net.Socket | null = null;
    private _server: net.Server | null = null;
    private _sockPath: string | null = null;
    private _connected = false;
    private _entry = false;
    private _configDone = false;
    private _started = false;
    private _running = false;
    private _done = false;
    private _stop: Stop = { reason: 'entry', path: '', lo: 0, hi: 0 };
    private _launch: { program: string; stopOnEntry: boolean } | null = null;
    private _pid: number | null = null;
    private _timer: ReturnType<typeof setTimeout> | null = null;

    constructor(send: (m: Msg) => void, opts?: AdapterOptions) {
        this.send = send;
        this.opts = opts || {};
        this.log = this.opts.log || (() => { });
    }

    // ------------------------------------------------------------ DAP plumbing
    handleMessage(msg: Msg): void {
        if (msg.type === 'response') {
            const r = this._reverse.get(msg.request_seq);
            if (r) {
                this._reverse.delete(msg.request_seq);
                r(msg);
            }
            return;
        }
        if (msg.type !== 'request') {
            return;
        }
        this.log('DAP request: ' + msg.command +
            (msg.command === 'evaluate' ? ' ' + JSON.stringify(msg.arguments && msg.arguments.expression) : ''));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const h = (this as any)['_req_' + msg.command];
        if (!h) {
            this._fail(msg, 'unsupported request: ' + msg.command);
            return;
        }
        try {
            const p = h.call(this, msg, msg.arguments || {});
            if (p && typeof p.catch === 'function') {
                p.catch((e: unknown) => this._fail(msg, String((e as Error)?.message ?? e)));
            }
        } catch (e) {
            this._fail(msg, String((e as Error)?.message ?? e));
        }
    }
    private _ok(req: Msg, body?: Msg): void {
        this.send({ seq: this._seq++, type: 'response', request_seq: req.seq, success: true, command: req.command, body: body || {} });
    }
    private _fail(req: Msg, message: string): void {
        this.log('DAP error in ' + req.command + ': ' + message);
        this.send({ seq: this._seq++, type: 'response', request_seq: req.seq, success: false, command: req.command, message });
    }
    private _event(event: string, body?: Msg): void {
        this.send({ seq: this._seq++, type: 'event', event, body: body || {} });
    }
    private _output(text: string, category?: string): void {
        this._event('output', { category: category || 'console', output: text + '\n' });
    }
    private _reverseRequest(command: string, args: Msg): Promise<Msg> {
        return new Promise((resolve) => {
            const seq = this._seq++;
            this._reverse.set(seq, resolve);
            this.send({ seq, type: 'request', command, arguments: args });
        });
    }

    // ------------------------------------------------------ interpreter socket
    private _listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            this._sockPath = path.join(os.tmpdir(), `ffdbg-${process.pid}-${++socketCounter}.sock`);
            try {
                fs.unlinkSync(this._sockPath);
            } catch (e) { /* none */ }
            this._server = net.createServer((s) => this._onConnection(s));
            this._server.once('error', reject);
            this._server.listen(this._sockPath, resolve);
        });
    }
    private _onConnection(sock: net.Socket): void {
        if (this._sock) {
            sock.destroy();
            return;
        }
        this._sock = sock;
        sock.setEncoding('utf8');
        sock.on('data', (d) => {
            this._buf += d;
            let i;
            while ((i = this._buf.indexOf('\n')) >= 0) {
                const line = this._buf.slice(0, i);
                this._buf = this._buf.slice(i + 1);
                if (line) {
                    this._onLine(line);
                }
            }
        });
        sock.on('close', () => this._finish());
        sock.on('error', () => { });
    }
    private _write(line: string): void {
        if (this._sock && !this._sock.destroyed) {
            this._sock.write(line + '\n');
        }
    }
    private _ask(line: string): Promise<string[][]> {
        return new Promise((resolve) => {
            this._pending.push({ rows: [], cb: resolve });
            this._write(line);
        });
    }
    private _onLine(line: string): void {
        const f = line.split('\t');
        switch (f[0]) {
            case 'hello':
                this._connected = true;
                this._pid = parseInt(f[2], 10) || null;
                if (this._timer) {
                    clearTimeout(this._timer);
                    this._timer = null;
                }
                this.log('interpreter connected, pid ' + this._pid);
                break;
            case 'stopped':
                this._onStopped(f[1], f[2], parseInt(f[3], 10), parseInt(f[4], 10));
                break;
            case 'exited':
                this._finish();
                break;
            default:
                if (this._pending.length) {
                    const p = this._pending[0];
                    if (f[0] === 'end') {
                        this._pending.shift();
                        p.cb(p.rows);
                    } else {
                        p.rows.push(f);
                    }
                }
        }
    }

    private _onStopped(reason: string, p: string, lo: number, hi: number): void {
        this._running = false;
        this._stop = { reason, path: p, lo, hi };
        if (reason === 'entry') {
            this._entry = true;
            this._flushBreakpoints();
            this._maybeStart();
            return;
        }
        this._event('stopped', { reason, threadId: THREAD_ID, allThreadsStopped: true });
        if (reason === 'breakpoint') {
            this._announceVars('Breakpoint');
        } else if (reason === 'pause') {
            this._announceVars('Paused');
        }
    }
    // Print the variables in the Debug Console as if `vars` had been typed. Sent
    // right after the stop (same tick), so it is ordered before any later command
    // on the socket, including a Continue pressed immediately.
    private async _announceVars(label: string): Promise<void> {
        try {
            const rows = await this._ask('vars');
            if (this._done) {
                return;
            }
            const s = this._stop;
            const line = this._displayLine(s.path, s.lo, s.hi, s.reason);
            this._output('-- ' + label + ' at ' + path.basename(s.path) + ':' + line + ' --\n' +
                (this._formatVars(rows) || '  (no script variables visible)'), 'console');
        } catch (e) { /* the session ended meanwhile */ }
    }
    private _formatVars(rows: string[][]): string {
        return rows.filter((r) => r[0] === 'var')
            .map((r) => ({ name: unesc(r[1]), type: unesc(r[2]), value: unesc(r[3]) }))
            .filter((v) => !v.name.startsWith('['))
            .map((v) => '  ' + v.name + ' : ' + v.type + (v.value !== '' ? ' = ' + v.value : ''))
            .join('\n');
    }
    private _maybeStart(): void {
        if (!(this._entry && this._configDone) || this._started) {
            return;
        }
        this._started = true;
        if (this._launch?.stopOnEntry) {
            this._event('stopped', { reason: 'entry', threadId: THREAD_ID, allThreadsStopped: true });
            this._announceVars('Stopped on entry');
        } else {
            this._resume('go');
        }
    }
    private _resume(cmd: string): void {
        this._running = true;
        this._write(cmd);
    }
    private _flushBreakpoints(): void {
        for (const p of this._breaks.keys()) {
            this._sendBreaks(p);
        }
    }
    private _sendBreaks(p: string): void {
        if (!this._connected) {
            return;
        }
        const lines = [...(this._breaks.get(p) || [])].sort((a, b) => a - b);
        this._write('setbreaks\t' + esc(p) + '\t' + lines.join(','));
    }

    private _finish(): void {
        if (this._done) {
            return;
        }
        this._done = true;
        for (const p of this._pending) {
            p.cb(p.rows);
        }
        this._pending = [];
        this._event('terminated');
        this._cleanup();
    }
    private _cleanup(): void {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        try {
            this._sock?.destroy();
        } catch (e) { /* ignore */ }
        try {
            this._server?.close();
        } catch (e) { /* ignore */ }
        if (this._sockPath) {
            try {
                fs.unlinkSync(this._sockPath);
            } catch (e) { /* gone */ }
        }
    }
    dispose(): void {
        this._cleanup();
    }

    // -------------------------------------------------------- source analysis
    // For every line of a file: does it hold code (not blank, not only comment)?
    private _scan(p: string): boolean[] | null {
        let st: fs.Stats;
        try {
            st = fs.statSync(p);
        } catch (e) {
            return null;
        }
        const cached = this._files.get(p);
        if (cached && cached.mtime === st.mtimeMs) {
            return cached.code;
        }
        let text: string;
        try {
            text = fs.readFileSync(p, 'utf8');
        } catch (e) {
            return null;
        }
        const lines = text.split('\n');
        const code: boolean[] = [];
        let inBlock = false;
        for (const t of lines) {
            let c = '';
            let j = 0;
            while (j < t.length) {
                if (inBlock) {
                    const k = t.indexOf('*/', j);
                    if (k < 0) {
                        j = t.length;
                    } else {
                        inBlock = false;
                        j = k + 2;
                    }
                } else if (t.startsWith('//', j)) {
                    break;
                } else if (t.startsWith('/*', j)) {
                    inBlock = true;
                    j += 2;
                } else {
                    c += t[j++];
                }
            }
            code.push(c.trim() !== '');
        }
        this._files.set(p, { mtime: st.mtimeMs, code });
        return code;
    }
    // First line in [lo,hi] that holds code (a statement's reported range may
    // begin with blank/comment lines).
    private _firstCodeLine(p: string, lo: number, hi: number): number {
        const code = this._scan(p);
        if (!code) {
            return lo;
        }
        for (let l = Math.max(lo, 1); l <= Math.min(hi, code.length); l++) {
            if (code[l - 1]) {
                return l;
            }
        }
        return lo;
    }
    // A breakpoint on a blank/comment line moves down to the next code line.
    private _adjust(p: string, line: number): number {
        const code = this._scan(p);
        if (!code) {
            return line;
        }
        for (let l = line; l <= code.length; l++) {
            if (code[l - 1]) {
                return l;
            }
        }
        return line;
    }
    private _displayLine(p: string, lo: number, hi: number, reason: string): number {
        if (reason === 'breakpoint') {
            const b = this._breaks.get(p);
            if (b) {
                for (const l of [...b].sort((x, y) => x - y)) {
                    if (l >= lo && l <= hi) {
                        return l;
                    }
                }
            }
        }
        return this._firstCodeLine(p, lo, hi);
    }

    // --------------------------------------------------------- DAP requests
    // (looked up by name in handleMessage: "_req_" + the DAP command)
    _req_initialize(req: Msg): void {
        this._ok(req, {
            supportsConfigurationDoneRequest: true,
            supportsEvaluateForHovers: true,
            supportsTerminateRequest: true,
            supportTerminateDebuggee: true,
            exceptionBreakpointFilters: [],
        });
        this._event('initialized');
    }

    async _req_launch(req: Msg, a: Msg): Promise<void> {
        const program = a.program;
        if (!program) {
            throw new Error('launch: no program (the .edp file to run)');
        }
        const exe = a.executable || this.opts.executable;
        if (!exe) {
            throw new Error('launch: no interpreter path');
        }
        const ffglut = a.ffglut || this.opts.ffglut;
        this._launch = { program, stopOnEntry: !!a.stopOnEntry };
        await this._listen();
        const args = [exe];
        if (ffglut && fs.existsSync(ffglut)) {
            args.push('-glut', ffglut);
        }
        args.push(program, '-cd', ...(a.args || []));
        const r = await this._reverseRequest('runInTerminal', {
            kind: 'integrated',
            title: 'FreeFEM debug',
            cwd: a.cwd || path.dirname(program),
            args,
            env: { FF_DEBUG_SOCKET: this._sockPath },
        });
        if (!r.success) {
            throw new Error(r.message || 'could not start the interpreter in a terminal');
        }
        this._ok(req);
        this._timer = setTimeout(() => {
            if (!this._connected) {
                this._output('The interpreter did not connect to the debugger. It must be a FreeFEM built with the debugger support (see docs/debugger.md).', 'stderr');
                this._finish();
            }
        }, 30000);
    }

    _req_setBreakpoints(req: Msg, a: Msg): void {
        const p = a.source && a.source.path;
        const wanted: number[] = (a.breakpoints || (a.lines || []).map((line: number) => ({ line }))).map((b: Msg) => b.line);
        if (!p) {
            this._ok(req, { breakpoints: wanted.map((line) => ({ verified: false, line })) });
            return;
        }
        const adj = wanted.map((l) => this._adjust(p, l));
        this._breaks.set(p, new Set(adj));
        this._sendBreaks(p);
        this._ok(req, { breakpoints: adj.map((line) => ({ verified: true, line })) });
    }
    _req_setExceptionBreakpoints(req: Msg): void {
        this._ok(req, {});
    }
    _req_configurationDone(req: Msg): void {
        this._configDone = true;
        this._ok(req);
        this._maybeStart();
    }
    _req_threads(req: Msg): void {
        this._ok(req, { threads: [{ id: THREAD_ID, name: 'FreeFEM' }] });
    }

    async _req_stackTrace(req: Msg): Promise<void> {
        if (this._running || !this._connected || this._done) {
            this._ok(req, { stackFrames: [], totalFrames: 0 });
            return;
        }
        const rows = await this._ask('stack');
        const frames = rows.filter((r) => r[0] === 'frame').map((r) => {
            const id = parseInt(r[1], 10);
            const name = unesc(r[2]);
            const p = unesc(r[3]);
            const line = this._displayLine(p, parseInt(r[4], 10), parseInt(r[5], 10), id === 0 ? this._stop.reason : 'step');
            return { id, name, line, column: 1, source: p ? { name: path.basename(p), path: p } : undefined };
        });
        this._ok(req, { stackFrames: frames, totalFrames: frames.length });
    }
    _req_scopes(req: Msg): void {
        this._ok(req, { scopes: [{ name: 'Script variables', variablesReference: 1, expensive: false }] });
    }

    async _req_variables(req: Msg): Promise<void> {
        if (this._running || !this._connected || this._done) {
            this._ok(req, { variables: [] });
            return;
        }
        const rows = await this._ask('vars');
        const variables = rows.filter((r) => r[0] === 'var')
            .map((r) => ({ name: unesc(r[1]), type: unesc(r[2]), value: unesc(r[3]) }))
            .filter((v) => !v.name.startsWith('['))
            .map((v) => ({ name: v.name, type: v.type, value: v.value !== '' ? v.value : '<' + v.type + '>', variablesReference: 0 }));
        this._ok(req, { variables });
    }

    async _req_evaluate(req: Msg, a: Msg): Promise<void> {
        if (this._running || !this._connected || this._done) {
            throw new Error('The program is running: pause it first.');
        }
        const expr = (a.expression || '').trim();
        if (!expr) {
            this._ok(req, { result: '', variablesReference: 0 });
            return;
        }
        // The pause> console's own commands also work in the Debug Console.
        const word = expr.replace(/[;\s]+$/, '');
        if (a.context === 'repl' && (word === 'vars' || word === 'resume' || word === 'kill')) {
            if (word === 'vars') {
                const rows = await this._ask('vars');
                this._ok(req, { result: this._formatVars(rows) || '(no script variables visible)', variablesReference: 0 });
            } else if (word === 'resume') {
                this._resume('go');
                this._ok(req, { result: '', variablesReference: 0 });
                this._event('continued', { threadId: THREAD_ID, allThreadsContinued: true });
            } else {
                this._ok(req, { result: '', variablesReference: 0 });
                this._quitProcess();
            }
            return;
        }
        // Debug Console input is a statement, like at the pause> prompt; watch and
        // hover expressions are values, so print them.
        const stmt = a.context === 'repl' ? (/[;}]$/.test(expr) ? expr : expr + ';') : 'cout << (' + expr + ') << endl;';
        const rows = await this._ask('eval\t' + esc(stmt));
        const r = rows.find((x) => x[0] === 'result');
        if (!r) {
            throw new Error('no answer from the interpreter');
        }
        const text = unesc(r[2] || '').replace(/\s+$/, '');
        if (r[1] !== '0') {
            throw new Error(text || 'evaluation failed');
        }
        this._ok(req, { result: text, variablesReference: 0 });
        if (a.context === 'repl') {
            this._event('invalidated', { areas: ['variables'] });
        }
    }

    _req_continue(req: Msg): void {
        if (!this._running) {
            this._resume('go');
        }
        this._ok(req, { allThreadsContinued: true });
    }
    _req_next(req: Msg): void {
        if (!this._running) {
            this._resume('next');
        }
        this._ok(req);
    }
    _req_stepIn(req: Msg): void {
        if (!this._running) {
            this._resume('stepin');
        }
        this._ok(req);
    }
    _req_stepOut(req: Msg): void {
        if (!this._running) {
            this._resume('stepout');
        }
        this._ok(req);
    }
    _req_pause(req: Msg): void {
        if (this._running) {
            this._write('pause');
        }
        this._ok(req);
    }

    private _end(req: Msg): void {
        this._ok(req);
        this._quitProcess();
    }
    private _quitProcess(): void {
        if (this._done) {
            return;
        }
        this._write('quit');
        const pid = this._pid;
        // A long single statement (a big solve) doesn't read the socket: if the
        // interpreter hasn't gone after a moment, signal it.
        setTimeout(() => {
            if (this._done) {
                return;   // exited by itself: never signal a possibly recycled pid
            }
            if (pid) {
                try {
                    process.kill(pid, 'SIGTERM');
                } catch (e) { /* gone */ }
            }
            this._finish();
        }, 2000).unref();
    }
    _req_disconnect(req: Msg): void {
        this._end(req);
    }
    _req_terminate(req: Msg): void {
        this._end(req);
    }
}
