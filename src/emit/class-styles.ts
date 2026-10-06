/**
 * What the rest of the project says about a class, for the entries to be written against.
 *
 * Cwicly's class ids repeat from block to block with different declarations (a duplicated block keeps
 * its id; docs/design.md), and the live page resolves the clash by source order: the template's
 * stylesheet is printed first and the post's own after it, so on a project page the post's rule wins
 * every property it sets. A Jx page orders the same two rules by where their elements sit in the tree,
 * and a template's element that comes after the entry's body wins instead (a card with 14px of bottom
 * padding where the post says 5px, an image 175px high where the post says `auto`). The entries need to
 * know which classes the pages, layouts and components also style, and with what, to write their own
 * rules for those classes so that they win ({@link collectClassStyles}; `emit/collections.ts` uses it).
 *
 * Two forms carry an element's class and style in a converted file: a node of the JSON tree, and a
 * query loop's item, which the converters write as the text of a JavaScript expression
 * (`${items.map(($i) => ({'tagName': 'h2', 'className': 'heading-c235f2d', 'style': {...}}))}`).
 * The second is read with a scanner that knows quotes and braces, and each literal is parsed by
 * `JSON.parse` after its single quotes are made double, so nothing in the file is ever evaluated.
 */
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

/** JSON with the keys of every object in order, so two objects that differ only in key order are the same. */
export const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    isRec(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** Class selector (`.div-c3a6482`) to the canonical JSON of every style an element of that class carries. */
export type ClassStyles = Map<string, Set<string>>;

function note(into: ClassStyles, className: unknown, style: unknown): void {
  if (typeof className !== "string" || !isRec(style) || Object.keys(style).length === 0) return;
  const first = className.trim().split(/\s+/)[0];
  if (!first) return;
  const key = `.${first}`;
  let seen = into.get(key);
  if (seen === undefined) {
    seen = new Set();
    into.set(key, seen);
  }
  seen.add(sortedJson(style));
}

/**
 * The end of the `{`…`}` literal that starts at `from` (the index of its `{`) in a JavaScript
 * expression, or -1: braces inside a quoted string are not counted.
 */
function literalEnd(text: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** A `{'a': 'b', 'c': {...}}` literal as an object, or undefined when it is anything but plain data. */
function parseLiteral(text: string): Rec | undefined {
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "") {
      if (c === "'") {
        quote = "'";
        out += '"';
      } else {
        if (c === '"') quote = '"';
        out += c;
      }
    } else if (c === "\\") {
      // `\'` needs no escape between double quotes; every other escape keeps its meaning.
      const next = text[++i] ?? "";
      out += next === "'" ? "'" : `\\${next}`;
    } else if (c === quote) {
      quote = "";
      out += '"';
    } else if (c === '"' && quote === "'") out += '\\"';
    else out += c;
  }
  try {
    const parsed: unknown = JSON.parse(out);
    return isRec(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const CLASS_IN_EXPRESSION = /'className': '([^']*)'/g;

/** The items a text holds as expression literals: each `'className'` and the `'style'` literal that follows it before the next element. */
function noteExpression(into: ClassStyles, text: string): void {
  for (const match of text.matchAll(CLASS_IN_EXPRESSION)) {
    const after = match.index + match[0].length;
    const nextElement = text.indexOf("'tagName'", after);
    const at = text.indexOf("'style': {", after);
    if (at < 0 || (nextElement >= 0 && nextElement < at)) continue;
    const open = at + "'style': ".length;
    const close = literalEnd(text, open);
    if (close < 0) continue;
    const style = parseLiteral(text.slice(open, close + 1));
    if (style !== undefined) note(into, match[1], style);
  }
}

function walk(into: ClassStyles, value: unknown): void {
  if (typeof value === "string") {
    if (value.includes("'className': '")) noteExpression(into, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(into, item);
    return;
  }
  if (!isRec(value)) return;
  note(into, value.className, value.style);
  for (const item of Object.values(value)) walk(into, item);
}

/** Every class the converted files style, and with which declarations: `files` are Jx documents (JSON text). */
export function collectClassStyles(
  files: readonly { path: string; content: string }[],
  into: ClassStyles = new Map(),
): ClassStyles {
  for (const file of files) {
    if (!file.path.endsWith(".json")) continue;
    try {
      walk(into, JSON.parse(file.content));
    } catch {
      // Not a Jx document (a stray file): it styles nothing.
    }
  }
  return into;
}
