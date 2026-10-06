/**
 * Cwicly components (`cc_block` posts) as Jx components: `components/<tag>.json`, flat in
 * `components/` (the build compiles only the files directly in it), one per `reference`.
 *
 * ## What a component document is
 *
 * `{tagName, description, $elements?, state, style, children}`. The body is the cc_block's blocks
 * converted in component mode (`convertSubject`, `{component=parameter=<id>}` and the connectors a
 * block names becoming `${state.<key>}` through `ctx.props`); everything else is decided here, in this
 * order:
 *
 * 1. **Placeholders** (`wp2jx-*`) are replaced with the resolvers the caller hands in over the
 *    defaults (a template part becomes its component's tag; a shortcode, a search form and a block
 *    nothing converts become a visible neutral element, `component.placeholder-neutral`). What nothing
 *    resolves stays and is reported (`placeholder.unresolved`).
 * 2. **Variants** (below).
 * 3. **`state`**: one entry per property, by the key `componentInfos` gave it, holding the value the
 *    plugin prints for an instance that gives none (`get_component_value`'s default branch), in the
 *    shape the property's type has: `text`, `richtext`, `list`, `video`, `id`, `cssText` and `color` are
 *    strings (a palette reference is the `var(--cc-color-N)` it names; one the palette does not have is
 *    left out and reported, `component.palette-unresolved`), `number` a number, `toggle` a boolean,
 *    `link` `{href, target?, rel?, title?}`, `image` `{src, alt, width?, height?}` (the attachment's
 *    file in the media plan), `icon` the SVG markup, `class` the class list (the authored classes, then
 *    the global classes' names; an id that names none is `class.dangling-global`), `options` the chosen
 *    option's value (an id no option has is empty, `component.option-unmatched`; a dynamic property's
 *    default is its raw text), `gallery` a list of images. Richtext defaults have their addresses moved
 *    as an instance's richtext value does. An instance's value replaces the default whole, but it is
 *    not always the same shape: the converter writes `toggle` and `number` values as the strings the
 *    block stored (`"false"`, `"7"`). So the body reads a toggle through a test that accepts both
 *    ({@link normaliseToggleReads}), and a number is bound to the CSS without a truthiness test (below).
 *    A `text` or `list` property that is the whole text of an element is bound as `innerHTML`, because
 *    the plugin prints a property's value raw and a text property may hold markup
 *    ({@link bindMarkupAsHtml}). The page-level state entries a conversion registered
 *    (`Converted.state`: a query's collection) are in the same `state`, except a query's list, which a
 *    component cannot hold (`component.query-unsupported`).
 * 4. **`$elements`**: a relative `$ref` to `./<tag>.json` for every component, template part and
 *    reusable block the body instantiates. Components that contain each other are cut where the cycle
 *    closes (Cwicly prints nothing for a component inside itself, `$seen_refs`) and reported
 *    (`component.cycle`).
 * 5. **`style`** (the host's, which Jx writes under the component's tag): `display: contents`, so the
 *    body's root stays the flex or grid item it was in the live markup; the `--comp-<id>` custom
 *    properties of the properties the plugin feeds into CSS (below); the rules no element's own
 *    `style` could hold (`:where()` rules, `@keyframes`, another class's rules), written `& <selector>`
 *    (a descendant of the host) or as the at-rule. A rule about the document itself (`body`, `:root`)
 *    has no spelling there: it is returned in {@link ComponentsUsed.documentRules} for the project's
 *    `style`.
 *
 * ## Variants
 *
 * A component's variants are classes: the instance prints `cs-<variantId>` (`variantClasses`), on
 * every element of the component in Cwicly (`{cs-index}`), and the component's stylesheet has
 * `.div-xyz.cs-abc{…}` for what a variant changes. The instance converter puts the classes on the HOST
 * (the custom element), because Jx has no per-instance class on an element of a definition's body
 * (a templated `className` is not safe: docs/bindings.md rule 5). So a rule that wants the class on
 * the element itself is rewritten to want it on an ancestor: the style module's `"&.cs-abc"` key is
 * `"&:is(.cs-abc *)"` here, which has the specificity of the compound it replaces (class plus
 * class) and matches exactly when the instance has the variant. The classes sit on the instance and
 * not on a shared ancestor, so another instance is never touched by them. (A component nested in a
 * component of its own kind would see its parent's variant; no real data does it.)
 *
 * ## Properties that become CSS
 *
 * The plugin writes `--comp-<propId>` on the instance's element for the properties of type `color`,
 * `number`, `cssText` and `options` (and an `icon` with `includeInCSS`), and the component's rules
 * read them as `var(--comp-<propId>)`. The definition's host `style` carries them as bindings on the
 * property's state (`${state.<key> || 'initial'}`: `initial` keeps a `var(--x, fallback)` on its
 * fallback, which an empty value would not; a number tests for an empty value instead, because `0`
 * is a value and the plugin writes `--comp-<id>: 0`), and Jx resolves a host binding per instance. Only the
 * custom properties the body's rules actually read are bound, and the name is spelled lower-case
 * (`--comp-pCol01` is `--comp-p-col01`, in the host and in the body's `var()`): a NESTED instance's
 * resolved host style is an inline `style` whose names Jx runs through camelCase-to-kebab, and a name
 * that survives that is the same in both places ({@link compVariable}). **One caveat, reported once per such component (`component.css-variable`):** a page-level instance's
 * resolved host style is written to a class rule on the instance's FIRST class, so instances that
 * differ in such a property need a first class of their own (the instance's classID), and the variant
 * class alone is shared. The report is a warning when the site's pages hold instances that give
 * different values (with their count), and info otherwise. No fixture component has a property of
 * these types, so this path is tested on hand-made components only.
 *
 * ## Sharing the path
 *
 * {@link buildComponentDocument} does steps 1 to 5 for any subject, and is the one conversion path
 * template parts and reusable blocks (`emit/templates.ts`) use: they pass their tag, their own
 * `SubjectOptions` and a `state` of their own (none) and get a document and what it uses.
 *
 * ## Scopes and leaks
 *
 * An element's own `style` is written to the selector of the first word of its `className`, which is
 * the block's classID (docs/design.md), so a component's rules never reach another component's
 * elements, nor another instance's. Two things can still collide: a classID that two components
 * share with different declarations (a duplicated component keeps its blocks' classIDs: the later
 * component's elements are renamed `<classID>-<tag>` and the rename reported,
 * `component.scope-renamed`), and an `id` inside a component, which every instance repeats
 * (`component.id-repeats`). `ComponentInfoOut.scopes` lists each component's scopes for a project
 * assembler that wants to check them against the pages'.
 *
 * ## Dead properties
 *
 * A property no binding, no style and no custom property of the body reads is `component.dead-prop`
 * (info): the live page ignores its value too (fineline's Icon Card has an `icon` property and no
 * block shows it; 170 instances set it). It stays in `state` so an instance that passes it is not
 * surprised. A `visibility` or `conditions` property is not dead: the plugin hides the block per
 * instance by it (`block_conditions_check`) and nothing here carries that, so it is
 * `component.property-unsupported` (warn).
 *
 * Report codes: `component.convert-failed`, `component.not-published`, `component.empty`,
 * `component.dead-prop`, `component.prop-reflected`, `component.prop-type-unknown`,
 * `component.css-variable`, `component.variant-orphan`, `component.variant-no-rules`,
 * `component.slot-multiple`, `component.id-repeats`, `component.cycle`, `component.scope-renamed`,
 * `component.scope-collision`, `component.state-undeclared`, `component.state-missing`,
 * `component.state-collision`, `component.literal-template`, `component.placeholder-neutral`,
 * `component.hoisted-unplaced`, `component.hoisted-collision`, `component.binding-misplaced` (a
 * component's `className` and `id` are bindings the build resolves per instance, so only a first class
 * that is a binding, or the id of a styled element, is one; {@link misplacedBindings}),
 * `component.property-unsupported`, `component.palette-unresolved`, `component.option-unmatched`,
 * `component.query-unsupported`, `class.dangling-global`, plus everything the conversion reports
 * (located `component:<reference>`). `component.not-published` is a warning: the plugin prints nothing
 * for an instance of a private, draft or password-protected component, and the converted page does.
 */
import { posix } from "node:path";
import { collectWpClasses } from "../core/block-css.ts";
import { convertSubject, dedupeRules, type Converted } from "../convert.ts";
import { resolvePaletteRefs } from "../cwicly/options.ts";
import { resolveTokens, texturize } from "../cwicly/tokens.ts";
import {
  childNodes,
  replacePlaceholders,
  walkElements,
  type Placeholder,
  type ResolverMap,
} from "../placeholders.ts";
import { createReport } from "../report.ts";
import {
  allSubjects,
  partTag,
  siteTags,
  subjectBlocks,
  subjectCtx,
  subjectWhere,
  type HoistedRule,
  type SiteContext,
  type Subject,
  type SubjectOptions,
} from "../site.ts";
import type {
  ComponentInfo,
  ConvertCtx,
  JxDocument,
  JxElement,
  JxNode,
  JxStyle,
  Report,
  ReportEntry,
} from "../types.ts";
import { walkBlocks } from "../wp/blocks.ts";
import { decodeEntities } from "../wp/model.ts";
import { fluentFormFor } from "./fluentform.ts";

// ── Contract ─────────────────────────────────────────────────────────────────────────────────────

export type ConvertFn = (
  site: SiteContext,
  subject: Subject,
  opts?: SubjectOptions,
) => Promise<Converted>;

export interface ComponentsOptions {
  /** Where findings go. Default: a fresh report (returned as `ComponentsOutput.report`). */
  report?: Report;
  /** Only these components (by `reference`), for a partial run. */
  only?: readonly string[];
  /**
   * Resolvers for the placeholders a component holds, over the defaults (a template part, a shortcode, a
   * search form, a block nothing converts). A tag outranks a kind and a kind outranks `*`.
   */
  resolvers?: ResolverMap;
  /** The conversion of one subject; a seam for tests. Default: `convertSubject`. */
  convert?: ConvertFn;
}

export interface ComponentFile {
  /** Project-relative, forward slashes: `components/wp-icon-card.json`. */
  path: string;
  content: string;
}

export interface ComponentProp {
  /** The property id (what `{component=parameter=<id>}` and an instance's `properties` key name). */
  id: string;
  /** The state key (`ComponentInfo.props[].key`): what an instance's `$props` names. */
  key: string;
  name: string;
  /** The type the component declares: `text`, `richtext`, `link`, `image`, `icon`, `color`… */
  type: string;
  /** The `state` default the document carries. */
  default: unknown;
  /** Whether the body reads it (a binding, a style or a `--comp-` custom property). */
  used: boolean;
  /** The custom property the plugin feeds from it (`--comp-<id>`), when the type is one that becomes CSS. */
  cssVariable?: string;
}

export interface ComponentVariant {
  id: string;
  name: string;
  /** The variant groups this variant is in (group ids). */
  groups: string[];
  /** The `cs-<id>` rules the body has for it (element rules rewritten for the host's class). */
  rules: number;
}

export interface ComponentInfoOut {
  /** The `reference` meta. */
  ref: string;
  postId: number;
  /** The post's title: `Icon Card`. */
  title: string;
  tag: string;
  /** `components/<tag>.json`. */
  file: string;
  props: ComponentProp[];
  variants: ComponentVariant[];
  variantGroups: { id: string; name: string; styles: string[] }[];
  /** The style variations (`styleVariations`): a variation picks one variant (or group) per instance. */
  styleVariations: { id: string; name: string; styles: string[] }[];
  /** How many `<slot>` elements the body has (an instance's children go in the first). */
  slots: number;
  /** The selectors the body's elements write their own style to (classIDs): what could collide with a page's. */
  scopes: string[];
}

export interface ComponentsUsed {
  /** Tags of the components, template parts and reusable blocks the components instantiate: `components/<tag>.json` must exist for each. */
  components: Set<string>;
  /** Every class name the components carry (for the compatibility stylesheet's pruning). */
  wpClasses: Set<string>;
  /** The rules written into the components' own `style` because no element's style could hold them, duplicates removed. */
  hoisted: HoistedRule[];
  /** Rules about the document itself (`body`, `:root`): not written into any component, for the project's `style`. */
  documentRules: HoistedRule[];
  /** Page-level state keys the components point at. */
  states: Set<string>;
}

export interface ComponentSkip {
  ref: string;
  code: string;
  reason: string;
}

export interface ComponentsOutput {
  /** One file per component, in path order. */
  files: ComponentFile[];
  components: ComponentInfoOut[];
  /** Components that did not become a file, and why. */
  skipped: ComponentSkip[];
  used: ComponentsUsed;
  /** Everything the conversions and this emitter found, located `component:<reference>`. */
  report: Report;
}

// ── Small readers ────────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== ""
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;

/** The values of a PHP array that came back as a list or as an object keyed by index or id. */
const rows = (value: unknown): Rec[] =>
  (Array.isArray(value) ? value : isRec(value) ? Object.values(value) : []).filter(isRec);

const firstMeta = (site: Pick<SiteContext, "model">, id: number, key: string): unknown =>
  site.model.postMeta.get(id)?.[key]?.[0];

/** Where a component's file is written: flat in `components/`, named by its tag. */
export const componentFile = (tag: string): string => `components/${tag}.json`;

/** A `$ref` to a project file, relative to the file it is written in. */
export function relativeRef(fromFile: string, toFile: string): string {
  const ref = posix.relative(posix.dirname(fromFile), toFile);
  return ref.startsWith(".") ? ref : `./${ref}`;
}

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `${` written so no binding can be read in it (a zero-width space between the two characters). */
const literalText = (value: string): string => value.replaceAll("${", "$​{");

const hasBinding = (value: unknown): boolean => typeof value === "string" && value.includes("${");

// ── Hoisted rules ────────────────────────────────────────────────────────────────────────────────

/** A selector split at its top-level commas (a comma inside `:is(a, b)` or `[x="a,b"]` is not a list separator). */
function selectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let from = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(selector.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(selector.slice(from).trim());
  return parts.filter((part) => part !== "");
}

/** Selectors about the document, which nothing nested under a component's host can name. */
const DOCUMENT_SELECTOR = /^(?:html|body|:root|:host|\*)(?![\w-])|^&$/i;

/**
 * At-rules whose key names ONE definition: a second `@keyframes spin` replaces the first in CSS, and a
 * style object has one slot per key, so `@font-face` (which CSS lets accumulate) is here too, because
 * its key is the same for every face. Every other rule accumulates, which a merge writes exactly.
 */
const REPLACING_AT_RULE =
  /^@(?:-\w+-)?(?:keyframes|property|counter-style|font-palette-values|font-feature-values|position-try|font-face)(?![\w-])/i;

/**
 * `source` over `target` as the cascade reads two rules of one selector: a property the later rule
 * sets wins (and moves to the end, because a shorthand written after a longhand overrides it and the
 * reverse does not), nested blocks (`:hover`, `@--md`) merge the same way.
 */
function mergeStyle(target: Rec, source: Rec): void {
  for (const [key, value] of Object.entries(source)) {
    const known = target[key];
    if (isRec(known) && isRec(value)) {
      mergeStyle(known, value);
      continue;
    }
    delete target[key];
    target[key] = structuredClone(value);
  }
}

interface HoistedStyle {
  style: JxStyle;
  /** Rules that have no spelling in a component's style. */
  unplaced: HoistedRule[];
  /** At-rules two rules define differently under one key, which cannot both be written; the later one is kept. */
  collisions: string[];
}

/**
 * The host style that holds hoisted rules: a selector is a descendant of the host (`& <selector>`:
 * Jx writes it under the component's tag), an at-rule is itself. A rule about the document is
 * `unplaced`.
 */
function hoistedStyle(rules: readonly HoistedRule[]): HoistedStyle {
  const style: Rec = {};
  const unplaced: HoistedRule[] = [];
  const collisions: string[] = [];
  const put = (key: string, value: JxStyle): void => {
    const known = style[key];
    if (known === undefined) {
      style[key] = structuredClone(value);
    } else if (REPLACING_AT_RULE.test(key)) {
      if (JSON.stringify(known) !== JSON.stringify(value) && !collisions.includes(key)) {
        collisions.push(key);
      }
      style[key] = structuredClone(value);
    } else if (isRec(known)) {
      mergeStyle(known, value as Rec);
    }
  };
  for (const rule of rules) {
    const selector = rule.selector.trim();
    if (selector.startsWith("@")) {
      put(selector, rule.style);
      continue;
    }
    const parts = selectorList(selector);
    if (parts.length === 0 || parts.some((part) => DOCUMENT_SELECTOR.test(part))) {
      unplaced.push(rule);
      continue;
    }
    for (const part of parts) put(`& ${part}`, rule.style);
  }
  return { style: style as JxStyle, unplaced, collisions };
}

// ── Variants ─────────────────────────────────────────────────────────────────────────────────────

/** A nested key that wants variant classes on the element itself: `&.cs-abc`, `&.cs-abc:hover`, `&.cs-a.cs-b svg`. */
const VARIANT_KEY = /^&((?:\.cs-[\w-]+)+)([\s\S]*)$/;

/**
 * The key that asks for the same thing when the classes sit on an ancestor (the instance's host):
 * `&:is(.cs-abc *)` followed by whatever the key said after the classes. `:is()` takes the specificity
 * of its argument, so the compound `.x.cs-abc` (class plus class) and `.x:is(.cs-abc *)` agree.
 */
export function ancestorVariantKey(key: string): { key: string; ids: string[] } | undefined {
  const m = VARIANT_KEY.exec(key);
  if (!m) return undefined;
  const classes = m[1]!;
  const ids = [...classes.matchAll(/\.cs-([\w-]+)/g)].map((c) => c[1]!);
  return { key: `&:is(${classes} *)${m[2]!}`, ids };
}

function rewriteVariantKeys(style: Rec, found: Map<string, number>): Rec {
  const out: Rec = {};
  for (const [key, value] of Object.entries(style)) {
    const moved = ancestorVariantKey(key);
    const next = isRec(value) ? rewriteVariantKeys(value, found) : value;
    if (moved === undefined) {
      out[key] = next;
      continue;
    }
    for (const id of moved.ids) found.set(id, (found.get(id) ?? 0) + 1);
    const known = out[moved.key];
    if (isRec(known) && isRec(next)) mergeStyle(known, next);
    else out[moved.key] = next;
  }
  return out;
}

/**
 * The nodes with every element's `&.cs-<id>` style key asking for its variant class on an ancestor
 * (see the module header), in a copy, and how many keys each variant id had. Nothing else changes.
 */
export function switchVariants(nodes: readonly JxNode[]): {
  nodes: JxNode[];
  variants: Map<string, number>;
} {
  const copy = structuredClone([...nodes]);
  const variants = new Map<string, number>();
  for (const element of walkElements(copy)) {
    if (isRec(element.style))
      element.style = rewriteVariantKeys(element.style, variants) as JxStyle;
  }
  return { nodes: copy, variants };
}

// ── Placeholders ─────────────────────────────────────────────────────────────────────────────────

/** The visible stand-in for what has no static form: the class says what it is, the text says what it said. */
function neutralElement(placeholder: Placeholder, label: string, text: string): JxElement {
  const inner = placeholder.element.children;
  return {
    tagName: "div",
    className: `wp2jx-unconverted wp2jx-${placeholder.kind}`,
    attributes: { "data-wp2jx": label },
    ...(Array.isArray(inner) && inner.length > 0
      ? { children: inner }
      : { textContent: literalText(text) }),
  };
}

function defaultResolvers(
  site: SiteContext,
  tags: ReadonlySet<string>,
  say: (entry: Omit<ReportEntry, "where">) => void,
): ResolverMap {
  const neutral = (
    placeholder: Placeholder,
    label: string,
    text: string,
    what: string,
  ): JxElement => {
    say({
      severity: "warn",
      code: "component.placeholder-neutral",
      message: `${what}; a visible neutral element holds its text where it stood.`,
      data: {
        kind: placeholder.kind,
        ...(placeholder.block === undefined ? {} : { block: placeholder.block }),
      },
    });
    return neutralElement(placeholder, label, text);
  };
  return {
    "template-part": (placeholder) => {
      const slug = placeholder.attrs.slug;
      if (slug === undefined || slug === "") return undefined;
      const tag = partTag(site, slug);
      if (!tags.has(tag)) return undefined;
      const className = placeholder.element.className;
      return {
        tagName: tag,
        ...(typeof className === "string" && className !== "" ? { className } : {}),
      };
    },
    shortcode: (placeholder) => {
      const name = placeholder.attrs["data-shortcode"] ?? "";
      const form = fluentFormFor(site, placeholder, say);
      if (form !== undefined) return form;
      return neutral(
        placeholder,
        `shortcode:${name}`,
        placeholder.attrs["data-source"] ?? `[${name}]`,
        `The shortcode [${name}] has no static form`,
      );
    },
    block: (placeholder) => {
      const block = placeholder.block ?? "unknown";
      const form = fluentFormFor(site, placeholder, say);
      if (form !== undefined) return form;
      return neutral(
        placeholder,
        `block:${block}`,
        `[${block}]`,
        `The block ${block} saved no markup and has no converter`,
      );
    },
    search: (placeholder) =>
      neutral(
        placeholder,
        "search",
        "[search]",
        "WordPress's search runs on the server and the migrated site has none",
      ),
  };
}

// ── Properties ───────────────────────────────────────────────────────────────────────────────────

/** One property as the `properties` meta declares it, with the key and type `componentInfos` read from it. */
interface PropMeta {
  id: string;
  key: string;
  name: string;
  type: string;
  /** The definition as stored (`default`, `options`, `isDynamic`, `includeInCSS`…). */
  raw: Rec;
}

function propMetas(site: Pick<SiteContext, "model">, info: ComponentInfo): PropMeta[] {
  const stored = firstMeta(site, info.postId, "properties");
  const defs = isRec(stored) ? stored : {};
  return info.props.map((p) => {
    const def = defs[p.id];
    return { id: p.id, key: p.key, name: p.name, type: p.type, raw: isRec(def) ? def : {} };
  });
}

/** The types whose value is HTML. */
const RICH_TYPES = new Set(["richtext", "wysiwyg", "content", "html", "list"]);

/** The types the plugin writes as a `--comp-<id>` custom property on the instance. */
const CSS_TYPES = new Set(["color", "number", "cssText", "options"]);

/** The types the plugin reads in `block_conditions_check` (a component's visibility and conditions), which nothing here carries. */
const UNSUPPORTED_TYPES = new Set(["visibility", "conditions"]);

/** Every type the plugin's property editor offers, and the ones older exports carry. */
const KNOWN_TYPES = new Set([
  "text",
  "richtext",
  "list",
  "link",
  "image",
  "gallery",
  "video",
  "icon",
  "color",
  "toggle",
  "boolean",
  "number",
  "class",
  "id",
  "options",
  "conditions",
  "visibility",
  "cssText",
  ...RICH_TYPES,
]);

/** The text a stored default or value holds: the string itself, or the outer `maker` the plugin reads, else the editor's `content`. */
function makerText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (!isRec(value)) return undefined;
  if (typeof value.maker === "string") return value.maker;
  if (typeof value.content === "string") return value.content;
  return isRec(value.content) && typeof value.content.content === "string"
    ? value.content.content
    : undefined;
}

/** PHP truthiness of a stored value: `""`, `"0"`, `0`, `false`, empty and absent are not set. */
const phpTruthy = (v: unknown): boolean =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === "" ||
    v === "0" ||
    v === 0 ||
    (Array.isArray(v) && v.length === 0) ||
    (isRec(v) && Object.keys(v).length === 0)
  );

const ADDRESS = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i;
const MEDIA_FILE = /^\/media\/[^?#]*\.[a-z0-9]{2,5}(?:[?#].*)?$/i;

/** An address as the Jx site has it; anything that is not an address (a fragment, `tel:`, a binding) is as it was. */
function address(ctx: ConvertCtx, value: string): string {
  const v = value.trim();
  return ADDRESS.test(v) && !MEDIA_FILE.test(v) && !v.includes("${") ? ctx.rewriteUrl(v) : value;
}

/** `wptexturize` of a text that may hold bindings: each binding is held out of the way. */
function texturizeText(value: string): string {
  if (/[‘’“”′″]/.test(value)) return value;
  if (!value.includes("${")) return texturize(value);
  let out = "";
  let at = 0;
  for (;;) {
    const start = value.indexOf("${", at);
    if (start < 0) break;
    let level = 0;
    let end = value.length;
    for (let i = start + 1; i < value.length; i++) {
      if (value[i] === "{") level++;
      else if (value[i] === "}" && --level === 0) {
        end = i + 1;
        break;
      }
    }
    out += texturize(value.slice(at, start)) + value.slice(start, end);
    at = end;
  }
  return out + texturize(value.slice(at));
}

/** The SVG of an icon (`{viewBox, paths: [null, {d}]}`) for a default that kept no `unicode`. */
function iconMarkup(icon: unknown): string | undefined {
  if (!isRec(icon)) return undefined;
  const viewBox = str(icon.viewBox);
  const paths = (Array.isArray(icon.paths) ? icon.paths : []).filter(isRec);
  const parts: string[] = [];
  const escape = (v: string): string => v.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  for (const path of paths) {
    const attrs = Object.entries(path)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .map(([k, v]) => `${k}="${escape(String(v))}"`)
      .join(" ");
    if (attrs !== "") parts.push(`<path ${attrs}></path>`);
  }
  if (viewBox === undefined || parts.length === 0) return undefined;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${escape(viewBox)}">${parts.join("")}</svg>`;
}

/** Where a default's own findings go (the caller locates them at the component). */
type Say = (entry: Omit<ReportEntry, "where">) => void;

/** The classes a `class` property's value names: the authored ones, then the global classes' names (a dangling id prints nothing, as on the live site, and is reported). */
function classList(ctx: ConvertCtx, value: unknown, meta?: PropMeta, say?: Say): string {
  if (typeof value === "string") return value;
  if (!isRec(value)) return "";
  const own = rows(value.additionalClass)
    .map((c) => str(c.value))
    .filter((c): c is string => c !== undefined);
  const globals: string[] = [];
  for (const id of Array.isArray(value.globalClass) ? value.globalClass : []) {
    if (typeof id !== "string") continue;
    const name = ctx.cwicly.globalClassNames.get(id);
    if (name !== undefined) {
      globals.push(name);
      continue;
    }
    say?.({
      severity: "warn",
      code: "class.dangling-global",
      message: `The global class ${id} named by the default of the property ${meta?.name || meta?.id || "(unnamed)"} no longer exists; the live page prints no class for it.`,
      data: { globalClass: id, ...(meta === undefined ? {} : { prop: meta.id }) },
    });
  }
  return [...own, ...globals].join(" ");
}

/** The image a stored image value (or default) names: the attachment's file, else the address it holds. */
function imageValue(
  ctx: ConvertCtx,
  raw: unknown,
): { src: string; alt: string; width?: number; height?: number } {
  const r = isRec(raw) ? raw : {};
  const inner = isRec(r.image) ? r.image : r;
  const id = Number(inner.imageID ?? r.imageID);
  const media = Number.isInteger(id) && id > 0 ? ctx.mediaFor(id) : undefined;
  const sized = (m: {
    src: string;
    alt?: string | undefined;
    width?: number | undefined;
    height?: number | undefined;
  }) => ({
    src: m.src,
    alt: m.alt ?? "",
    ...(m.width === undefined ? {} : { width: m.width }),
    ...(m.height === undefined ? {} : { height: m.height }),
  });
  if (media) return sized(media);
  const maker = isRec(r.maker) ? r.maker : {};
  const src = str(maker.src) ?? str(inner.imageURL) ?? str(r.imageURL);
  if (src === undefined) return { src: "", alt: "" };
  const resolved = resolveTokens(src, ctx, undefined, { where: "attribute" });
  const byUrl = ctx.mediaForUrl(resolved);
  return byUrl ? sized(byUrl) : { src: address(ctx, resolved), alt: "" };
}

/** The link a stored link value (or default) holds. */
function linkValue(
  ctx: ConvertCtx,
  raw: unknown,
): { href: string; target?: string; rel?: string; title?: string } {
  const r = isRec(raw) ? raw : {};
  const maker = isRec(r.maker) ? r.maker : {};
  const href =
    str(maker.href) ??
    str(isRec(r.link) ? r.link.linkWrapperUrl : undefined) ??
    (typeof raw === "string" ? raw : undefined);
  if (href === undefined) return { href: "" };
  const target = str(maker.target);
  const rel = str(maker.rel);
  const title = str(maker.title);
  return {
    href: address(ctx, resolveTokens(href, ctx, undefined, { where: "attribute" })),
    ...(target === undefined || target === "_self" ? {} : { target }),
    ...(rel === undefined ? {} : { rel }),
    ...(title === undefined ? {} : { title }),
  };
}

/** The value of a palette-aware text: a colour may be `!var=<id>!`. */
function colourText(ctx: ConvertCtx, value: string): { text: string; unresolved: string[] } {
  return resolvePaletteRefs(value, ctx.cwicly.globalStyles.colorRefs);
}

/** Move the addresses of a markup string to where the Jx site has them (what an instance's richtext value goes through). */
const rewriteMarkup = (ctx: ConvertCtx, html: string): string =>
  html.replaceAll(
    /\b(href|src)=("([^"]*)"|'([^']*)')/g,
    (whole, attr: string, quoted: string, d?: string, single?: string) => {
      const value = d ?? single ?? "";
      const moved = address(ctx, value);
      if (moved === value) return whole;
      const quote = quoted.startsWith('"') ? '"' : "'";
      return `${attr}=${quote}${moved}${quote}`;
    },
  );

/**
 * The `state` default of a property: what the plugin prints for an instance that gives no value
 * (`get_component_value`), in the shape an instance's `$props` has (see the module header).
 */
export function stateDefault(ctx: ConvertCtx, meta: PropMeta, say?: Say): unknown {
  const raw = meta.raw.default;
  const type = meta.type;
  switch (type) {
    case "link":
      return linkValue(ctx, raw);
    case "image":
      return imageValue(ctx, raw);
    case "icon": {
      const icon = isRec(raw) && isRec(raw.icon) ? raw.icon : undefined;
      return str(icon?.unicode) ?? iconMarkup(icon?.icon) ?? "";
    }
    case "class":
      return classList(ctx, raw, meta, say);
    case "toggle":
    case "boolean":
      return raw === true || raw === "true" || raw === 1 || raw === "1";
    case "number": {
      const t = makerText(raw);
      if (t === undefined || t.trim() === "") return "";
      return Number.isFinite(Number(t)) ? Number(t) : t;
    }
    case "color": {
      const t = makerText(raw);
      if (t === undefined) return "";
      const { text, unresolved } = colourText(ctx, t);
      if (unresolved.length === 0) return text;
      // A reference the palette does not have is the artefact docs/design.md says to report and never emit.
      const ids = [...new Set(unresolved)];
      say?.({
        severity: "warn",
        code: "component.palette-unresolved",
        message: `The default of the property ${meta.name || meta.id} names the palette colour ${ids.join(", ")}, which the site's palette does not have: it is left out of the default.`,
        data: { prop: meta.id, ids },
      });
      let kept = text;
      for (const id of ids) kept = kept.replaceAll(`!var=${id}!`, "");
      return kept.replaceAll(/\s{2,}/g, " ").trim();
    }
    case "options": {
      const id = makerText(raw);
      if (id === undefined) return "";
      // `get_component_value` hands a dynamic property's default over as it is, and every other one is
      // looked up: an id no option has is an empty value (and the editor writes no `--comp-` for it).
      if (phpTruthy(meta.raw.isDynamic))
        return resolveTokens(id, ctx, undefined, { where: "text" });
      const chosen = rows(meta.raw.options).find((o) => str(o.id) === id);
      if (chosen === undefined) {
        say?.({
          severity: "info",
          code: "component.option-unmatched",
          message: `The default of the property ${meta.name || meta.id} is the option ${id}, which the property no longer has: the plugin prints an empty value for it, and so does the component.`,
          data: { prop: meta.id, option: id },
        });
        return "";
      }
      return str(chosen.value) ?? "";
    }
    case "gallery":
      return [];
    default:
      break;
  }
  const t = makerText(raw);
  if (t === undefined || !phpTruthy(raw)) return "";
  if (RICH_TYPES.has(type)) {
    return rewriteMarkup(ctx, resolveTokens(t, ctx, undefined, { where: "html" }));
  }
  return texturizeText(resolveTokens(t, ctx, undefined, { where: "text" }));
}

/** Whether a stored definition asks for its value to reach the CSS (`includeInCSS` is the plugin's own switch for an icon). */
const feedsCss = (meta: PropMeta): boolean =>
  CSS_TYPES.has(meta.type) || (meta.type === "icon" && meta.raw.includeInCSS === true);

/**
 * The custom property the plugin writes for a property id, spelled so that Jx writes the same name
 * wherever it resolves a host style: a nested instance's resolved style is an inline `style`
 * attribute whose names go through camelCase-to-kebab, which turns `--comp-pCol01` into
 * `--comp-p-col01` (property ids are mixed case), while a page-level instance's is written as it
 * stands. Spelled lower-case already, the name survives both, and the body's `var(--comp-pCol01)` is
 * rewritten to it.
 */
export const compVariable = (id: string): string =>
  `--comp-${id.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** `value` with every `var(--comp-<id>` of the given ids spelled {@link compVariable}, in a copy (strings of nested objects too). */
function renameCompVariables<T>(value: T, ids: readonly string[]): T {
  const changed = ids.filter((id) => compVariable(id) !== `--comp-${id}`);
  if (changed.length === 0) return value;
  const rename = (text: string): string => {
    let out = text;
    for (const id of changed) {
      out = out.replaceAll(
        new RegExp(`--comp-${escapeRegExp(id)}(?![\\w-])`, "g"),
        compVariable(id),
      );
    }
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return rename(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isRec(v))
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner)]));
    return v;
  };
  return walk(value) as T;
}

/** The host `style` entries that carry the properties the plugin feeds into CSS as `--comp-<id>`. */
function cssVariables(metas: readonly PropMeta[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const meta of metas) {
    if (!feedsCss(meta)) continue;
    const read = `state.${meta.key}`;
    // `||` would turn a number's 0 into `initial`, where the plugin writes `--comp-<id>: 0`.
    out[compVariable(meta.id)] =
      meta.type === "icon"
        ? `\${${read} ? "url('data:image/svg+xml;charset=utf8," + encodeURIComponent(${read}).replaceAll("'", "%27") + "')" : 'initial'}`
        : meta.type === "number"
          ? `\${${read} === '' || ${read} == null ? 'initial' : ${read}}`
          : `\${${read} || 'initial'}`;
  }
  return out;
}

// ── Walking and rewriting trees ──────────────────────────────────────────────────────────────────

/**
 * The nodes without the elements `drop` names (and what is inside them), in a copy. A repeater whose
 * template is dropped loses its children.
 */
function dropElements(nodes: readonly JxNode[], drop: (element: JxElement) => boolean): JxNode[] {
  const out: JxNode[] = [];
  for (const node of nodes) {
    if (typeof node === "string") {
      out.push(node);
      continue;
    }
    if (drop(node)) continue;
    const next: Rec = { ...node };
    const { children } = node;
    if (Array.isArray(children)) {
      next.children = dropElements(children, drop);
    } else if (isRec(children) && isRec(children.map)) {
      const [kept] = dropElements([children.map as JxNode], drop);
      if (kept === undefined) delete next.children;
      else next.children = { ...children, map: kept };
    }
    out.push(next as JxElement);
  }
  return out;
}

/** Every string of a tree (values, not keys), for the scans that read bindings. */
function* stringsOf(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* stringsOf(item);
  else if (isRec(value)) for (const inner of Object.values(value)) yield* stringsOf(inner);
}

/** A string cut into its `${…}` bindings and the literal text between them, braces counted the way the build finds the end (without reading string literals). */
function splitBindings(text: string): { binding: boolean; text: string }[] {
  const parts: { binding: boolean; text: string }[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("${", from);
    if (start < 0) break;
    let level = 0;
    let end = text.length;
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === "{") level++;
      else if (text[i] === "}" && --level === 0) {
        end = i + 1;
        break;
      }
    }
    if (start > from) parts.push({ binding: false, text: text.slice(from, start) });
    parts.push({ binding: true, text: text.slice(start, end) });
    from = end;
  }
  if (from < text.length) parts.push({ binding: false, text: text.slice(from) });
  return parts;
}

/** The text of every `${…}` in a string. */
const bindingTexts = (text: string): string[] =>
  splitBindings(text)
    .filter((part) => part.binding)
    .map((part) => part.text);

const STATE_READ = /\bstate(?:\??\.([A-Za-z_$][\w$]*)|\[\s*(?:"([^"]+)"|'([^']+)')\s*\])/g;

/** The state keys the bindings in a tree read (`state.x`, `state?.x`, `state["x"]`). */
function stateReads(value: unknown): Set<string> {
  const keys = new Set<string>();
  for (const text of stringsOf(value)) {
    if (!text.includes("${")) continue;
    for (const binding of bindingTexts(text)) {
      for (const m of binding.matchAll(STATE_READ)) keys.add(m[1] ?? m[2] ?? m[3] ?? "");
    }
  }
  return keys;
}

/** The state keys a tree points at with a JSON pointer (`{"$ref": "#/state/<key>…"}`). */
function statePointers(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) statePointers(item, into);
    return;
  }
  if (!isRec(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === "$ref" && typeof inner === "string") {
      const m = /^#\/state\/([^/]+)/.exec(inner);
      if (m) {
        let name = m[1]!;
        try {
          name = decodeURIComponent(name);
        } catch {
          // A stray `%` is not an escape; the pointer names the key as written.
        }
        into.add(name.replaceAll("~1", "/").replaceAll("~0", "~"));
      }
    } else statePointers(inner, into);
  }
}

// ── Reading a property the way the plugin prints it ──────────────────────────────────────────────

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The state keys one binding reads. */
const readsOf = (binding: string): Set<string> =>
  new Set([...binding.matchAll(STATE_READ)].map((m) => m[1] ?? m[2] ?? m[3] ?? ""));

/**
 * The nodes with every element whose text is made of bindings of the given properties written as
 * `innerHTML` and not `textContent`, in a copy. The plugin prints a property's value into the page
 * raw (a `text` property holding `Increased <br>Value` is a line break on the live page), and
 * `textContent` is HTML-escaped by the emitter, so the tags would show. The literal text around the
 * bindings is escaped to stay what it was; an element that also reads anything else is left alone.
 */
export function bindMarkupAsHtml(nodes: readonly JxNode[], keys: ReadonlySet<string>): JxNode[] {
  const copy = structuredClone([...nodes]);
  for (const element of walkElements(copy)) {
    const text = element.textContent;
    if (typeof text !== "string" || !text.includes("${") || element.innerHTML !== undefined)
      continue;
    const parts = splitBindings(text);
    const reads = parts.filter((part) => part.binding).map((part) => readsOf(part.text));
    if (
      reads.length === 0 ||
      reads.some((set) => set.size === 0 || [...set].some((k) => !keys.has(k)))
    ) {
      continue;
    }
    element.innerHTML = parts
      .map((part) => (part.binding ? part.text : escapeHtml(part.text)))
      .join("");
    delete element.textContent;
  }
  return copy;
}

/** The same test the toggle default is made with: an instance's value is `true`, `"true"`, `1` or `"1"`. */
const toggleOn = (read: string): string =>
  `(${read} === true || ${read} === 'true' || ${read} === 1 || ${read} === '1')`;

const STATE_READ_AT =
  /(?<![\w$.])state(?:\??\.([A-Za-z_$][\w$]*)|\[\s*(?:"([^"]+)"|'([^']+)')\s*\])/g;

/**
 * The nodes with every read of a toggle property inside a binding written as the test that decides
 * whether it is on, in a copy. A toggle's default is a boolean, and an instance's value is the string
 * `"false"` or `"true"` (the converter writes what the block stored), which `state.open ? a : b`
 * reads as on in both cases.
 */
export function normaliseToggleReads(
  nodes: readonly JxNode[],
  keys: ReadonlySet<string>,
): JxNode[] {
  const rewrite = (text: string): string =>
    splitBindings(text)
      .map((part) =>
        part.binding
          ? part.text.replaceAll(STATE_READ_AT, (whole, a?: string, b?: string, c?: string) => {
              const key = a ?? b ?? c ?? "";
              return keys.has(key) ? toggleOn(whole) : whole;
            })
          : part.text,
      )
      .join("");
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return value.includes("${") ? rewrite(value) : value;
    if (Array.isArray(value)) return value.map(walk);
    if (isRec(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, inner]) => [k, walk(inner)]));
    }
    return value;
  };
  return keys.size === 0 ? [...nodes] : (walk(nodes) as JxNode[]);
}

// ── Bindings in the wrong place ──────────────────────────────────────────────────────────────────

/** Top-level properties the static emitter writes but also binds on the client, which ships JavaScript. */
const UNBOUND_PROPS = ["hidden", "title", "tabIndex", "lang", "dir"] as const;

/** Values inside a nested style block (`:hover`, `& a`, `@--md`), where a binding is silently lost. */
function nestedStyleBinding(style: unknown, nested: boolean): boolean {
  if (!isRec(style)) return nested && hasBinding(style);
  return Object.values(style).some((value) =>
    isRec(value) ? nestedStyleBinding(value, true) : nested && hasBinding(value),
  );
}

export interface MisplacedBinding {
  /** Where: `children/2/children/0`. */
  path: string;
  /** Which position (docs/bindings.md rule 5): `className`, `id`, `children`, `style`, `hidden`… */
  position: string;
}

export interface MisplacedOptions {
  /**
   * The document is a component definition, whose body is rendered once per instance: there a
   * `className` or an `id` that holds a binding is resolved for each instance (measured, a plain page
   * and an entry's component alike), and only a binding in the FIRST class (the scope an element's own
   * style is written to) or in the `id` of a styled element ends up as a CSS selector.
   */
  perInstance?: boolean;
}

const firstWord = (value: unknown): string =>
  typeof value === "string" ? (value.trim().split(/\s+/)[0] ?? "") : "";

/**
 * The places in a finished component where a `${` is never evaluated, or is evaluated twice
 * (docs/bindings.md, rule 5): `className` and `id`, the top-level `hidden`/`title`/`tabIndex`/`lang`/`dir`,
 * a text child in `children`, and a nested style block. The host's own flat `style` values are bindings
 * Jx resolves per instance, and are fine. See {@link MisplacedOptions.perInstance} for what a
 * component's body may bind that a page's may not.
 */
export function misplacedBindings(
  doc: JxDocument,
  opts: MisplacedOptions = {},
): MisplacedBinding[] {
  const found: MisplacedBinding[] = [];
  const styled = (node: JxElement): boolean =>
    isRec(node.style) && Object.keys(node.style).length > 0;
  const visit = (node: JxNode, path: string): void => {
    if (typeof node === "string") return;
    const flag = (position: string, at = path): void => void found.push({ path: at, position });
    if (hasBinding(opts.perInstance === true ? firstWord(node.className) : node.className)) {
      flag("className");
    }
    if (hasBinding(node.id) && (opts.perInstance !== true || styled(node))) flag("id");
    for (const prop of UNBOUND_PROPS) {
      if (hasBinding((node as Rec)[prop])) flag(prop);
    }
    if (nestedStyleBinding(node.style, false)) flag("style");
    const here = path === "" ? "" : `${path}/`;
    if (Array.isArray(node.children)) {
      node.children.forEach((child, i) => {
        if (typeof child === "string") {
          if (hasBinding(child)) flag("children", `${here}children/${i}`);
        } else visit(child, `${here}children/${i}`);
      });
    }
    const listed = Array.isArray(node.children) ? node.children : [];
    childNodes(node)
      .filter((child) => !listed.includes(child))
      .forEach((child, i) => visit(child, `${here}map/${i}`));
  };
  if (Array.isArray(doc.children)) {
    doc.children.forEach((child, i) => {
      if (typeof child === "string") {
        if (hasBinding(child)) found.push({ path: `children/${i}`, position: "children" });
      } else visit(child, `children/${i}`);
    });
  }
  if (nestedStyleBinding(doc.style, false)) found.push({ path: "style", position: "style" });
  return found;
}

// ── One document ─────────────────────────────────────────────────────────────────────────────────

export interface DocumentOptions {
  /** The custom element's tag (`site.ts`: `componentInfos`, `partTag`, `reusableTag`). */
  tagName: string;
  /** The file the document will be written at, which relative `$ref`s are measured from. Default `components/<tagName>.json`. */
  file?: string;
  /** What the conversion is told (`mode`, `target`, `entryType`…); a component is converted as `component` by its kind. */
  subject?: SubjectOptions;
  /** Declared inputs: the state defaults of the component's properties. A conversion's own state entries are added; a key both name is `component.state-collision`. */
  state?: Record<string, unknown>;
  /** The host's own style (what Jx writes under the component's tag). Default `{display: "contents"}`; `false` for none. */
  hostStyle?: Rec | false;
  /** Further host style entries (the `--comp-` custom properties), written after `hostStyle`. */
  hostBindings?: Record<string, string>;
  /** The element's `description` (what it is, for a person reading the file or Studio's panel). */
  description?: string;
  /** Resolvers for the placeholders in the body, over the defaults. */
  resolvers?: ResolverMap;
  /** The conversion; a seam for tests. Default `convertSubject`. */
  convert?: ConvertFn;
  /** Where findings go (they are located at the subject). Default: a fresh report. */
  report?: Report;
  /** The tags the emitters write for this site; default `siteTags(site)`. */
  tags?: ReadonlySet<string>;
}

/** A converted subject, placeholders replaced and variants switched, before it is a document. */
export interface PreparedDocument {
  subject: Subject;
  tagName: string;
  file: string;
  /** The finished body. */
  nodes: JxNode[];
  converted: Converted;
  /** The variant ids the body has rules for, with how many rules. */
  variants: Map<string, number>;
  /** The tags (of the site's components, parts and reusable blocks) the body instantiates, sorted. */
  instantiated: string[];
  report: Report;
  where: string;
}

export interface BuiltDocument {
  doc: JxDocument;
  /** The file text: the document as JSON, two-space indent, a trailing newline. */
  content: string;
  file: string;
  prepared: PreparedDocument;
  /** The classes, state keys and rules the document uses (see {@link ComponentsUsed}). */
  used: ComponentsUsed;
  /** How many `<slot>` elements the body has. */
  slots: number;
}

const instancesIn = (nodes: readonly JxNode[], tags: ReadonlySet<string>): string[] => {
  const found = new Set<string>();
  for (const element of walkElements(nodes)) {
    const tag = element.tagName as string | undefined;
    if (tag !== undefined && tags.has(tag)) found.add(tag);
  }
  return [...found].sort();
};

/**
 * Convert a subject and put the result in the form a document's body takes: its placeholders
 * replaced (module header, 1) and its variant keys moved to the host's class (see Variants).
 */
export async function prepareDocument(
  site: SiteContext,
  subject: Subject,
  opts: DocumentOptions,
): Promise<PreparedDocument> {
  const report = opts.report ?? createReport();
  const where = subjectWhere(site, subject);
  const convert = opts.convert ?? convertSubject;
  const tags = opts.tags ?? siteTags(site);
  const converted = await convert(site, subject, opts.subject);
  for (const entry of converted.report.entries()) report.add(entry);

  const say = (entry: Omit<ReportEntry, "where">): void => report.add({ ...entry, where });
  const replaced = replacePlaceholders(
    converted.nodes,
    { ...defaultResolvers(site, tags, say), ...opts.resolvers },
    { report, where },
  );
  const switched = switchVariants(replaced);
  return {
    subject,
    tagName: opts.tagName,
    file: opts.file ?? componentFile(opts.tagName),
    nodes: switched.nodes,
    converted,
    variants: switched.variants,
    instantiated: instancesIn(switched.nodes, tags),
    report,
    where,
  };
}

/**
 * The document of a prepared body: `$elements`, `state` and the host's `style` (module header, 3 to
 * 5), checked for bindings that read state nobody declared and for the positions the build never
 * evaluates.
 */
export function finishDocument(
  prepared: PreparedDocument,
  opts: Pick<DocumentOptions, "state" | "hostStyle" | "hostBindings" | "description">,
): BuiltDocument {
  const { converted, nodes, report, where, tagName, file } = prepared;
  const say = (entry: Omit<ReportEntry, "where">): void => report.add({ ...entry, where });

  const elements = prepared.instantiated
    .filter((tag) => tag !== tagName)
    .map((tag) => ({ $ref: relativeRef(file, componentFile(tag)) }));

  // State: the declared inputs, then what the conversion registered.
  const state: Record<string, unknown> = { ...opts.state };
  for (const [key, definition] of Object.entries(converted.state)) {
    if (Object.hasOwn(state, key)) {
      say({
        severity: "error",
        code: "component.state-collision",
        message: `The conversion registered the state entry "${key}", which is also the key of a property; the property's is kept.`,
        data: { key },
      });
      continue;
    }
    state[key] = definition;
  }

  // Style: the host, its custom properties, the rules no element's style could hold.
  const hoisted = dedupeRules(converted.hoisted);
  const placed = hoistedStyle(hoisted);
  for (const rule of placed.unplaced) {
    say({
      severity: "info",
      code: "component.hoisted-unplaced",
      message: `The rule ${rule.selector} is about the document itself, which a component's style cannot reach; it is returned in used.documentRules for the project's style, which takes unscoped selectors.`,
      data: { selector: rule.selector },
    });
  }
  for (const key of placed.collisions) {
    say({
      severity: "warn",
      code: "component.hoisted-collision",
      message: `Two rules define ${key} differently, and an at-rule of that name has one definition; the later one is kept.`,
      data: { key },
    });
  }
  const style: Rec = {};
  if (opts.hostStyle !== false) Object.assign(style, opts.hostStyle ?? { display: "contents" });
  Object.assign(style, opts.hostBindings);
  mergeStyle(style, placed.style as Rec);

  const doc: Rec = { tagName };
  if (opts.description !== undefined && opts.description !== "") doc.description = opts.description;
  if (elements.length > 0) doc.$elements = elements;
  if (Object.keys(state).length > 0) doc.state = state;
  if (Object.keys(style).length > 0) doc.style = style;
  doc.children = nodes;

  // Pointers and reads must find their state.
  const wanted = new Set<string>(converted.used.states);
  statePointers(nodes, wanted);
  for (const key of [...wanted].sort()) {
    if (Object.hasOwn(state, key)) continue;
    say({
      severity: "error",
      code: "component.state-missing",
      message: `The component points at the state entry "${key}" and no conversion registered it.`,
      data: { key },
    });
  }
  for (const key of [...stateReads([nodes, style])].sort()) {
    if (Object.hasOwn(state, key)) continue;
    say({
      severity: "error",
      code: "component.state-undeclared",
      message: `A binding reads state.${key}, which the component does not declare (no property of that key), so it prints nothing.`,
      data: { key },
    });
  }
  for (const found of misplacedBindings(doc as unknown as JxDocument, { perInstance: true })) {
    say({
      severity: "error",
      code: "component.binding-misplaced",
      message: `A \${…} sits in ${found.position} (${found.path || "the component"}), where the build never evaluates it.`,
      data: { ...found },
    });
  }

  let slots = 0;
  for (const element of walkElements(nodes)) if (element.tagName === "slot") slots++;
  if (slots > 1) {
    say({
      severity: "warn",
      code: "component.slot-multiple",
      message: `The body has ${slots} slots; Jx fills the first and, in a prerendered page, copies the instance's children into every one. Only a single default slot is reliable.`,
      data: { slots },
    });
  }

  return {
    doc: doc as unknown as JxDocument,
    content: `${JSON.stringify(doc, null, 2)}\n`,
    file,
    prepared,
    slots,
    used: {
      components: new Set(prepared.instantiated.filter((tag) => tag !== tagName)),
      wpClasses: collectWpClasses(nodes),
      hoisted: hoisted.filter((rule) => !placed.unplaced.includes(rule)),
      documentRules: placed.unplaced,
      states: wanted,
    },
  };
}

/**
 * One subject as a custom-element document: {@link prepareDocument} then {@link finishDocument}. The
 * path template parts and reusable blocks take (`emit/templates.ts`): their own `tagName`, their own
 * `subject` options, no declared state.
 */
export async function buildComponentDocument(
  site: SiteContext,
  subject: Subject,
  opts: DocumentOptions,
): Promise<BuiltDocument> {
  return finishDocument(await prepareDocument(site, subject, opts), opts);
}

// ── Lists a component cannot hold, instances that disagree ───────────────────────────────────────

/**
 * A query's list is a computed `children` string (`${[...state.x_entries].filter(…).map(…)}`) that
 * the build evaluates in a page or an entry. Inside a component it is never evaluated for an
 * instance, and the page prints the expression. The string children that read a collection the
 * conversion registered are left out of the body (the container stays, empty), the collection is no
 * longer declared when nothing else reads it, and the loss is reported.
 */
function withoutQueryLists(prepared: PreparedDocument, say: Say): void {
  const collections = new Set(
    Object.entries(prepared.converted.state)
      .filter(
        ([, definition]) => isRec(definition) && definition.$prototype === "ContentCollection",
      )
      .map(([key]) => key),
  );
  if (collections.size === 0) return;
  const dropped = new Set<string>();
  for (const element of walkElements(prepared.nodes)) {
    if (!Array.isArray(element.children)) continue;
    const kept = element.children.filter((child) => {
      if (typeof child !== "string") return true;
      const parts = splitBindings(child);
      if (parts.length !== 1 || !parts[0]!.binding) return true;
      const hit = [...readsOf(child)].filter((key) => collections.has(key));
      for (const key of hit) dropped.add(key);
      return hit.length === 0;
    });
    if (kept.length === element.children.length) continue;
    if (kept.length === 0) delete element.children;
    else element.children = kept;
  }
  if (dropped.size === 0) return;
  const stillRead = new Set<string>(stateReads(prepared.nodes));
  statePointers(prepared.nodes, stillRead);
  const state = Object.fromEntries(
    Object.entries(prepared.converted.state).filter(
      ([key]) => !dropped.has(key) || stillRead.has(key),
    ),
  );
  prepared.converted = {
    ...prepared.converted,
    state,
    used: {
      ...prepared.converted.used,
      states: new Set([...prepared.converted.used.states].filter((key) => key in state)),
    },
  };
  say({
    severity: "warn",
    code: "component.query-unsupported",
    message: `The component holds a query block. Its list is a computed expression that a component's body never evaluates for an instance (the page would print the expression as text), so the list is left out and its container is empty. A query belongs on the page or the entry that uses it.`,
    data: { states: [...dropped].sort() },
  });
}

/** The `properties` each page-level instance of each component gives (posts and templates: an instance in a component is nested, and resolved inline). */
function scanInstances(site: SiteContext): Map<string, Rec[]> {
  const found = new Map<string, Rec[]>();
  for (const subject of allSubjects(site)) {
    if (subject.kind !== "post" && subject.kind !== "template") continue;
    walkBlocks(subjectBlocks(site, subject), (block) => {
      if (block.name !== "cwicly/component" || typeof block.attrs.ref !== "string") return;
      const list = found.get(block.attrs.ref) ?? [];
      list.push(isRec(block.attrs.properties) ? block.attrs.properties : {});
      found.set(block.attrs.ref, list);
    });
  }
  return found;
}

/** How many instances there are and which of the given properties they do not all give the same value for. */
function instanceSpread(
  instances: readonly Rec[],
  ids: readonly string[],
): { instances: number; differing: string[] } {
  const differing = ids.filter((id) => {
    const values = new Set(
      instances.map((given) => {
        const own = given[id];
        return JSON.stringify(isRec(own) ? (own.value ?? null) : null);
      }),
    );
    return values.size > 1;
  });
  return { instances: instances.length, differing };
}

// ── Cycles and scopes ────────────────────────────────────────────────────────────────────────────

/**
 * The instances that close a cycle among the components, found by a depth-first walk in tag order: an
 * edge to a component still on the walk's stack is the one to cut. Cwicly prints nothing for a
 * component inside itself (`$seen_refs`), and Jx refuses a definition that renders itself.
 */
function cycleEdges(
  graph: ReadonlyMap<string, readonly string[]>,
): { from: string; to: string; chain: string[] }[] {
  const cut: { from: string; to: string; chain: string[] }[] = [];
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (tag: string): void => {
    state.set(tag, "open");
    stack.push(tag);
    for (const next of graph.get(tag) ?? []) {
      if (!graph.has(next)) continue;
      const seen = state.get(next);
      if (seen === "open")
        cut.push({ from: tag, to: next, chain: [...stack.slice(stack.indexOf(next)), next] });
      else if (seen === undefined) visit(next);
    }
    stack.pop();
    state.set(tag, "done");
  };
  for (const tag of [...graph.keys()].sort()) if (!state.has(tag)) visit(tag);
  return cut;
}

/** The first word of an element's `className`, when it is a plain class name. */
const firstClass = (element: JxElement): string | undefined => {
  const first =
    typeof element.className === "string" ? element.className.trim().split(/\s+/)[0] : undefined;
  return first === undefined || first === "" || first.includes("${") ? undefined : first;
};

/** The selectors the elements' own styles are written to, each with the styles written to it. */
function ownScopes(nodes: readonly JxNode[]): Map<string, string[]> {
  const scopes = new Map<string, string[]>();
  for (const element of walkElements(nodes)) {
    if (!isRec(element.style) || Object.keys(element.style).length === 0) continue;
    const id =
      typeof element.id === "string" && element.id !== "" && !hasBinding(element.id)
        ? element.id
        : undefined;
    const klass = firstClass(element);
    const scope = id !== undefined ? `#${id}` : klass === undefined ? undefined : `.${klass}`;
    if (scope === undefined) continue;
    const list = scopes.get(scope) ?? [];
    list.push(JSON.stringify(element.style));
    scopes.set(scope, list);
  }
  return scopes;
}

/** `from` written `to` wherever it is a class of an element or named in a style key, in place. */
function renameScope(doc: Rec, from: string, to: string): void {
  const inKey = new RegExp(`\\.${escapeRegExp(from)}(?![\\w-])`, "g");
  const renameKeys = (style: Rec): Rec => {
    const out: Rec = {};
    for (const [key, value] of Object.entries(style)) {
      out[key.replace(inKey, `.${to}`)] = isRec(value) ? renameKeys(value) : value;
    }
    return out;
  };
  const nodes = (doc.children ?? []) as JxNode[];
  for (const element of walkElements(nodes)) {
    if (typeof element.className === "string") {
      element.className = element.className
        .split(/(\s+)/)
        .map((word) => (word === from ? to : word))
        .join("");
    }
    if (isRec(element.style)) element.style = renameKeys(element.style) as JxStyle;
  }
  if (isRec(doc.style)) doc.style = renameKeys(doc.style);
}

// ── Building ─────────────────────────────────────────────────────────────────────────────────────

/** State keys that are also properties of an element: an instance's `$props` for one is read through a reflected accessor (spec.md §13.2). */
const REFLECTED_KEYS = new Set(["title", "role", "id", "lang", "dir", "slot", "hidden"]);

/** A string default that must not be read as a template: the literal `${` degraded, reported once. */
function plainDefault(value: unknown, onLiteral: () => void): unknown {
  if (typeof value !== "string" || !value.includes("${")) return value;
  onLiteral();
  return literalText(value);
}

interface Entry {
  info: ComponentInfo;
  metas: PropMeta[];
  state: Record<string, unknown>;
  hostBindings: Record<string, string>;
  prepared: PreparedDocument;
  title: string;
}

/**
 * Every `cc_block` of the site as a Jx component document; see the module header. Components are
 * converted one after another (a conversion shares process-wide state) in tag order, and the output
 * is sorted by file, so two runs over the same site write the same bytes. One component that cannot
 * be converted costs that component only (`component.convert-failed`).
 */
export async function buildComponents(
  site: SiteContext,
  opts: ComponentsOptions = {},
): Promise<ComponentsOutput> {
  const report = opts.report ?? createReport();
  const only = opts.only === undefined ? undefined : new Set(opts.only);
  const tags = siteTags(site);
  const infos = [...site.components.values()]
    .filter((info) => only === undefined || only.has(info.ref))
    .sort((a, b) => (a.tagName < b.tagName ? -1 : a.tagName > b.tagName ? 1 : 0));

  const skipped: ComponentSkip[] = [];
  const entries: Entry[] = [];
  // Only a component with a custom property its CSS reads needs the instances, so the pages are read once, when one does.
  let instanceIndex: Map<string, Rec[]> | undefined;
  const pageInstances = (): Map<string, Rec[]> => (instanceIndex ??= scanInstances(site));
  for (const info of infos) {
    const where = `component:${info.ref}`;
    const post = site.model.posts.get(info.postId);
    const title = decodeEntities(post?.title ?? info.tagName);
    try {
      if (post !== undefined && (post.status !== "publish" || post.passwordProtected)) {
        const why = [
          ...(post.status === "publish" ? [] : [`is ${post.status}`]),
          ...(post.passwordProtected ? ["is password protected"] : []),
        ].join(" and ");
        report.add({
          severity: "warn",
          code: "component.not-published",
          message: `The component "${title}" ${why}: the plugin prints nothing for its instances on the live site (it renders published, unprotected components only), but the file is written because the instances name it, so the converted page prints it where the live page does not. Publish the component, or take its instances out.`,
          where,
          data: { status: post.status, passwordProtected: post.passwordProtected },
        });
      }
      const subject: Subject = { kind: "component", ref: info.ref };
      const metas = propMetas(site, info);
      const ctx = await subjectCtx(site, subject, { report });
      const state: Record<string, unknown> = {};
      for (const meta of metas) {
        if (!KNOWN_TYPES.has(meta.type)) {
          report.add({
            severity: "info",
            code: "component.prop-type-unknown",
            message: `The property ${meta.name || meta.id} has the type "${meta.type}", which this tool does not know: its default is carried as a plain value.`,
            where,
            data: { prop: meta.id, type: meta.type },
          });
        }
        if (UNSUPPORTED_TYPES.has(meta.type)) {
          report.add({
            severity: "warn",
            code: "component.property-unsupported",
            message: `The property ${meta.name || meta.id} (${meta.type}) decides, per instance, whether the plugin prints a block at all; this tool binds nothing for it, so an instance that sets it is shown as if it had not.`,
            where,
            data: { prop: meta.id, key: meta.key, type: meta.type },
          });
        }
        let value = stateDefault(ctx, meta, (entry) => void report.add({ ...entry, where }));
        // The converters' tokens escape their own literals; the types read without them are escaped here.
        if (
          ![
            "text",
            "richtext",
            "list",
            "link",
            "image",
            "video",
            "id",
            "wysiwyg",
            "content",
            "html",
          ].includes(meta.type)
        ) {
          value = plainDefault(value, () =>
            report.add({
              severity: "warn",
              code: "component.literal-template",
              message: `The default of the property ${meta.name || meta.id} holds a literal dollar-brace, which would be read as a binding; it is written with a zero-width space between the two characters.`,
              where,
              data: { prop: meta.id },
            }),
          );
        }
        state[meta.key] = value;
        if (REFLECTED_KEYS.has(meta.key)) {
          report.add({
            severity: "info",
            code: "component.prop-reflected",
            message: `The property key "${meta.key}" is also a property every HTML element has: an instance's value reaches the component in a prerendered page, but a client-rendered instance reads it through the element's own accessor (spec.md §13.2).`,
            where,
            data: { prop: meta.id, key: meta.key },
          });
        }
      }
      const prepared = await prepareDocument(site, subject, {
        tagName: info.tagName,
        report,
        tags,
        ...(opts.resolvers === undefined ? {} : { resolvers: opts.resolvers }),
        ...(opts.convert === undefined ? {} : { convert: opts.convert }),
      });
      // The body reads `var(--comp-<id>)`; spelled the way a host style resolves (compVariable).
      const ids = metas.filter(feedsCss).map((meta) => meta.id);
      prepared.nodes = renameCompVariables(prepared.nodes, ids);
      // The plugin prints a property's value raw, and a toggle's value is a string on an instance.
      const keysOf = (...types: string[]): Set<string> =>
        new Set(metas.filter((m) => types.includes(m.type)).map((m) => m.key));
      prepared.nodes = bindMarkupAsHtml(prepared.nodes, keysOf("text", ...RICH_TYPES));
      prepared.nodes = normaliseToggleReads(prepared.nodes, keysOf("toggle", "boolean"));
      withoutQueryLists(prepared, (entry) => void report.add({ ...entry, where }));
      prepared.converted = {
        ...prepared.converted,
        hoisted: renameCompVariables(prepared.converted.hoisted, ids),
      };
      // Only the custom properties the body's rules read are worth a binding on the host.
      const read = JSON.stringify([prepared.nodes, prepared.converted.hoisted]);
      const hostBindings = Object.fromEntries(
        Object.entries(cssVariables(metas)).filter(([name]) => read.includes(name)),
      );
      entries.push({ info, metas, state, hostBindings, prepared, title });
    } catch (error) {
      skipped.push({
        ref: info.ref,
        code: "component.convert-failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      report.add({
        severity: "error",
        code: "component.convert-failed",
        message: `The component "${title}" could not be converted (${error instanceof Error ? error.message : String(error)}); it is not written.`,
        where,
      });
    }
  }

  // Components inside components: cut the instances that close a cycle.
  const graph = new Map(entries.map((e) => [e.info.tagName, e.prepared.instantiated] as const));
  const byName = new Map(entries.map((e) => [e.info.tagName, e] as const));
  for (const edge of cycleEdges(graph)) {
    const entry = byName.get(edge.from)!;
    entry.prepared.nodes = dropElements(entry.prepared.nodes, (el) => el.tagName === edge.to);
    entry.prepared.instantiated = instancesIn(entry.prepared.nodes, tags);
    report.add({
      severity: "warn",
      code: "component.cycle",
      message: `${edge.chain.join(" > ")}: a component that contains itself (Cwicly prints nothing for the inner one, and Jx refuses a definition that renders itself); the instances of ${edge.to} inside ${edge.from} are left out.`,
      where: entry.prepared.where,
      data: { chain: edge.chain },
    });
  }

  // The documents.
  const used: ComponentsUsed = {
    components: new Set(),
    wpClasses: new Set(),
    hoisted: [],
    documentRules: [],
    states: new Set(),
  };
  const built: { entry: Entry; built: BuiltDocument; info: ComponentInfoOut }[] = [];
  for (const entry of entries) {
    const { info, metas, prepared, title } = entry;
    const where = prepared.where;
    const say = (e: Omit<ReportEntry, "where">): void => report.add({ ...e, where });
    const description = `Cwicly component "${literalText(title)}" (reference ${info.ref}).`;
    const doc = finishDocument(prepared, {
      state: entry.state,
      hostBindings: entry.hostBindings,
      description,
    });

    // Properties nothing reads.
    const body = JSON.stringify([prepared.nodes, doc.used.hoisted]);
    const reads = stateReads([prepared.nodes, doc.used.hoisted]);
    const props: ComponentProp[] = metas.map((meta) => {
      const variable = feedsCss(meta) ? compVariable(meta.id) : undefined;
      const live =
        reads.has(meta.key) ||
        (variable !== undefined && body.includes(variable)) ||
        body.includes(`#/state/${meta.key}`);
      if (!live && !UNSUPPORTED_TYPES.has(meta.type)) {
        say({
          severity: "info",
          code: "component.dead-prop",
          message: `The property ${meta.name || meta.id} (${meta.type || "no type"}) is read by nothing in the component: instances can set it and the live page ignores it too. It stays in state.`,
          data: { prop: meta.id, key: meta.key, type: meta.type },
        });
      }
      return {
        id: meta.id,
        key: meta.key,
        name: meta.name,
        type: meta.type,
        default: entry.state[meta.key],
        used: live,
        ...(variable === undefined ? {} : { cssVariable: variable }),
      };
    });
    const withVariables = props.filter((p) => p.cssVariable !== undefined && p.used);
    if (withVariables.length > 0) {
      const ids = withVariables.map((p) => p.id);
      const spread = instanceSpread(pageInstances().get(info.ref) ?? [], ids);
      const differing = spread.differing.length > 0 && spread.instances > 1;
      say({
        severity: differing ? "warn" : "info",
        code: "component.css-variable",
        message: `The properties ${withVariables.map((p) => p.name || p.id).join(", ")} reach the component's CSS as --comp-<id> custom properties on the host. A page-level instance's resolved host style is written to a class rule of its FIRST class, so two instances that differ in one of them need a first class of their own (the instance's classID) and not a shared variant class.${differing ? ` ${spread.instances} instances on the site's pages give ${spread.differing.join(", ")} different values: the instances that share a first class all get the last one's.` : ""}`,
        data: {
          props: ids,
          ...(spread.instances === 0 ? {} : { instances: spread.instances }),
          ...(differing ? { differing: spread.differing } : {}),
        },
      });
    }

    // Variants.
    const groups = rows(firstMeta(site, info.postId, "variantGroups")).map((g) => ({
      id: str(g.id) ?? "",
      name: str(g.name) ?? "",
      styles: (Array.isArray(g.styles) ? g.styles : [])
        .map(str)
        .filter((s): s is string => s !== undefined),
    }));
    const variations = rows(firstMeta(site, info.postId, "styleVariations")).map((g) => ({
      id: str(g.id) ?? "",
      name: str(g.name) ?? "",
      styles: (Array.isArray(g.styles) ? g.styles : [])
        .map(str)
        .filter((s): s is string => s !== undefined),
    }));
    const defined = new Set(info.variants.map((v) => v.id));
    for (const [id, count] of prepared.variants) {
      if (defined.has(id)) continue;
      say({
        severity: "warn",
        code: "component.variant-orphan",
        message: `The component's CSS has ${count} rule${count === 1 ? "" : "s"} for the variant ${id}, which the component does not define (no instance can select it).`,
        data: { variant: id, rules: count },
      });
    }
    const variants: ComponentVariant[] = info.variants.map((v) => ({
      id: v.id,
      name: v.name,
      groups: groups.filter((g) => g.styles.includes(v.id)).map((g) => g.id),
      rules: prepared.variants.get(v.id) ?? 0,
    }));
    if (variants.length > 0 && variants.every((v) => v.rules === 0)) {
      say({
        severity: "info",
        code: "component.variant-no-rules",
        message: `The component defines ${variants.length} variant${variants.length === 1 ? "" : "s"} and no rule of its CSS reads any of them: the classes an instance prints change nothing.`,
        data: { variants: variants.map((v) => v.id) },
      });
    }

    // An id inside a component is repeated by every instance.
    const ids = [...walkElements(prepared.nodes)]
      .map((el) => (typeof el.id === "string" ? el.id : undefined))
      .filter((id): id is string => id !== undefined && id !== "");
    if (ids.length > 0) {
      say({
        severity: "info",
        code: "component.id-repeats",
        message: `The component has elements with an id (${ids.join(", ")}); every instance repeats it, so a page with two instances has duplicate ids.`,
        data: { ids },
      });
    }
    if (prepared.nodes.length === 0) {
      say({
        severity: "info",
        code: "component.empty",
        message:
          "The component has no content after conversion (every block was left out); it is written as an empty element.",
      });
    }

    built.push({
      entry,
      built: doc,
      info: {
        ref: info.ref,
        postId: info.postId,
        title,
        tag: info.tagName,
        file: doc.file,
        props,
        variants,
        variantGroups: groups,
        styleVariations: variations,
        slots: doc.slots,
        scopes: [],
      },
    });
  }

  // A classID two components share with different declarations: the later one is renamed.
  const owner = new Map<string, { tag: string; styles: string }>();
  for (const item of built) {
    const doc = item.built.doc as unknown as Rec;
    const scopes = ownScopes((doc.children ?? []) as JxNode[]);
    for (const [scope, styles] of [...scopes].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const fingerprint = JSON.stringify(styles);
      const known = owner.get(scope);
      if (known === undefined) {
        owner.set(scope, { tag: item.info.tag, styles: fingerprint });
        item.info.scopes.push(scope);
      } else if (known.styles !== fingerprint && known.tag !== item.info.tag) {
        if (scope.startsWith(".")) {
          const next = `${scope.slice(1)}-${item.info.tag}`;
          renameScope(doc, scope.slice(1), next);
          item.info.scopes.push(`.${next}`);
          report.add({
            severity: "warn",
            code: "component.scope-renamed",
            message: `The class ${scope.slice(1)} is the classID of blocks in ${known.tag} and in ${item.info.tag} (a duplicated component keeps its blocks' classIDs) with different declarations, and an element's style is written to its first class, so the two would overwrite each other on a page that has both: in ${item.info.tag} it is ${next}.`,
            where: item.entry.prepared.where,
            data: { from: scope.slice(1), to: next, other: known.tag },
          });
        } else {
          item.info.scopes.push(scope);
          report.add({
            severity: "warn",
            code: "component.scope-collision",
            message: `The id ${scope.slice(1)} names styled elements in ${known.tag} and in ${item.info.tag} with different declarations, and a style is written to #id: the two overwrite each other on a page that has both.`,
            where: item.entry.prepared.where,
            data: { scope, other: known.tag },
          });
        }
      } else item.info.scopes.push(scope);
    }
  }

  const files: ComponentFile[] = [];
  const components: ComponentInfoOut[] = [];
  for (const item of built) {
    const doc = item.built;
    files.push({ path: doc.file, content: `${JSON.stringify(doc.doc, null, 2)}\n` });
    components.push(item.info);
    for (const tag of doc.used.components) used.components.add(tag);
    for (const name of doc.used.wpClasses) used.wpClasses.add(name);
    for (const key of doc.used.states) used.states.add(key);
    used.hoisted.push(...doc.used.hoisted);
    used.documentRules.push(...doc.used.documentRules);
  }
  used.hoisted = dedupeRules(used.hoisted);
  used.documentRules = dedupeRules(used.documentRules);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  components.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  skipped.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { files, components, skipped, used, report };
}
