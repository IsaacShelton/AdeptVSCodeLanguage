
import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    HoverParams,
    Hover,
} from 'vscode-languageserver';

import {
    Range,
    TextDocument
} from 'vscode-languageserver-textdocument';

interface IdentifierToken {
    range: Range,
    content: string;
}

var insight_server = require('./insight_server.js');
var is_wasm_initialized = false;
var ast: any = null;
var identifierTokens: IdentifierToken[] = [];

class CompletionDetails {
    detail: string;
    documentation: string;

    constructor(details: string, documentation: string) {
        this.detail = details;
        this.documentation = documentation;
    }
}

class AutoCompletions {
    completionItems: CompletionItem[];
    completionItemDetails: CompletionDetails[];

    constructor() {
        this.completionItems = [];
        this.completionItemDetails = [];
    }

    // NOTE: 'item.data' is autofilled
    add(item: CompletionItem, detail: CompletionDetails) {
        item.data = this.completionItems.length;

        this.completionItems.push(item);
        this.completionItemDetails.push(detail);
    }

    getDetailedCompletionItem(item: CompletionItem) {
        // 'item.data' is used as index for completion item
        Object.assign(item, this.completionItemDetails[item.data]);
        return item;
    }
}

var autoCompletion: AutoCompletions = new AutoCompletions();

insight_server.Module['onRuntimeInitialized'] = function () {
    is_wasm_initialized = true;
    if (!insight_server.Module["noFSInit"] && !insight_server.FS.init.initialized) insight_server.FS.init();
    insight_server.TTY.init();
    insight_server.preMain();

    documents.all().forEach(validateTextDocument);
};

function invokeInsight(query_json_string: string | object): null | string | object {
    if (!is_wasm_initialized) return null;

    if (typeof query_json_string != "string") {
        query_json_string = JSON.stringify(query_json_string);
    }

    var bytes = insight_server.lengthBytesUTF8(query_json_string);
    var cstring = insight_server._malloc(bytes + 1);
    insight_server.stringToUTF8(query_json_string, cstring, bytes + 1);
    var result_json_cstring = insight_server.Module._server_main(cstring);
    var result_json = insight_server.UTF8ToString(result_json_cstring);
    insight_server._free(cstring);
    insight_server._free(result_json_cstring);
    insight_server.checkUnflushedContent();

    return JSON.parse(result_json);
}

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. 
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
    let capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // Tell the client that this server supports code completion.
            completionProvider: {
                resolveProvider: true
            },
            hoverProvider: true
        }
    };

    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }
    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});

// The example settings
interface ExampleSettings {
    maxNumberOfProblems: number;
    root: string;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000, root: "" };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    } else {
        globalSettings = <ExampleSettings>(
            (change.settings.adeptLanguageInsight || defaultSettings)
        );
    }

    // Revalidate all open text documents
    documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'adeptLanguageInsight'
        });
        documentSettings.set(resource, result);
    }
    return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
    documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    // In this simple example we get the settings for every validate run.
    let settings = await getDocumentSettings(textDocument.uri);
    let diagnostics: Diagnostic[] = [];

    var uri2path = require('file-uri-to-path');
    var path = require('path');
    var filename: string;

    try {
        filename = path.resolve(uri2path(textDocument.uri));
    } catch (err) {
        return;
    }

    var response: null | string | any = invokeInsight({
        "query": "ast",
        "infrastructure": settings.root,
        "filename": filename,
        "code": textDocument.getText()
    });

    if (settings.root == "") {
        connection.sendNotification("adeptLanguageInsight/noRoot");
        return;
    }

    if (response == null) {
        // Do nothing if WASM module isn't operation yet
        // We will make sure to do a pass once it becomes so
    } else if (typeof response == "string") {
        let diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Error,
            range: {
                start: textDocument.positionAt(0),
                end: textDocument.positionAt(0)
            },
            message: response as string
        };

        diagnostics.push(diagnostic);
    } else if (Array.isArray(response.validation)) {
        (response.validation as any[]).forEach(element => {
            var is_self = element.source.object === filename;
            if (!is_self) return;

            let diagnostic: Diagnostic = {
                severity: element.kind == "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
                range: {
                    start: textDocument.positionAt(element.source.index),
                    end: textDocument.positionAt(Math.floor(element.source.index + element.source.stride))
                },
                message: element.message,
                source: undefined
            };

            diagnostics.push(diagnostic);
        });
    }

    if (response && response.identifierTokens) {
        identifierTokens = response.identifierTokens;
    }

    if (response && response.ast) {
        ast = response.ast;
        autoCompletion = constructAutoCompletions();
    }

    // Send the computed diagnostics to VSCode.
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
    // Monitored files have change in VSCode
    connection.console.log('We received an file change event');
});


// This handler provides the initial list of the completion items.
connection.onCompletion(
    (textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
        let document = documents.get(textDocumentPosition.textDocument.uri);

        function makeStandardLibraryComponentCompletionItem(name: string) {
            return { label: name, kind: CompletionItemKind.Module, detail: "Standard library component" };
        }

        // Special auto-completion suggestions for `import`
        if (document?.getText({
            start: { line: textDocumentPosition.position.line, character: 0 },
            end: textDocumentPosition.position
        }).startsWith("import")) {
            return [
                "AABB",
                "Anything",
                "array_util",
                "Array",
                "audio",
                "basics",
                "captain",
                "cerrno",
                "cmath",
                "csignal",
                "cstdio",
                "cstdlib",
                "cstring",
                "ctime",
                "Grid",
                "initializer_list_util",
                "InitializerList",
                "JSON",
                "list_util",
                "List",
                "math",
                "Matrix4f",
                "mt19937",
                "Optional",
                "Ownership",
                "Pair",
                "parse",
                "random",
                "string_util",
                "String",
                "terminal",
                "TypeInfo",
                "Unique",
                "VariadicArray",
                "Vector2f",
                "Vector2i",
                "Vector3f",
                "where",
            ].map(makeStandardLibraryComponentCompletionItem);
        }

        // The pass parameter contains the position of the text document in
        // which code complete got requested. For the example we ignore this
        // info and always provide the same completion items.
        return autoCompletion.completionItems;
    }
);

function constructAutoCompletions(): AutoCompletions {
    var completions: AutoCompletions = new AutoCompletions();
    var symbols: any[] = [];

    if (ast) {
        symbols.push({ name: "byte", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "ubyte", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "short", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "ushort", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "int", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "uint", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "long", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "ulong", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "usize", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "bool", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "successful", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "float", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "double", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "void", _completionItemKind: CompletionItemKind.Keyword });
        symbols.push({ name: "ptr", _completionItemKind: CompletionItemKind.Keyword });

        ast.composites.forEach((f: any) => {
            f._completionItemKind = CompletionItemKind.Struct
        });
        symbols = symbols.concat(ast.composites);

        ast.enums.forEach((f: any) => {
            f._completionItemKind = CompletionItemKind.Enum
        });
        symbols = symbols.concat(ast.enums);

        ast.aliases.forEach((f: any) => {
            f._completionItemKind = CompletionItemKind.Struct
        });
        symbols = symbols.concat(ast.aliases);

        ast.functions.forEach((f: any) => {
            f._completionItemKind = CompletionItemKind.Function
        });
        symbols = symbols.concat(ast.functions);

        ast.function_aliases.forEach((f: any) => {
            f._completionItemKind = CompletionItemKind.Function
        });
        symbols = symbols.concat(ast.function_aliases);

        ast.namedExpressions.forEach((f: any) => {
            f._completionItemKind = CompletionItemKind.EnumMember
        });
        symbols = symbols.concat(ast.namedExpressions);
    }

    symbols.forEach((symbol) => {
        var item: CompletionItem = { label: symbol.name, kind: symbol._completionItemKind };
        var details: CompletionDetails = new CompletionDetails(symbol.definition ? symbol.definition : "", symbol.documentation ? symbol.documentation : "");

        completions.add(item, details);
    });

    return completions;
}

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
    (item: CompletionItem): CompletionItem => {
        return autoCompletion.getDetailedCompletionItem(item);
    }
);

connection.onHover((params: HoverParams): Hover | null => {
    if (!ast || !identifierTokens) return null;

    for (var identifier of identifierTokens) {
        if (params.position.line != identifier.range.start.line) continue;
        if (params.position.line != identifier.range.end.line) continue;
        if (params.position.character < identifier.range.start.character) continue;
        if (params.position.character > identifier.range.end.character) continue;

        var definitions: string[] = ast.functions.filter((f: any) => f.name == identifier.content).map((f: any) => f.definition);
        return definitions.length == 0 ? null : {
            contents: { kind: "plaintext", value: definitions.join("\n") },
            range: identifier.range
        };
    };

    return null;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
