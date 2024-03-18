import path from 'path';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    var currentlyOpenTabfilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (currentlyOpenTabfilePath) {
        var currentlyOpenTabfileName = path.basename(currentlyOpenTabfilePath);
        var currentlyOpenTabfilePathTo = path.dirname(currentlyOpenTabfilePath);
        // Use the console to output diagnostic information (console.log) and errors (console.error)
        // This line of code will only be executed once when your extension is activated
        console.log('Running FreeFEM with file: ' + currentlyOpenTabfileName);

        // The command has been defined in the package.json file
        // Now provide the implementation of the command with registerCommand
        // The commandId parameter must match the command field in package.json
        let disposable = vscode.commands.registerCommand('freefem.runFile', () => {
            // The code you place here will be executed every time your command is executed

            let terminal_array = vscode.window.terminals;
            let terminal = terminal_array.find((element) => element.name == 'FreeFEM')
            if (terminal === undefined) {
                terminal = vscode.window.createTerminal({ name: `FreeFEM`, cwd: currentlyOpenTabfilePathTo });
            }
            terminal.show()
            terminal.sendText("FreeFem++ " + currentlyOpenTabfileName);
            // Display a message box to the user
            // vscode.window.showInformationMessage('Hello World!');
        });

        context.subscriptions.push(disposable);
    }
    else {
        console.log('No file opened');
    }
}

// this method is called when your extension is deactivated
export function deactivate() { }
