/**
 * The `wp2jx-*` placeholder elements: structure a converter cannot build itself and a later emitter
 * can.
 *
 * A placeholder is an ordinary Jx element whose tag starts with `wp2jx-`. It says WHAT is wanted
 * (a menu, a template part, the body of the entry, a shortcode's output) in `data-*` attributes and
 * keeps whatever the block held as `children`; the emitter that owns the thing replaces it with the
 * real nodes ({@link replacePlaceholders}). One spelling per kind lives here ({@link PLACEHOLDERS},
 * {@link placeholderElement}), so a converter and the emitter that resolves it cannot disagree about
 * an attribute name. A placeholder that is never replaced is an element no browser knows: it renders
 * as nothing, and {@link replacePlaceholders} reports it (`placeholder.unresolved`, error) so a
 * migration cannot silently ship an empty `<wp2jx-menu>`.
 *
 * The kinds, by who makes and who resolves them:
 *
 * | Tag                        | Made by                          | Resolved by            |
 * | -------------------------- | -------------------------------- | ---------------------- |
 * | `wp2jx-menu`               | tokens.ts (`{menu}`, `{nav_menu}`) | menus emitter        |
 * | `wp2jx-post-content`       | tokens.ts (`{postcontent}`)      | templates emitter      |
 * | `wp2jx-template-part`      | core `core/template-part`        | templates emitter      |
 * | `wp2jx-navigation`         | core `core/navigation`           | menus emitter          |
 * | `wp2jx-shortcode`          | core `core/shortcode`, text      | project assembler      |
 * | `wp2jx-block`              | core and the driver (unknown)    | project assembler      |
 * | `wp2jx-post-title` and kin | core dynamic blocks, no source   | templates emitter      |
 *
 * Report codes: `placeholder.unresolved` (error: a placeholder nothing replaced, or one inside an
 * `innerHTML` string where no resolver can reach it), `placeholder.cycle` (error: a replacement that
 * keeps producing placeholders), `placeholder.marker-leaked` (error: see below).
 *
 * `wp2jx-inner` is not one of them: it is the private marker `core/static.ts` puts where an inner
 * block goes, and it never leaves a converter ({@link INTERNAL_MARKERS}). Finding one in a result is
 * a bug in the converter that made it.
 */
import { joinClass } from "./jx-util.ts";
import type { JxElement, JxNode, Report } from "./types.ts";

/** Every placeholder tag starts with this. */
export const PLACEHOLDER_PREFIX = "wp2jx-";

export const MENU = "menu";
export const POST_CONTENT = "post-content";
export const TEMPLATE_PART = "template-part";
export const NAVIGATION = "navigation";
export const SHORTCODE = "shortcode";
export const BLOCK = "block";

/** The tag of a kind: `tagOf("menu")` is `wp2jx-menu`. */
export const tagOf = (kind: string): string => `${PLACEHOLDER_PREFIX}${kind}`;

/** Markers that are scaffolding of one converter, not placeholders for an emitter: they must not survive a conversion. */
export const INTERNAL_MARKERS: readonly string[] = ["wp2jx-inner"];

/**
 * The attributes each kind carries, the ones named here being the contract. `data-block` is the
 * block's name and `data-attrs` its attributes as JSON (the dollar sign of a `${` written
 * `\u0024`, so the JSON can never be read as a binding); a kind may hold more.
 */
export interface PlaceholderAttrs {
  /** A menu: `data-menu` is the nav menu's term id, absent for "the menu of this theme location". */
  menu: { "data-menu"?: string };
  /** The body of the entry (or the page) the template renders. No attributes. */
  "post-content": Record<never, never>;
  /** A template part: `slug` and `theme` name it, `area` and `tag` are the block's own. */
  "template-part": {
    "data-block": string;
    "data-attrs"?: string;
    slug?: string;
    theme: string;
    area?: string;
    tag?: string;
  };
  /** A `core/navigation` block: `data-ref` is the `wp_navigation` post id; the children are the links the block itself held. */
  navigation: { "data-block": string; "data-attrs"?: string; "data-ref"?: string };
  /** A shortcode: `data-shortcode` its name, `data-attributes` its parsed attributes (JSON), `data-source` the text as written. The children are what an enclosing shortcode encloses. */
  shortcode: { "data-shortcode": string; "data-attributes"?: string; "data-source": string };
  /** A block nothing converts (a dynamic block saved no markup): the generic placeholder. */
  block: { "data-block": string; "data-attrs"?: string };
  /** The dynamic core blocks that show data of a page, converted where there is no page to read: the same two attributes. */
  "post-title": { "data-block": string; "data-attrs"?: string };
  "post-featured-image": { "data-block": string; "data-attrs"?: string };
  "post-excerpt": { "data-block": string; "data-attrs"?: string };
  "post-date": { "data-block": string; "data-attrs"?: string };
  "post-terms": { "data-block": string; "data-attrs"?: string };
  "query-title": { "data-block": string; "data-attrs"?: string };
}

export type PlaceholderKind = keyof PlaceholderAttrs;

export interface PlaceholderSpec {
  kind: PlaceholderKind;
  tag: string;
  /** What the placeholder stands for and what resolving it means. */
  meaning: string;
  /** Who builds it. */
  madeBy: string;
  /** Who is expected to resolve it. */
  resolvedBy: string;
  /** Whether the element's children are content the resolver may keep or must reconcile. */
  children: "none" | "content";
}

const dynamicBlock = (kind: PlaceholderKind, what: string): PlaceholderSpec => ({
  kind,
  tag: tagOf(kind),
  meaning: `${what}: a dynamic block of the page being rendered, converted where the converter had no page or entry to read.`,
  madeBy: "core/blocks.ts (unresolved)",
  resolvedBy: "templates emitter",
  children: "none",
});

/** Every placeholder kind the converters emit, documented. */
export const PLACEHOLDERS: Readonly<Record<PlaceholderKind, PlaceholderSpec>> = {
  menu: {
    kind: "menu",
    tag: tagOf(MENU),
    meaning:
      "A rendered navigation menu (`{menu}`, `{nav_menu=ID}`): the menus emitter writes the nav component and puts it here.",
    madeBy: "cwicly/tokens.ts",
    resolvedBy: "menus emitter",
    children: "none",
  },
  "post-content": {
    kind: "post-content",
    tag: tagOf(POST_CONTENT),
    meaning:
      "The body of the page or entry a template renders (`{postcontent}`): in a layout, the slot.",
    madeBy: "cwicly/tokens.ts",
    resolvedBy: "templates emitter",
    children: "none",
  },
  "template-part": {
    kind: "template-part",
    tag: tagOf(TEMPLATE_PART),
    meaning:
      "A template part (`core/template-part`): the part is its own subject, converted to a component the emitter names with partTag.",
    madeBy: "core/blocks.ts",
    resolvedBy: "templates emitter",
    children: "none",
  },
  navigation: {
    kind: "navigation",
    tag: tagOf(NAVIGATION),
    meaning:
      "A `core/navigation` block: a menu WordPress renders per request, with the links the block itself held as children.",
    madeBy: "core/blocks.ts",
    resolvedBy: "menus emitter",
    children: "content",
  },
  shortcode: {
    kind: "shortcode",
    tag: tagOf(SHORTCODE),
    meaning:
      "A shortcode, which runs on every WordPress request and has no static form: the assembler decides (a form, a widget, nothing) and the report says what was lost.",
    madeBy: "core/blocks.ts",
    resolvedBy: "project assembler",
    children: "content",
  },
  block: {
    kind: "block",
    tag: tagOf(BLOCK),
    meaning:
      "A block no converter knows and that saved no markup (a third-party dynamic block): kept so its place is not lost.",
    madeBy: "core/blocks.ts, convert.ts",
    resolvedBy: "project assembler",
    children: "none",
  },
  "post-title": dynamicBlock("post-title", "The title of the current post"),
  "post-featured-image": dynamicBlock(
    "post-featured-image",
    "The featured image of the current post",
  ),
  "post-excerpt": dynamicBlock("post-excerpt", "The excerpt of the current post"),
  "post-date": dynamicBlock("post-date", "The date of the current post"),
  "post-terms": dynamicBlock("post-terms", "The terms of the current post"),
  "query-title": dynamicBlock("query-title", "The title of the current archive"),
};

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

/** A placeholder element read: its kind, its attributes as strings and the block's own attributes (`data-attrs`) decoded. */
export interface Placeholder {
  /** `wp2jx-menu`. */
  tag: string;
  /** `menu`: the tag without the prefix. */
  kind: string;
  element: JxElement;
  /** The element's `attributes`, as written (a value is a string; one that is not is dropped). */
  attrs: Readonly<Record<string, string>>;
  /** The block's name, from `data-block`. */
  block?: string;
  /** The block's attributes, from `data-attrs`; `{}` when absent or unreadable. */
  blockAttrs: Record<string, unknown>;
}

export const isPlaceholderTag = (tag: unknown): tag is string =>
  typeof tag === "string" && tag.startsWith(PLACEHOLDER_PREFIX);

/** Whether a node is a placeholder element (an internal marker is not one). */
export const isPlaceholder = (node: JxNode): node is JxElement =>
  typeof node !== "string" &&
  isPlaceholderTag(node.tagName) &&
  !INTERNAL_MARKERS.includes(node.tagName as string);

/** `data-attrs` decoded: an escaped dollar sign (`\u0024`) in the JSON reads back as the `$` it stands for. */
function decodeBlockAttrs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Read an element as a placeholder; undefined when it is not one. */
export function readPlaceholder(node: JxNode): Placeholder | undefined {
  if (!isPlaceholder(node)) return undefined;
  const attrs: Record<string, string> = {};
  for (const [name, value] of Object.entries(node.attributes ?? {})) {
    if (typeof value === "string") attrs[name] = value;
  }
  const tag = node.tagName as string;
  return {
    tag,
    kind: tag.slice(PLACEHOLDER_PREFIX.length),
    element: node,
    attrs,
    ...(attrs["data-block"] === undefined ? {} : { block: attrs["data-block"] }),
    blockAttrs: decodeBlockAttrs(attrs["data-attrs"]),
  };
}

/** The typed attributes of a placeholder of a known kind. */
export function placeholderAttrs<K extends PlaceholderKind>(
  node: JxNode,
  kind: K,
): Partial<PlaceholderAttrs[K]> | undefined {
  const read = readPlaceholder(node);
  return read?.kind === kind ? (read.attrs as Partial<PlaceholderAttrs[K]>) : undefined;
}

// ── Building ─────────────────────────────────────────────────────────────────────────────────────

/** A block's attributes as the JSON an element carries them in: no `${` can be read back as a binding. */
export const encodeBlockAttrs = (attrs: Record<string, unknown>): string =>
  JSON.stringify(attrs).replaceAll("${", "\\u0024{");

export interface PlaceholderOptions {
  /** The block the placeholder stands for: sets `data-block` and, when it has any, `data-attrs`. */
  block?: { name: string | null; attrs: Record<string, unknown> };
  /** Classes the element carries (a wrapper's own, so a style written for the block still matches). */
  className?: string;
  children?: JxNode[];
}

/**
 * The element for a placeholder of `kind`. `attributes` are written after the block's; a value
 * holding a `${` is the caller's to escape (the converters write these through their own literal
 * helper). Nothing about the element shows on a built page that was not replaced.
 */
export function placeholderElement<K extends PlaceholderKind>(
  kind: K,
  attributes: Partial<PlaceholderAttrs[K]> = {},
  options: PlaceholderOptions = {},
): JxElement {
  const own: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes))
    if (typeof value === "string") own[name] = value;
  const block = options.block;
  const blockAttrs =
    block === undefined
      ? {}
      : {
          "data-block": block.name ?? "freeform",
          ...(Object.keys(block.attrs).length > 0
            ? { "data-attrs": encodeBlockAttrs(block.attrs) }
            : {}),
        };
  const className = joinClass(options.className);
  const attrs = { ...blockAttrs, ...own };
  return {
    tagName: tagOf(kind),
    ...(className === "" ? {} : { className }),
    ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
    ...(options.children && options.children.length > 0 ? { children: options.children } : {}),
  };
}

// ── Walking Jx trees ─────────────────────────────────────────────────────────────────────────────

type Mapped = { $prototype?: string; items?: unknown; map?: JxNode };
type Record_ = Record<string, unknown>;

/**
 * The elements inside an element, wherever a Jx document keeps them: `children` (a list, or a
 * mapped array's `map`), the `map` an element can carry itself, and the `cases` of a `$switch`.
 */
export function childNodes(element: JxElement): JxNode[] {
  const out: JxNode[] = [];
  const { children } = element;
  if (Array.isArray(children)) out.push(...children);
  else if (children && typeof children === "object" && (children as Mapped).map !== undefined) {
    out.push((children as Mapped).map as JxNode);
  }
  const own = (element as Record_).map;
  if (own && typeof own === "object") out.push(own as JxNode);
  if (element.cases && typeof element.cases === "object") out.push(...Object.values(element.cases));
  return out;
}

/** Every element of the trees, parents before children, in document order (a repeater's template and every `$switch` case included). */
export function* walkElements(nodes: readonly JxNode[]): Generator<JxElement> {
  const stack: JxNode[] = [...nodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (typeof node === "string") continue;
    yield node;
    stack.push(...childNodes(node).reverse());
  }
}

const PLACEHOLDER_IN_MARKUP = /<(wp2jx-[a-z0-9-]+)/gi;

/**
 * The placeholders in the trees, by tag, with how many of each: elements and, because a converter
 * may hold a subtree as markup, the ones inside an `innerHTML` string. Internal markers are counted
 * too (a marker is what a leak looks like).
 */
export function collectPlaceholders(nodes: readonly JxNode[]): Map<string, number> {
  const found = new Map<string, number>();
  const add = (tag: string): void => void found.set(tag, (found.get(tag) ?? 0) + 1);
  for (const element of walkElements(nodes)) {
    if (isPlaceholderTag(element.tagName)) add(element.tagName);
    if (typeof element.innerHTML === "string" && element.innerHTML.includes(PLACEHOLDER_PREFIX)) {
      for (const m of element.innerHTML.matchAll(PLACEHOLDER_IN_MARKUP)) add(m[1]!.toLowerCase());
    }
  }
  return found;
}

// ── Replacing ────────────────────────────────────────────────────────────────────────────────────

/**
 * What a resolver answers: nodes to put in the placeholder's place, `null` to remove it (the thing it
 * stood for is nothing here), or `undefined` for "not mine": the placeholder stays and is reported.
 */
export type Resolution = JxNode | JxNode[] | null | undefined;

/** Resolves one placeholder. `placeholder.element`'s children are already replaced; the nodes returned are walked again. */
export type Resolver = (placeholder: Placeholder) => Resolution;

/**
 * Which resolver answers for which placeholder: by full tag (`wp2jx-menu`), by kind (`menu`), or `*`
 * for the rest. The tag wins over the kind and both over `*`.
 */
export type ResolverMap = Readonly<Record<string, Resolver>>;

export interface ReplaceOptions {
  /** Where `placeholder.unresolved` goes. Without one nothing is reported (the tree is still returned and `stats` filled). */
  report?: Report;
  /** The location the findings carry: `post:5246`, `template:cwicly//header`. */
  where?: string;
  url?: string;
  /** Filled in: how many of each tag were replaced, and how many were left. */
  stats?: { replaced: Map<string, number>; left: Map<string, number> };
  /** The deepest a replacement may itself hold placeholders (a part that embeds a part that embeds…). Default 32. */
  maxDepth?: number;
}

const bump = (map: Map<string, number>, key: string): void =>
  void map.set(key, (map.get(key) ?? 0) + 1);

/**
 * Replace the placeholder elements of `nodes` through `resolver`, in a copy (the input is not
 * modified and unchanged subtrees are shared). Elements are visited children first, so a resolver
 * sees its own children already replaced; what it returns is walked again, to a depth of
 * `maxDepth`. Every placeholder left, and every one inside an `innerHTML` string (which a resolver
 * cannot reach), is reported `placeholder.unresolved` (error). Internal markers are left alone by
 * the resolver and reported as `placeholder.marker-leaked`.
 */
export function replacePlaceholders(
  nodes: readonly JxNode[],
  resolver: ResolverMap,
  options: ReplaceOptions = {},
): JxNode[] {
  const { report, where, url } = options;
  const maxDepth = options.maxDepth ?? 32;
  const replaced = options.stats?.replaced ?? new Map<string, number>();
  const left = options.stats?.left ?? new Map<string, number>();

  const say = (code: string, message: string, data: Record<string, unknown>): void =>
    report?.add({
      severity: "error",
      code,
      message,
      ...(where === undefined ? {} : { where }),
      ...(url === undefined ? {} : { url }),
      data,
    });

  const find = (tag: string, kind: string): Resolver | undefined => {
    if (Object.hasOwn(resolver, tag)) return resolver[tag];
    if (Object.hasOwn(resolver, kind)) return resolver[kind];
    return Object.hasOwn(resolver, "*") ? resolver["*"] : undefined;
  };

  /**
   * What walking has produced, so a resolver that hands back its own placeholder's children (already
   * replaced, already reported) does not get them walked, or reported, twice. Scoped, not global:
   * `collecting` is the sets of the elements whose children are being walked right now (every output
   * lands in each, so a grandchild is covered too), and `settled` the sets of the elements whose
   * answer is being walked. The same object met in two places of the input is two placeholders and
   * is resolved, counted and reported at each.
   */
  const collecting: WeakSet<object>[] = [];
  const settled: WeakSet<object>[] = [];
  /** The placeholders whose answer is being walked: a repeat is a part that contains itself. */
  const expanding: string[] = [];
  /** Cycles already reported, by identity: one entry for a cycle, however many times it is cut. */
  const cycles = new Set<string>();

  /** One node → the nodes that stand in its place. */
  function visit(node: JxNode, depth: number): JxNode[] {
    if (typeof node === "string" || settled.some((walked) => walked.has(node))) return [node];
    const out = visitElement(node, depth);
    for (const next of out) {
      if (typeof next === "string") continue;
      for (const walked of collecting) walked.add(next);
    }
    return out;
  }

  /** What a placeholder is, for telling a part that contains itself from one that merely repeats. */
  const identityOf = (placeholder: Placeholder): string =>
    `${placeholder.tag}\0${JSON.stringify(Object.entries(placeholder.attrs).sort(([a], [b]) => (a < b ? -1 : 1)))}`;

  function visitElement(node: JxElement, depth: number): JxNode[] {
    const walked = new WeakSet<object>();
    collecting.push(walked);
    let inner: JxElement;
    try {
      inner = rebuild(node, depth);
    } finally {
      collecting.pop();
    }
    const innerTag = (inner.tagName ?? "") as string;
    if (INTERNAL_MARKERS.includes(innerTag)) {
      bump(left, innerTag);
      say(
        "placeholder.marker-leaked",
        `The internal marker <${innerTag}> is still in the result: the converter that placed it did not take it out, so the content it stood for is missing.`,
        { tag: innerTag },
      );
      return [inner];
    }
    const placeholder = readPlaceholder(inner);
    if (!placeholder) return [inner];
    const resolve = find(placeholder.tag, placeholder.kind);
    const identity = identityOf(placeholder);
    if (resolve !== undefined && expanding.includes(identity)) {
      // Expanding it again would only produce it again: cut at the first repeat, so a part that
      // embeds itself twice costs two cuts, not 2^maxDepth resolutions.
      bump(left, placeholder.tag);
      if (!cycles.has(identity)) {
        cycles.add(identity);
        say(
          "placeholder.cycle",
          `Replacing <${placeholder.tag}> produced <${placeholder.tag}> again, the same one: a part or block that contains itself was cut here.`,
          { tag: placeholder.tag, depth, attributes: placeholder.attrs },
        );
      }
      return [inner];
    }
    const answer = resolve?.(placeholder);
    if (answer === undefined) {
      bump(left, placeholder.tag);
      say(
        "placeholder.unresolved",
        `The placeholder <${placeholder.tag}>${placeholder.block === undefined ? "" : ` (${placeholder.block})`} was not replaced, so it renders as nothing.`,
        {
          tag: placeholder.tag,
          ...(placeholder.block === undefined ? {} : { block: placeholder.block }),
          attributes: placeholder.attrs,
        },
      );
      return [inner];
    }
    bump(replaced, placeholder.tag);
    const result = answer === null ? [] : Array.isArray(answer) ? answer : [answer];
    if (depth >= maxDepth) {
      for (const tag of collectPlaceholders(result).keys()) {
        bump(left, tag);
        say(
          "placeholder.cycle",
          `Replacing <${placeholder.tag}> produced <${tag}> again ${maxDepth} levels deep; a part or block that contains itself was cut here.`,
          { tag, depth },
        );
      }
      return result;
    }
    settled.push(walked);
    expanding.push(identity);
    try {
      return result.flatMap((next) => visit(next, depth + 1));
    } finally {
      expanding.pop();
      settled.pop();
    }
  }

  /** A position that holds exactly one element (a repeater's template, a `$switch` case). */
  function single(node: JxNode, depth: number): JxNode {
    const out = visit(node, depth);
    if (out.length === 1) return out[0]!;
    return { tagName: "div", style: { display: "contents" }, children: out };
  }

  /** `element` with its descendants replaced; the same object when nothing below it changed. */
  function rebuild(element: JxElement, depth: number): JxElement {
    let next: JxElement | undefined;
    const set = (patch: Record_): void => {
      next = { ...(next ?? element), ...patch } as JxElement;
    };
    const { children } = element;
    if (Array.isArray(children)) {
      const mapped = children.flatMap((child) => visit(child, depth));
      if (mapped.length !== children.length || mapped.some((child, i) => child !== children[i]))
        set({ children: mapped });
    } else if (children && typeof children === "object" && (children as Mapped).map !== undefined) {
      const proto = children as Mapped;
      const map = single(proto.map as JxNode, depth);
      if (map !== proto.map) set({ children: { ...proto, map } } as Record_);
    }
    const own = (element as Record_).map;
    if (own && typeof own === "object") {
      const map = single(own as JxNode, depth);
      if (map !== own) set({ map } as Record_);
    }
    if (element.cases && typeof element.cases === "object") {
      let cases: Record<string, JxElement> | undefined;
      for (const [name, branch] of Object.entries(element.cases)) {
        const out = single(branch, depth);
        if (out !== branch) (cases ??= { ...element.cases })[name] = out as JxElement;
      }
      if (cases) set({ cases });
    }
    if (typeof element.innerHTML === "string" && element.innerHTML.includes(PLACEHOLDER_PREFIX)) {
      for (const m of element.innerHTML.matchAll(PLACEHOLDER_IN_MARKUP)) {
        const tag = m[1]!.toLowerCase();
        bump(left, tag);
        say(
          INTERNAL_MARKERS.includes(tag) ? "placeholder.marker-leaked" : "placeholder.unresolved",
          `The placeholder <${tag}> is inside the innerHTML of a <${element.tagName}>, where no resolver can reach it, so it renders as nothing.`,
          { tag, inMarkup: true, parent: element.tagName },
        );
      }
    }
    return next ?? element;
  }

  return nodes.flatMap((node) => visit(node, 0));
}
