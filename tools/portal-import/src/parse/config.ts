import { parse, type Node } from 'acorn';

/**
 * Reads `docusaurus.config.js` without executing it: the file is parsed into an AST and the
 * exported config object is evaluated from literals only. Top-level `const` declarations are
 * resolved (`${currentVersion}`), `new Date().getFullYear()` becomes `{year}`, a member of an
 * imported theme object (`prismThemes.github`) becomes its property name, and anything else
 * (function calls, `require.resolve`, …) becomes `undefined`.
 */

export type JsValue = string | number | boolean | null | undefined | JsValue[] | JsObject;
export interface JsObject {
  [key: string]: JsValue;
}

export const YEAR_TOKEN = '{year}';

/** Minimal structural view of ESTree nodes; acorn's own types are a loose union. */
interface AnyNode extends Node {
  [key: string]: unknown;
}

const asNode = (v: unknown): AnyNode | null =>
  v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'
    ? (v as AnyNode)
    : null;

const nodes = (v: unknown): AnyNode[] =>
  Array.isArray(v) ? v.map(asNode).filter((n): n is AnyNode => n !== null) : [];

interface Scope {
  consts: Map<string, AnyNode>;
  /** Identifiers bound by imports / requires (theme objects). */
  imports: Set<string>;
  /** Guards against `const a = b; const b = a;`. */
  resolving: Set<string>;
}

export interface ConfigReadResult {
  config: JsObject;
  /** Problems that made parts of the config unreadable. */
  errors: string[];
}

export function readDocusaurusConfig(source: string): ConfigReadResult {
  const errors: string[] = [];
  let program: AnyNode;
  try {
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as AnyNode;
  } catch (err) {
    try {
      program = parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'script',
      }) as unknown as AnyNode;
    } catch {
      return { config: {}, errors: [err instanceof Error ? err.message : String(err)] };
    }
  }

  const scope: Scope = { consts: new Map(), imports: new Set(), resolving: new Set() };
  let exported: AnyNode | null = null;

  for (const stmt of nodes(program.body)) {
    if (stmt.type === 'ImportDeclaration') {
      for (const spec of nodes(stmt.specifiers)) {
        const local = asNode(spec.local);
        if (local && typeof local.name === 'string') scope.imports.add(local.name);
      }
    } else if (stmt.type === 'VariableDeclaration') {
      for (const decl of nodes(stmt.declarations)) {
        const id = asNode(decl.id);
        const init = asNode(decl.init);
        if (!init || !id) continue;
        if (id.type === 'Identifier' && typeof id.name === 'string') {
          if (isRequireCall(init)) scope.imports.add(id.name);
          else scope.consts.set(id.name, init);
        } else if (id.type === 'ObjectPattern' && isRequireCall(init)) {
          for (const prop of nodes(id.properties)) {
            const value = asNode(prop.value);
            if (value && typeof value.name === 'string') scope.imports.add(value.name);
          }
        }
      }
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      exported = asNode(stmt.declaration);
    } else if (stmt.type === 'ExpressionStatement') {
      const expr = asNode(stmt.expression);
      if (expr?.type === 'AssignmentExpression' && isModuleExports(asNode(expr.left))) {
        exported = asNode(expr.right);
      }
    }
  }

  if (!exported) return { config: {}, errors: ['No exported config object found'] };
  if (exported.type === 'Identifier' && typeof exported.name === 'string') {
    exported = scope.consts.get(exported.name) ?? null;
  }
  if (!exported || exported.type !== 'ObjectExpression') {
    return { config: {}, errors: ['The exported config is not an object literal'] };
  }
  const value = evaluate(exported, scope);
  return { config: isObject(value) ? value : {}, errors };
}

function isRequireCall(node: AnyNode): boolean {
  const callee = asNode(node.callee);
  return (
    node.type === 'CallExpression' && callee?.type === 'Identifier' && callee.name === 'require'
  );
}

function isModuleExports(node: AnyNode | null): boolean {
  if (!node || node.type !== 'MemberExpression') return false;
  const obj = asNode(node.object);
  const prop = asNode(node.property);
  return obj?.name === 'module' && prop?.name === 'exports';
}

function propertyKey(prop: AnyNode, scope: Scope): string | null {
  const key = asNode(prop.key);
  if (!key) return null;
  if (prop.computed) {
    const v = evaluate(key, scope);
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
  }
  if (key.type === 'Identifier' && typeof key.name === 'string') return key.name;
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return String(key.value);
  }
  return null;
}

function evaluate(node: AnyNode, scope: Scope): JsValue {
  switch (node.type) {
    case 'Literal': {
      const v = node.value;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
        return v;
      }
      return undefined;
    }
    case 'TemplateLiteral': {
      const quasis = nodes(node.quasis);
      const exprs = nodes(node.expressions);
      let out = '';
      for (let i = 0; i < quasis.length; i++) {
        const value = asNode(quasis[i])?.value as { cooked?: string | null } | undefined;
        out += value?.cooked ?? '';
        const expr = exprs[i];
        if (expr) {
          const v = evaluate(expr, scope);
          if (v === undefined || (typeof v === 'object' && v !== null)) return undefined;
          out += String(v);
        }
      }
      return out;
    }
    case 'Identifier': {
      const name = typeof node.name === 'string' ? node.name : '';
      if (name === 'undefined') return undefined;
      const init = scope.consts.get(name);
      if (!init || scope.resolving.has(name)) return undefined;
      scope.resolving.add(name);
      const v = evaluate(init, scope);
      scope.resolving.delete(name);
      return v;
    }
    case 'ObjectExpression': {
      const out: JsObject = {};
      for (const prop of nodes(node.properties)) {
        if (prop.type === 'SpreadElement') {
          const arg = asNode(prop.argument);
          const v = arg ? evaluate(arg, scope) : undefined;
          if (isObject(v)) Object.assign(out, v);
          continue;
        }
        const key = propertyKey(prop, scope);
        const value = asNode(prop.value);
        if (key === null || !value) continue;
        out[key] = evaluate(value, scope);
      }
      return out;
    }
    case 'ArrayExpression':
      return nodes(node.elements).map((e) => evaluate(e, scope));
    case 'UnaryExpression': {
      const arg = asNode(node.argument);
      const v = arg ? evaluate(arg, scope) : undefined;
      if (node.operator === '-' && typeof v === 'number') return -v;
      if (node.operator === '!') return !v;
      return undefined;
    }
    case 'BinaryExpression': {
      const l = asNode(node.left);
      const r = asNode(node.right);
      const a = l ? evaluate(l, scope) : undefined;
      const b = r ? evaluate(r, scope) : undefined;
      if (node.operator === '+') {
        if (typeof a === 'number' && typeof b === 'number') return a + b;
        if (
          (typeof a === 'string' || typeof a === 'number') &&
          (typeof b === 'string' || typeof b === 'number')
        ) {
          return `${a}${b}`;
        }
      }
      return undefined;
    }
    case 'CallExpression': {
      if (isYearCall(node)) return YEAR_TOKEN;
      // `require.resolve('@scope/plugin')` → the module name.
      const callee = asNode(node.callee);
      const arg = nodes(node.arguments)[0];
      if (
        callee?.type === 'MemberExpression' &&
        asNode(callee.object)?.name === 'require' &&
        asNode(callee.property)?.name === 'resolve' &&
        arg?.type === 'Literal' &&
        typeof arg.value === 'string'
      ) {
        return arg.value;
      }
      return undefined;
    }
    case 'MemberExpression': {
      // `prismThemes.github` → 'github' (a named theme from an imported module).
      const obj = asNode(node.object);
      const prop = asNode(node.property);
      if (
        obj?.type === 'Identifier' &&
        typeof obj.name === 'string' &&
        scope.imports.has(obj.name) &&
        !node.computed &&
        typeof prop?.name === 'string'
      ) {
        return prop.name;
      }
      if (obj) {
        const base = evaluate(obj, scope);
        const key = node.computed && prop ? evaluate(prop, scope) : prop?.name;
        if (isObject(base) && typeof key === 'string') return base[key];
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** `new Date().getFullYear()` */
function isYearCall(node: AnyNode): boolean {
  const callee = asNode(node.callee);
  if (callee?.type !== 'MemberExpression') return false;
  const prop = asNode(callee.property);
  const obj = asNode(callee.object);
  const ctor = asNode(obj?.callee);
  return prop?.name === 'getFullYear' && obj?.type === 'NewExpression' && ctor?.name === 'Date';
}

export function isObject(v: JsValue | unknown): v is JsObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const str = (v: JsValue): string | null => (typeof v === 'string' ? v : null);
export const obj = (v: JsValue): JsObject => (isObject(v) ? v : {});
export const arr = (v: JsValue): JsValue[] => (Array.isArray(v) ? v : []);

/** `presets: [['classic', { docs, blog, theme }]]` → the classic preset options. */
export function classicPresetOptions(config: JsObject): JsObject {
  for (const preset of arr(config.presets)) {
    if (Array.isArray(preset)) {
      const name = str(preset[0] ?? null);
      if (name && /classic/.test(name)) return obj(preset[1]);
    }
  }
  return {};
}
