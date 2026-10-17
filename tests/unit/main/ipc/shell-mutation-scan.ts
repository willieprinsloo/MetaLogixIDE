/**
 * Static scanner for the IPC handler map: finds every channel whose handler
 * spawns, kills, removes or records a shell (`ptyManager.spawn/kill`,
 * `shells.upsert/remove`), directly or through any same-file helper it
 * references, transitively. Spreads in the map (`...dropHandlers`) are
 * followed into same-file constants or imported modules; a spread or handler
 * shape it cannot read throws, so the guard fails closed instead of silently
 * skipping a channel.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const MUTATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  ptyManager: new Set(['spawn', 'kill']),
  shells: new Set(['upsert', 'remove']),
};

/** Result of scanning one handler map: every channel seen, and those that mutate shells. */
export interface HandlerScan {
  readonly channels: readonly string[];
  readonly mutating: readonly string[];
}

/** Maps a module specifier to a source path; returns null for packages the scan cannot follow. */
export type ModuleResolver = (specifier: string, fromFile: string) => string | null;

interface ParsedFile {
  readonly file: string;
  readonly source: ts.SourceFile;
  readonly locals: ReadonlyMap<string, ts.Node>;
  readonly imports: ReadonlyMap<string, { specifier: string; name: string }>;
  readonly mutatingLocals: ReadonlySet<string>;
}

function receiverName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function isShellMutation(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const receiver = receiverName(node.expression.expression);
  return receiver !== null && (MUTATIONS[receiver]?.has(node.expression.name.text) ?? false);
}

function scanBody(body: ts.Node, localNames: ReadonlySet<string>): { direct: boolean; refs: Set<string> } {
  const refs = new Set<string>();
  let direct = false;
  const visit = (node: ts.Node): void => {
    if (isShellMutation(node)) direct = true;
    if (ts.isIdentifier(node) && localNames.has(node.text)) refs.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return { direct, refs };
}

function collectLocals(source: ts.SourceFile): Map<string, ts.Node> {
  const locals = new Map<string, ts.Node>();
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) locals.set(stmt.name.text, stmt);
    if (ts.isClassDeclaration(stmt) && stmt.name) locals.set(stmt.name.text, stmt);
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) locals.set(decl.name.text, decl.initializer);
    }
  }
  return locals;
}

function collectImports(source: ts.SourceFile): Map<string, { specifier: string; name: string }> {
  const imports = new Map<string, { specifier: string; name: string }>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      imports.set(el.name.text, { specifier: stmt.moduleSpecifier.text, name: (el.propertyName ?? el.name).text });
    }
  }
  return imports;
}

function mutatingClosure(locals: ReadonlyMap<string, ts.Node>): Set<string> {
  const names = new Set(locals.keys());
  const scans = new Map([...locals].map(([name, node]) => [name, scanBody(node, names)]));
  const mutating = new Set([...scans].filter(([, s]) => s.direct).map(([name]) => name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, s] of scans) {
      if (mutating.has(name) || ![...s.refs].some((r) => mutating.has(r))) continue;
      mutating.add(name);
      grew = true;
    }
  }
  return mutating;
}

function parseFile(file: string, text: string): ParsedFile {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const locals = collectLocals(source);
  return { file, source, locals, imports: collectImports(source), mutatingLocals: mutatingClosure(locals) };
}

function propertyKey(prop: ts.ObjectLiteralElementLike, file: string): string {
  const name = prop.name;
  if (name && (ts.isStringLiteral(name) || ts.isIdentifier(name))) return name.text;
  throw new Error(`${file}: unreadable handler key at ${prop.getText().slice(0, 60)}`);
}

function handlerMutates(node: ts.Node, parsed: ParsedFile): boolean {
  const s = scanBody(node, new Set(parsed.locals.keys()));
  return s.direct || [...s.refs].some((r) => parsed.mutatingLocals.has(r));
}

interface ScanContext {
  readonly read: (file: string) => string;
  readonly resolveModule: ModuleResolver;
}

function scanObject(obj: ts.ObjectLiteralExpression, parsed: ParsedFile, ctx: ScanContext, out: Map<string, boolean>): void {
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      scanSpread(prop.expression, parsed, ctx, out);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      out.set(prop.name.text, handlerMutates(prop.name, parsed));
      continue;
    }
    out.set(propertyKey(prop, parsed.file), handlerMutates(prop, parsed));
  }
}

function asObjectLiteral(node: ts.Node | undefined): ts.ObjectLiteralExpression | null {
  let current = node;
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))) {
    current = current.expression;
  }
  return current && ts.isObjectLiteralExpression(current) ? current : null;
}

function scanSpread(expr: ts.Expression, parsed: ParsedFile, ctx: ScanContext, out: Map<string, boolean>): void {
  if (!ts.isIdentifier(expr)) throw new Error(`${parsed.file}: cannot follow spread ${expr.getText()}`);
  const local = asObjectLiteral(parsed.locals.get(expr.text));
  if (local) return scanObject(local, parsed, ctx, out);
  const imported = parsed.imports.get(expr.text);
  const target = imported ? ctx.resolveModule(imported.specifier, parsed.file) : null;
  if (!imported || !target) throw new Error(`${parsed.file}: cannot follow spread ${expr.text}`);
  scanNamedObject(target, imported.name, ctx, out);
}

function scanNamedObject(file: string, name: string, ctx: ScanContext, out: Map<string, boolean>): void {
  const parsed = parseFile(file, ctx.read(file));
  const obj = asObjectLiteral(parsed.locals.get(name));
  if (!obj) throw new Error(`${file}: ${name} is not an object literal`);
  scanObject(obj, parsed, ctx, out);
}

/**
 * Scans the object literal bound to `mapName` in `file` and reports every
 * channel key plus those whose handler mutates shells. `read` and
 * `resolveModule` are injectable so the scanner itself can be tested on
 * synthetic sources. Throws when the map or any spread cannot be read.
 */
export function scanHandlerMap(file: string, mapName: string, read: (f: string) => string, resolveModule: ModuleResolver): HandlerScan {
  const out = new Map<string, boolean>();
  scanNamedObject(file, mapName, { read, resolveModule }, out);
  return {
    channels: [...out.keys()],
    mutating: [...out].filter(([, m]) => m).map(([channel]) => channel),
  };
}

/** Resolves `@main/…` and relative specifiers to `.ts` files under `srcRoot`; packages resolve to null. */
export function srcResolver(srcRoot: string): ModuleResolver {
  return (specifier, fromFile) => {
    if (specifier.startsWith('@main/')) return resolve(srcRoot, 'main', `${specifier.slice('@main/'.length)}.ts`);
    if (specifier.startsWith('.')) return resolve(dirname(fromFile), `${specifier}.ts`);
    return null;
  };
}

/** Reads a source file as UTF-8. */
export const readSource = (file: string): string => readFileSync(file, 'utf8');
