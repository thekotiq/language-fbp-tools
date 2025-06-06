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
  if (node?.type === 'ObjectExpression') {
    return node;
  }

  // Arrow function with implicit return
  if (node?.type === 'ArrowFunctionExpression') {
    if (node.body?.type === 'ObjectExpression') {
      return node.body;
    }
  }

  // Arrow function or regular function with explicit return statement
  if (
    (node?.type === 'ArrowFunctionExpression' ||
     node?.type === 'FunctionExpression' ||
     node?.type === 'FunctionDeclaration') &&
    node.body?.type === 'BlockStatement'
  ) {
    for (const stmt of node.body.body) {
      if (stmt.type === 'ReturnStatement' && stmt.argument?.type === 'ObjectExpression') {
        return stmt.argument;
      }
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

function findPackageRoot(startPath: string): string | undefined {
  let currentDir = startPath;
  let lastFound: string | undefined = undefined;

  while (true) {
    const pkgPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      lastFound = currentDir;  // remember the last found package.json folder
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // reached root

    currentDir = parentDir;
  }

  return lastFound;
}

function resolveComponentPath(fbpFileUri: vscode.Uri, proc_info: { component: string }): string | undefined {
  const fbpDir = path.dirname(fbpFileUri.fsPath);
  const packageRoot = findPackageRoot(fbpDir)

  if (proc_info.component.startsWith('./') || proc_info.component.startsWith('../')) {
    const resolved = path.resolve(fbpDir, `${proc_info.component}.node.js`);
    if (fs.existsSync(resolved)) return resolved;
  }

  if (packageRoot) {
    const absPath = path.resolve(packageRoot, `${proc_info.component}.node.js`);
    if (fs.existsSync(absPath)) return absPath;

    const nodeModulesPath = path.resolve(packageRoot, 'node_modules', `${proc_info.component}.node.js`);
    if (fs.existsSync(nodeModulesPath)) return nodeModulesPath;
  }

  return undefined;
}

function getComponentPath(documentUri: vscode.Uri, fbpContent: String, name: String): string | undefined {
  const parsed = parse(fbpContent)
  const proc_info = parsed.processes[name]
  
  return resolveComponentPath(documentUri, proc_info)
}

function getProcessDescription(documentUri: vscode.Uri, fbpContent: String, name: String): vscode.Hover {
  const parsed = parse(fbpContent)
  const proc_info = parsed.processes[name]
  
  const component_file = resolveComponentPath(documentUri, proc_info)
  if (!component_file) {
    return new vscode.Hover(`Error loading ${component_file}`);
  }

  try {
    const component_content: string = fs.readFileSync(component_file).toString()
    const { props, inports, outports } = extractComponentSummary(component_content)
    
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
  }
}

export function activate(context: vscode.ExtensionContext) {

  const defProvider = vscode.languages.registerDefinitionProvider([
    'fbp',
    'javascript',
    'typescript',
  ], {
    provideDefinition(document, position) {
      const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
      if (!wordRange) return;
      
      let filePath
      const word = document.getText(wordRange);
      const { languageId } = document;

      if (languageId === 'fbp') {
        filePath = getComponentPath(document.uri, document.getText(), word);
        console.debug('provideDefinition', { document, position, wordRange, word, filePath })
      }

      // Case 2: .js files — only if inside `# fbp` template literal
      if (['javascript', 'typescript'].includes(languageId)) {
        const fullText = document.getText();
        const cursorOffset = document.offsetAt(position);

        const fbpBlocks = Array.from(fullText.matchAll(/`# fbp([\s\S]*?)`/g));
        for (const match of fbpBlocks) {
          const start = match.index;
          const end = start + match[0].length;

          if (cursorOffset >= start && cursorOffset <= end) {
            const fbpContent = match[1].trimStart();
            filePath = getComponentPath(document.uri, fbpContent, word)
          }
        }
      }

      if (filePath) {
        return new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(0, 0));
      }

      return null;
    }
  });
  context.subscriptions.push(defProvider);

  const hoverProvider = vscode.languages.registerHoverProvider([
    'fbp',
    'javascript',
    'typescript',
  ], {
    provideHover(document, position, token) {
      const wordRange = document.getWordRangeAtPosition(position, /[a-z0-9_]+/i);
      if (!wordRange) return;

      const word = document.getText(wordRange);
      const { languageId } = document;

      // Case 1: .fbp files — always allow
      if (languageId === 'fbp') {
        console.debug('provideHover (fbp)', { word });
        return getProcessDescription(document.uri, document.getText(), word);
      }

      // Case 2: .js files — only if inside `# fbp` template literal
      if (['javascript', 'typescript'].includes(languageId)) {
        const fullText = document.getText();
        const cursorOffset = document.offsetAt(position);

        const fbpBlocks = Array.from(fullText.matchAll(/`# fbp([\s\S]*?)`/g));
        for (const match of fbpBlocks) {
          const start = match.index;
          const end = start + match[0].length;

          if (cursorOffset >= start && cursorOffset <= end) {
            const fbpContent = match[1].trimStart(); // extract only the inner content
            console.debug('provideHover (js/fbp virtual)', { word });
            return getProcessDescription(document.uri, fbpContent, word);
          }
        }

        return;
      }

      return;
    }
  });

  context.subscriptions.push(hoverProvider);
}

export function deactivate() {}
