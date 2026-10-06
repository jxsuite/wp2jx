/**
 * Small helpers every converter needs when it writes Jx: style objects, class lists, and the one
 * piece of Jx syntax that content can collide with, the `${` template marker.
 */
import { isTemplateString } from "@jxsuite/schema/guards";
import type { JxStyle } from "./types.ts";

type StyleValue = JxStyle[string];

// ── Template expressions ─────────────────────────────────────────────────────────────────────────

/**
 * Whether a value is a Jx template expression. Jx's own test is "contains `${`" (a string need not
 * be a well-formed expression to be evaluated), so this defers to it rather than restating it.
 */
export function isBinding(value: unknown): value is string {
  return isTemplateString(value);
}

/**
 * Spell every literal `${` in an HTML string so no Jx pass reads it as a template: the character
 * reference for the dollar sign. Jx has no escape for a literal `${` in `textContent` or in an
 * attribute value (a backslash is consumed by the build-time evaluation and the sequence is then
 * evaluated a second time by the client emitter), and the static emitter escapes `&`, so a
 * reference written there would be shown as text. `innerHTML` is the one position that survives:
 * the build evaluates it only when it contains `${`, and the compiler itself writes `&#36;{` there
 * for the same reason (`resolveDocTemplates`, packages/compiler/src/site/site-build.ts).
 *
 * Apply it to markup that is going into an `innerHTML`, never to a value that is going into
 * `textContent` or `attributes`. It is also wrong inside `<script>` and `<style>`, whose content
 * the HTML parser does not decode; `html.ts` leaves those alone and reports them.
 */
export function escapeTemplate(html: string): string {
  return html.replaceAll("${", "&#36;{");
}

// ── Class lists ──────────────────────────────────────────────────────────────────────────────────

/** Whitespace as the HTML class-token splitter sees it: ASCII only, so a no-break space stays put. */
const CLASS_SPLIT = /[ \t\n\f\r]+/;

/**
 * Join class strings into one list: duplicates dropped (the first occurrence keeps its place) and
 * falsy parts skipped. Order matters in Jx, where an element's own style is written to the selector
 * of its FIRST class, so nothing here reorders.
 */
export function joinClass(...parts: (string | false | null | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const name of part.split(CLASS_SPLIT)) {
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out.join(" ");
}

// ── Style objects ────────────────────────────────────────────────────────────────────────────────

/**
 * A CSS property name as a Jx style key: the inverse of the runtime's `camelToKebab`. Custom
 * properties are case-sensitive and pass through; a vendor prefix loses its dash and keeps a
 * capital (`-webkit-box-orient` is `WebkitBoxOrient`, `-ms-flex` is `MsFlex`, because the runtime
 * turns `msFlex` into `ms-flex`).
 */
export function kebabToCamel(prop: string): string {
  if (prop.startsWith("--")) return prop;
  const camel = (prop.startsWith("-") ? prop.slice(1) : prop).replaceAll(
    /-([a-zA-Z])/g,
    (_, letter: string) => letter.toUpperCase(),
  );
  return prop.startsWith("-") ? camel.charAt(0).toUpperCase() + camel.slice(1) : camel;
}

/** One declaration of a `style` attribute, before it becomes a style entry. */
interface Declaration {
  name: string;
  value: string;
  important: boolean;
}

const IDENT = /^-?[a-zA-Z][a-zA-Z0-9-]*$/;
const CUSTOM = /^--[^\s:;{}()'"]+$/;
const IMPORTANT = /\s*!\s*important\s*$/i;

/** One declaration as written, and whether the CSS parser would have thrown it away unread. */
interface RawDeclaration {
  text: string;
  unreadable: boolean;
}

const CLOSER: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

/** What can precede `url(` for it to be the url function: not a longer name that ends in `url`. */
const URL_FUNCTION = /(?:^|[^\w\u0080-\uFFFF\\-])url$/i;

/**
 * Whether the parenthesis at `at` opens an unquoted address: the text before it ends in `url`, and
 * what comes after is not a string. Such a token runs to its `)` whatever it holds, so `/*` in it is
 * part of the address and `;` ends nothing.
 */
function opensUnquotedUrl(text: string, current: string, at: number): boolean {
  if (!URL_FUNCTION.test(current)) return false;
  let next = at + 1;
  while (/[ \t\n]/.test(text.charAt(next))) next++;
  const quote = text.charAt(next);
  return quote !== '"' && quote !== "'";
}

/**
 * Split declaration text the way the CSS parser does: a `;` ends a declaration only outside a
 * string and outside every `()`, `[]` and `{}`, and a comment is dropped unless it is inside a
 * string or an unquoted `url()`. `url(data:image/svg+xml;base64,...)`, `content: ";"` and
 * `--a: {x: 1; y: 2}` each hold a semicolon that ends nothing.
 *
 * What is still open at the end of the text is closed there, as CSS does at the end of input, so
 * nothing written from the result can swallow the rule after it. A declaration that CSS would have
 * thrown away is returned as unreadable: a closing bracket nothing opened (`color:red}`), a brace
 * that never closes, or a string that met a raw newline.
 */
function declarations(source: string): RawDeclaration[] {
  const text = source.replaceAll(/\r\n?|\f/g, "\n");
  const out: RawDeclaration[] = [];
  let current = "";
  let unreadable = false;
  let quote = "";
  // Inside an unquoted url(), where nothing but a backslash and the closing parenthesis means anything.
  let address = false;
  const open: string[] = [];
  const finish = (): void => {
    if (current.trim() !== "") out.push({ text: current, unreadable });
    current = "";
    unreadable = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "\\") {
      // A backslash escapes the next character. One at the very end escapes nothing, and left in front
      // of what closes a string or a bracket below it would escape that.
      if (i + 1 < text.length) current += ch + text.charAt(++i);
      else if (!quote && open.length === 0) current += ch;
      continue;
    }
    if (quote) {
      if (ch === "\n") {
        // A string does not run over a raw newline: it is a bad string, and the declaration with it.
        quote = "";
        unreadable = true;
      } else if (ch === quote) quote = "";
      current += ch;
      continue;
    }
    if (address) {
      current += ch;
      if (ch === ")") {
        address = false;
        open.pop();
      }
      continue;
    }
    if (ch === "/" && text.charAt(i + 1) === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch in CLOSER) {
      address = ch === "(" && opensUnquotedUrl(text, current, i);
      open.push(CLOSER[ch] as string);
      current += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (open.at(-1) === ch) open.pop();
      else unreadable = true;
      current += ch;
    } else if (ch === ";" && open.length === 0) {
      finish();
    } else {
      current += ch;
    }
  }
  if (open.includes("}")) unreadable = true;
  if (!unreadable) current += quote + open.toReversed().join("");
  finish();
  return out;
}

/** Where the property name ends: the first colon outside quotes and parentheses. */
function colonIndex(raw: string): number {
  let quote = "";
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

function parseDeclaration(raw: string): Declaration | undefined {
  const at = colonIndex(raw);
  if (at === -1) return undefined;
  const given = raw.slice(0, at).trim();
  // Custom properties are case-sensitive; every other property name is not.
  const name = given.startsWith("--") ? given : given.toLowerCase();
  if (!(given.startsWith("--") ? CUSTOM.test(name) : IDENT.test(name))) return undefined;
  let value = raw.slice(at + 1).trim();
  const important = IMPORTANT.test(value);
  if (important) value = value.replace(IMPORTANT, "").trim();
  return value === "" ? undefined : { name, value, important };
}

/**
 * Parse the text of a `style` attribute into a Jx style object: camelCase keys, custom properties
 * kept as written, `!important` kept on the value. A declaration that cannot be read (no colon, an
 * empty value, a name that is not an identifier, brackets that do not pair) is skipped; `onSkip`
 * hears about each so a caller can report it rather than lose it silently.
 *
 * Declarations are applied in CSS cascade order: a repeated property moves to the end (so a
 * shorthand written after its longhand still wins in the emitted rule), except that a later plain
 * declaration never replaces an earlier `!important` one.
 *
 * That is the cascade for declarations that are all valid. A browser throws away one it cannot read,
 * so `width: 100px; width: 90px\9` leaves 100px, and `display: flex; display: -ms-flexbox` leaves
 * flex: the way fallbacks are written. A style object holds one value per property and the text
 * carries no way to tell which a browser would read, so each time a declaration displaces another
 * with a different value `onRepeat` hears the property, the value that was dropped and the one that
 * was kept; a caller that wants the browser's own answer keeps the text.
 */
export function cssTextToStyle(
  text: string | null | undefined,
  onSkip?: (declaration: string) => void,
  onRepeat?: (property: string, dropped: string, kept: string) => void,
): JxStyle {
  const style: JxStyle = {};
  const importantKeys = new Set<string>();
  for (const { text: raw, unreadable } of declarations(text ?? "")) {
    const decl = unreadable ? undefined : parseDeclaration(raw);
    if (!decl) {
      onSkip?.(raw.trim());
      continue;
    }
    const key = kebabToCamel(decl.name);
    const value = decl.important ? `${decl.value} !important` : decl.value;
    const before = style[key];
    if (importantKeys.has(key) && !decl.important) {
      if (typeof before === "string" && before !== value) onRepeat?.(decl.name, value, before);
      continue;
    }
    if (typeof before === "string" && before !== value) onRepeat?.(decl.name, before, value);
    delete style[key];
    style[key] = value;
    if (decl.important) importantKeys.add(key);
  }
  return style;
}

const isBlock = (value: unknown): value is JxStyle =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cloneBlock = (block: JxStyle): JxStyle => {
  const copy: JxStyle = {};
  for (const [key, inner] of Object.entries(block)) copy[key] = cloneValue(inner);
  return copy;
};

function cloneValue(value: StyleValue): StyleValue {
  if (Array.isArray(value)) return value.map(cloneBlock);
  return isBlock(value) ? cloneBlock(value) : value;
}

/**
 * Merge two style objects, `b` winning. Nested blocks (`":hover"`, `"@--md"`, `"& a"`) merge
 * recursively. Every key `b` sets is written after all of `a`'s remaining keys, because the emitted
 * rule keeps key order and CSS lets the later of a shorthand and its longhand win: `b`'s
 * `margin: 0` must override `a`'s `marginTop`, not sit before it. The same key written in blocks
 * of several at-rules (an array, as `@font-face` needs) concatenates rather than replaces.
 * Neither input is modified.
 */
export function mergeStyle(a: JxStyle | null | undefined, b: JxStyle | null | undefined): JxStyle {
  const out: JxStyle = {};
  for (const [key, value] of Object.entries(a ?? {})) {
    if (value === undefined || (b && b[key] !== undefined)) continue;
    out[key] = cloneValue(value);
  }
  for (const [key, value] of Object.entries(b ?? {})) {
    if (value === undefined) continue;
    const before = a?.[key];
    if (isBlock(value) && isBlock(before)) out[key] = mergeStyle(before, value);
    else if (Array.isArray(value) && Array.isArray(before))
      out[key] = [...before.map(cloneBlock), ...value.map(cloneBlock)];
    else out[key] = cloneValue(value);
  }
  return out;
}

/**
 * Whether a style carries nothing the compiler would write: no declaration and no block that holds
 * one. A block of empty blocks, an empty string and `undefined` all count as nothing.
 */
export function isEmptyStyle(style: JxStyle | null | undefined): boolean {
  if (!style) return true;
  return Object.values(style).every((value) => {
    if (value === undefined || value === "") return true;
    if (Array.isArray(value)) return value.every((entry) => isEmptyStyle(entry));
    if (isBlock(value)) return isEmptyStyle(value);
    return false;
  });
}

// ── Bindings across HTML conversion ──────────────────────────────────────────────────────────────

/**
 * What a binding's value is when it is written into markup: `text` is plain text, which an
 * `innerHTML` does not escape and so must be escaped by the expression; `html` is markup, written as is.
 * `textContent` and attribute values are escaped by the Jx emitter, so there the two are the same.
 */
export type BindingKind = "text" | "html";

/** Where a string with bindings will be written; it decides which escapes its literal parts need. */
export type BindingContext = "text" | "attribute" | "html";

const MARK_OPEN = "";
const MARK_CLOSE = "";
const MARKER = /([th])([A-Za-z0-9_-]*)/g;

/**
 * A placeholder for `${expr}`. The HTML converters read every `${` in markup as a literal one and
 * escape it, so a binding cannot travel through them as itself. The placeholder is made of private-use
 * characters and base64url, which no parser, whitespace rule or class splitter touches, and carries
 * its expression and its kind. {@link finishBindings} and {@link finishNodes} turn it back.
 */
export function bindingMarker(expr: string, kind: BindingKind = "text"): string {
  const encoded = Buffer.from(expr, "utf8").toString("base64url");
  return `${MARK_OPEN}${kind === "html" ? "h" : "t"}${encoded}${MARK_CLOSE}`;
}

export function hasBindingMarkers(value: string): boolean {
  return value.includes(MARK_OPEN);
}

type Piece = { literal: string } | { expr: string; kind: BindingKind };

function splitMarkers(value: string): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  for (const m of value.matchAll(MARKER)) {
    if (m.index > at) pieces.push({ literal: value.slice(at, m.index) });
    pieces.push({
      expr: Buffer.from(m[2] ?? "", "base64url").toString("utf8"),
      kind: m[1] === "h" ? "html" : "text",
    });
    at = m.index + m[0].length;
  }
  if (at < value.length) pieces.push({ literal: value.slice(at) });
  return pieces;
}

/**
 * The expression that escapes a plain-text value for markup: what a text binding needs where it
 * lands in an `innerHTML`. The regular expression, the arrow function and the object literal are all
 * evaluated by the Jx build (docs/bindings.md, section 5).
 */
export function htmlEscapeExpr(expr: string): string {
  return `String((${expr}) ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))`;
}

/** A literal `${` where only a character reference could spell it: no spelling survives, so a zero-width space splits it. */
const LITERAL_TEMPLATE = "$​{";

function literalPart(text: string, where: BindingContext, hasBindings: boolean): string {
  // In a template literal a backslash and a backtick are syntax; in a string with no binding the
  // build never evaluates the text and they are what they look like.
  let out = hasBindings ? text.replaceAll("\\", "\\\\").replaceAll("`", "\\`") : text;
  if (where === "html") out = escapeTemplate(out);
  else out = out.replaceAll("${", LITERAL_TEMPLATE);
  return out;
}

/**
 * Turns the placeholders of one string into real bindings, for the place the string is written.
 * Literal parts are escaped as the build needs them (backslash and backtick, only when the string
 * holds a binding; a literal `${` as `&#36;{` in markup and split with a zero-width space elsewhere,
 * where no spelling survives: `onLiteralTemplate` hears about that). A text binding that lands in
 * markup is escaped by its expression; an HTML binding is written as is.
 */
export function finishBindings(
  value: string,
  where: BindingContext,
  onLiteralTemplate?: () => void,
): string {
  const pieces = splitMarkers(value);
  const hasBindings = pieces.some((p) => "expr" in p);
  let out = "";
  for (const piece of pieces) {
    if ("expr" in piece) {
      out += `\${${where === "html" && piece.kind === "text" ? htmlEscapeExpr(piece.expr) : piece.expr}}`;
    } else {
      if (where !== "html" && piece.literal.includes("${")) onLiteralTemplate?.();
      out += literalPart(piece.literal, where, hasBindings);
    }
  }
  return out;
}

/** A string that holds a placeholder as a piece of markup: its literal text escaped, its bindings kept as placeholders. */
function markupFromText(value: string): string {
  return splitMarkers(value)
    .map((p) =>
      "expr" in p
        ? bindingMarker(p.expr, p.kind)
        : p.literal.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    )
    .join("");
}

const hasHtmlBinding = (value: string): boolean =>
  splitMarkers(value).some((p) => "expr" in p && p.kind === "html");

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Turns every placeholder in the nodes (or in the `{textContent, children, innerHTML}` that
 * `htmlToContent` returns) into a real binding, in the form each position needs: `textContent`,
 * attributes, `style` values and `$props` take the bare expression (the emitter escapes them),
 * `innerHTML` escapes a text binding. Two shapes the build cannot evaluate are rewritten on the way:
 * a string in `children` that holds a binding is printed as written, so it becomes a
 * `<span>` with its own `textContent`; and a `textContent` that holds an HTML binding would show the
 * markup as text, so it becomes `innerHTML`. The input is not modified.
 */
export function finishNodes<T>(value: T, onLiteralTemplate?: () => void): T {
  return walk(value, onLiteralTemplate) as T;
}

/** Keys whose string value is written into markup. */
const MARKUP_KEYS = new Set(["innerHTML"]);

function walk(value: unknown, onLit: (() => void) | undefined): unknown {
  if (typeof value === "string") {
    return hasBindingMarkers(value) ? finishBindings(value, "attribute", onLit) : value;
  }
  if (Array.isArray(value)) return value.map((item) => walkChild(item, onLit));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "children") {
      out[key] = Array.isArray(inner)
        ? inner.map((child) => walkChild(child, onLit))
        : walk(inner, onLit);
    } else if (typeof inner === "string" && hasBindingMarkers(inner)) {
      if (key === "textContent" && hasHtmlBinding(inner)) {
        out.innerHTML = finishBindings(markupFromText(inner), "html", onLit);
      } else if (MARKUP_KEYS.has(key)) {
        out[key] = finishBindings(inner, "html", onLit);
      } else {
        out[key] = finishBindings(inner, key === "textContent" ? "text" : "attribute", onLit);
      }
    } else {
      out[key] = walk(inner, onLit);
    }
  }
  return out;
}

function walkChild(child: unknown, onLit: (() => void) | undefined): unknown {
  if (typeof child === "string" && hasBindingMarkers(child)) {
    return hasHtmlBinding(child)
      ? { tagName: "span", innerHTML: finishBindings(markupFromText(child), "html", onLit) }
      : { tagName: "span", textContent: finishBindings(child, "text", onLit) };
  }
  return walk(child, onLit);
}
