"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
// @ts-ignore
const utils_1 = require("@nsfx/utils");
const parser = __importStar(require("@babel/parser"));
const traverse_1 = __importDefault(require("@babel/traverse"));
function extractPropsDetails(objectExpr) {
    const props = [];
    const propNode = objectExpr.properties.find(p => p.type === 'ObjectProperty' &&
        ((p.key.type === 'Identifier' && p.key.name === 'props') ||
            (p.key.type === 'StringLiteral' && p.key.value === 'props')));
    if (!propNode || propNode.type !== 'ObjectProperty')
        return props;
    const value = propNode.value;
    if (value.type === 'ObjectExpression') {
        for (const prop of value.properties) {
            if (prop.type !== 'ObjectProperty' || prop.key.type !== 'Identifier')
                continue;
            const name = prop.key.name;
            let required = false;
            let def = undefined;
            if (prop.value.type === 'ObjectExpression') {
                for (const inner of prop.value.properties) {
                    if (inner.type !== 'ObjectProperty' || inner.key.type !== 'Identifier')
                        continue;
                    if (inner.key.name === 'required') {
                        required = inner.value.type === 'BooleanLiteral' ? inner.value.value : false;
                    }
                    if (inner.key.name === 'default') {
                        def = inner.value.value;
                    }
                }
            }
            props.push({ name, required, default: def });
        }
    }
    else if (value.type === 'ArrayExpression') {
        for (const el of value.elements) {
            if (el && el.type === 'StringLiteral') {
                props.push({ name: el.value });
            }
        }
    }
    return props;
}
function extractComponentSummary(jsCode) {
    const keys = [];
    let props = [];
    const ast = parser.parse(jsCode, {
        sourceType: 'unambiguous',
        plugins: ['jsx', 'typescript'],
        attachComment: true,
    });
    (0, traverse_1.default)(ast, {
        AssignmentExpression(path) {
            const { node } = path;
            if (node.left.type === 'MemberExpression' &&
                node.left.object.type === 'Identifier' &&
                node.left.object.name === 'module' &&
                node.left.property.type === 'Identifier' &&
                node.left.property.name === 'exports') {
                const rhs = node.right;
                const objectExpr = extractObjectExpression(rhs);
                if (objectExpr) {
                    keys.push(...extractObjectKeysWithComments(objectExpr, ast.comments || []));
                    props = extractPropsDetails(objectExpr);
                }
            }
        },
        ExportDefaultDeclaration(path) {
            const rhs = path.node.declaration;
            const objectExpr = extractObjectExpression(rhs);
            if (objectExpr) {
                keys.push(...extractObjectKeysWithComments(objectExpr, ast.comments || []));
                props = extractPropsDetails(objectExpr);
            }
        }
    });
    return {
        props,
        inports: keys.filter(x => x.name.startsWith('_')),
        outports: keys.filter(x => x.name.endsWith('_')),
    };
}
function extractObjectExpression(node) {
    var _a;
    if ((node === null || node === void 0 ? void 0 : node.type) === 'ObjectExpression')
        return node;
    if ((node === null || node === void 0 ? void 0 : node.type) === 'ArrowFunctionExpression') {
        if (((_a = node.body) === null || _a === void 0 ? void 0 : _a.type) === 'ObjectExpression') {
            return node.body;
        }
    }
    return null;
}
function extractObjectKeysWithComments(objExpr, comments) {
    return objExpr.properties
        .filter((prop) => (prop.type === 'ObjectProperty' || prop.type === 'ObjectMethod') &&
        (prop.key.type === 'Identifier' || prop.key.type === 'StringLiteral'))
        .map((prop) => {
        // @ts-ignore
        const key = prop.key.name || prop.key.value;
        console.debug('extractObjectKeysWithComments', { key, prop, comments });
        const leadingComment = comments.find((c) => {
            return (
            // @ts-ignore
            c.end < prop.start &&
                // @ts-ignore
                prop.start - c.end <= 3);
        });
        return {
            name: key,
            comment: leadingComment === null || leadingComment === void 0 ? void 0 : leadingComment.value.trim(),
        };
    });
}
function resolveComponent(proc_info) {
    var _a;
    const workspace_folder = (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a[0].uri.fsPath;
    if (workspace_folder) {
        return proc_info.component.startsWith('./') ||
            proc_info.component.startsWith('../')
            ? path.resolve(workspace_folder, `${proc_info.component}.node.js`)
            : path.resolve(workspace_folder, 'node_modules', `${proc_info.component}.node.js`);
    }
}
function getComponentFile(document, name) {
    const def = document.getText();
    const parsed = (0, utils_1.parse)(def);
    const proc_info = parsed.processes[name];
    return resolveComponent(proc_info);
}
function getProcessDescription(document, name) {
    const def = document.getText();
    const parsed = (0, utils_1.parse)(def);
    const proc_info = parsed.processes[name];
    const component_file = resolveComponent(proc_info);
    if (!component_file) {
        return new vscode.Hover(`Error loading ${component_file}`);
    }
    try {
        const component_content = fs.readFileSync(component_file).toString();
        const { props, inports, outports } = extractComponentSummary(component_content);
        // const { inports, outports } = loadComponent(component_file)
        const markdown = new vscode.MarkdownString(`**${name}**\n\n*${proc_info.component}*\n\n`);
        markdown.appendMarkdown('**Props**\n\n');
        for (const prop of props) {
            markdown.appendMarkdown(`- \`${prop.name}\` - ${prop.required ? 'required' : 'optional'}, default: \`${prop.default}\`\n\n`);
        }
        if (!props.length) {
            markdown.appendMarkdown(`No props\n\n`);
        }
        markdown.appendMarkdown('**Input ports**\n\n');
        for (const port of inports) {
            const name = port.name.substring(1).toLocaleUpperCase();
            markdown.appendMarkdown(`\`${name}\`\n\n`);
            if (port.comment) {
                markdown.appendMarkdown(`${port.comment}\n\n`);
            }
        }
        markdown.appendText('\n\n');
        markdown.appendMarkdown('**Ouput ports**\n\n');
        for (const port of outports) {
            const name = port.name.substring(0, port.name.length - 1).toLocaleUpperCase();
            markdown.appendMarkdown(`\`${name}\`\n\n`);
            if (port.comment) {
                markdown.appendMarkdown(`${port.comment}\n\n`);
            }
        }
        return new vscode.Hover(markdown);
    }
    catch (err) {
        console.error('Failed to load module:', err);
        return new vscode.Hover(`Error loading ${component_file}\n\n${err.message}`);
        // return `Error loading ${component_file}: ${err.message}`
    }
}
function activate(context) {
    const defProvider = vscode.languages.registerDefinitionProvider('fbp', {
        provideDefinition(document, position) {
            const range = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
            // if (!range) return;
            const word = document.getText(range);
            const filePath = getComponentFile(document, word);
            console.debug('provideDefinition', { document, position, range, word, filePath });
            if (filePath) {
                return new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(0, 0));
            }
            return null;
        }
    });
    context.subscriptions.push(defProvider);
    const hoverProvider = vscode.languages.registerHoverProvider('fbp', {
        provideHover(document, position, token) {
            const range = document.getWordRangeAtPosition(position, /[a-z0-9_]+/);
            const word = document.getText(range);
            return getProcessDescription(document, word);
        }
    });
    context.subscriptions.push(hoverProvider);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map