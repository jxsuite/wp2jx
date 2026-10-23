/**
 * Class rules written into the elements that carry the class, and the classes taken off them.
 *
 * The project's stylesheets end up as one ordered list of rules (`emit/fold-css.ts`). A rule whose
 * selector names a class can be written on every element that carries the class instead, as a key of
 * the element's own `style`: the class becomes `&`, so `.card` is the element's own block, `.card:hover`
 * `&:hover`, `.card svg` `& svg`, `a.card` `&:is(a)`, `.dark .card` `&:is(.dark *)` (Jx resolves `&`
 * only at the start of a key), `.card.big` `&.big`.
 * Jx scopes an element's style with one class of its own (its first class, or a generated `jx-N`),
 * so every such selector keeps its specificity. Which class of a selector is the one written away is
 * the one nearest its subject (a list is decided member by member); the other classes it names stay on
 * the elements that carry them, because the browser still has to match them.
 *
 * Per element, the rules of all its classes and its own style are put back together in cascade order
 * (`OrderedStyle`): the project's rules came before the element's own on the page, so the element's
 * own declarations win a tie, as they did; a declaration that a later one of the same selector covers
 * wherever it applies is dropped; and where the order of the object cannot say who wins, a declaration
 * goes into an equal-specificity alias block (`&:where(*)`).
 *
 * A class is taken off an element when nothing needs it any more: no rule left in the project names it
 * (other than the class's own rules, which the element now carries), no key of any element's style
 * names it, and nothing outside the JSON element trees can see it. What those are, and what keeps a
 * class's rules in the project:
 *
 * - an element this pass does not rewrite: one with an `id` (Jx would scope its style with `#id`, which
 *   is more specific than the class it replaces), a custom element (a component instance: its class
 *   reaches the component's host), one whose `className` is not a plain string or holds a binding, or
 *   whose `attributes.class` is set;
 * - text: HTML held as a string (`innerHTML`, a query loop's item written as an expression), a string
 *   that is a class list (a component property's value), Markdown entries, scripts (the current-page
 *   script adds `current`), and `protect` (a class a third-party script looks for, `cf-turnstile`).
 *
 * A rule for a class that no element and no text carries is dead and dropped.
 */
import { createHash } from "node:crypto";
import selectorParser from "postcss-selector-parser";
import {
  contextContains,
  flattenElementStyle,
  isBlock,
  OrderedStyle,
  selectorMembers,
  type FlatRule,
  type RankedDeclaration,
} from "./style-order.ts";
import { covers } from "./design-system.ts";
import type { JxStyle } from "../types.ts";

type Rec = Record<string, unknown>;

/** A rule of the project's stylesheet, with its place in the cascade. */
export interface ProjectRule extends FlatRule {
  rank: number;
}

export interface InlineInput {
  /** Every rule of the project's stylesheets, in cascade order (`rank` ascending). */
  rules: ProjectRule[];
  /** The Jx documents the pass may rewrite (pages, layouts, components, JSON entries), parsed. */
  documents: { path: string; doc: unknown }[];
  /** Markdown entries: their classes are visible and cannot be rewritten. */
  markdown: string[];
  /** Scripts: every word in them may be a class they look for. */
  scripts: string[];
  /** Classes always kept, wherever they are. */
  protect?: Iterable<string>;
  /** `project.json`'s `$media`, to tell which breakpoint blocks hold within which. */
  media: Readonly<Record<string, string>>;
}

export interface InlineResult {
  /** The rules that stay in the project, in order. */
  rules: ProjectRule[];
  /** The documents that changed. */
  changed: Set<string>;
  stats: {
    /** Elements whose style took rules in. */
    elements: number;
    /** Class names taken off elements. */
    classesRemoved: number;
    /** Distinct classes that no element carries any more. */
    classesGone: number;
    /** Selector list members written into elements and gone from the project. */
    rulesMoved: number;
    /** Members for a class nothing carries. */
    rulesDead: number;
    /** Declarations placed in an alias block to keep the cascade. */
    aliased: number;
  };
}

const IDENT = /^-?[_a-zA-Z -￿][\w -￿-]*$/;

/** Tokens of `text` that a class attribute, a `className` value or a Markdown attribute block names. */
function classesInText(text: string, into: Set<string>): void {
  for (const m of text.matchAll(/\bclass(?:Name)?\s*[=:]\s*\\?(["'])((?:(?!\1).)*)\\?\1/g)) {
    for (const token of m[2]!.split(/\s+/)) if (IDENT.test(token)) into.add(token);
  }
  for (const m of text.matchAll(/'className':\s*'([^']*)'/g)) {
    for (const token of m[1]!.split(/\s+/)) if (IDENT.test(token)) into.add(token);
  }
  // Markdown attribute blocks: `{.a .b}` and `{className="a b"}` (the second is caught above).
  for (const m of text.matchAll(/\{([^{}\n]*)\}/g)) {
    for (const c of m[1]!.matchAll(/(?:^|\s)\.(-?[_a-zA-Z][\w-]*)/g)) into.add(c[1]!);
  }
}

/** Every class a selector names (outside or inside functional pseudo-classes). */
function classesOfSelector(selector: string, into: Set<string>): void {
  try {
    selectorParser((root) => {
      root.walkClasses((node) => {
        into.add(node.value);
      });
    }).processSync(selector);
  } catch {
    for (const m of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) into.add(m[1]!);
  }
}

/** Classes named in the selector keys of a style object, at any depth. */
function classesOfStyleKeys(style: unknown, into: Set<string>): void {
  if (!isBlock(style)) return;
  for (const [key, value] of Object.entries(style)) {
    if (!isBlock(value)) continue;
    if (!key.startsWith("@")) classesOfSelector(key.replaceAll("&", ".x-scope"), into);
    classesOfStyleKeys(value, into);
  }
  into.delete("x-scope");
}

interface Relocation {
  /** The class written away. */
  target: string;
  /** The selector against `&`. */
  key: string;
  /** The other classes of the target's compound: the element must carry them too for the rule to match it. */
  with: string[];
}

const relocationCache = new Map<string, Relocation | null>();

/**
 * A list member as a key of the style of the elements that carry one of its classes, or null when it
 * names no class, names an id, already holds `&`, or names its class twice.
 */
function relocate(member: string): Relocation | null {
  let found = relocationCache.get(member);
  if (found !== undefined) return found;
  found = null;
  if (!member.includes("&") && member.includes(".")) {
    try {
      const selector = selectorParser().astSync(member).nodes[0];
      if (selector !== undefined && selector.nodes.every((n) => n.type !== "id")) {
        // Compounds, outside functional pseudo-classes.
        const compounds: selectorParser.Node[][] = [[]];
        for (const node of selector.nodes) {
          if (node.type === "combinator") compounds.push([]);
          else compounds[compounds.length - 1]!.push(node);
        }
        let chosen: selectorParser.ClassName | undefined;
        for (let at = compounds.length - 1; at >= 0 && chosen === undefined; at--) {
          chosen = compounds[at]!.find((n): n is selectorParser.ClassName => n.type === "class");
        }
        if (chosen !== undefined) {
          const target = chosen.value;
          let count = 0;
          selector.walkClasses((n) => {
            if (n.value === target) count++;
          });
          if (count === 1) {
            const compound = compounds.find((c) => c.includes(chosen!))!;
            // Classes the element must carry as well: the compound's own, and those of a `:where()` or
            // `:is()` of one compound (an entry's isolating `:where(.jx-…)`).
            const together: string[] = [];
            for (const n of compound) {
              if (n.type === "class" && n !== chosen) together.push(n.value);
              const name = n.type === "pseudo" ? n.value.toLowerCase() : "";
              if (
                (name === ":where" || name === ":is") &&
                (n as selectorParser.Pseudo).nodes.length === 1
              ) {
                const inner = (n as selectorParser.Pseudo).nodes[0]!;
                if (inner.nodes.every((x) => x.type === "class"))
                  for (const x of inner.nodes) together.push((x as selectorParser.ClassName).value);
              }
            }
            const tag = compound.find((n) => n.type === "tag" || n.type === "universal");
            if (tag !== undefined) {
              if (tag.type === "tag") {
                const is = selectorParser().astSync(`:is(${tag.toString().trim()})`).nodes[0]!
                  .nodes[0]!;
                chosen.parent!.insertAfter(chosen, is);
              }
              tag.remove();
            }
            chosen.replaceWith(selectorParser.nesting({ value: "&" }));
            let key = selector.toString().trim();
            // Jx resolves `&` only in a key that starts with it (`.wrap &` compiles as a compound,
            // `.jx-1.wrap &`), so what comes before the element is said with `:is()`: `.wrap &` is
            // `&:is(.wrap *)`, the same elements at the same specificity.
            const at = key.indexOf("&");
            if (at > 0) key = `&:is(${key.slice(0, at).trim()} *)${key.slice(at + 1)}`;
            found = { target, key, with: together };
          }
        }
      }
    } catch {
      found = null;
    }
  }
  if (relocationCache.size > 20_000) relocationCache.clear();
  relocationCache.set(member, found);
  return found;
}

/** Top-level words of a value (parentheses and quotes kept whole). */
function words(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const c of value) {
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (/\s/.test(c) && depth === 0) {
      if (current !== "") out.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current !== "") out.push(current);
  return out;
}

const BOX: Record<string, readonly string[]> = {
  padding: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  margin: ["marginTop", "marginRight", "marginBottom", "marginLeft"],
  inset: ["top", "right", "bottom", "left"],
  borderWidth: ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"],
  borderStyle: ["borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle"],
  borderColor: ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"],
  borderRadius: [
    "borderTopLeftRadius",
    "borderTopRightRadius",
    "borderBottomRightRadius",
    "borderBottomLeftRadius",
  ],
};

/**
 * A box shorthand (`padding: 3rem 1rem`) as its four longhands, or `gap` as its two; null for any
 * other property, a value a `var()` could stand for several words of, or a radius with a `/`.
 */
function expandShorthand(property: string, value: unknown): [string, string][] | null {
  if (typeof value !== "string" || /var\(|\/|\$\{/i.test(value)) return null;
  const important = /\s*!\s*important\s*$/i.exec(value);
  const bare = important === null ? value : value.slice(0, important.index);
  const suffix = important === null ? "" : " !important";
  const parts = words(bare);
  if (property === "gap") {
    if (parts.length < 1 || parts.length > 2) return null;
    return [
      ["rowGap", parts[0]! + suffix],
      ["columnGap", (parts[1] ?? parts[0]!) + suffix],
    ];
  }
  const longhands = BOX[property];
  if (longhands === undefined || parts.length < 1 || parts.length > 4) return null;
  const [a, b = a, c = a, d = b] = parts as [string, string?, string?, string?];
  return longhands.map((name, i) => [name, [a, b, c, d][i]! + suffix]);
}

interface Element {
  node: Rec;
  path: string;
  pointer: string;
  classes: string[];
  /** Its place in the documents' tree order. */
  order: number;
}

/**
 * An element's own style, which Jx writes for the element's FIRST class when it has one (`.F {…}`),
 * so that it styles every element of the page that carries the class: a rule of that class, at the
 * element's place in the page.
 */
interface StyleSource {
  first: string;
  node: Rec;
  path: string;
  order: number;
  style: JxStyle;
}

/** Page-level ranks start above every project rule's, in tree order. */
const PAGE_RANK = 10_000_000;
/** Room for the declarations of one rule between two ranks. */
const STEP = 10_000;

/** Rewrite the documents and the rules: see the module comment. */
export function inlineClasses(input: InlineInput): InlineResult {
  const stats: InlineResult["stats"] = {
    elements: 0,
    classesRemoved: 0,
    classesGone: 0,
    rulesMoved: 0,
    rulesDead: 0,
    aliased: 0,
  };
  let elements: Element[] = [];
  const sources: StyleSource[] = [];
  let order = 0;
  /** Classes something outside the rewritable elements can see. */
  const visible = new Set<string>(input.protect ?? []);
  /** Classes the rewritable elements carry. */
  const carried = new Set<string>();
  /** Selector keys of element styles: classes they name must stay where they are. */
  const keyClasses = new Set<string>();

  const scanString = (text: string): void => {
    const tokens = text.trim().split(/\s+/);
    if (tokens.length > 0 && tokens.every((t) => IDENT.test(t)))
      for (const t of tokens) visible.add(t);
    if (text.includes("class")) classesInText(text, visible);
  };
  const walk = (value: unknown, path: string, pointer: string, inAttributes = false): void => {
    if (typeof value === "string") {
      // An attribute's value (`type="button"`, `href`) is not a class list; HTML in one still counts.
      if (inAttributes) {
        if (value.includes("class")) classesInText(value, visible);
      } else scanString(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, path, `${pointer}/${i}`, inAttributes));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as Rec;
    let skipClassName = false;
    if (typeof node.tagName === "string") {
      order++;
      const className = node.className;
      if (
        typeof className === "string" &&
        !className.includes("${") &&
        node.id === undefined &&
        !node.tagName.includes("-") &&
        isBlock(node.style) &&
        Object.keys(node.style).length > 0
      ) {
        const first = className.trim().split(/\s+/)[0];
        if (first !== undefined && first !== "") {
          sources.push({
            first,
            node,
            path,
            order,
            style: JSON.parse(JSON.stringify(node.style)) as JxStyle,
          });
        }
      }
      const attributes = isBlock(node.attributes) ? node.attributes : undefined;
      const rewritable =
        typeof className === "string" &&
        !className.includes("${") &&
        node.id === undefined &&
        !node.tagName.includes("-") &&
        attributes?.class === undefined;
      if (rewritable) {
        const classes = className.trim().split(/\s+/).filter(Boolean);
        elements.push({ node, path, pointer, classes, order });
        skipClassName = true;
      }
      classesOfStyleKeys(node.style, keyClasses);
    }
    for (const [key, item] of Object.entries(node)) {
      if (key === "style" && typeof node.tagName === "string") continue;
      if (key === "className" && skipClassName) continue;
      if (key === "tagName") continue;
      walk(
        item,
        path,
        `${pointer}/${key}`,
        inAttributes || (key === "attributes" && typeof node.tagName === "string"),
      );
    }
  };
  for (const { path, doc } of input.documents) walk(doc, path, "");
  for (const text of input.markdown) classesInText(text, visible);
  /** Words of the scripts: a class one adds at run time can be on any element. */
  const scripted = new Set<string>();
  for (const text of input.scripts) for (const m of text.matchAll(/[\w-]+/g)) scripted.add(m[0]);
  for (const word of scripted) visible.add(word);

  // An element whose style is written for a class that something this pass cannot rewrite also carries
  // styles that too, through the class: it is left exactly as it is, and so is what it needs.
  const styled = (element: Element): boolean =>
    isBlock(element.node.style) && Object.keys(element.node.style).length > 0;
  const frozen = new Set<Element>();
  const byNode = new Map(elements.map((element) => [element.node, element]));
  const freeze = (element: Element | undefined): boolean => {
    if (element === undefined || frozen.has(element)) return false;
    frozen.add(element);
    for (const c of element.classes) visible.add(c);
    return true;
  };
  // A style that reaches an element of another document through the class (a layout's element and a
  // page's, two layouts, a component's and a page's) reaches it only where the two are drawn together,
  // which one rewritten style cannot say: both are left as they are.
  for (const source of sources) {
    for (const element of elements) {
      if (element.node === source.node || element.path === source.path) continue;
      if (!element.classes.includes(source.first)) continue;
      freeze(element);
      freeze(byNode.get(source.node));
    }
  }
  for (let again = true; again;) {
    again = false;
    for (const element of elements) {
      if (frozen.has(element) || !styled(element) || !visible.has(element.classes[0] ?? ""))
        continue;
      again = freeze(element) || again;
    }
  }
  elements = elements.filter((element) => !frozen.has(element));
  for (const element of elements) for (const c of element.classes) carried.add(c);

  // ── Which rules go where ────────────────────────────────────────────────────────────────────────
  /** Per class: what to write into its elements, in cascade order. */
  const moves = new Map<string, { rule: ProjectRule; key: string; with: string[] }[]>();
  const kept: ProjectRule[] = [];
  /** Classes the rules left in the project need on their elements. */
  const needed = new Set<string>();
  for (const rule of input.rules) {
    if (rule.selector === null || rule.selector.startsWith("&")) {
      kept.push(rule);
      continue;
    }
    const stay: string[] = [];
    for (const member of selectorMembers(rule.selector)) {
      const move = relocate(member);
      if (move === null) {
        stay.push(member);
        classesOfSelector(member, needed);
        continue;
      }
      const onElements = carried.has(move.target);
      const elsewhere = visible.has(move.target);
      if (onElements) {
        let list = moves.get(move.target);
        if (list === undefined) moves.set(move.target, (list = []));
        list.push({ rule, key: move.key, with: move.with });
      }
      if (elsewhere) {
        stay.push(member);
        // The class stays for what sees it; the elements this pass rewrites carry the rule themselves.
        const others = new Set<string>();
        classesOfSelector(member, others);
        others.delete(move.target);
        for (const c of others) needed.add(c);
      } else if (onElements) stats.rulesMoved++;
      else stats.rulesDead++;
      if (onElements) {
        const others = new Set<string>();
        classesOfSelector(move.key.replaceAll("&", ".x-scope"), others);
        others.delete("x-scope");
        for (const c of others) needed.add(c);
      }
    }
    if (stay.length > 0) kept.push({ ...rule, selector: stay.join(", ") });
  }

  // ── The elements ────────────────────────────────────────────────────────────────────────────────
  const changed = new Set<string>();
  const inlinedInto = new Set<Element>();
  for (const element of elements) {
    const incoming: { rule: ProjectRule; key: string }[] = [];
    const has = new Set(element.classes);
    for (const c of element.classes) {
      for (const move of moves.get(c) ?? []) {
        // `.a.b` matches only an element with both: the copy is dead on one that lacks `b`.
        if (move.with.every((other) => has.has(other) || scripted.has(other))) incoming.push(move);
      }
    }
    // The styles of other elements of the page whose first class this element carries.
    const shared = sources.filter(
      (source) =>
        source.node !== element.node && has.has(source.first) && source.path === element.path,
    );
    if (incoming.length > 0 || shared.length > 0) {
      incoming.sort((a, b) => a.rule.rank - b.rule.rank);
      type Item = { selector: string; context: string[]; decl: RankedDeclaration };
      const items: Item[] = [];
      const seen = new Set<string>();
      for (const { rule, key } of incoming) {
        // The same rule reached through two classes of the element is one rule.
        const id = `${rule.rank}\0${key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        rule.declarations.forEach(([property, value], i) =>
          items.push({
            selector: key,
            context: rule.context,
            decl: { property, value, rank: rule.rank * STEP + i },
          }),
        );
      }
      // Page-level styles, this element's own among them, in tree order.
      const ownStyle = (element.node.style ?? {}) as JxStyle;
      const pageLevel = [
        ...shared.map((source) => ({ order: source.order, style: source.style })),
        { order: element.order, style: ownStyle },
      ].sort((a, b) => a.order - b.order);
      let ownExtras: [string, unknown][] = [];
      for (const { order: at, style } of pageLevel) {
        const flat = flattenElementStyle(style);
        if (style === ownStyle) ownExtras = flat.extras;
        let n = 0;
        for (const rule of flat.rules) {
          for (const [property, value] of rule.declarations) {
            items.push({
              selector: rule.selector!,
              context: rule.context,
              decl: { property, value, rank: (PAGE_RANK + at) * STEP + n++ },
            });
          }
        }
      }
      // A shorthand that a later declaration of the same selector partly overrides wherever it applies
      // is written as its longhands, so the overridden ones can go (rather than the later one having
      // to be moved after it, into an alias block).
      for (let at = 0; at < items.length; at++) {
        const item = items[at]!;
        const parts = expandShorthand(item.decl.property, item.decl.value);
        if (parts === null) continue;
        const partly = items.some(
          (later) =>
            later.decl.rank > item.decl.rank &&
            later.selector === item.selector &&
            parts.some(([longhand]) => longhand === later.decl.property) &&
            contextContains(later.context, item.context, input.media),
        );
        if (!partly) continue;
        items.splice(
          at,
          1,
          ...parts.map(([property, value], i) => ({
            ...item,
            decl: { property, value, rank: item.decl.rank + i / 16 },
          })),
        );
        at += parts.length - 1;
      }
      // A declaration a later one of the same selector covers wherever it applies has nothing to say.
      const important = (v: unknown): boolean =>
        typeof v === "string" && /!\s*important\s*$/i.test(v);
      const live = items.filter(
        (item) =>
          !items.some(
            (later) =>
              later.decl.rank > item.decl.rank &&
              later.selector === item.selector &&
              !later.decl.property.startsWith("$") &&
              covers(later.decl.property, item.decl.property) &&
              (important(later.decl.value) || !important(item.decl.value)) &&
              contextContains(later.context, item.context, input.media),
          ),
      );
      const built = new OrderedStyle("element", input.media);
      for (const item of live) built.place(item.selector, item.context, item.decl);
      built.extras.push(...ownExtras);
      stats.aliased += built.aliased;
      const style = built.toStyle();
      if (Object.keys(style).length > 0) element.node.style = style;
      else delete element.node.style;
      for (const key of Object.keys(style)) {
        if (isBlock(style[key]) && !key.startsWith("@"))
          classesOfStyleKeys({ [key]: style[key] }, keyClasses);
      }
      stats.elements++;
      inlinedInto.add(element);
      changed.add(element.path);
    }
  }

  // ── The classes ─────────────────────────────────────────────────────────────────────────────────
  // What finds elements by class at run time needs the class on them; what only shows it (HTML text,
  // an entry, an element this pass leaves alone) keeps the rule in the project and nothing more.
  const stays = new Set<string>([...(input.protect ?? []), ...scripted, ...needed, ...keyClasses]);
  const remaining = new Set<string>();
  for (const element of elements) {
    const keep = element.classes.filter((c) => stays.has(c));
    const took = inlinedInto.has(element);
    if (keep.length === element.classes.length && !took) {
      for (const c of keep) remaining.add(c);
      continue;
    }
    stats.classesRemoved += element.classes.length - keep.length;
    const styled = isBlock(element.node.style) && Object.keys(element.node.style).length > 0;
    // Jx scopes the style with the first class, so the style needs one no other element has: a class
    // the element keeps is shared (that is why it is kept), and what the element took in would reach
    // every element that carries it. The block's own first class was its own scope before; once it is
    // gone, or the style holds rules it did not, the scope is a class of this element's own.
    // Jx numbers the `jx-N` scope it gives a class-less element per document, so a layout's `jx-0` and
    // the page's `jx-0` are two elements with one class and each other's rules: in a layout, a styled
    // element that loses its last class keeps a scope of its own instead.
    const unnumbered = keep.length === 0 && element.path.startsWith("layouts/");
    if (
      styled &&
      (unnumbered ||
        (keep.length > 0 &&
          !keep[0]!.startsWith("jx-") &&
          (took || keep[0] !== element.classes[0])))
    ) {
      const hash = createHash("sha256")
        .update(`${element.path}#${element.pointer}`)
        .digest("hex")
        .slice(0, 8);
      keep.unshift(`jx-w${hash}`);
    }
    for (const c of keep) remaining.add(c);
    if (keep.length > 0) element.node.className = keep.join(" ");
    else delete element.node.className;
    changed.add(element.path);
  }
  for (const c of carried) if (!remaining.has(c) && !visible.has(c)) stats.classesGone++;
  return { rules: kept, changed, stats };
}
