/**
 * The conversion driver: a block tree in, Jx nodes out.
 *
 * {@link convertBlocks} dispatches each block to the converter registered under its name
 * ({@link converters}: the core blocks, then the Cwicly layout, interactive and data modules), hands
 * every converter a context whose `convert` recurses through the same registry (with `overrides`
 * laid over the parent's, so a query loop's `entryExpr` reaches the blocks inside it), and falls back
 * for a name nothing knows: the block is reported (`block.unsupported`) and its saved markup and
 * inner blocks are kept, with a `wp2jx-block` placeholder where it saved nothing, so no content is
 * lost on the way. A converter that throws is reported (`block.converter-error`, error) and the block
 * takes the same fallback: one bad block never takes a whole page, or a whole site, with it.
 *
 * {@link convertSubject} is a whole subject: the context (site.ts), the conversion, and the passes
 * that need the finished tree, in this order:
 *
 * 1. **finish bindings** (`finishNodes`): a binding that crossed an HTML conversion as a placeholder
 *    becomes the real `${…}` of its position. Converters finish their own; this only catches what a
 *    converter left marked, and is a no-op on finished nodes.
 * 2. **texturize** ({@link texturizeNodes}): `wptexturize` over the text a node holds, once. The
 *    core and Cwicly converters texturize the markup they read (the live pages print every block's
 *    text texturized, and after migration nothing else will), and `wptexturize` is not idempotent, so
 *    a text that already carries its quotes is left as it is: the pass is a fixed point on what the
 *    converters made (checked over both sites) and only repairs text a converter built by hand and
 *    never texturized. It never touches an attribute, a `style`, a `${…}` binding, or the text of
 *    `pre`, `code`, `kbd`, `tt`, `script`, `style` and `textarea`.
 * 3. **what the tree uses**: the components it instantiates, the classes it carries (for the
 *    compatibility stylesheet's pruning), the placeholders it holds, the state entries it points at.
 * 4. **hoisted rules**, with duplicates removed (the same selector with the same declarations once, the last of them kept so the cascade does not change).
 *
 * Report codes: `block.unsupported`, `block.converter-error`, `block.too-deep`, `subject.missing`, `css.invalid-reference`,
 * `convert.marker-leaked`, `site.registry-incomplete`, and `token.literal-template` from finishing.
 */
import { collectWpClasses } from "./core/block-css.ts";
import { coreConverters } from "./core/blocks.ts";
import { note, staticBlock } from "./core/static.ts";
import {
  literalTemplate,
  report as tokenReport,
  texturize,
  texturizeHtml,
} from "./cwicly/tokens.ts";
import { finishNodes } from "./jx-util.ts";
import { isUnregisteredBlock } from "./wp/block-registry.ts";
import { lazyBlock } from "./cwicly/blocks/lazyblocks.ts";
import {
  INTERNAL_MARKERS,
  collectPlaceholders,
  placeholderElement,
  walkElements,
} from "./placeholders.ts";
import {
  subjectBlocks,
  subjectPost,
  subjectSession,
  reportOwnCss,
  siteTags,
  subjectWhere,
  type HoistedRule,
  type SiteContext,
  type Subject,
  type SubjectOptions,
} from "./site.ts";
import type {
  BlockConverter,
  ConvertCtx,
  CssIndex,
  JxElement,
  JxNode,
  Report,
  WpBlock,
  WpPost,
} from "./types.ts";

// ── The registry ─────────────────────────────────────────────────────────────────────────────────

/**
 * Converters by block name. Starts as the core set; {@link ensureConverters} adds the Cwicly layout,
 * interactive and data modules that exist, and {@link registerConverters} adds more. One object for
 * the whole process: a context's `convert` reads it when it is called, never when it is made.
 */
export const converters: Record<string, BlockConverter> = { ...coreConverters };

/** A converter module: its name in the status, where it is (relative to this file, or absolute) and the export that holds its table. */
export interface ConverterModule {
  name: string;
  path: string;
  export: string;
}

/** The Cwicly converter modules, by the export each is expected to have. */
const OPTIONAL_MODULES: readonly ConverterModule[] = [
  { name: "layout", path: "./cwicly/blocks/layout.ts", export: "layoutConverters" },
  { name: "interactive", path: "./cwicly/blocks/interactive.ts", export: "interactiveConverters" },
  { name: "data", path: "./cwicly/blocks/data.ts", export: "dataConverters" },
];

export interface RegistryStatus {
  module: string;
  loaded: boolean;
  /** How many block names it registered. */
  blocks: number;
  /** Why it did not load: the module is not there, or it threw while loading. */
  error?: string;
}

/** Add converters (a test's fakes, an emitter's own blocks). A later registration of a name replaces the earlier. */
export function registerConverters(extra: Readonly<Record<string, BlockConverter>>): void {
  Object.assign(converters, extra);
}

let loading: Promise<readonly RegistryStatus[]> | undefined;

/**
 * Load one converter module into the registry. A module that is not there, does not load or exports no
 * table is a status, never a throw.
 */
export async function loadConverterModule(entry: ConverterModule): Promise<RegistryStatus> {
  try {
    // A variable specifier: a module that is not there yet is a status, not a failure to link this file.
    const specifier = entry.path;
    const mod = (await import(specifier)) as Record<string, unknown>;
    const table = mod[entry.export];
    if (typeof table !== "object" || table === null) {
      return {
        module: entry.name,
        loaded: false,
        blocks: 0,
        error: `${entry.path} does not export ${entry.export}`,
      };
    }
    const own: Record<string, BlockConverter> = {};
    for (const [name, converter] of Object.entries(table)) {
      if (typeof converter === "function") own[name] = converter as BlockConverter;
    }
    registerConverters(own);
    return { module: entry.name, loaded: true, blocks: Object.keys(own).length };
  } catch (error) {
    return {
      module: entry.name,
      loaded: false,
      blocks: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build the registry from the modules that exist. Idempotent and shared: the first call loads, the
 * rest wait for the same promise. A module that is missing or broken is a status here, and a report
 * entry where a site asks ({@link reportRegistry}); its blocks fall back to `block.unsupported`.
 */
export function ensureConverters(): Promise<readonly RegistryStatus[]> {
  loading ??= Promise.all(OPTIONAL_MODULES.map(loadConverterModule));
  return loading;
}

/** Said once per site report, however many subjects convert. */
const registryReported = new WeakSet<Report>();

/** Put the registry's missing modules in the report, once. */
export function reportRegistry(report: Report, status: readonly RegistryStatus[]): void {
  if (registryReported.has(report)) return;
  registryReported.add(report);
  for (const entry of status) {
    if (entry.loaded) continue;
    report.add({
      severity: "error",
      code: "site.registry-incomplete",
      message: `The ${entry.module} block converters did not load (${entry.error ?? "unknown"}); the blocks they own are kept as their saved markup and reported block.unsupported.`,
      where: "site",
      data: { module: entry.module, ...(entry.error === undefined ? {} : { error: entry.error }) },
    });
  }
}

// ── Contexts ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A context for nested blocks: `ctx` with `more` laid over it. The result's own `convert` carries
 * the merge forward, so overrides compose (a query loop inside a component inside an entry); an
 * override of `convert` itself is respected as the caller's own.
 */
export function withOverrides(
  ctx: ConvertCtx,
  more: Partial<ConvertCtx>,
  registry: Readonly<Record<string, BlockConverter>> = converters,
): ConvertCtx {
  const next: ConvertCtx = { ...ctx, ...more };
  if (more.convert === undefined) {
    next.convert = (blocks, again) =>
      convertBlocks(blocks, again ? withOverrides(next, again, registry) : next, registry);
  }
  return next;
}

/** `ctx` with its `convert` bound to `registry`: how a test converts through a registry of fakes. */
export function withRegistry(
  ctx: ConvertCtx,
  registry: Readonly<Record<string, BlockConverter>>,
): ConvertCtx {
  const next: ConvertCtx = { ...ctx };
  next.convert = (blocks, more) =>
    convertBlocks(blocks, more ? withOverrides(next, more, registry) : next, registry);
  return next;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────────

/** Nesting deeper than this is a converter calling itself (a component inside its own definition), not a page. */
const MAX_DEPTH = 200;
let depth = 0;

/** Cwicly's loop and id bookkeeping: tokens with no value on a converted site, and no report. */
const BOOKKEEPING_TOKENS = new Set(["idadd", "loop-id", "loop-index", "loop-position", "empty"]);

/**
 * The `class` and `id` attributes of saved markup. Not `data-class`: the attribute must start at a space.
 */
const SAVED_NAME_ATTR = /(?<=\s)(class|id)="([^"]*)"/g;

/**
 * A Cwicly block nothing converts keeps its saved markup, and Cwicly's `save()` writes render-time
 * tokens into that markup that PHP would have resolved per request: an `id` or first class like
 * `nav-c05ccc2{idadd}` is an invalid selector once the block's style is scoped to it (docs/design.md,
 * field notes). The tokens in the block's own `class` and `id` attributes are resolved here the way
 * cwicly/style.ts does (`{gcl}` the block's global class names, bookkeeping tokens nothing,
 * `{currentpageclass}` nothing and an `info`), and one nobody can resolve is dropped and reported
 * `token.unresolved`. Inner blocks are not touched: they are converted, and settled, on their own.
 */
function settleSavedTokens(block: WpBlock, ctx: ConvertCtx): WpBlock {
  if (!block.name?.startsWith("cwicly/")) return block;
  const settle = (markup: string): string =>
    markup.replace(SAVED_NAME_ATTR, (whole, attribute: string, value: string) => {
      if (!value.includes("{")) return whole;
      const text = value.replaceAll(/\{([^{}$]*)\}/g, (token: string, inner: string) => {
        const name = inner.split("=")[0] ?? "";
        if (BOOKKEEPING_TOKENS.has(name)) return "";
        if (name === "gcl" && attribute === "class") {
          const ids = Array.isArray(block.attrs.globalClass) ? block.attrs.globalClass : [];
          const names: string[] = [];
          for (const id of ids) {
            const named = typeof id === "string" ? ctx.cwicly.globalClassNames.get(id) : undefined;
            if (named) names.push(named);
            else
              tokenReport(
                ctx,
                "class.dangling-global",
                "warn",
                `global class ${String(id)} no longer exists; the live page prints no class for it`,
                { token: String(id), globalClass: id },
              );
          }
          return names.join(" ");
        }
        if (name === "currentpageclass") {
          tokenReport(
            ctx,
            "class.current-page",
            "info",
            `the class that marks a link to the current page (${token}) has no static value and is dropped`,
            { token },
          );
          return "";
        }
        tokenReport(
          ctx,
          "token.unresolved",
          "warn",
          `The token ${token} in the ${attribute} of ${block.name} has no value on the converted site; it prints nothing.`,
          { token, in: attribute, block: block.name },
        );
        return "";
      });
      return `${attribute}="${attribute === "class" ? text.replaceAll(/\s+/g, " ").trim() : text}"`;
    });
  const innerHTML = settle(block.innerHTML);
  const innerContent = block.innerContent.map((part) => (part === null ? part : settle(part)));
  return innerHTML === block.innerHTML &&
    innerContent.every((part, i) => part === block.innerContent[i])
    ? block
    : { ...block, innerHTML, innerContent };
}

/**
 * A block no converter owns: reported, and kept as what it saved. A block with no saved markup and no
 * inner blocks (a dynamic block WordPress builds per request) becomes a `wp2jx-block` placeholder.
 */
function unsupportedBlock(block: WpBlock, ctx: ConvertCtx): JxNode[] {
  let nodes: JxNode[] = [];
  try {
    nodes = staticBlock(settleSavedTokens(block, ctx), ctx);
  } catch (error) {
    // Even the saved markup would not convert: the placeholder is all that is left to keep the place.
    const message = error instanceof Error ? error.message : String(error);
    note(
      ctx,
      "error",
      "block.converter-error",
      `The saved markup of ${block.name ?? "freeform"} could not be converted (${message}).`,
      {
        block: block.name,
        error: message,
      },
    );
  }
  const kept = nodes.length > 0 || block.innerBlocks.length > 0;
  if (!kept && isUnregisteredBlock(ctx.model, block.name)) {
    note(
      ctx,
      "info",
      "block.unregistered",
      `The block ${block.name} saved no markup and no plugin or theme of the site registers its namespace any more: WordPress prints nothing for it, so nothing is written.`,
      { block: block.name },
    );
    return [];
  }
  note(
    ctx,
    "warn",
    "block.unsupported",
    kept
      ? `The block ${block.name ?? "freeform"} has no converter; its saved markup is kept as it is.`
      : `The block ${block.name ?? "freeform"} has no converter and saved no markup (WordPress builds it per request); a wp2jx-block placeholder marks its place.`,
    { block: block.name, kept },
  );
  return kept ? nodes : [placeholderElement("block", {}, { block })];
}

/** What a converter must answer: an array whose every entry is a string or an element object. */
const isNodeList = (value: unknown): value is JxNode[] =>
  Array.isArray(value) &&
  value.every(
    (node) =>
      typeof node === "string" ||
      (typeof node === "object" && node !== null && !Array.isArray(node)),
  );

const describeResult = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "a list with a hole in it" : typeof value;

/**
 * Whether the editor's own visibility setting hides the block (`metadata.blockVisibility: false`, the
 * "Hide" switch of WordPress 6.9). The render filter answers an empty string for it before the block's
 * renderer runs, so neither the block nor its inner blocks reach the page, whatever kind of block it is.
 * (The setting can also be an object of viewports, which hides the block at some widths only; that
 * form is not read here.)
 */
export function hiddenByEditor(block: WpBlock): boolean {
  const metadata = block.attrs.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).blockVisibility === false
  );
}

function convertBlock(
  block: WpBlock,
  ctx: ConvertCtx,
  registry: Readonly<Record<string, BlockConverter>>,
): JxNode[] {
  // Freeform (classic) HTML has no name; the core module registers it as `core/freeform`.
  const name = block.name ?? "core/freeform";
  if (hiddenByEditor(block)) {
    note(
      ctx,
      "info",
      "block.hidden",
      `The block ${name} is hidden in the editor (its visibility setting is off): WordPress prints nothing for it or what it holds, and so does this.`,
      { block: block.name, classID: block.attrs.classID },
    );
    return [];
  }
  const key = Object.hasOwn(registry, name)
    ? name
    : name.startsWith("core-embed/") && Object.hasOwn(registry, "core/embed")
      ? "core/embed"
      : undefined;
  const converter = key === undefined ? undefined : registry[key];
  if (converter === undefined) {
    // A Lazy Blocks block is named by its slug, so no table lists it: the recipes are asked for it.
    return (
      (name.startsWith("lazyblock/") ? lazyBlock(block, ctx) : undefined) ??
      unsupportedBlock(block, ctx)
    );
  }
  try {
    const nodes: unknown = converter(block, ctx);
    if (isNodeList(nodes)) return nodes;
    note(
      ctx,
      "error",
      "block.converter-error",
      `The converter of ${name} returned ${describeResult(nodes)} instead of a list of nodes; the block is kept as its saved markup.`,
      { block: block.name, error: "not a list of nodes" },
    );
    return unsupportedBlock(block, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    note(
      ctx,
      "error",
      "block.converter-error",
      `The converter of ${name} threw (${message}); the block is kept as its saved markup.`,
      {
        block: block.name,
        error: message,
      },
    );
    return unsupportedBlock(block, ctx);
  }
}

/** Convert blocks in order, each by the converter registered under its name. */
export function convertBlocks(
  blocks: readonly WpBlock[],
  ctx: ConvertCtx,
  registry: Readonly<Record<string, BlockConverter>> = converters,
): JxNode[] {
  if (depth >= MAX_DEPTH) {
    note(
      ctx,
      "error",
      "block.too-deep",
      `Blocks are nested more than ${MAX_DEPTH} levels deep (a component or reusable block that contains itself?); the rest is left out.`,
      {
        blocks: blocks.length,
      },
    );
    return [];
  }
  depth++;
  try {
    const out: JxNode[] = [];
    for (const block of blocks) out.push(...convertBlock(block, ctx, registry));
    return out;
  } finally {
    depth--;
  }
}

// ── Texturize ────────────────────────────────────────────────────────────────────────────────────

/** Elements whose text is not prose: WordPress's list (`wptexturize` skips them) plus `textarea`, whose text is a value. */
const NO_TEXTURIZE = new Set(["pre", "code", "kbd", "style", "script", "tt", "textarea"]);

const OPEN = "\uE010";
const CLOSE = "\uE011";

/**
 * Where each `${…}` of a string ends, by the rule the Jx build uses: braces are counted without
 * reading string literals (docs/bindings.md, rule 13). An unbalanced one runs to the end.
 */
function bindingSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("${", from);
    if (start < 0) return spans;
    let level = 0;
    let end = text.length;
    for (let i = start + 1; i < text.length; i++) {
      const c = text[i];
      if (c === "{") level++;
      else if (c === "}" && --level === 0) {
        end = i + 1;
        break;
      }
    }
    spans.push([start, end]);
    from = end;
  }
}

/**
 * What `wptexturize` writes for quotes and primes. A text that holds one has been through it already
 * (the core and Cwicly converters texturize the markup they read), and a second pass is not the
 * first: `only.'"` is left as `only.'”` by the real function (a closing single quote followed by a
 * double quote is neither an apostrophe nor a close), and read again as `only.'”` its quote is an
 * apostrophe and becomes `’`. The one text of both fixture sites that a second pass changes is such a
 * quotation (anabaptistperspectives post 11976).
 */
const TEXTURIZED = /[\u2018\u2019\u201C\u201D\u2032\u2033]/;

/**
 * `texturize` of text or markup that may hold bindings: each binding is held out of the way, so no
 * rule reaches into one. Text that already carries `wptexturize`'s own quotes is returned as it is.
 */
function texturizeWithBindings(text: string, markup: boolean): string {
  const run = markup ? texturizeHtml : texturize;
  if (TEXTURIZED.test(text)) return text;
  if (!text.includes("${")) return run(text);
  const held: string[] = [];
  let masked = "";
  let at = 0;
  for (const [start, end] of bindingSpans(text)) {
    masked += text.slice(at, start) + `${OPEN}${held.length}${CLOSE}`;
    held.push(text.slice(start, end));
    at = end;
  }
  masked += text.slice(at);
  return run(masked).replaceAll(
    new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"),
    (_, i: string) => held[Number(i)] ?? "",
  );
}

/**
 * `wptexturize` over the text of Jx nodes, in a copy: `textContent`, the strings of `children` and the
 * text between the tags of an `innerHTML`. Attributes, styles, bindings and the text of `pre`, `code`,
 * `kbd`, `tt`, `script`, `style` and `textarea` (and everything inside them) are left as they are, and so
 * is any node nothing changed (shared, not copied).
 */
export function texturizeNodes(nodes: readonly JxNode[]): JxNode[] {
  return nodes.map(texturizeNode);
}

function texturizeNode(node: JxNode): JxNode {
  if (typeof node === "string") return texturizeWithBindings(node, false);
  if (NO_TEXTURIZE.has(node.tagName as string)) return node;
  let next: JxElement | undefined;
  const set = (patch: Record<string, unknown>): void => {
    next = { ...(next ?? node), ...patch } as JxElement;
  };
  if (typeof node.textContent === "string") {
    const text = texturizeWithBindings(node.textContent, false);
    if (text !== node.textContent) set({ textContent: text });
  }
  if (typeof node.innerHTML === "string") {
    const html = texturizeWithBindings(node.innerHTML, true);
    if (html !== node.innerHTML) set({ innerHTML: html });
  }
  const { children } = node;
  if (Array.isArray(children)) {
    const mapped = children.map(texturizeNode);
    if (mapped.some((child, i) => child !== children[i])) set({ children: mapped });
  } else if (
    children &&
    typeof children === "object" &&
    (children as { map?: JxNode }).map !== undefined
  ) {
    const proto = children as { map: JxNode };
    const map = texturizeNode(proto.map);
    if (map !== proto.map) set({ children: { ...proto, map } });
  }
  const own = (node as { map?: unknown }).map;
  if (own && typeof own === "object") {
    const map = texturizeNode(own as JxNode);
    if (map !== own) set({ map });
  }
  if (node.cases && typeof node.cases === "object") {
    let cases: Record<string, JxElement> | undefined;
    for (const [name, branch] of Object.entries(node.cases)) {
      const out = texturizeNode(branch);
      if (out !== branch) (cases ??= { ...node.cases })[name] = out as JxElement;
    }
    if (cases) set({ cases });
  }
  return next ?? node;
}

// ── What a tree uses ─────────────────────────────────────────────────────────────────────────────

/** The key a `#/state/<key>…` JSON pointer names, percent- and `~`-decoded; undefined for any other string. */
function stateKeyOf(pointer: string): string | undefined {
  const m = /^#\/state\/([^/]+)/.exec(pointer);
  if (!m) return undefined;
  let key = m[1]!;
  try {
    key = decodeURIComponent(key);
  } catch {
    // A stray `%` is not an escape; the pointer names the key as written.
  }
  return key.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * The state keys a tree points at: the `$ref` of an object, `{"$ref": "#/state/<key>…"}`, anywhere in
 * it. Only a `$ref` is a pointer: a paragraph that happens to read `#/state/x` is text.
 */
function stateRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) stateRefs(item, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === "$ref" && typeof inner === "string") {
      const state = stateKeyOf(inner);
      if (state !== undefined) into.add(state);
    } else {
      stateRefs(inner, into);
    }
  }
}

/**
 * The same selector with the same declarations once, the LAST of them kept: of equal rules the later
 * one is the one the cascade honours, so `.x red, .x blue, .x red` must stay red, and dropping the
 * second `.x red` would hand the win to blue.
 */
export function dedupeRules(rules: readonly HoistedRule[]): HoistedRule[] {
  const seen = new Set<string>();
  const out: HoistedRule[] = [];
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    const key = `${rule.selector}\0${JSON.stringify(rule.style)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out.reverse();
}

// ── A subject ────────────────────────────────────────────────────────────────────────────────────

export interface Converted {
  subject: Subject;
  /** The post the subject stands for. */
  post?: WpPost;
  nodes: JxNode[];
  /** Rules that could not live in one element's `style` (keyframes, `:where()` rules, rules of other classes), duplicates removed. */
  hoisted: HoistedRule[];
  used: {
    /** Tags of the components (and parts, reusable blocks) the nodes instantiate. */
    components: Set<string>;
    /** Every class name the nodes carry. */
    wpClasses: Set<string>;
    /** The stylesheets the subject's page loads, in cascade order (global, its own, its parts', components', reusable blocks'). */
    cssFiles: Set<string>;
    /** The `wp2jx-*` tags still in the nodes; `placeholderCounts` says how many of each. */
    placeholders: Set<string>;
    placeholderCounts: Map<string, number>;
    /** Page-level state keys the nodes point at (`#/state/<key>`) or that a converter registered. */
    states: Set<string>;
  };
  /** The page-level state entries converters registered through `ctx.defineState`, by key. */
  state: Record<string, unknown>;
  /** What this conversion could not carry over. */
  report: Report;
  /** The subject's own CSS index (see site.ts). */
  css: CssIndex;
}

/** The context overrides a conversion's options stand for. */
function overridesOf(opts: SubjectOptions): Partial<ConvertCtx> {
  return {
    ...(opts.mode === undefined ? {} : { mode: opts.mode }),
    ...(opts.entryExpr === undefined ? {} : { entryExpr: opts.entryExpr }),
    ...(opts.entryType === undefined ? {} : { entryType: opts.entryType }),
    ...(opts.termExpr === undefined ? {} : { termExpr: opts.termExpr }),
    ...(opts.target === undefined ? {} : { target: opts.target }),
  };
}

/**
 * Convert one subject: its blocks, through the registry, finished (see the module header). `opts`
 * replace what the subject's kind implies (`mode`, `entryType`, `termExpr`, `target`): the templates
 * emitter says an entry template renders `project`s, a page emitter says a page is a page.
 */
export async function convertSubject(
  site: SiteContext,
  subject: Subject,
  opts: SubjectOptions = {},
): Promise<Converted> {
  reportRegistry(site.report, await ensureConverters());
  const session = await subjectSession(site, subject, overridesOf(opts));
  const { ctx } = session;
  // What is wrong in the subject's own stylesheet is the conversion's finding, not the context's: a
  // context built only to read a block (a test's, an emitter's) starts with an empty report.
  await reportOwnCss(site, subject, ctx.report, subjectWhere(site, subject));
  for (const file of session.cssInvalid) {
    note(
      ctx,
      "warn",
      "css.invalid-reference",
      `A block names the stylesheet ${JSON.stringify(file)}, which is not a file name (a slug, theme or reference with a slash or control character in it); it was not looked up.`,
      { file },
    );
  }
  const post = subjectPost(site, subject);
  const base = { subject, ...(post ? { post } : {}) };

  const empty = (): Converted => ({
    ...base,
    nodes: [],
    hoisted: [],
    used: {
      components: new Set(),
      wpClasses: new Set(),
      cssFiles: new Set(session.cssNames),
      placeholders: new Set(),
      placeholderCounts: new Map(),
      states: new Set(),
    },
    state: {},
    report: ctx.report,
    css: ctx.css,
  });
  if (!post) {
    ctx.report.add({
      severity: "error",
      code: "subject.missing",
      message: `There is no published ${subject.kind} for ${JSON.stringify(subject)}; nothing was converted.`,
      where: subjectWhere(site, subject),
    });
    return empty();
  }

  let nodes = convertBlocks(subjectBlocks(site, subject), ctx);
  nodes = finishNodes(nodes, () => literalTemplate(ctx));
  nodes = texturizeNodes(nodes);

  const placeholderCounts = collectPlaceholders(nodes);
  for (const marker of INTERNAL_MARKERS) {
    const count = placeholderCounts.get(marker);
    if (count === undefined) continue;
    placeholderCounts.delete(marker);
    note(
      ctx,
      "error",
      "convert.marker-leaked",
      `The internal marker <${marker}> is still in the converted nodes (${count}); the inner block it stood for is missing.`,
      {
        marker,
        count,
      },
    );
  }

  const tags = siteTags(site);
  const components = new Set<string>();
  for (const element of walkElements(nodes)) {
    const tag = element.tagName as string | undefined;
    if (tag !== undefined && tags.has(tag)) components.add(tag);
  }

  const states = new Set<string>();
  stateRefs(nodes, states);
  for (const key of session.state.keys()) states.add(key);

  return {
    ...base,
    nodes,
    hoisted: dedupeRules(session.hoisted),
    used: {
      components,
      wpClasses: collectWpClasses(nodes),
      cssFiles: new Set(session.cssNames),
      placeholders: new Set(placeholderCounts.keys()),
      placeholderCounts,
      states,
    },
    state: Object.fromEntries(session.state),
    report: ctx.report,
    css: ctx.css,
  };
}
