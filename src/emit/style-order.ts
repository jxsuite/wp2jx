/**
 * Style objects as the ordered rules Jx emits, and back.
 *
 * A Jx style object is a stylesheet whose order is implied by its shape, and the two places a
 * converted project holds one emit it differently:
 *
 * - **An element's `style`** is walked depth first (`buildStyleRules` in `@jxsuite/runtime/css`):
 *   the block's own declarations, then each nested key in order, a selector key resolved against
 *   the element (`&`), an at-rule key wrapping what it holds.
 * - **`project.json`'s `style`** (`buildSiteStyleCSS` in `@jxsuite/site`): the top-level declarations
 *   (custom properties on `:root`, the rest on `body`), then EVERY selector block in key order, and
 *   only then every at-rule block in key order. A selector rule written after an at-rule's rule in
 *   the source cannot follow it there unless it sits in an at-rule block itself, which is what
 *   `@(min-width: 0px)` (`EVERY_WIDTH`, always true) is for.
 *
 * {@link flattenProjectStyle} and {@link flattenElementStyle} read a style object as that sequence of
 * rules, and {@link OrderedStyle} writes one back from declarations given in cascade order (a rank
 * per declaration) without changing which of two declarations wins: a declaration joins an existing
 * block only when no block emitted after that block holds a lower-ranked declaration it competes
 * with (same specificity, same importance, overlapping properties, selectors that can end on one
 * element). Otherwise it goes into a block of its own spelled with an alias that matches the same
 * elements at the same specificity and is emitted last: `:where(*)` appended on an element
 * (`&:where(*)` is the element itself), `@(min-width: 0px)` or a respelled at-rule key at the project
 * level.
 */
import selectorParser from "postcss-selector-parser";
import { specificityOf } from "../cwicly/css.ts";
import { overlaps } from "./design-system.ts";
import type { JxStyle } from "../types.ts";

type Rec = Record<string, unknown>;

/** The at-rule wrapper that is always true, so a selector rule placed in it is emitted with the at-rules. */
export const ALWAYS = "@(min-width: 0px)";

const isRef = (v: unknown): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "$ref" in v;

/** A nested block: an object that is neither an array nor a `{ $ref }` value. */
export const isBlock = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !isRef(v);

/** At-rules whose block is not a rule of the scope (`@font-face`, `@keyframes`…): carried as they are. */
export const isUnscopedAtRule = (key: string): boolean =>
  /^@(?:font-face|property|counter-style|position-try|(?:-(?:webkit|moz|o)-)?keyframes)\b/i.test(
    key,
  );

// ── Selectors ─────────────────────────────────────────────────────────────────────────────────────

const listCache = new Map<string, string[]>();

/** The members of a selector list (commas inside `:is()`, attribute values or strings do not split). */
export function selectorMembers(selector: string): string[] {
  let found = listCache.get(selector);
  if (found === undefined) {
    if (listCache.size > 20_000) listCache.clear();
    try {
      found = selectorParser()
        .astSync(selector)
        .nodes.map((member) => member.toString().trim())
        .filter((member) => member !== "");
    } catch {
      found = [selector.trim()];
    }
    listCache.set(selector, found);
  }
  return found;
}

/** The selector a nested key stands for under `scope`, member by member, the way Jx resolves it. */
export function resolveNested(scope: string, key: string): string {
  const out: string[] = [];
  for (const outer of selectorMembers(scope)) {
    for (const inner of selectorMembers(key)) {
      if (inner.includes("&")) out.push(inner.replaceAll("&", outer));
      else if (/^[:.[]/.test(inner)) out.push(outer + inner);
      else out.push(`${outer} ${inner}`);
    }
  }
  return out.join(", ");
}

/** What decides whether two rules compete: specificity, and what their subject can be. */
interface SelectorFacts {
  specificity: string;
  /** `[name=value]` of the first compound: two rules that differ in one of these never meet. */
  attributes: Map<string, string>;
  /** The element type of the subject, empty when any element can be it. */
  tag: string;
  /** `::before`…, empty for the element itself. */
  pseudoElement: string;
}

const factsCache = new Map<string, SelectorFacts>();
/** The scope (`&`) is read as one class: the handle Jx writes for it (`.jx-3`, `.heading-c1f`) is one. */
const SCOPE_CLASS = ".jx-scope-placeholder";

function factsOf(selector: string | null): SelectorFacts {
  if (selector === null)
    return { specificity: "root", tag: "", pseudoElement: "", attributes: new Map() };
  let found = factsCache.get(selector);
  if (found !== undefined) return found;
  if (factsCache.size > 20_000) factsCache.clear();
  found = { specificity: `?${selector}`, tag: "", pseudoElement: "", attributes: new Map() };
  try {
    const members = selectorParser().astSync(selector.replaceAll("&", SCOPE_CLASS)).nodes;
    // A list's members are separate rules for the cascade; the most specific one stands for it.
    let best: SelectorFacts | undefined;
    let bestSpec: readonly number[] = [-1, -1, -1];
    for (const member of members) {
      const spec = specificityOf(member);
      let tag = "";
      let pseudoElement = "";
      for (let at = member.nodes.length - 1; at >= 0; at--) {
        const node = member.nodes[at]!;
        if (node.type === "combinator") break;
        if (node.type === "tag") tag = node.value.toLowerCase();
        if (node.type === "pseudo") {
          const name = node.value.toLowerCase();
          if (name.startsWith("::") || /^:(?:before|after|first-line|first-letter)$/.test(name))
            pseudoElement = name.replace(/^::?/, "::");
        }
      }
      if (
        spec[0] > bestSpec[0]! ||
        (spec[0] === bestSpec[0] &&
          (spec[1] > bestSpec[1]! || (spec[1] === bestSpec[1] && spec[2] > bestSpec[2]!)))
      ) {
        bestSpec = spec;
        const attributes = new Map<string, string>();
        for (const node of member.nodes) {
          if (node.type === "combinator") break;
          if (node.type === "attribute" && node.operator === "=" && node.value !== undefined)
            attributes.set(node.attribute, node.value);
        }
        best = {
          specificity: members.length === 1 ? spec.join(",") : `${spec.join(",")}|${selector}`,
          tag,
          pseudoElement,
          attributes: members.length === 1 ? attributes : new Map(),
        };
      }
    }
    if (best !== undefined) found = best;
  } catch {
    // An unreadable selector competes with nothing but itself.
  }
  factsCache.set(selector, found);
  return found;
}

// ── Flattening ────────────────────────────────────────────────────────────────────────────────────

/** One rule: a selector (`null` for the top-level declarations), the at-rules around it, its declarations. */
export interface FlatRule {
  selector: string | null;
  context: string[];
  declarations: [string, unknown][];
}

/** A style object read as rules, plus what is carried as it is (unscoped at-rules, arrays). */
export interface Flattened {
  rules: FlatRule[];
  extras: [string, unknown][];
}

/**
 * `project.json`'s `style` as the rules the site builder emits, in its order: the top-level
 * declarations, every selector block, then every at-rule block.
 */
export function flattenProjectStyle(style: JxStyle): Flattened {
  const rules: FlatRule[] = [];
  const extras: [string, unknown][] = [];
  const top: [string, unknown][] = [];
  const selectors: [string, Rec][] = [];
  const conditions: [string, Rec][] = [];
  for (const [key, value] of Object.entries(style as Rec)) {
    if (Array.isArray(value) || isUnscopedAtRule(key)) extras.push([key, value]);
    else if (isBlock(value)) {
      if (key.startsWith("@")) conditions.push([key, value]);
      else if (!key.startsWith("--")) selectors.push([key, value]);
    } else top.push([key, value]);
  }
  if (top.length > 0) rules.push({ selector: null, context: [], declarations: top });
  const walk = (node: Rec, selector: string | null, context: string[]): void => {
    const own: [string, unknown][] = [];
    for (const [key, value] of Object.entries(node)) if (!isBlock(value)) own.push([key, value]);
    if (own.length > 0) rules.push({ selector, context, declarations: own });
    for (const [key, value] of Object.entries(node)) {
      if (!isBlock(value)) continue;
      if (isUnscopedAtRule(key)) extras.push([key, value]);
      else if (key.startsWith("@")) walk(value, selector, [...context, key]);
      else walk(value, selector === null ? key : resolveNested(selector, key), context);
    }
  };
  for (const [key, value] of selectors) walk(value, key, []);
  for (const [key, value] of conditions) walk(value, null, [key]);
  return { rules, extras };
}

/**
 * An element's `style` as rules, in the order Jx emits them, each selector written against `&` (the
 * element): `&` for its own declarations, `&:hover`, `& svg`, `.wrap &`.
 */
export function flattenElementStyle(style: JxStyle): Flattened {
  const rules: FlatRule[] = [];
  const extras: [string, unknown][] = [];
  const walk = (node: Rec, selector: string, context: string[], top: boolean): void => {
    const own: [string, unknown][] = [];
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value) || (isBlock(value) && isUnscopedAtRule(key))) {
        if (top) extras.push([key, value]);
      } else if (!isBlock(value)) own.push([key, value]);
    }
    if (own.length > 0) rules.push({ selector, context, declarations: own });
    for (const [key, value] of Object.entries(node)) {
      if (!isBlock(value) || isUnscopedAtRule(key)) continue;
      if (key.startsWith("@")) walk(value, selector, [...context, key], false);
      else walk(value, resolveNested(selector, key), context, false);
    }
  };
  walk(style as Rec, "&", [], true);
  return { rules, extras };
}

// ── Conditions ────────────────────────────────────────────────────────────────────────────────────

type Condition = { kind: "max" | "min"; px: number } | { kind: "raw"; text: string } | null;

function conditionOf(key: string, media: Readonly<Record<string, string>>): Condition {
  let query = key.trim();
  if (query.startsWith("@--")) query = media[query.slice(1)] ?? query;
  else if (query.startsWith("@(")) query = query.slice(1);
  else if (/^@media\s/i.test(query)) query = query.replace(/^@media\s+/i, "");
  else return { kind: "raw", text: query.replace(/\s+/g, " ") };
  const compact = query.replace(/\s+/g, "").toLowerCase();
  const width = /^\((max|min)-width:(\d+(?:\.\d+)?)px\)$/.exec(compact);
  if (width !== null) {
    const px = Number(width[2]);
    if (width[1] === "min" && px === 0) return null;
    return { kind: width[1] as "max" | "min", px };
  }
  return { kind: "raw", text: compact };
}

/** Whether every condition of `outer` holds wherever all of `inner`'s do (`[]` holds everywhere). */
export function contextContains(
  outer: readonly string[],
  inner: readonly string[],
  media: Readonly<Record<string, string>>,
): boolean {
  const have = inner.map((key) => conditionOf(key, media)).filter((c) => c !== null);
  return outer.every((key) => {
    const need = conditionOf(key, media);
    if (need === null) return true;
    return have.some((c) => {
      if (need.kind === "raw" || c.kind === "raw")
        return need.kind === "raw" && c.kind === "raw" && need.text === c.text;
      return need.kind === c.kind && (need.kind === "max" ? c.px <= need.px : c.px >= need.px);
    });
  });
}

// ── Writing back ──────────────────────────────────────────────────────────────────────────────────

/** A declaration and where it stands in the cascade (higher wins at equal specificity). */
export interface RankedDeclaration {
  property: string;
  value: unknown;
  rank: number;
}

const IMPORTANT = /!\s*important\s*$/i;
const isImportant = (value: unknown): boolean => typeof value === "string" && IMPORTANT.test(value);

interface Block {
  path: string[];
  selector: string | null;
  facts: SelectorFacts;
  declarations: RankedDeclaration[];
}

const startsWith = (path: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((key, at) => path[at] === key);
const samePath = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && startsWith(a, b);

/** Respell an at-rule key so that it is a new key for the same condition (`@media  (…)`). */
function respell(key: string, media: Readonly<Record<string, string>>, n: number): string {
  let text = key;
  if (text.startsWith("@--")) text = `@media ${media[text.slice(1)] ?? text.slice(1)}`;
  else if (text.startsWith("@(")) text = `@media ${text.slice(1)}`;
  const match = /^(@[\w-]+)\s*(.*)$/s.exec(text);
  return match === null ? text : `${match[1]}${" ".repeat(n)}${match[2]}`;
}

/** `:where(*)` appended (before any pseudo-element): the same elements at the same specificity. */
function whereAlias(selector: string, n: number): string {
  const tail = ":where(*)".repeat(n);
  return selectorMembers(selector)
    .map((member) => {
      const at = member.search(/::|:(?:before|after|first-line|first-letter)\b/i);
      return at < 0 ? member + tail : member.slice(0, at) + tail + member.slice(at);
    })
    .join(", ");
}

/**
 * A style object written from declarations given in cascade order (see the module comment).
 * `mode` is which emitter will read it: `"element"` (selectors written against `&`) or `"project"`.
 */
export class OrderedStyle {
  private readonly blocks: Block[] = [];
  readonly extras: [string, unknown][] = [];
  /** How many declarations had to go to an alias block to keep the cascade. */
  aliased = 0;

  constructor(
    private readonly mode: "element" | "project",
    private readonly media: Readonly<Record<string, string>>,
  ) {}

  private pathOf(selector: string | null, context: readonly string[]): string[] {
    if (this.mode === "element") return selector === "&" ? [...context] : [selector!, ...context];
    if (selector === null) return [...context];
    return context.length === 0 ? [selector] : [...context, selector];
  }

  private isCondition = (key: string): boolean => key.startsWith("@");

  /** Where a block for `path` would be emitted, if it is not there yet. */
  private insertionIndex(path: readonly string[]): number {
    if (path.length === 0) return 0;
    const below = this.blocks.findIndex((b) => b.path.length > 0 && startsWith(b.path, path));
    if (below >= 0) return below;
    for (let parent = path.slice(0, -1); parent.length > 0; parent = parent.slice(0, -1)) {
      const last = this.blocks.findLastIndex((b) => startsWith(b.path, parent));
      if (last >= 0) return last + 1;
    }
    if (this.mode === "project" && !this.isCondition(path[0]!)) {
      const firstCondition = this.blocks.findIndex(
        (b) => b.path.length > 0 && this.isCondition(b.path[0]!),
      );
      return firstCondition < 0 ? this.blocks.length : firstCondition;
    }
    return this.blocks.length;
  }

  /** Whether a block emitted from `from` on holds a lower-ranked declaration `declaration` competes with. */
  private blocked(from: number, facts: SelectorFacts, declaration: RankedDeclaration): boolean {
    const important = isImportant(declaration.value);
    for (let at = from; at < this.blocks.length; at++) {
      const block = this.blocks[at]!;
      if (block.facts.specificity !== facts.specificity) continue;
      if (block.facts.tag !== "" && facts.tag !== "" && block.facts.tag !== facts.tag) continue;
      if (block.facts.pseudoElement !== facts.pseudoElement) continue;
      if (
        [...facts.attributes].some(
          ([name, value]) =>
            block.facts.attributes.has(name) && block.facts.attributes.get(name) !== value,
        )
      )
        continue;
      for (const other of block.declarations) {
        if (other.rank >= declaration.rank) continue;
        if (isImportant(other.value) !== important) continue;
        if (other.property.startsWith("$") || declaration.property.startsWith("$")) continue;
        if (overlaps(other.property, declaration.property)) return true;
      }
    }
    return false;
  }

  private add(at: number, path: string[], selector: string | null, decl: RankedDeclaration): void {
    this.blocks.splice(at, 0, { path, selector, facts: factsOf(selector), declarations: [decl] });
  }

  private push(block: Block, decl: RankedDeclaration): void {
    const same = block.declarations.findIndex((d) => d.property === decl.property);
    if (same >= 0) {
      // An earlier `!important` is not displaced by a later plain value.
      if (isImportant(block.declarations[same]!.value) && !isImportant(decl.value)) return;
      block.declarations.splice(same, 1);
    }
    block.declarations.push(decl);
  }

  /** Place one declaration, given in ascending rank order. */
  place(selector: string | null, context: readonly string[], decl: RankedDeclaration): void {
    const facts = factsOf(selector);
    const path = this.pathOf(selector, context);
    const existing = this.blocks.findIndex((b) => samePath(b.path, path));
    if (existing >= 0) {
      if (!this.blocked(existing + 1, facts, decl)) {
        this.push(this.blocks[existing]!, decl);
        return;
      }
    } else {
      const at = this.insertionIndex(path);
      if (!this.blocked(at, facts, decl)) {
        this.add(at, path, selector, decl);
        return;
      }
    }
    this.aliased++;
    this.placeAlias(selector, context, decl);
  }

  /** A block of its own, emitted after everything placed so far, for the same elements and conditions. */
  private placeAlias(
    selector: string | null,
    context: readonly string[],
    decl: RankedDeclaration,
  ): void {
    const taken = (path: readonly string[]): boolean =>
      this.blocks.some((b) => b.path.length > 0 && b.path[0] === path[0]);
    if (this.mode === "element") {
      for (let n = 1; ; n++) {
        const alias = whereAlias(selector ?? "&", n);
        const path = [alias, ...context];
        if (!taken(path)) {
          this.blocks.push({
            path,
            selector: alias,
            facts: factsOf(selector),
            declarations: [decl],
          });
          return;
        }
      }
    }
    // Project level: a new at-rule block, which is emitted after every block placed so far.
    const head = context.length === 0 ? ALWAYS : context[0]!;
    const rest = context.slice(1);
    for (let n = context.length === 0 ? 0 : 1; ; n++) {
      const key = n === 0 ? head : respell(head, this.media, n);
      const path = selector === null ? [key, ...rest] : [key, ...rest, selector];
      if (!taken(path)) {
        this.blocks.push({ path, selector, facts: factsOf(selector), declarations: [decl] });
        return;
      }
    }
  }

  /** The style object: blocks in emission order, then what was carried as it is. */
  toStyle(): JxStyle {
    const style: Rec = {};
    for (const block of this.blocks) {
      let node = style;
      for (const key of block.path) {
        const next = node[key];
        if (isBlock(next)) node = next;
        else {
          const made: Rec = {};
          node[key] = made;
          node = made;
        }
      }
      for (const d of block.declarations) {
        if (d.property in node) delete node[d.property];
        node[d.property] = d.value;
      }
    }
    for (const [key, value] of this.extras) style[key] = value;
    return style as JxStyle;
  }
}
