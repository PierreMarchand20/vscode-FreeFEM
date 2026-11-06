import path from 'path';
import fs from 'fs';
import * as vscode from 'vscode';
import { FreeFemDebugAdapter } from './debug/adapter';

export const DEBUG_TYPE = 'freefem';

// Absolute path of an executable named `name` on PATH, or undefined. A name
// containing a separator is taken as a path.
export function findOnPath(name: string, envPath: string = process.env.PATH ?? ''): string | undefined {
    if (!name) {
        return undefined;
    }
    if (name.includes(path.sep)) {
        return fs.existsSync(name) ? name : undefined;
    }
    const names = process.platform === 'win32' ? [name + '.exe', name] : [name];
    for (const dir of envPath.split(path.delimiter)) {
        if (!dir) {
            continue;
        }
        for (const n of names) {
            const p = path.join(dir, n);
            try {
                if (fs.statSync(p).isFile()) {
                    return p;
                }
            } catch (e) { /* not here */ }
        }
    }
    return undefined;
}

// The interpreter is the `freefem.executable` setting, else FreeFem++ found
// on PATH. `found` says whether it exists; `exe` is the name to report if not.
export function resolveExecutable(configured: string | undefined): { exe: string; found: boolean } {
    const wanted = configured || (process.platform === 'win32' ? 'FreeFem++.exe' : 'FreeFem++');
    const exe = findOnPath(wanted);
    return { exe: exe ?? wanted, found: exe !== undefined };
}

function settings() {
    const c = vscode.workspace.getConfiguration('freefem');
    return {
        executable: c.get<string>('executable') ?? '',
        ffglut: c.get<string>('ffglut') ?? '',
    };
}

// Registers the FreeFEM debugger: the `freefem.debugFile` command, the debug
// configuration provider (F5 without a launch.json), the debug adapter, and
// the focus of the Debug Console when the program stops.
export function activateDebugger(context: vscode.ExtensionContext): void {
    const out = vscode.window.createOutputChannel('FreeFEM debugger');
    context.subscriptions.push(out);

    context.subscriptions.push(
        vscode.commands.registerCommand('freefem.debugFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.isUntitled) {
                vscode.window.showWarningMessage('FreeFEM: open and save a .edp file first.');
                return;
            }
            await editor.document.save();
            const file = editor.document.uri.fsPath;
            await vscode.debug.startDebugging(undefined, {
                type: DEBUG_TYPE,
                request: 'launch',
                name: 'FreeFEM: ' + path.basename(file),
                program: file,
            });
        }),

        // F5 on a .edp file with no launch.json: fill in a configuration; then
        // (after VSCode substituted ${file} etc.) check the interpreter exists
        // and pass it the paths from the settings.
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
            resolveDebugConfiguration(_folder, config) {
                if (!config.type && !config.request && !config.name) {
                    const ed = vscode.window.activeTextEditor;
                    if (ed && ed.document.languageId === 'freefem') {
                        config.type = DEBUG_TYPE;
                        config.request = 'launch';
                        config.name = 'FreeFEM: current file';
                        config.program = '${file}';
                        config.stopOnEntry = false;
                    }
                }
                return config;
            },
            resolveDebugConfigurationWithSubstitutedVariables(_folder, config) {
                if (!config.program) {
                    vscode.window.showErrorMessage('FreeFEM: open a .edp file to debug.');
                    return undefined;
                }
                const cfg = settings();
                const exe = resolveExecutable(config.executable || cfg.executable);
                if (!exe.found) {
                    vscode.window.showErrorMessage(
                        `FreeFEM interpreter '${exe.exe}' not found: put FreeFem++ on PATH or set the freefem.executable setting. ` +
                        'It must be a FreeFEM built with the debugger support (see the extension README).');
                    return undefined;
                }
                config.executable = exe.exe;
                config.ffglut = config.ffglut || cfg.ffglut || undefined;
                out.appendLine('debug launch: ' + config.executable + ' ' + config.program);
                return config;
            },
        }),

        // The statements you type while stopped go in the Debug Console, but the
        // terminal is what's in front (the program runs there). So when the
        // program stops at a breakpoint or on Pause, focus the Debug Console input.
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, {
            createDebugAdapterTracker() {
                return {
                    onDidSendMessage(m: { type?: string; event?: string; body?: { reason?: string } }) {
                        if (m && m.type === 'event' && m.event === 'stopped' && m.body &&
                            (m.body.reason === 'breakpoint' || m.body.reason === 'pause' || m.body.reason === 'entry')) {
                            Promise.resolve(vscode.commands.executeCommand('workbench.debug.action.focusRepl')).catch(() => { });
                        }
                    },
                };
            },
        }),

        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
            createDebugAdapterDescriptor() {
                const emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
                const adapter = new FreeFemDebugAdapter((m) => emitter.fire(m), { log: (s) => out.appendLine(s) });
                return new vscode.DebugAdapterInlineImplementation({
                    onDidSendMessage: emitter.event,
                    handleMessage: (m) => adapter.handleMessage(m),
                    dispose: () => adapter.dispose(),
                });
            },
        }),
    );
}
