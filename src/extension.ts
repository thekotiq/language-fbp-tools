import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
// @ts-ignore
import { parse } from '@nsfx/utils'
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import type { File, ObjectExpression } from '@babel/types';

type PropDetail = {
  name: string;
  required?: boolean;
  default?: any;
};

type PortDetail = {
  name: string;
  comment?: string;
};

function extractPropsDetails(objectExpr: ObjectExpression): PropDetail[] {
  const props: PropDetail[] = [];

  const propNode = objectExpr.properties.find(
    p =>
      p.type === 'ObjectProperty' &&
      ((p.key.type === 'Identifier' && p.key.name === 'props') ||
        (p.key.type === 'StringLiteral' && p.key.value === 'props'))
  );

  if (!propNode || propNode.type !== 'ObjectProperty') return props;

  const value = propNode.value;

  if (value.type === 'ObjectExpression') {
    for (const prop of value.properties) {
      if (prop.type !== 'ObjectProperty' || prop.key.type !== 'Identifier') continue;

      const name = prop.key.name;
      let required = false;
      let def: any = undefined;

      if (prop.value.type === 'ObjectExpression') {
        for (const inner of prop.value.properties) {
          if (inner.type !== 'ObjectProperty' || inner.key.type !== 'Identifier') continue;
          if (inner.key.name === 'required') {
            required = inner.value.type === 'BooleanLiteral' ? inner.value.value : false;
          }
          if (inner.key.name === 'default') {
            def = (inner.value as any).value;
          }
        }
      }

      props.push({ name, required, default: def });
    }
  } else if (value.type === 'ArrayExpression') {
    for (const el of value.elements) {
      if (el && el.type === 'StringLiteral') {
        props.push({ name: el.value });
      }
    }
  }

  return props;
}

function extractComponentSummary(jsCode: string): {
  props: PropDetail[],
  inports: PortDetail[],
  outports: PortDetail[]
} {
  const keys: PortDetail[] = [];
  let props: PropDetail[] = [];

  const ast: File = parser.parse(jsCode, {
    sourceType: 'unambiguous',
    plugins: ['jsx', 'typescript'],
    attachComment: true,
  });

  traverse(ast, {
    AssignmentExpression(path: any) {
      const { node } = path;

      if (
        node.left.type === 'MemberExpression' &&
        node.left.object.type === 'Identifier' &&
        node.left.object.name === 'module' &&
        node.left.property.type === 'Identifier' &&
        node.left.property.name === 'exports'
      ) {
        const rhs = node.right;
        const objectExpr = extractObjectExpression(rhs);
        if (objectExpr) {
          keys.push(...extractObjectKeysWithComments(objectExpr, ast.comments || []));
          props = extractPropsDetails(objectExpr);
        }
      }
    },

    ExportDefaultDeclaration(path: any) {
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

function extractObjectExpression(node: any): ObjectExpression | null {
  if (node?.type === 'ObjectExpression') return node;

  if (node?.type === 'ArrowFunctionExpression') {
    if (node.body?.type === 'ObjectExpression') {
      return node.body;
    }
  }

  return null;
}

function extractObjectKeysWithComments(objExpr: ObjectExpression, comments: any[]): PortDetail[] {
  return objExpr.properties
    .filter(
      (prop) =>
        (prop.type === 'ObjectProperty' || prop.type === 'ObjectMethod') &&
        (prop.key.type === 'Identifier' || prop.key.type === 'StringLiteral')
    )
    .map((prop) => {
      // @ts-ignore
      const key = prop.key.name || prop.key.value;
      console.debug('extractObjectKeysWithComments', { key, prop, comments })

      const leadingComment = comments.find((c) => {
        return (
          // @ts-ignore
          c.end < prop.start &&
          // @ts-ignore
          prop.start - c.end <= 3
        );
      });

      return {
        name: key,
        comment: leadingComment?.value.trim(),
      };
    });
}

function resolveComponentPath(proc_info: { component: string }, fbpFileUri: vscode.Uri): string | undefined {
  const fbpDir = path.dirname(fbpFileUri.fsPath);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(fbpFileUri);

  if (proc_info.component.startsWith('./') || proc_info.component.startsWith('../')) {
    const resolved = path.resolve(fbpDir, `${proc_info.component}.node.js`);
    if (fs.existsSync(resolved)) return resolved;
  }
  
  if (workspaceFolder) {
    const absPath = path.resolve(workspaceFolder.uri.fsPath, `${proc_info.component}.node.js`);
    if (fs.existsSync(absPath)) return absPath;

    const nodeModulesPath = path.resolve(workspaceFolder.uri.fsPath, 'node_modules', `${proc_info.component}.node.js`);
    if (fs.existsSync(nodeModulesPath)) return nodeModulesPath;
  }

  return undefined;
}

function getComponentPath(document: vscode.TextDocument, name: String): string | undefined {
  const def = document.getText()
  const parsed = parse(def)
  const proc_info = parsed.processes[name]
  
  return resolveComponentPath(proc_info, document.uri)
}

function getProcessDescription(document: vscode.TextDocument, name: String): vscode.Hover {
  const def = document.getText()
  const parsed = parse(def)
  const proc_info = parsed.processes[name]
  
  const component_file = resolveComponentPath(proc_info, document.uri)
  if (!component_file) {
    return new vscode.Hover(`Error loading ${component_file}`);
  }

  try {
    const component_content: string = fs.readFileSync(component_file).toString()
    const { props, inports, outports } = extractComponentSummary(component_content)
    
    // const { inports, outports } = loadComponent(component_file)
    const markdown = new vscode.MarkdownString(`**${name}**\n\n*${proc_info.component}*\n\n`);

    markdown.appendMarkdown('**Props**\n\n')
    for (const prop of props) {
      markdown.appendMarkdown(`- \`${prop.name}\` - ${prop.required ? 'required' : 'optional'}, default: \`${prop.default}\`\n\n`)
    }
    if (!props.length) {
      markdown.appendMarkdown(`No props\n\n`)
    }

    markdown.appendMarkdown('**Input ports**\n\n')
    for (const port of inports) {
      const name = port.name.substring(1).toLocaleUpperCase()
      markdown.appendMarkdown(`\`${name}\`\n\n`)
      if (port.comment) {
        markdown.appendMarkdown(`${port.comment}\n\n`)
      }
    }

    markdown.appendText('\n\n')
    markdown.appendMarkdown('**Ouput ports**\n\n')
    for (const port of outports) {
      const name = port.name.substring(0, port.name.length - 1).toLocaleUpperCase()
      markdown.appendMarkdown(`\`${name}\`\n\n`)
      if (port.comment) {
        markdown.appendMarkdown(`${port.comment}\n\n`)
      }
    }
    
    return new vscode.Hover(markdown)
  } catch (err: any) {
    console.error('Failed to load module:', err);
    return new vscode.Hover(`Error loading ${component_file}\n\n${err.message}`);
    // return `Error loading ${component_file}: ${err.message}`
  }
}

export function activate(context: vscode.ExtensionContext) {

  const defProvider = vscode.languages.registerDefinitionProvider('fbp', {
    provideDefinition(document, position) {
      const range = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
      // if (!range) return;
      const word = document.getText(range);
      const filePath = getComponentPath(document, word);
      console.debug('provideDefinition', { document, position, range, word, filePath })

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

      return getProcessDescription(document, word)
    }
  });
  context.subscriptions.push(hoverProvider);
}

export function deactivate() {}
