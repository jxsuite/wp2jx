/**
 * Custom CSS on a Cwicly block, from the attribute to plain CSS.
 *
 * `customCSS` is never in the generated stylesheet files: `render.php` prints it inline, in a
 * `<style id="custom-css-<id>">`, after replacing a few words in it. This module reproduces that
 * step and the one before it, because what the editor stores is not always CSS.
 *
 * **Which attribute is printed** (`render.php`): `customSCSS` when the site's `cwicly_scss_compiler`
 * option is on and the block has one, else `customCSS`. In the editor the source is `customCSS`
 * (Monaco, SCSS mode) and `customSCSS` is what the SCSS compiler made of it, so with the option on
 * the value that reaches the page is already CSS. That is why the census of both sites (34 blocks:
 * 12 `customSCSS`, 30 `customCSS`, no nesting, no `$variable`, no mixin, no `//` comment, two
 * `@keyframes`) holds nothing a CSS reader cannot read as is. `compileScss` exists for the other
 * case, which the live site gets wrong: a `customCSS` written as SCSS that nobody compiled (the
 * option off, or `customSCSS` empty) is printed raw and the browser reads what it can. Here it is
 * compiled, so the author's intent survives; the converter reports that it did.
 *
 * **The words** (`render.php`, in this order): `blockclass` becomes the block's classID, `blockid`
 * its `id` attribute (the editor's id: the live element has it only when the block prints one),
 * every CR and LF is deleted (not turned into a space), whitespace runs collapse to one space, and
 * for each breakpoint but the main one `media-breakpoint-<key>` becomes `<min|max>-width: <w>px`
 * and `breakpoint-<key>` becomes `<w>px`. `min` is a breakpoint listed before the main one, `max` one
 * listed after it (`Breakpoint.direction`). `media-breakpoint-` is replaced first, because the
 * shorter word is inside it.
 *
 * **The SCSS subset** `compileScss` reads is the part of Sass that turns into CSS by text
 * rewriting, which is what an author writes in a block's custom CSS box: `//` comments, `$variables`
 * (and `#{$interpolation}`), nested rules with `&` in any position (`&:hover`, `&-suffix`, `.a &`,
 * `& + &`), selector lists, `@media`/`@supports` at any depth (bubbling out of its rule), `@mixin`
 * with parameters and defaults and `@include` with positional or keyword arguments. Everything else
 * is returned in `unsupported` and left out of the output rather than guessed at: `@content`,
 * `@extend`, `%placeholders`, `@if`/`@each`/`@for`/`@while`, `@function`/`@return`, `@use`/`@forward`/
 * `@import`, nested properties (`font: { … }`), arithmetic (on a variable, or on literals: `10px + 5px`), and the colour and math
 * functions Sass evaluates (`darken`, `mix`, `math.div`…).
 */
import type { Breakpoint } from "../types.ts";

// ── The words render.php replaces ────────────────────────────────────────────────────────────────

export interface CustomCssVars {
  /** `blockclass`: the block's classID. */
  classID: string;
  /** `blockid`: the block's `id` attribute. */
  id: string;
  /** The site's breakpoints; the main one is skipped. */
  breakpoints: readonly Pick<Breakpoint, "key" | "width" | "isMain" | "direction">[];
}

export interface ExpandOptions {
  /**
   * Delete CR and LF and collapse whitespace, as `render.php` does (default). Off, newlines stay
   * what they are, which a `//` comment needs to end where its author ended it.
   */
  php?: boolean;
}

/** The text `render.php` prints between `<style>` tags for a block's custom CSS. */
export function expandCustomCssTokens(
  css: string,
  vars: CustomCssVars,
  opts: ExpandOptions = {},
): string {
  const php = opts.php ?? true;
  let out = css.replaceAll("blockclass", vars.classID).replaceAll("blockid", vars.id);
  if (php) out = out.replaceAll(/[\r\n]/g, "").replaceAll(/\s+/g, " ");
  if (out.includes("breakpoint-")) {
    for (const bp of vars.breakpoints) {
      if (bp.isMain) continue;
      const type = bp.direction === "min" ? "min" : "max";
      out = out
        .replaceAll(`media-breakpoint-${bp.key}`, `${type}-width: ${bp.width}px`)
        .replaceAll(`breakpoint-${bp.key}`, `${bp.width}px`);
    }
  }
  return out;
}

/**
 * Which attribute `render.php` prints: `customSCSS` when the SCSS option is on and it is not empty,
 * else `customCSS`. PHP truthiness decides both: `"0"` and the empty string are false, nothing else
 * stored here is (so a stored `"false"` is on, exactly as it is on the live site).
 */
export function customCssSource(
  attrs: Record<string, unknown>,
  scssOption: string | undefined,
): { source: "customCSS" | "customSCSS"; css: string } | undefined {
  const truthy = (value: unknown): boolean =>
    typeof value === "string" && value !== "" && value !== "0";
  if (!truthy(attrs.customCSS)) return undefined;
  const compiled = attrs.customSCSS;
  if (truthy(scssOption) && truthy(compiled)) {
    return { source: "customSCSS", css: compiled as string };
  }
  return { source: "customCSS", css: attrs.customCSS as string };
}

// ── SCSS ─────────────────────────────────────────────────────────────────────────────────────────

export interface ScssProblem {
  /** What was met: `@content`, `@extend`, `arithmetic`… */
  feature: string;
  /** The text it was met in, cut short. */
  detail: string;
}

export interface ScssResult {
  /** Plain CSS, rules in source order. Empty when there was nothing to compile. */
  css: string;
  unsupported: ScssProblem[];
}

/**
 * Whether text uses anything only Sass reads: a `//` comment, a `$variable`, an `@mixin`/`@include`,
 * an interpolation, or a rule nested inside a rule that is not an at-rule's. Plain CSS (including
 * native CSS nesting, which the CSS reader flattens itself) answers false and needs no compile.
 *
 * What is inside a string or a `url(...)` is text to Sass, except for `#{…}` in a string: a price
 * in a `content` (`"$5"`), a protocol-relative url (`url(//cdn.test/a.png)`) and a plain
 * `@import url(...)` are all CSS, and compiling them would drop the rule they are in.
 */
export function usesScss(source: string): boolean {
  const { plain, lineComment, stringInterpolation } = scan(source);
  if (lineComment || stringInterpolation) return true;
  // A plain CSS import (a url(), or a quoted .css file or absolute address) is not a Sass one.
  const imports = stripComments(source, true).text.replaceAll(
    /@import\s+(?:url\(|["'][^"']*(?:\.css|:\/\/)|["']\/\/)/gi,
    "",
  );
  return (
    /(^|[\s;{}])\$[\w-]+\s*:|\$[\w-]+|#\{|@(?:mixin|include|extend|content|use|forward|function|if|else|each|for|while)\b|(^|[;{}\s])%[\w-]+/.test(
      plain,
    ) || /@import\b/.test(imports)
  );
}

/** `fn` applied to the text outside quoted strings; what is inside them is returned as written. */
function outsideStrings(text: string, fn: (part: string) => string): string {
  let out = "";
  let part = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += text.charAt(i + 1);
        i++;
      } else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      out += fn(part);
      part = "";
      quote = ch;
      out += ch;
    } else {
      part += ch;
    }
  }
  return out + fn(part);
}

/**
 * The text with its comments, strings and `url(...)` bodies blanked, and what that hid: whether a
 * `//` comment was there and whether a string held a `#{…}` (the one place Sass reads inside one).
 */
function scan(source: string): {
  plain: string;
  lineComment: boolean;
  stringInterpolation: boolean;
} {
  let plain = "";
  let lineComment = false;
  let stringInterpolation = false;
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source.charAt(j) !== ch) j += source.charAt(j) === "\\" ? 2 : 1;
      if (source.slice(i + 1, j).includes("#{")) stringInterpolation = true;
      plain += `${ch}${ch}`;
      i = j + 1;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (ch === "/" && next === "/") {
      lineComment = true;
      while (i < source.length && source.charAt(i) !== "\n") i++;
    } else if (ch === "(" && /url$/i.test(plain)) {
      const end = source.indexOf(")", i);
      plain += "()";
      i = end === -1 ? source.length : end + 1;
    } else {
      plain += ch;
      i++;
    }
  }
  return { plain, lineComment, stringInterpolation };
}

type Node =
  | { kind: "decl"; prop: string; value: string }
  | { kind: "rule"; selector: string; body: Node[] }
  | { kind: "at"; name: string; params: string; body: Node[] | undefined }
  | { kind: "var"; name: string; value: string; fallback: boolean }
  | { kind: "mixin"; name: string; params: string; body: Node[] }
  | { kind: "include"; name: string; args: string };

const clip = (text: string, limit = 80): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/**
 * Remove comments. `//` runs to the end of the line, except inside a string or a `url(...)`, and
 * `/* *\/` is removed too when `all` is set (it is kept for output otherwise: CSS comments are harmless).
 */
function stripComments(source: string, all = false): { text: string } {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  let depthUrl = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (depthUrl === 0 && /url\($/i.test(out)) depthUrl = 1;
    if (depthUrl > 0) {
      if (ch === ")") depthUrl = 0;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source.charAt(i) !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      if (!all) out += source.slice(i, stop);
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out };
}

/** A block's statements: text up to `;`, or a `{ … }` block with its prelude. */
function parseBlock(text: string, at: { i: number }, problems: ScssProblem[]): Node[] {
  const nodes: Node[] = [];
  let buffer = "";
  let quote: string | null = null;
  let parens = 0;
  const flushStatement = (): void => {
    const statement = buffer.trim();
    buffer = "";
    if (statement === "") return;
    const variable = /^(\$[\w-]+)\s*:\s*([\s\S]*)$/.exec(statement);
    if (variable) {
      const raw = variable[2]!.trim();
      const fallback = /\s*!default\s*$/.test(raw);
      nodes.push({
        kind: "var",
        name: variable[1]!,
        value: raw.replace(/\s*!default\s*$/, "").replace(/\s*!global\s*$/, ""),
        fallback,
      });
      return;
    }
    const include = /^@include\s+([\w-]+)\s*(?:\(([\s\S]*)\))?$/.exec(statement);
    if (include) {
      nodes.push({ kind: "include", name: include[1]!, args: include[2] ?? "" });
      return;
    }
    if (statement.startsWith("@")) {
      nodes.push({
        kind: "at",
        name: /^@([\w-]+)/.exec(statement)?.[1] ?? "",
        params: statement,
        body: undefined,
      });
      return;
    }
    const colon = findColon(statement);
    if (colon === -1) {
      problems.push({ feature: "statement", detail: clip(statement) });
      return;
    }
    nodes.push({
      kind: "decl",
      prop: statement.slice(0, colon).trim(),
      value: statement.slice(colon + 1).trim(),
    });
  };
  while (at.i < text.length) {
    const ch = text.charAt(at.i);
    if (quote) {
      buffer += ch;
      if (ch === "\\") {
        buffer += text.charAt(at.i + 1);
        at.i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      at.i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      at.i++;
      continue;
    }
    if (ch === "(") parens++;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    if (ch === "#" && text.charAt(at.i + 1) === "{") {
      const end = text.indexOf("}", at.i);
      const stop = end === -1 ? text.length : end + 1;
      buffer += text.slice(at.i, stop);
      at.i = stop;
      continue;
    }
    if (ch === ";" && parens === 0) {
      at.i++;
      flushStatement();
      continue;
    }
    if (ch === "{" && parens === 0) {
      at.i++;
      const prelude = buffer.trim();
      buffer = "";
      const body = parseBlock(text, at, problems);
      if (prelude.startsWith("@mixin")) {
        const m = /^@mixin\s+([\w-]+)\s*(?:\(([\s\S]*)\))?$/.exec(prelude);
        if (m) nodes.push({ kind: "mixin", name: m[1]!, params: m[2] ?? "", body });
        else problems.push({ feature: "@mixin", detail: clip(prelude) });
      } else if (prelude.startsWith("@")) {
        nodes.push({
          kind: "at",
          name: /^@([\w-]+)/.exec(prelude)?.[1] ?? "",
          params: prelude,
          body,
        });
      } else {
        nodes.push({ kind: "rule", selector: prelude, body });
      }
      continue;
    }
    if (ch === "}" && parens === 0) {
      at.i++;
      flushStatement();
      return nodes;
    }
    buffer += ch;
    at.i++;
  }
  flushStatement();
  return nodes;
}

/** The colon that separates a property from its value (not one in a string, parentheses or a pseudo selector). */
function findColon(statement: string): number {
  let quote: string | null = null;
  let parens = 0;
  for (let i = 0; i < statement.length; i++) {
    const ch = statement.charAt(i);
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") parens++;
    else if (ch === ")" || ch === "]") parens--;
    else if (ch === ":" && parens === 0) return i;
  }
  return -1;
}

/** Split on top-level commas (parentheses, brackets and strings respected). */
function splitTop(text: string, separator = ","): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === separator && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((part) => part.trim()).filter((part) => part !== "");
}

type Env = Map<string, string>;

/**
 * Functions only Sass evaluates, which a browser would not understand if they were passed through.
 * `grayscale`, `invert` and `saturate` are CSS filter functions as well: `sassFilter` tells them apart.
 */
const SASS_FUNCTIONS =
  /\b(?:darken|lighten|desaturate|adjust-hue|mix|percentage|math\.[a-z-]+|map-get|map\.get|nth|length|unit|unitless|str-[a-z]+|em-calc|scale-color|change-color|adjust-color|transparentize|opacify|fade-in|fade-out|complement)\(/;

/** The text between the parentheses of each `name(` call in `text`, nested calls included in their caller's. */
function callsOf(text: string, names: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(names)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i++) {
      if (text.charAt(i) === "(") depth++;
      else if (text.charAt(i) === ")") depth--;
    }
    out.push(text.slice(start, depth === 0 ? i - 1 : i));
  }
  return out;
}

/**
 * Whether `grayscale(…)`, `invert(…)` or `saturate(…)` is Sass's colour function: it takes a colour
 * (and a second argument), where the CSS filter takes one number, percentage, variable or calc().
 */
function sassFilter(plain: string): boolean {
  return callsOf(plain, /\b(?:grayscale|invert|saturate)\(/g).some((args) => {
    const parts = splitTop(args);
    if (parts.length !== 1) return true;
    const first = parts[0]!;
    return (
      /^(?:#|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\()/i.test(first) ||
      /^[a-z][\w-]*$/i.test(first)
    );
  });
}

/** Whether `if(…)` is Sass's conditional function (its arguments compare or name a boolean), not CSS's. */
const sassIf = (plain: string): boolean =>
  callsOf(plain, /\bif\(/g).some((args) =>
    /==|!=|<=|>=|\b(?:true|false|null|not|and|or)\b/.test(args),
  );

const MATH_CALL =
  /\b(?:-webkit-|-moz-)?(?:calc|min|max|clamp|round|mod|rem|abs|sign|sin|cos|tan|asin|acos|atan|atan2|pow|sqrt|hypot|log|exp)\(/gi;

/** Arithmetic Sass would compute on literals (`10px + 5px`, `(10px * 2)`, `4px - 1px`), which is not CSS outside a math function. */
function literalArithmetic(plain: string): boolean {
  let text = plain.replaceAll(/(\d)e([+-]\d)/gi, "$1_$2");
  for (const body of callsOf(text, MATH_CALL)) text = text.replace(body, "");
  return /(?<![\w.#$-])(?:\d+\.?\d*|\.\d+)[a-z%]*\s*(?:[+*]|\s-\s)\s*-?(?:\d|\.\d)/i.test(text);
}

interface Flat {
  contexts: string[];
  selector: string;
  decls: [string, string][];
  /** Keyframe stops (`50%`, `from`) with their declarations, for `@keyframes` bodies. */
  stops?: [string, string][];
}

class Compiler {
  readonly problems: ScssProblem[] = [];
  readonly flat: Flat[] = [];
  readonly mixins = new Map<string, { params: string; body: Node[]; env: Env }>();
  private depth = 0;

  report(feature: string, detail: string): void {
    if (!this.problems.some((p) => p.feature === feature && p.detail === detail)) {
      this.problems.push({ feature, detail: clip(detail) });
    }
  }

  /** `$name` and `#{$name}` replaced from the environment; an unknown variable is reported and left. */
  substitute(text: string, env: Env): string {
    const names = [...env.keys()].toSorted((a, b) => b.length - a.length);
    const out = text.replaceAll(/#\{\s*([^{}]*?)\s*\}/g, (_, inner: string) =>
      /^\$[\w-]+$/.test(inner) && env.has(inner) ? env.get(inner)! : `#{${inner}}`,
    );
    // Sass reads `$name` outside a string; inside one it is text (`#{$name}` above is the way in).
    return outsideStrings(out, (part) => {
      let text = part;
      for (const name of names) {
        text = text.replaceAll(new RegExp(`\\${name}(?![\\w-])`, "g"), () => env.get(name)!);
      }
      return text;
    });
  }

  /** Whether a declaration's value can be written out: false (and reported) when Sass would have had to evaluate it. */
  usable(value: string, original: string): boolean {
    let ok = true;
    // A `$word` or a function name inside a string or a url() is text.
    const { plain } = scan(value);
    if (/\$[\w-]+/.test(plain)) {
      this.report("variable", `${original} (undefined variable)`);
      ok = false;
    }
    if (/#\{/.test(value)) {
      this.report("interpolation", original);
      ok = false;
    }
    if (SASS_FUNCTIONS.test(plain) || sassFilter(plain) || sassIf(plain)) {
      this.report("function", original);
      ok = false;
    }
    // Arithmetic needs an operand Sass would have computed: a variable beside an operator.
    const written = scan(original).plain;
    const arithmetic = /(?:\$[\w-]+|\))\s*[*+/]\s*[\w($.-]|[\w).]\s*[*+/]\s*\$[\w-]+/.test(written);
    if (arithmetic && /\$[\w-]+/.test(written) && !/url\(/.test(original)) {
      this.report("arithmetic", original);
      ok = false;
    } else if (literalArithmetic(plain)) {
      this.report("arithmetic", original);
      ok = false;
    }
    return ok;
  }

  evaluate(
    nodes: Node[],
    env: Env,
    parents: string[],
    contexts: string[],
    sink: Flat | undefined,
  ): void {
    if (++this.depth > 64) {
      this.report("nesting", "nesting deeper than 64 levels");
      this.depth--;
      return;
    }
    let own: Flat | undefined = sink;
    const ensure = (): Flat => {
      if (own === undefined) {
        own = { contexts, selector: parents.join(", "), decls: [] };
        this.flat.push(own);
      }
      return own;
    };
    const scope: Env = new Map(env);
    for (const node of nodes) {
      switch (node.kind) {
        case "var": {
          if (node.fallback && scope.has(node.name)) break;
          scope.set(node.name, this.substitute(node.value, scope));
          break;
        }
        case "mixin":
          this.mixins.set(node.name, { params: node.params, body: node.body, env: new Map(scope) });
          break;
        case "include": {
          const mixin = this.mixins.get(node.name);
          if (!mixin) {
            this.report("@include", `@include ${node.name} (no such mixin)`);
            break;
          }
          const bound = new Map(mixin.env);
          const params = splitTop(mixin.params);
          const args = splitTop(this.substitute(node.args, scope));
          const keyword = new Map<string, string>();
          const positional: string[] = [];
          for (const arg of args) {
            const named = /^(\$[\w-]+)\s*:\s*([\s\S]+)$/.exec(arg);
            if (named) keyword.set(named[1]!, named[2]!.trim());
            else positional.push(arg);
          }
          params.forEach((param, index) => {
            const m = /^(\$[\w-]+)\s*(?::\s*([\s\S]+))?$/.exec(param);
            if (!m) {
              this.report("@mixin", `parameter ${param}`);
              return;
            }
            const given = keyword.get(m[1]!) ?? positional[index];
            const value =
              given ?? (m[2] === undefined ? undefined : this.substitute(m[2].trim(), bound));
            if (value === undefined)
              this.report("@include", `@include ${node.name}: missing ${m[1]}`);
            else bound.set(m[1]!, value);
          });
          if (mixin.body.some((n) => n.kind === "decl") && parents.length === 0) {
            this.report("@include", `@include ${node.name} outside a rule`);
            break;
          }
          this.evaluate(mixin.body, bound, parents, contexts, own);
          // The mixin's declarations went into the same rule; its nested rules were flattened.
          break;
        }
        case "decl": {
          const prop = this.substitute(node.prop, scope);
          const value = this.substitute(node.value, scope);
          if (!this.usable(value, node.value)) break;
          if (parents.length === 0) {
            this.report("declaration", `${prop}: ${value} outside a rule`);
            break;
          }
          ensure().decls.push([prop, value]);
          break;
        }
        case "rule": {
          if (/:\s*$/.test(node.selector) && !/::?[\w-]+\s*$/.test(node.selector)) {
            this.report("nested properties", node.selector);
            break;
          }
          const selector = this.substitute(node.selector, scope);
          if (selector.includes("%")) {
            this.report("%placeholder", selector);
            break;
          }
          const members = splitTop(selector);
          let next: string[];
          if (parents.length === 0) {
            next = members;
            if (members.some((m) => m.includes("&")))
              this.report("&", `${selector} outside a rule`);
          } else {
            // Sass lists the parents' combinations parent by parent.
            next = parents.flatMap((parent) =>
              members.map((child) =>
                child.includes("&") ? child.replaceAll("&", parent) : `${parent} ${child}`,
              ),
            );
          }
          // A rule that follows declarations of its parent starts a new flat rule for the parent's
          // later declarations, so source order survives.
          own = undefined;
          this.evaluate(node.body, scope, next, contexts, undefined);
          break;
        }
        case "at": {
          const params = this.substitute(node.params, scope);
          if (/^@(media|supports|container|layer)\b/.test(params) && node.body) {
            own = undefined;
            this.evaluate(node.body, scope, parents, [...contexts, params.trim()], undefined);
          } else if (
            /^@(keyframes|font-face|-webkit-keyframes|property|page|counter-style)\b/.test(
              params,
            ) &&
            node.body
          ) {
            const flat: Flat = { contexts, selector: params.trim(), decls: [] };
            this.flat.push(flat);
            this.rawBlock(node.body, flat, scope);
          } else if (
            /^@(charset|import url|import "|import ')/.test(params) &&
            node.body === undefined &&
            parents.length === 0
          ) {
            this.flat.push({ contexts: [], selector: params.trim(), decls: [] });
          } else {
            this.report(node.name === "" ? "at-rule" : `@${node.name}`, params);
          }
          break;
        }
      }
    }
    this.depth--;
  }

  /** The body of `@keyframes` and friends: kept as written, with variables substituted. */
  rawBlock(body: Node[], flat: Flat, env: Env): void {
    for (const node of body) {
      if (node.kind === "rule") {
        const inner = node.body
          .filter((n): n is Extract<Node, { kind: "decl" }> => n.kind === "decl")
          .map((n) => `${n.prop}:${this.substitute(n.value, env)}`)
          .join(";");
        (flat.stops ??= []).push([this.substitute(node.selector, env), inner]);
      } else if (node.kind === "decl") {
        flat.decls.push([node.prop, this.substitute(node.value, env)]);
      }
    }
  }
}

/** Compile the SCSS subset to CSS. See the module comment for what it reads and what it reports. */
export function compileScss(source: string): ScssResult {
  const compiler = new Compiler();
  const text = stripComments(source).text;
  const nodes = parseBlock(text, { i: 0 }, compiler.problems);
  compiler.evaluate(nodes, new Map(), [], [], undefined);
  for (const feature of featuresIn(text)) compiler.report(feature.feature, feature.detail);
  const out: string[] = [];
  for (const flat of compiler.flat) {
    const head = flat.selector;
    let body = flat.decls.map(([k, v]) => `${k}:${v};`).join("");
    if (flat.stops) {
      body = flat.stops.map(([stop, inner]) => `${stop}{${inner}}`).join("");
    } else if (flat.decls.length === 0) {
      // A statement at-rule (`@import url(...)`) has no body; an empty rule says nothing.
      if (head.startsWith("@")) out.push(`${head};`);
      continue;
    }
    let rule = `${head}{${body}}`;
    for (const context of flat.contexts.toReversed()) rule = `${context}{${rule}}`;
    out.push(rule);
  }
  return { css: out.join("\n"), unsupported: compiler.problems };
}

/** Constructs that no pass of the compiler handles, found by their syntax. */
function featuresIn(text: string): ScssProblem[] {
  const found: ScssProblem[] = [];
  const add = (feature: string, pattern: RegExp): void => {
    const m = pattern.exec(text);
    if (m) found.push({ feature, detail: clip(text.slice(m.index, m.index + 60)) });
  };
  add("@content", /@content\b/);
  add("@extend", /@extend\b/);
  add("@if", /@(?:if|else)\b/);
  add("@each", /@each\b/);
  add("@for", /@for\b/);
  add("@while", /@while\b/);
  add("@function", /@(?:function|return)\b/);
  add("@use", /@(?:use|forward)\b/);
  add("@import", /@import\s+(?!url|["'][^"']*(?:\.css|:\/\/)|["']\/\/)/);
  return found;
}
