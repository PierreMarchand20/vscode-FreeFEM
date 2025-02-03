import path from 'path';
import * as vscode from 'vscode';
import * as shiki from 'shiki';

export async function activate(context: vscode.ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Running FreeFEM extension');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with registerCommand
    // The commandId parameter must match the command field in package.json
    let disposable = vscode.commands.registerCommand('freefem.runFile', () => {
        // The code you place here will be executed every time your command is executed
        var currentlyOpenTabfilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (currentlyOpenTabfilePath) {
            var currentlyOpenTabfileName = path.basename(currentlyOpenTabfilePath);
            var currentlyOpenTabfilePathTo = path.dirname(currentlyOpenTabfilePath);

            var nbproc = '1';
            var param = '';

            const editor = vscode.window.activeTextEditor;

            if (editor) {
                let document = editor.document;

                // Get the document text
                const documentText = document.getText();

                const lines = documentText.split(/\r?\n/);

                lines.forEach(function (line) {
                    if (line.startsWith("//") && line.includes("NBPROC")) {
                        nbproc = line.split('NBPROC')[1];
                    }
                    if (line.startsWith("//") && line.includes("PARAM")) {
                        param = line.split('PARAM')[1];
                    }
                });
            }

            let terminal_array = vscode.window.terminals;
            let terminal = terminal_array.find((element) => element.name == 'FreeFEM')
            if (terminal === undefined) {
                terminal = vscode.window.createTerminal({ name: `FreeFEM`, cwd: currentlyOpenTabfilePathTo });
            }
            terminal.show()
            if (nbproc == '1') {
                if (process.platform === 'win32')
                    terminal.sendText("FreeFem++.exe \"" + currentlyOpenTabfilePathTo + "\\" + currentlyOpenTabfileName + "\" -cd " + param);
                else
                    terminal.sendText("FreeFem++ \"" + currentlyOpenTabfilePathTo + "/" + currentlyOpenTabfileName + "\" -cd " + param);
            }
            else {
                if (process.platform === 'win32')
                    terminal.sendText("mpiexec.exe -np " + nbproc + " FreeFem++-mpi.exe \"" + currentlyOpenTabfilePathTo + "\\" + currentlyOpenTabfileName + "\" -cd " + param);
                else
                    terminal.sendText("ff-mpirun -np " + nbproc + " \"" + currentlyOpenTabfilePathTo + "/" + currentlyOpenTabfileName + "\" -cd " + param);
            }
            // Display a message box to the user
            // vscode.window.showInformationMessage('Hello World!');
        }
        else {
            console.log('No file opened');
        }
    });

    context.subscriptions.push(disposable);

    let Highlighter: any;

    const fflang = {
        "id": "freefem",
        "language": "freefem",
        "scopeName": "source.edp",
        "path": context.asAbsolutePath('syntaxes/freefem.tmLanguage.json')
    }

    await shiki.getHighlighter({
        theme: 'nord',
        langs: [fflang]
    }).then(highlighter => {
        Highlighter = highlighter;
    })

    return {
        extendMarkdownIt(md: any) {
            const { highlight } = md.options;
            md.options.highlight = (code: any, lang = '') =>
                lang.match(/\bfreefem\b/i) ? Highlighter.codeToHtml(code, 'freefem') : highlight(code, lang);
            return md;
        }
    };
}

// this method is called when your extension is deactivated
export function deactivate() { }
