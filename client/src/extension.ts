/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { workspace, ExtensionContext, window, ConfigurationTarget } from 'vscode';

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient';

import * as child_process from 'child_process';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
    // The server is implemented in node
    let serverModule = context.asAbsolutePath(
        path.join('server', 'out', 'server.js')
    );
    
    // The debug options for the server
    // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
    let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    let serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions
        }
    };

    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
        // Register the server for plain text documents
        documentSelector: [{ scheme: 'file', language: 'adept' }],
        synchronize: {
            // Notify the server about file changes to '.clientrc files contained in the workspace
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
        }
    };

    // Create the language client and start the client.
    client = new LanguageClient(
        'adeptLanguageServer',
        'Adept Language 2.7',
        serverOptions,
        clientOptions
    );

    client.onReady().then(() => {
        client.onNotification("adeptLanguageInsight/noRoot", () => {
            let yes: string = "Auto Configure (recommended)";

            window
                .showInformationMessage("No Adept Root Configured! Would you like to automatically configure it?", yes, "No")
                .then(selection => {
                    if(selection != yes){
                        window.showInformationMessage("In order to manually configure, you must set 'adeptLanguageInsight.root' to be the root folder of your desired compiler. You can easily get the root folder of an Adept compiler by running `desired-compiler --root`");
                        return;
                    }

                    child_process.exec("adept --root", (err, stdout, stderr) => {
                        stdout = stdout.trim();
                        workspace.getConfiguration()
                            .update('adeptLanguageInsight.root', stdout, ConfigurationTarget.Global);
                        window.showInformationMessage("Automatically configuration successful!");
                    });
                });
        });
    });

    // Start the client. This will also launch the server
    context.subscriptions.push(client.start());
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
