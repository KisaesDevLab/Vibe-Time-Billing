// SPDX-License-Identifier: Elastic-2.0
//
// Minimal, dependency-free template engine for the editable invoice
// document template. Unlike the email/SMS merge-token resolver
// (proposals/merge-tokens.ts), which is intentionally flat (no loops or
// conditionals — Q28), an invoice has to iterate line items, so this
// engine adds exactly three constructs on top of `{{ token }}`:
//
//   {{ scope.path }}                 — HTML-escaped value
//   {{{ scope.path }}}               — raw value (no escaping)
//   {{ token | default("text") }}    — fallback when the value is empty
//   {{#each items}} … {{/each}}      — iterate an array; inside, `this`/`this.f`
//   {{#if token}} … {{else}} … {{/if}} — truthy branch
//
// Lookups resolve dotted paths against the context object. Inside an
// {{#each}}, `this` is the current item and `this.field` reads its
// fields; bare scoped paths (e.g. `firm.name`) still resolve against the
// root. Unknown tokens render as the empty string. The engine is pure
// (no DB, no IO) and is unit-tested in template-engine.test.ts.

export type TemplateContext = Record<string, unknown>;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Parser — turns the template string into a small node tree.
// ---------------------------------------------------------------------------

interface TextNode {
  type: 'text';
  value: string;
}
interface VarNode {
  type: 'var';
  expr: string;
  raw: boolean;
}
interface EachNode {
  type: 'each';
  path: string;
  body: Node[];
}
interface IfNode {
  type: 'if';
  path: string;
  then: Node[];
  otherwise: Node[];
}
type Node = TextNode | VarNode | EachNode | IfNode;

// Matches {{{ raw }}} first, then {{ normal }}.
const TAG_RE = /\{\{\{\s*([\s\S]*?)\s*\}\}\}|\{\{\s*([\s\S]*?)\s*\}\}/g;

interface RawToken {
  text?: string;
  tag?: { content: string; raw: boolean };
}

function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(input))) {
    if (m.index > last) tokens.push({ text: input.slice(last, m.index) });
    const raw = m[1] !== undefined;
    tokens.push({ tag: { content: (raw ? m[1] : m[2])!.trim(), raw } });
    last = TAG_RE.lastIndex;
  }
  if (last < input.length) tokens.push({ text: input.slice(last) });
  return tokens;
}

function parse(tokens: RawToken[]): Node[] {
  let i = 0;

  // Parse a sequence of nodes until one of `stoppers` (block-closers /
  // else) is hit. Returns the nodes and leaves `i` pointing at the
  // stopper tag (not consumed).
  function parseSeq(stoppers: string[]): Node[] {
    const nodes: Node[] = [];
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok.text !== undefined) {
        nodes.push({ type: 'text', value: tok.text });
        i++;
        continue;
      }
      const content = tok.tag!.content;
      const keyword = content.split(/\s+/)[0] ?? '';
      if (stoppers.includes(keyword)) return nodes; // leave for caller

      if (keyword === '#each') {
        i++; // consume the #each tag
        const path = content.slice('#each'.length).trim();
        const body = parseSeq(['/each']);
        expectClose('/each');
        nodes.push({ type: 'each', path, body });
        continue;
      }
      if (keyword === '#if') {
        i++; // consume the #if tag
        const path = content.slice('#if'.length).trim();
        const thenNodes = parseSeq(['else', '/if']);
        let otherwise: Node[] = [];
        if (peekKeyword() === 'else') {
          i++; // consume else
          otherwise = parseSeq(['/if']);
        }
        expectClose('/if');
        nodes.push({ type: 'if', path, then: thenNodes, otherwise });
        continue;
      }
      // Plain variable / value tag.
      nodes.push({ type: 'var', expr: content, raw: tok.tag!.raw });
      i++;
    }
    return nodes;
  }

  function peekKeyword(): string | null {
    const tok = tokens[i];
    if (!tok || tok.tag === undefined) return null;
    return tok.tag.content.split(/\s+/)[0] ?? null;
  }

  function expectClose(kw: string): void {
    if (peekKeyword() === kw) i++; // consume the closer
    // If missing, we simply stop — be forgiving rather than throw on
    // a half-finished template typed in the editor.
  }

  return parseSeq([]);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function getDotted(obj: unknown, path: string): unknown {
  if (path === '') return obj;
  let cursor: unknown = obj;
  for (const part of path.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function resolveValue(path: string, root: TemplateContext, item: unknown): unknown {
  if (path === 'this') return item;
  if (path.startsWith('this.')) return getDotted(item, path.slice('this.'.length));
  return getDotted(root, path);
}

function isTruthy(v: unknown): boolean {
  if (v == null || v === false) return false;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number') return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// Parse `expr` of the form `path` or `path | default("fallback")`.
function parseExpr(expr: string): { path: string; fallback: string | null } {
  const pipe = expr.indexOf('|');
  if (pipe === -1) return { path: expr.trim(), fallback: null };
  const path = expr.slice(0, pipe).trim();
  const filter = expr.slice(pipe + 1).trim();
  const dm = /^default\(\s*(["'])([\s\S]*?)\1\s*\)$/.exec(filter);
  return { path, fallback: dm ? dm[2]! : null };
}

function evalNodes(nodes: Node[], root: TemplateContext, item: unknown): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.value;
        break;
      case 'var': {
        const { path, fallback } = parseExpr(node.expr);
        let v = resolveValue(path, root, item);
        if ((v == null || v === '') && fallback != null) v = fallback;
        const str = v == null ? '' : String(v);
        out += node.raw ? str : escapeHtml(str);
        break;
      }
      case 'each': {
        const arr = resolveValue(node.path, root, item);
        if (Array.isArray(arr)) {
          for (const el of arr) out += evalNodes(node.body, root, el);
        }
        break;
      }
      case 'if': {
        const v = resolveValue(node.path, root, item);
        out += isTruthy(v)
          ? evalNodes(node.then, root, item)
          : evalNodes(node.otherwise, root, item);
        break;
      }
    }
  }
  return out;
}

/** Render a template body (or CSS) against a context object. */
export function renderInvoiceTemplate(template: string, context: TemplateContext): string {
  const nodes = parse(tokenize(template));
  return evalNodes(nodes, context, undefined);
}

/**
 * Compose the final invoice HTML document from an editable body + CSS,
 * substituting tokens in both. CSS is injected into the document head
 * (so the stored body needs no <link>/<style>); if the body has no
 * <head>, a minimal HTML shell is wrapped around it.
 */
export function composeInvoiceHtml(
  bodyHtml: string,
  css: string,
  context: TemplateContext,
): string {
  const renderedBody = renderInvoiceTemplate(bodyHtml, context);
  const renderedCss = renderInvoiceTemplate(css ?? '', context);
  const styleTag = renderedCss.trim() ? `<style>\n${renderedCss}\n</style>` : '';
  if (/<\/head>/i.test(renderedBody)) {
    return renderedBody.replace(/<\/head>/i, `${styleTag}\n</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8" />${styleTag}</head><body>${renderedBody}</body></html>`;
}
