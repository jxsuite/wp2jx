/**
 * The round-trip oracle for `src/cwicly/css.ts`.
 *
 *   canonicalCss(original).rules   must equal   canonicalCss(renderCssIndex(parseCwiclyCss(original))).rules
 *
 * (and likewise `.atRules`) for every stylesheet Cwicly generated. `canonicalCss` reduces CSS to selector → at-rule context →
 * property → value using postcss and nothing from the reader, so the two sides share no logic. It
 * applies the same equivalences the reader promises (autoprefixer duplicates collapsed, repeated
 * declarations merged as the cascade does, `a.cls` ≡ `.cls:is(a)`, legacy `:before` ≡ `::before`,
 * `screen and (max-width: Wpx)` ≡ the breakpoint it names) and removes the generator's artifacts,
 * counting what it found per artifact code so a test can hold those counts to the reader's report.
 *
 * One thing the comparison cannot see through: Jx writes a `(prefers-color-scheme: …)` block twice,
 * under selectors of its own (the forced-scheme twin), so a stylesheet with such a query is not
 * expected to round-trip textually. The corpus has none.
 *
 * `renderCssIndex` turns an index back into CSS through the real Jx rule builder
 * (`@jxsuite/runtime/css`), so the oracle also proves that Jx reads the keys the reader writes the way
 * they were meant: `"&:is(a)"` as `.cls:is(a)`, `"@--md"` as the breakpoint's media query, a `-webkit-`
 * property as `-webkit-`.
 */
import { buildStyleRules } from "@jxsuite/runtime/css";
import { buildSiteStyleCSS } from "@jxsuite/site/site-style";
import postcss from "postcss";
import type { AtRule, Container, Declaration, Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import { projectStyles } from "../../src/cwicly/css.ts";
import type { Breakpoint, CssIndex } from "../../src/types.ts";

/** selector → context (`""` or `@media (max-width: 992px)`, nested contexts joined by ` | `) → property → value. */
export type CanonicalRules = Record<string, Record<string, Record<string, string>>>;

export interface CanonicalCss {
  rules: CanonicalRules;
  /** `@import`, `@font-face`, `@keyframes`…: head and canonical body, in source order. */
  atRules: { head: string; body: Record<string, unknown> }[];
  /**
   * The artifacts the oracle found on its own, by the code the reader reports them under: what it
   * removed (`css.invalid-value`, `css.undefined-selector`…) and, when it was told the breakpoints,
   * the media queries that name none (`css.media-unmapped`, which stay in the CSS).
   */
  artifacts: Record<string, number>;
}

const collapse = (text: string): string =>
  text
    .trim()
    .replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\s+/g, (_, quoted?: string) => quoted ?? " ");

// ── Declarations ─────────────────────────────────────────────────────────────────────────────────

const VENDOR = ["-webkit-", "-moz-", "-ms-", "-o-"];
const isVendorName = (property: string): boolean =>
  VENDOR.some((prefix) => property.startsWith(prefix));
const unprefixed = (property: string): string => property.replace(/^-(?:webkit|moz|ms|o)-/, "");
const hasVendorValue = (value: string): boolean => /(^|[\s,(])-(webkit|moz|ms|o)-/.test(value);

interface Entry {
  property: string;
  value: string;
}

/** What a declaration reads as once cleaned: lower-case name (custom properties exact), trimmed value. */
function entryOf(declaration: Declaration): Entry {
  const property = declaration.prop.startsWith("--")
    ? declaration.prop
    : declaration.prop.toLowerCase();
  return {
    property,
    value: declaration.value.trim() + (declaration.important ? " !important" : ""),
  };
}

/** Autoprefixer's additions: a prefixed twin of a property present unprefixed, and superseded prefixed values. */
function withoutAutoprefix(entries: Entry[]): Entry[] {
  return entries.filter((entry, index) => {
    if (
      isVendorName(entry.property) &&
      entries.some((other) => other.property === unprefixed(entry.property))
    ) {
      return false;
    }
    if (!hasVendorValue(entry.value)) return true;
    for (let later = index + 1; later < entries.length; later += 1) {
      if (entries[later]!.property === entry.property && !hasVendorValue(entries[later]!.value))
        return false;
    }
    return true;
  });
}

const endsImportant = (value: string | undefined): boolean =>
  value !== undefined && value.endsWith("!important");

/** Later wins, except that a plain declaration never displaces an `!important` one. */
function put(target: Record<string, string>, property: string, value: string): void {
  if (endsImportant(target[property]) && !endsImportant(value)) return;
  target[property] = value;
}

function declarationsOf(node: Container): Declaration[] {
  return (node.nodes ?? []).filter((child): child is Declaration => child.type === "decl");
}

// ── Artifacts, defined from the report in docs/design.md and counted independently ──────────────

interface Counter {
  artifacts: Record<string, number>;
}

const bump = (counter: Counter, code: string, by = 1): void => {
  counter.artifacts[code] = (counter.artifacts[code] ?? 0) + by;
};

/** The text of a value with its strings and `url(…)` bodies blanked, so that a scan of what is left cannot be fooled by data. */
const withoutData = (value: string): string =>
  value
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
    .replace(/url\((?:[^)\\]|\\.)*\)/gi, "url()");

/**
 * Whether a browser would throw the declaration away for a reason that shows in the text alone: an
 * empty value, an empty function argument, `u002d` where `--` was written, an `!important` in the
 * middle. Written as a hand scan, not with the reader's value parser, so the two can disagree.
 */
export function discardedByBrowsers(property: string, value: string): boolean {
  if (!property.startsWith("--") && value.trim() === "") return true;
  const text = withoutData(value);
  if (/u002d/i.test(text) || /!\s*important/i.test(text)) return true;
  const names: string[] = [];
  // For each open parenthesis: the function it belongs to, and the last significant character seen inside.
  const lastInside: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "(") {
      names.push(/([\w-]*)$/.exec(text.slice(0, i))?.[1]?.toLowerCase() ?? "");
      lastInside.push("(");
    } else if (ch === ")") {
      const name = names.pop() ?? "";
      const last = lastInside.pop();
      if (last === "(" && !["url", "circle", "ellipse"].includes(name)) return true;
      if (last === "," && name !== "var" && name !== "env") return true;
      if (lastInside.length > 0) lastInside[lastInside.length - 1] = ")";
    } else if (lastInside.length > 0 && !/\s/.test(ch)) {
      const last = lastInside[lastInside.length - 1];
      if (ch === "," && (last === "(" || last === ",")) return true;
      lastInside[lastInside.length - 1] = ch;
    }
  }
  return false;
}

/** Returns the declarations that survive, counting the artifacts among the rest. */
function surviving(declarations: Declaration[], counter: Counter): Declaration[] {
  return declarations.filter((declaration) => {
    const value = declaration.value;
    let artifact = false;
    const palette = value.match(/!var=[^!]*!/g);
    if (palette !== null) {
      bump(counter, "css.unresolved-palette-var", palette.length);
      artifact = true;
    }
    if (/\{[A-Za-z][\w-]*(=[^{}]*)?\}|<ccd>/.test(value)) {
      bump(counter, "css.token");
      artifact = true;
    }
    if (
      /(^|[^\w-])undefined|\[object Object\]/.test(value) ||
      discardedByBrowsers(declaration.prop, value)
    ) {
      bump(counter, "css.invalid-value");
      artifact = true;
    }
    const ieHack = /[*_]/.test(declaration.raws.before ?? "");
    if (
      ieHack ||
      (!declaration.prop.startsWith("--") &&
        !/^-?[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/i.test(declaration.prop))
    ) {
      bump(counter, "css.unclassified");
      artifact = true;
    }
    return !artifact;
  });
}

// ── Selectors ────────────────────────────────────────────────────────────────────────────────────

/**
 * A dot with no name after it (`.`, `. svg`, `a.`, `.:hover`): the generator's selector for a block
 * whose classID is empty. A dot inside a string or an escape (`\.`) is not one.
 */
function hasEmptyClass(selector: string): boolean {
  const bare = selector.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""').replace(/\\./g, "x");
  return /\.(?![\w-]|[\u0080-\uFFFF])/.test(bare);
}

const LEGACY_ELEMENTS = new Set([":before", ":after", ":first-line", ":first-letter"]);

/** `:is(a)` with nothing but one type selector inside: the same thing as `a` in front of the compound. */
function isTypeOnlyIs(node: selectorParser.Node): string | null {
  if (node.type !== "pseudo" || node.value.toLowerCase() !== ":is" || node.nodes.length !== 1)
    return null;
  const inner = node.nodes[0]!.nodes;
  return inner.length === 1 && inner[0]!.type === "tag" && !inner[0]!.namespace
    ? inner[0]!.toString().trim()
    : null;
}

function canonicalSimple(node: selectorParser.Node): string {
  if (node.type === "pseudo" && LEGACY_ELEMENTS.has(node.value.toLowerCase()))
    return `:${node.value.toLowerCase()}`;
  // Re-escaping the unescaped name makes `\31 23` and `\000031 23` the same class, and keeps the
  // class `md:flex` (written `.md\:flex`) apart from the class `md` with a `:flex` pseudo-class.
  if (node.type === "class") return classSelector(node.value);
  return node.toString().trim();
}

/**
 * One compound selector in canonical spelling. The order of its simple selectors carries no meaning
 * (`[a].b` is `.b[a]`), except that pseudo-elements close it, so everything else is sorted and the
 * pseudo-elements keep their order after it.
 */
function canonicalCompound(nodes: selectorParser.Node[]): string {
  const explicit = nodes.find((node) => node.type === "tag" || node.type === "universal");
  let hoisted: string | null = null;
  const parts: string[] = [];
  for (const node of nodes) {
    if (node === explicit) continue;
    const type: string | null =
      explicit === undefined && hoisted === null ? isTypeOnlyIs(node) : null;
    if (type !== null) {
      hoisted = type;
      continue;
    }
    parts.push(canonicalSimple(node));
  }
  const elements = parts.filter((part) => part.startsWith("::"));
  const others = parts.filter((part) => !part.startsWith("::")).sort();
  const head = explicit === undefined ? (hoisted ?? "") : explicit.toString().trim();
  return head + others.join("") + elements.join("");
}

/** Throws when postcss-selector-parser cannot read the selector. */
function canonicalSelector(selector: string): string {
  const root = selectorParser().astSync(selector);
  if (root.nodes.length !== 1) throw new Error(`not a single selector: ${selector}`);
  let text = "";
  let compound: selectorParser.Node[] = [];
  for (const node of root.nodes[0]!.nodes) {
    if (node.type === "comment") continue;
    if (node.type === "combinator") {
      text += canonicalCompound(compound);
      compound = [];
      const value = node.value.trim();
      text += value === "" ? " " : ` ${value} `;
    } else {
      compound.push(node);
    }
  }
  return text + canonicalCompound(compound);
}

// ── At-rules ─────────────────────────────────────────────────────────────────────────────────────

const canonicalQuery = (params: string): string =>
  collapse(params)
    .toLowerCase()
    .replace(/\s*:\s*/g, ": ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/^screen and (?=\()/, "");

function head(at: AtRule): string {
  const name = at.name.toLowerCase();
  const params = collapse(at.params);
  if (name === "media") return `@media ${canonicalQuery(params)}`;
  return params === "" ? `@${name}` : `@${name} ${params}`;
}

const WRAPPING = new Set(["media", "supports", "container", "layer", "starting-style", "scope"]);
const BODY = new Set(["font-face", "property", "counter-style", "position-try"]);

/** CSS Nesting, written out directly: what a nested selector means under one member of the parent's list. */
function nest(parent: string, nested: string): string {
  if (/^[>+~]/.test(nested)) return `${parent} ${nested}`;
  const count = nested.split("&").length - 1;
  if (count === 0) return `${parent} ${nested}`;
  if (count === 1 && nested.startsWith("&")) return parent + nested.slice(1);
  return nested.replaceAll("&", `:is(${parent})`);
}

// ── canonicalCss ─────────────────────────────────────────────────────────────────────────────────

/**
 * Reduce CSS to its canonical form. Throws on constructs the oracle does not model, so nothing slips
 * by unchecked. Given the breakpoints, it also counts the media queries that name none.
 */
export function canonicalCss(css: string, breakpoints?: readonly Breakpoint[]): CanonicalCss {
  const result: CanonicalCss = { rules: {}, atRules: [], artifacts: {} };
  const declared = new Set(
    (breakpoints ?? [])
      .filter((bp) => !bp.isMain && bp.direction !== "none")
      .map((bp) => `(${bp.direction}-width: ${bp.width}px)`),
  );
  /** The context key of an at-rule, counting a media query that no breakpoint declares. */
  const contextOf = (at: AtRule): string => {
    const key = head(at);
    if (
      breakpoints !== undefined &&
      at.name.toLowerCase() === "media" &&
      !declared.has(key.slice("@media ".length))
    ) {
      bump(result, "css.media-unmapped");
    }
    return key;
  };
  const root = postcss.parse(css, { from: undefined });

  const cleaned = (declarations: Declaration[]): Record<string, string> => {
    const merged: Record<string, string> = {};
    for (const entry of withoutAutoprefix(surviving(declarations, result).map(entryOf))) {
      put(merged, entry.property, entry.value);
    }
    return merged;
  };

  const members = (selector: string): string[] =>
    postcss.list
      .comma(selector)
      .map((member) => member.trim())
      .filter(Boolean);

  const rule = (node: Rule, parents: string[] | null, context: string[]): void => {
    const own = members(node.selector);
    const resolved =
      parents === null
        ? own
        : parents.flatMap((parent) => own.map((member) => nest(parent, member)));
    const selectors: string[] = [];
    for (const member of resolved) {
      if (/(^|[^\w-])undefined/.test(member) || hasEmptyClass(member)) {
        bump(result, "css.undefined-selector");
        continue;
      }
      if (/\{[A-Za-z][\w-]*(=[^{}]*)?\}|<ccd>/.test(member)) {
        bump(result, "css.token");
        continue;
      }
      try {
        selectors.push(canonicalSelector(member));
      } catch {
        bump(result, "css.unclassified");
      }
    }
    body(node, resolved, selectors, context);
  };

  /** A rule's (or a nested at-rule's) own declarations, then what is nested in it. */
  const body = (
    node: Rule | AtRule,
    resolved: string[],
    selectors: string[],
    context: string[],
  ): void => {
    const declarations = cleaned(declarationsOf(node));
    const key = context.join(" | ");
    for (const selector of selectors) {
      for (const [property, value] of Object.entries(declarations)) {
        const byContext = ((result.rules[selector] ??= {})[key] ??= {});
        put(byContext, property, value);
      }
    }
    for (const child of node.nodes ?? []) {
      if (child.type === "rule") {
        rule(child, resolved, context);
      } else if (child.type === "atrule") {
        if (!WRAPPING.has(child.name.toLowerCase()) || child.nodes === undefined) {
          throw new Error(`oracle: unsupported nested at-rule ${head(child)}`);
        }
        body(child, resolved, selectors, [...context, contextOf(child)]);
      }
    }
  };

  const walk = (container: Container, context: string[]): void => {
    for (const node of container.nodes ?? []) {
      if (node.type === "rule") rule(node, null, context);
      else if (node.type === "atrule") atRule(node, context);
    }
  };

  const atRule = (at: AtRule, context: string[]): void => {
    const name = at.name.toLowerCase();
    if (WRAPPING.has(name) && at.nodes !== undefined) {
      walk(at, [...context, contextOf(at)]);
    } else if (name === "charset") {
      // Carries no style.
    } else if (context.length === 0 && name === "import" && at.nodes === undefined) {
      result.atRules.push({ head: head(at), body: {} });
    } else if (context.length === 0 && BODY.has(name) && at.nodes !== undefined) {
      result.atRules.push({ head: head(at), body: cleaned(declarationsOf(at)) });
    } else if (
      context.length === 0 &&
      /^(-(webkit|moz|o)-)?keyframes$/.test(name) &&
      at.nodes !== undefined
    ) {
      // `@-webkit-keyframes x` beside `@keyframes x` is autoprefixer's copy; alone, it is `@keyframes x`.
      const animation = collapse(at.params);
      const twin = (at.parent?.nodes ?? []).some(
        (sibling) =>
          sibling.type === "atrule" &&
          sibling.name.toLowerCase() === "keyframes" &&
          collapse(sibling.params) === animation,
      );
      if (name !== "keyframes" && twin) return;
      const stops: Record<string, Record<string, string>> = {};
      for (const stop of at.nodes) {
        if (stop.type !== "rule") continue;
        const stopName = postcss.list
          .comma(stop.selector)
          .map((m) => m.trim())
          .join(", ");
        const declarations = cleaned(declarationsOf(stop));
        if (Object.keys(declarations).length > 0) {
          const block = (stops[stopName] ??= {});
          for (const [property, value] of Object.entries(declarations)) put(block, property, value);
        }
      }
      if (Object.keys(stops).length > 0)
        result.atRules.push({ head: `@keyframes ${animation}`, body: stops });
    } else {
      throw new Error(`oracle: unsupported at-rule ${head(at)}`);
    }
  };

  // postcss lets a stray `$scss-variable: x;` stand at the root; it is judged like any declaration.
  surviving(declarationsOf(root), result);
  walk(root, []);

  // An empty context is a rule the cascade has nothing to say about; drop what holds no declaration.
  for (const [selector, contexts] of Object.entries(result.rules)) {
    for (const [context, declarations] of Object.entries(contexts)) {
      if (Object.keys(declarations).length === 0) delete contexts[context];
    }
    if (Object.keys(contexts).length === 0) delete result.rules[selector];
  }
  // A body at-rule with nothing left in it says nothing either (the reader never records it).
  result.atRules = result.atRules.filter(
    (rule) => rule.head.startsWith("@import") || Object.keys(rule.body).length > 0,
  );
  return result;
}

/** One line per declaration, `selector {context} property: value`, sorted: easy to diff and to print. */
export function flattenCanonical(canonical: CanonicalCss): string[] {
  const lines: string[] = [];
  for (const [selector, contexts] of Object.entries(canonical.rules)) {
    for (const [context, declarations] of Object.entries(contexts)) {
      for (const [property, value] of Object.entries(declarations)) {
        lines.push(`${selector} {${context}} ${property}: ${value}`);
      }
    }
  }
  for (const rule of canonical.atRules) lines.push(`${rule.head} ${JSON.stringify(rule.body)}`);
  return lines.sort();
}

/** What is in one canonical form and not in the other, at most `limit` lines each way. */
export function canonicalDiff(expected: CanonicalCss, actual: CanonicalCss, limit = 12): string[] {
  const a = flattenCanonical(expected);
  const b = flattenCanonical(actual);
  const inB = new Set(b);
  const inA = new Set(a);
  const out: string[] = [];
  for (const line of a.filter((l) => !inB.has(l)).slice(0, limit)) out.push(`- ${line}`);
  for (const line of b.filter((l) => !inA.has(l)).slice(0, limit)) out.push(`+ ${line}`);
  return out;
}

// ── renderCssIndex ───────────────────────────────────────────────────────────────────────────────

/** The `$media` map Jx resolves `"@--md"` against. */
export function mediaQueriesFor(breakpoints: readonly Breakpoint[]): Record<string, string> {
  const queries: Record<string, string> = {};
  for (const bp of breakpoints) {
    if (bp.direction !== "none") queries[`--${bp.key}`] = `(${bp.direction}-width: ${bp.width}px)`;
  }
  return queries;
}

/**
 * `.name`, escaped as a selector. postcss-selector-parser escapes through the `value` setter only: a
 * node built with `className({ value })` prints the name raw, so `md:flex` would come out as a class
 * `md` carrying a `:flex` pseudo-class.
 */
export function classSelector(name: string): string {
  const node = selectorParser.className({ value: "x" });
  node.value = name;
  return node.toString();
}

/** An index as CSS text, built by the real Jx rule builder. Statement at-rules (`@import`) are written out directly. */
export function renderCssIndex(index: CssIndex, breakpoints: readonly Breakpoint[]): string {
  const mediaQueries = mediaQueriesFor(breakpoints);
  const out: string[] = [];
  for (const { key, style } of index.atRules) {
    if (Object.keys(style).length === 0) {
      out.push(`${key};`);
    } else {
      for (const rule of buildStyleRules({ [key]: style }, { mediaQueries })) out.push(rule.text);
    }
  }
  for (const [name, { style }] of index.classes) {
    for (const rule of buildStyleRules(style, { scope: classSelector(name), mediaQueries }))
      out.push(rule.text);
  }
  for (const [selector, style] of index.other) {
    for (const rule of buildStyleRules(style, { scope: selector, mediaQueries }))
      out.push(rule.text);
  }
  return out.join("\n");
}

/**
 * The index as a stylesheet the cascade can trust: `projectStyles` lays the rules out stylesheet by
 * stylesheet, every base rule before every responsive one, and the real site-style builder (the one
 * the compiler writes every page's project style with) emits each layer. Where `renderCssIndex`
 * writes class after class, which keeps each tree whole and loses the order between classes, this
 * is the order of the files.
 */
export function renderCascade(index: CssIndex, breakpoints: readonly Breakpoint[]): string {
  const mediaQueries = mediaQueriesFor(breakpoints);
  const out: string[] = [];
  for (const { key, style } of index.atRules) {
    if (Object.keys(style).length === 0) {
      out.push(`${key};`);
    } else {
      for (const rule of buildStyleRules({ [key]: style }, { mediaQueries })) out.push(rule.text);
    }
  }
  for (const style of projectStyles(index, breakpoints)) {
    out.push(buildSiteStyleCSS(style, mediaQueries, (value) => value));
  }
  return out.join("\n");
}

/**
 * The same index as a site would carry it in `project.json` `style` (class rules keyed `.name`, the
 * rest keyed by selector), emitted by the builder the compiler writes every page's project style with.
 * Statement and declaration at-rules have no project-style spelling here and are left out.
 */
export function renderProjectStyle(index: CssIndex, breakpoints: readonly Breakpoint[]): string {
  const style: Record<string, unknown> = {};
  for (const [name, entry] of index.classes) style[classSelector(name)] = entry.style;
  for (const [selector, other] of index.other) style[selector] = other;
  return buildSiteStyleCSS(style, mediaQueriesFor(breakpoints), (value) => value);
}

// ── The cascade, simulated ───────────────────────────────────────────────────────────────────────
//
// `canonicalCss` answers "does every selector end up with the same declarations", and cannot answer
// "which of two rules wins on one element": it keeps no order, so two stylesheets that rank their
// rules differently are the same canonical form. These functions are the other half. They keep every
// rule in source order and resolve the cascade for one element at one viewport width the way a
// browser does (important, then specificity, then source order), for the part of selector syntax the
// reader works with: an element is a tag, a set of classes and a set of states (`:hover`), and a
// rule applies to it when its FIRST compound matches; whatever follows the first compound (` svg`,
// ` > div:nth-of-type(1)`, `::before`) says which descendant or pseudo-element is styled, and is
// compared as written.
//
// The two sides of a comparison are built by two different programs (Cwicly's generator and the
// reader plus Jx's rule builder), so the oracle shares no ordering logic with either.

/** One style rule in source order: one selector, the at-rules around it, its cleaned declarations. */
export interface OrderedRule {
  /** Canonical spelling of one member of the rule's selector list. */
  selector: string;
  /** `@media (max-width: 992px)`…, outermost first. */
  conditions: string[];
  /** Source order, artifacts and autoprefixer twins removed, `!important` kept in the value. */
  declarations: { property: string; value: string }[];
}

const membersOf = (selector: string): string[] =>
  postcss.list
    .comma(selector)
    .map((member) => member.trim())
    .filter(Boolean);

/** The rules of a stylesheet in source order. Throws on at-rules the oracle does not model, like `canonicalCss`. */
export function orderedRules(css: string): OrderedRule[] {
  const rules: OrderedRule[] = [];
  const counter: Counter = { artifacts: {} };
  const root = postcss.parse(css, { from: undefined });
  const entriesOf = (node: Container): Entry[] =>
    withoutAutoprefix(surviving(declarationsOf(node), counter).map(entryOf));

  const rule = (node: Rule, parents: string[] | null, conditions: string[]): void => {
    const own = membersOf(node.selector);
    const resolved =
      parents === null
        ? own
        : parents.flatMap((parent) => own.map((member) => nest(parent, member)));
    const selectors: string[] = [];
    for (const member of resolved) {
      if (/(^|[^\w-])undefined/.test(member) || hasEmptyClass(member)) continue;
      if (/\{[A-Za-z][\w-]*(=[^{}]*)?\}|<ccd>/.test(member)) continue;
      try {
        selectors.push(canonicalSelector(member));
      } catch {
        // Not a selector: no rule.
      }
    }
    body(node, resolved, selectors, conditions);
  };
  const body = (
    node: Rule | AtRule,
    resolved: string[],
    selectors: string[],
    conditions: string[],
  ): void => {
    const declarations = entriesOf(node);
    if (declarations.length > 0) {
      for (const selector of selectors) rules.push({ selector, conditions, declarations });
    }
    for (const child of node.nodes ?? []) {
      if (child.type === "rule") {
        rule(child, resolved, conditions);
      } else if (
        child.type === "atrule" &&
        WRAPPING.has(child.name.toLowerCase()) &&
        child.nodes !== undefined
      ) {
        body(child, resolved, selectors, [...conditions, head(child)]);
      }
    }
  };
  const walk = (container: Container, conditions: string[]): void => {
    for (const node of container.nodes ?? []) {
      if (node.type === "rule") {
        rule(node, null, conditions);
      } else if (
        node.type === "atrule" &&
        WRAPPING.has(node.name.toLowerCase()) &&
        node.nodes !== undefined
      ) {
        walk(node, [...conditions, head(node)]);
      }
    }
  };
  walk(root, []);
  return rules;
}

/** What an element is, for matching: a tag, its classes and the states it is in (`:hover`). */
export interface CascadeElement {
  tag: string;
  classes: ReadonlySet<string>;
  states: ReadonlySet<string>;
}

type Specificity = readonly [number, number, number];

interface Subject {
  tag: string | null;
  classes: string[];
  /** Pseudo-classes of the first compound; each must hold for the element. */
  tests: ((element: CascadeElement) => boolean)[];
}

/** A rule ready to be matched: the first compound as a test, the rest as the target it styles. */
export interface AnalysedRule extends OrderedRule {
  /** Position in the stylesheet: the later of two rules of equal specificity wins. */
  index: number;
  /** Null when the first compound uses something the model does not build elements out of (ids, attributes). */
  subject: Subject | null;
  /** What the rule styles: `""` the element itself, ` svg` a descendant, `::before` a pseudo-element. */
  target: string;
  specificity: Specificity;
}

function selectorMatches(selector: selectorParser.Selector, element: CascadeElement): boolean {
  return selector.nodes.every((node) => {
    if (node.type === "class") return element.classes.has(node.value);
    if (node.type === "tag") return element.tag === node.value.toLowerCase();
    if (node.type === "universal") return true;
    if (node.type === "pseudo") return pseudoTest(node)?.(element) ?? false;
    return false;
  });
}

/** The test a pseudo-class stands for, or null for a pseudo-element. */
function pseudoTest(node: selectorParser.Pseudo): ((element: CascadeElement) => boolean) | null {
  const name = node.value.toLowerCase();
  if (name.startsWith("::") || LEGACY_ELEMENTS.has(name)) return null;
  if (name === ":is" || name === ":where" || name === ":matches") {
    return (element) => node.nodes.some((selector) => selectorMatches(selector, element));
  }
  if (name === ":not") {
    return (element) => !node.nodes.some((selector) => selectorMatches(selector, element));
  }
  return (element) => element.states.has(name);
}

const maxSpecificity = (values: Specificity[]): Specificity =>
  values.reduce<Specificity>(
    (best, value) =>
      value[0] > best[0] ||
      (value[0] === best[0] && (value[1] > best[1] || (value[1] === best[1] && value[2] > best[2])))
        ? value
        : best,
    [0, 0, 0],
  );

function specificityOf(selector: selectorParser.Selector): Specificity {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const node of selector.nodes) {
    if (node.type === "id") a += 1;
    else if (node.type === "class" || node.type === "attribute") b += 1;
    else if (node.type === "tag") c += 1;
    else if (node.type === "pseudo") {
      const name = node.value.toLowerCase();
      if (name.startsWith("::") || LEGACY_ELEMENTS.has(name)) {
        c += 1;
      } else if (name === ":where") {
        // Specificity zero.
      } else if (name === ":is" || name === ":not" || name === ":has" || name === ":matches") {
        const inner = maxSpecificity(node.nodes.map(specificityOf));
        a += inner[0];
        b += inner[1];
        c += inner[2];
      } else {
        b += 1;
      }
    }
  }
  return [a, b, c];
}

/** Prepare ordered rules for matching: the oracle's selector reading, done once per rule. */
export function analyseRules(rules: readonly OrderedRule[]): AnalysedRule[] {
  return rules.map((rule, index): AnalysedRule => {
    const parsed = selectorParser().astSync(rule.selector).nodes[0]!;
    const first: selectorParser.Node[] = [];
    for (const node of parsed.nodes) {
      if (node.type === "combinator") break;
      first.push(node);
    }
    const compound = canonicalCompound(first);
    const rest = rule.selector.slice(compound.length);
    let pseudoElement = "";
    let modelled = true;
    const subject: Subject = { tag: null, classes: [], tests: [] };
    for (const node of first) {
      if (node.type === "tag") {
        subject.tag = node.value.toLowerCase();
      } else if (node.type === "class") {
        subject.classes.push(node.value);
      } else if (node.type === "universal") {
        // Matches anything.
      } else if (node.type === "pseudo") {
        const test = pseudoTest(node);
        if (test === null) pseudoElement = canonicalSimple(node);
        else subject.tests.push(test);
      } else {
        modelled = false;
      }
    }
    return {
      ...rule,
      index,
      subject: modelled ? subject : null,
      target: rest !== "" ? rest + pseudoElement : pseudoElement,
      specificity: specificityOf(parsed),
    };
  });
}

const SIDES = ["top", "right", "bottom", "left"];
const sides = (prefix: string, suffix = ""): string[] =>
  SIDES.map((side) => `${prefix}-${side}${suffix}`);
const BORDER_PARTS = [
  ...sides("border", "-width"),
  ...sides("border", "-style"),
  ...sides("border", "-color"),
];
/**
 * The shorthands whose longhands are not simply the properties that extend their name (`gap` sets
 * `row-gap`; `border` sets the per-side widths, styles and colours but not `border-radius`; `font`
 * sets `line-height`). For any other property, a longhand is a name that starts with the property
 * and a dash: `background` and `background-color`.
 */
const SHORTHANDS: Record<string, string[]> = {
  font: [
    "font-style",
    "font-variant",
    "font-weight",
    "font-stretch",
    "font-size",
    "line-height",
    "font-family",
  ],
  margin: sides("margin"),
  padding: sides("padding"),
  inset: [...SIDES],
  "border-width": sides("border", "-width"),
  "border-style": sides("border", "-style"),
  "border-color": sides("border", "-color"),
  border: BORDER_PARTS,
  "border-radius": ["top-left", "top-right", "bottom-right", "bottom-left"].map(
    (corner) => `border-${corner}-radius`,
  ),
  gap: ["row-gap", "column-gap"],
  "flex-flow": ["flex-direction", "flex-wrap"],
  overflow: ["overflow-x", "overflow-y"],
  "place-content": ["align-content", "justify-content"],
  "place-items": ["align-items", "justify-items"],
  "place-self": ["align-self", "justify-self"],
  columns: ["column-width", "column-count"],
};

/** Whether a declaration of `property` also sets `longhand` (the same name, or a longhand of it). */
function sets(property: string, longhand: string): boolean {
  if (property === longhand) return true;
  const listed = SHORTHANDS[property];
  if (listed !== undefined) return listed.includes(longhand);
  return longhand.startsWith(`${property}-`);
}

/** Whether a media query holds at a viewport width in CSS pixels. Only width queries are modelled. */
function mediaHolds(query: string, width: number): boolean {
  return query.split(",").some((alternative) =>
    alternative
      .trim()
      .split(/\s+and\s+/i)
      .every((term) => {
        const text = term.trim().toLowerCase();
        if (text === "screen" || text === "all") return true;
        const bound = /^\(\s*(min|max)-width\s*:\s*([\d.]+)(px|em|rem)?\s*\)$/.exec(text);
        if (bound === null) return false;
        const pixels = Number(bound[2]) * (bound[3] === "em" || bound[3] === "rem" ? 16 : 1);
        return bound[1] === "max" ? width <= pixels : width >= pixels;
      }),
  );
}

function conditionHolds(condition: string, width: number): boolean {
  if (condition.startsWith("@media ")) return mediaHolds(condition.slice("@media ".length), width);
  // `@supports`, `@layer`, … are taken to hold; the corpus uses them for features every browser has.
  return !/^@supports\s+not\b/i.test(condition);
}

/** Rules by the first class of their subject, built once per rule list: a query only looks at the rules that name one of its classes. */
const byFirstClass = new WeakMap<
  readonly AnalysedRule[],
  { named: Map<string, AnalysedRule[]>; unnamed: AnalysedRule[] }
>();

function candidateRules(
  rules: readonly AnalysedRule[],
  classes: ReadonlySet<string>,
): AnalysedRule[] {
  let index = byFirstClass.get(rules);
  if (index === undefined) {
    index = { named: new Map(), unnamed: [] };
    for (const rule of rules) {
      const first = rule.subject?.classes[0];
      if (rule.subject === null) continue;
      if (first === undefined) {
        index.unnamed.push(rule);
      } else {
        const list = index.named.get(first) ?? [];
        list.push(rule);
        index.named.set(first, list);
      }
    }
    byFirstClass.set(rules, index);
  }
  const found = [...index.unnamed];
  for (const name of classes) found.push(...(index.named.get(name) ?? []));
  return found;
}

export interface CascadeQuery {
  classes: readonly string[];
  /** Default `div`. */
  tag?: string;
  /** Viewport width in CSS pixels. */
  width: number;
  /** The pseudo-classes the element is in, written with the colon: `[":hover"]`. */
  states?: readonly string[];
}

/**
 * What the cascade decides for one element: `"<target>|<longhand>"` → the declaration that wins
 * (`"padding-top: 0px"`). Declarations are compared by what they say, so a shorthand that wins is
 * named as the shorthand: the comparison is "does the same declaration win", which is what a stale
 * rule order breaks.
 */
export function cascadeOf(
  rules: readonly AnalysedRule[],
  query: CascadeQuery,
): Record<string, string> {
  const element: CascadeElement = {
    tag: query.tag ?? "div",
    classes: new Set(query.classes),
    states: new Set(query.states ?? []),
  };
  const candidatesOf = candidateRules(rules, element.classes);
  interface Candidate {
    target: string;
    property: string;
    text: string;
    important: boolean;
    specificity: Specificity;
    order: number;
  }
  const candidates: Candidate[] = [];
  for (const rule of candidatesOf) {
    const { subject } = rule;
    if (subject === null) continue;
    if (subject.tag !== null && subject.tag !== element.tag) continue;
    if (!subject.classes.every((name) => element.classes.has(name))) continue;
    if (!subject.tests.every((test) => test(element))) continue;
    if (!rule.conditions.every((condition) => conditionHolds(condition, query.width))) continue;
    rule.declarations.forEach((declaration, position) => {
      candidates.push({
        target: rule.target,
        property: declaration.property,
        text: `${declaration.property}: ${declaration.value}`,
        important: declaration.value.endsWith("!important"),
        specificity: rule.specificity,
        order: rule.index * 65_536 + position,
      });
    });
  }

  const outranks = (a: Candidate, b: Candidate): boolean => {
    if (a.important !== b.important) return a.important;
    for (let i = 0; i < 3; i += 1) {
      if (a.specificity[i] !== b.specificity[i]) return a.specificity[i]! > b.specificity[i]!;
    }
    return a.order > b.order;
  };
  const result: Record<string, string> = {};
  const longhands = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    let names = longhands.get(candidate.target);
    if (names === undefined) {
      names = new Set();
      longhands.set(candidate.target, names);
    }
    names.add(candidate.property);
    for (const longhand of SHORTHANDS[candidate.property] ?? []) names.add(longhand);
  }
  for (const [target, names] of longhands) {
    for (const longhand of names) {
      let winner: Candidate | undefined;
      for (const candidate of candidates) {
        if (candidate.target !== target || !sets(candidate.property, longhand)) continue;
        if (winner === undefined || outranks(candidate, winner)) winner = candidate;
      }
      if (winner !== undefined) result[`${target}|${longhand}`] = winner.text;
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The lines on which two cascade results differ, `-` for the first, `+` for the second. */
export function cascadeDiff(
  expected: Record<string, string>,
  actual: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (expected[key] !== actual[key]) {
      out.push(`${key}: ${expected[key] ?? "(none)"}  ->  ${actual[key] ?? "(none)"}`);
    }
  }
  return out;
}

/** CSS text as analysed rules, memoised by text: the corpus tests ask about the same files many times. */
const analysed = new Map<string, AnalysedRule[]>();
export function analysedRulesOf(css: string): AnalysedRule[] {
  let rules = analysed.get(css);
  if (rules === undefined) {
    rules = analyseRules(orderedRules(css));
    analysed.set(css, rules);
  }
  return rules;
}
