/**
 * The Cwicly blocks that move: accordions, tabs, modals, popovers, sliders, navigation, menus, form
 * controls, filters, range sliders and swatches. Cwicly drives every one of them with a script
 * (`assets/js/cc-accordion`, `cc-tab`, `cc-modal`, `cc-popover`, `cc-slider`, `nav/dist/main`), and
 * none of those scripts is ported: each block becomes the native element or the CSS-only pattern that
 * does the same job, and whatever has no static form is reported (`interaction.dropped`, with the
 * block, its classID and the feature) and never left out silently.
 *
 * The root of every block is made by `buildBlock`/`assemble` (common.ts), so the class list (classID
 * first), the style, the visibility and the author's attributes are the same as for the layout
 * blocks. What is decided here is what is INSIDE a block and which element the root is, per block:
 *
 * - **Accordions** become `<details>`/`<summary>`: the open state is the `open` attribute
 *   (`accordionOpen`), an exclusive group is the `name` attribute `<details>` has for exactly that
 *   (`accordionGroup`, on the container or on each accordion). The state classes
 *   (`cc-accordion-active`/`-hidden`) are not printed: the plugin's `.cc-accordion-hidden
 *   [data-cc-accordion-content] {visibility: hidden}` would keep the content of an accordion the visitor
 *   opened hidden for ever, and nothing in either fixture site's stylesheets selects them.
 * - **Tabs** are a radio group and `:has()`. The tab is a `<label>` around an `<input type="radio">` (the
 *   native control keeps the arrow keys, the focus and the "one selected" rule that the script
 *   implemented by hand), and every panel but the selected tab's own is hidden by one rule per panel,
 *   `:root:has(#<radio>:not(:checked)) #<panel> {display: none}`, which reaches a panel wherever the
 *   tab list and the panels sit (Cwicly links them by id, and so does the rule). The rules are
 *   hoisted; the roles of the script's ARIA tabs are not printed, because a label that is not a tab
 *   would lie about being one. Both converters know the same id, the panels' container (`tabContentsID`
 *   on the tab list, `id` on the container), and a position, so the tab list and the panels agree
 *   without either seeing the other.
 * - **Modals and popovers** use the `popover` attribute. A modal keeps the plugin's `.cc-mdl` shell
 *   (`modal.min.css` is shipped for it) and gains `popover` and its `id`, so the opener the link module
 *   builds (`triggerOf`: a `<button popovertarget>`) opens it; the dimming layer is the
 *   close button, Escape and a click outside close it, and the page's scroll is locked with `:has()`.
 *   A popover opened by an element (`popoverOptions.trigger`, the usual way) cannot use `popovertarget`
 *   (only a button can be an invoker, and the trigger is any element), so it is a box that CSS shows
 *   while its trigger is hovered or focused, placed beside the trigger with CSS anchor positioning
 *   where the browser has it.
 * - **Sliders** are a scroll-snap list: the plugin's `.swiper` becomes the scroller, `.swiper-slide`
 *   the snap areas; slides per view and the gap are custom properties per breakpoint. Arrows, dots,
 *   autoplay, loop, fade and the rest are Swiper's and are reported.
 * - **Navigation** keeps the plugin's `cc-nav*` markup, because `build/style-index.css` styles it. The
 *   script's two jobs become CSS: a dropdown opens while its item is hovered or holds the focus, and
 *   below the block's breakpoint the wrapper is a popover that the hamburger (now a `<button>`) opens,
 *   with the rules `[is-modal=true]` switched on in the stylesheet re-written for that media query.
 * - **Menus** (`menu`, `navmenu`) are the `wp2jx-menu` placeholder the menus emitter replaces, carrying
 *   the menu id and the block's own options.
 * - **Inputs** are the form control the saved markup holds. **Filters** whose options are a
 *   taxonomy's terms become a list of links to the term archives (the page cannot filter a query; the
 *   archive is the same query already filtered), every other filter is reported `filter.static`.
 *
 * Report codes (the block, classID and uniqueID are in `data`): `interaction.dropped` (a script's job
 * with no static form), `interaction.approximated` (a script's job done another way, with what
 * differs), `filter.static`, `block.unsupported` (a WooCommerce swatch), plus what the style, link, dynamic and
 * condition modules report on the way.
 */
import { finishNodes, joinClass, mergeStyle } from "../../jx-util.ts";
import type {
  BlockConverter,
  Breakpoint,
  ConvertCtx,
  JxElement,
  JxNode,
  JxStyle,
  WpBlock,
  WpTerm,
} from "../../types.ts";
import { decodeEntities } from "../../wp/model.ts";
import { contentOptions, htmlNodes } from "../../core/static.ts";
import { escapeHtml, literalFinal, literalTemplate, resolveMarked } from "../tokens.ts";
import {
  assemble,
  buildBlock,
  hoistRule,
  inlineContent,
  linkAttributes,
  placeholder,
  prepare,
  record,
  say,
  text,
  triggerOf,
  type AttrValue,
  type BlockEnv,
  type Built,
} from "./common.ts";

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────

/** `{name: undefined, …}`: the attributes of the saved element a spec removes. */
const without = (...names: string[]): Record<string, undefined> =>
  Object.fromEntries(names.map((name) => [name, undefined]));

/** The names of the saved element's attributes that match `pattern`, as a removal. */
function savedLike(env: BlockEnv, pattern: RegExp): Record<string, undefined> {
  return without(
    ...Object.keys(env.styling.element?.attributes ?? {}).filter((n) => pattern.test(n)),
  );
}

/** A block's environment with the classes matching `drop` (and any class that is a binding) taken out of its class list. */
function withoutClasses(env: BlockEnv, drop: RegExp): BlockEnv {
  const className = env.styling.className
    .split(/\s+/)
    .filter((c) => c !== "" && !drop.test(c) && !c.includes("${"))
    .join(" ");
  return { ...env, styling: { ...env.styling, className } };
}

/**
 * The declarations of `defaults` the block's own rule does not make: a converter that gives an element
 * the look its saved tag had (a button's pointer, a label's box) must not overrule what the author set.
 */
function missing(env: BlockEnv, defaults: JxStyle): JxStyle {
  const own = env.styling.style;
  return Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in own)));
}

const isElement = (node: JxNode | undefined): node is JxElement =>
  node !== undefined && typeof node !== "string";

/**
 * An identifier as a selector writes it: `CSS.escape` (CSSOM 2.1), which a plain "backslash before
 * anything odd" is not. A leading digit (or a hyphen and then a digit) needs a code-point escape, an
 * astral character is ONE code point (two escaped surrogates match nothing), a control character is a
 * code-point escape too, and a character above U+007F is an identifier character as it is.
 */
function cssIdent(id: string): string {
  const points = [...id];
  let out = "";
  points.forEach((ch, i) => {
    const code = ch.codePointAt(0) as number;
    const digit = code >= 0x30 && code <= 0x39;
    if (code === 0) out += "\uFFFD";
    else if (
      (code >= 0x01 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && digit) ||
      (i === 1 && digit && points[0] === "-")
    )
      out += `\\${code.toString(16)} `;
    else if (i === 0 && ch === "-" && points.length === 1) out += `\\${ch}`;
    else if (code >= 0x80 || ch === "-" || ch === "_" || /[0-9A-Za-z]/.test(ch)) out += ch;
    else out += `\\${ch}`;
  });
  return out;
}

/** The dashed-ident that names the popover `id`'s anchor: escaped as an identifier, so no id (`1pop`, `pop.1`) can make an invalid name. */
const anchorName = (id: string): string => `--${cssIdent(`popover-${id}`)}`;

/** `true`, or the string the editor saves a switch as. */
const on = (v: unknown): boolean => v === true || v === "true" || v === 1 || v === "1";

/** A responsive attribute's values by breakpoint key (`{lg: "2", md: "1"}`); anything else is nothing. */
function responsive(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(v) ?? {})) {
    if (
      /^[a-z]+$/.test(key) &&
      (typeof value === "string" || typeof value === "number") &&
      `${value}` !== ""
    )
      out[key] = `${value}`;
  }
  return out;
}

/**
 * A style that sets `property` to `fn(value)` at each breakpoint the attribute has a value for: the
 * main breakpoint is the base, the others are `@--<key>` blocks (the project's `$media`). An empty
 * value is not a value (the editor writes `""` for "unset at this breakpoint").
 */
function perBreakpoint(
  ctx: ConvertCtx,
  values: Record<string, string>,
  fn: (value: string) => JxStyle,
): JxStyle {
  const out: JxStyle = {};
  const bps = ctx.cwicly.breakpoints;
  // Cascade order: min-width breakpoints, the main one, max-width ones.
  for (const bp of bps) {
    const value = values[bp.key];
    if (value === undefined) continue;
    if (bp.isMain) Object.assign(out, fn(value));
    else out[`@--${bp.key}`] = fn(value);
  }
  return out;
}

/**
 * Report a script feature the block uses that no static page can carry. One entry per block, class and
 * feature (`say` keeps one entry per subject, code and `data.detail`).
 */
function dropped(
  ctx: ConvertCtx,
  block: WpBlock,
  feature: string,
  message: string,
  severity: "info" | "warn" = "warn",
): void {
  say(ctx, block, "interaction.dropped", severity, message, { detail: feature, feature });
}

function approximated(ctx: ConvertCtx, block: WpBlock, feature: string, message: string): void {
  say(ctx, block, "interaction.approximated", "info", message, { detail: feature, feature });
}

// ── The script's state classes ──────────────────────────────────────────────────────────────────

/**
 * The classes the scripts toggle on accordions and tabs, and the native state that replaces each. A
 * site's stylesheets select them (Cwicly's own editor writes `.cc-tab-active` rules for a tab list's
 * "active" state), and nothing here sets a class, so every such rule is written again for the state the
 * element has instead. A tab is a label with a radio inside it, an accordion a `<details>`. Each
 * replacement names the element it is the state of: a bare `[open]` or `:not([open])` would match html,
 * body and every dialog of the page, and a `:not([open])` rule would then reach INSIDE an open
 * accordion. `:is(details)` is a compound the class it replaces can stand beside
 * (`.accordion-c1.cc-accordion-active` becomes `.accordion-c1:is(details)[open]`) and weighs what a
 * tag does.
 */
const STATE_SELECTORS: Record<string, string> = {
  "cc-tab-active": ".cc-tab-label:has(> .cc-tab-radio:checked)",
  "cc-tab-hidden": ".cc-tab-label:not(:has(> .cc-tab-radio:checked))",
  "cc-accordion-active": ":is(details)[open]",
  "cc-accordion-hidden": ":is(details):not([open])",
};

/** A state class, with the tag the rule may have put in front of it (`button.cc-tab-active`). */
const STATE_CLASS = new RegExp(
  `(?:(?<![\\w.#:\\[-])[a-z][a-z0-9]*)?\\.(${Object.keys(STATE_SELECTORS).join("|")})(?![\\w-])`,
  "g",
);

/** `selector` with every state class replaced; undefined when it names none. */
function restated(selector: string): string | undefined {
  let found = false;
  const out = selector.replace(STATE_CLASS, (_whole, name: string) => {
    found = true;
    return STATE_SELECTORS[name] as string;
  });
  return found ? out : undefined;
}

/**
 * `style` with every nested selector `rewrite` has an answer for written that way, and whether any was.
 * The block's own rules (its `customCSS`, its `relativeStyles`) are nested keys of its style, at the top
 * and inside the breakpoints and at-rules.
 */
function rewriteKeys(
  style: JxStyle,
  rewrite: (key: string) => string | undefined,
): { style: JxStyle; changed: boolean } {
  let changed = false;
  const walk = (from: JxStyle): JxStyle => {
    const out: JxStyle = {};
    for (const [key, value] of Object.entries(from)) {
      if (!isBlock(value)) {
        out[key] = value as never;
        continue;
      }
      const now = key.startsWith("@") ? undefined : rewrite(key);
      if (now !== undefined) changed = true;
      const target = now ?? key;
      const walked = walk(value);
      const earlier = out[target];
      out[target] = (isBlock(earlier) ? mergeStyle(earlier, walked) : walked) as never;
    }
    return out;
  };
  return { style: walk(style), changed };
}

/**
 * `prepare`, with the state classes the block's own rules select written for the native state, and the
 * stylesheets' rules about them hoisted. Cwicly's `customCSS` is printed inline at render time, so it is
 * in the block's style and not in the stylesheet files `hoistStateRules` reads.
 */
function prepareState(block: WpBlock, ctx: ConvertCtx): BlockEnv | undefined {
  const env = prepare(block, ctx);
  if (!env) return undefined;
  hoistStateRules(ctx, block);
  const { style, changed } = rewriteKeys(env.styling.style, restated);
  if (!changed) return env;
  approximated(
    ctx,
    block,
    "own-state-rules",
    "The block's own rules select the classes the scripts toggle (cc-tab-active, cc-accordion-active…); they are written again for the state the native element has (a checked tab, an open details).",
  );
  return withStyle(env, style);
}

const stateDone = new WeakSet<object>();

/**
 * Write again, for the native state, every rule of the subject's stylesheets that selects a state class.
 * The index holds a rule `.tablist-decor button.cc-tab-active` as the key `& button.cc-tab-active` of
 * the class `tablist-decor`, and a class that is a state itself (`.cc-accordion-active .icon`) as an
 * entry of its own: both are walked once per stylesheet set, and each rule that names a state class is
 * hoisted with the selector it is for now.
 */
function hoistStateRules(ctx: ConvertCtx, block: WpBlock): void {
  if (stateDone.has(ctx.css)) return;
  stateDone.add(ctx.css);
  let count = 0;
  const rule = (selector: string, style: JxStyle): void => {
    count++;
    hoistRule(ctx, block, { selector, style });
  };
  const nested = (owner: string, style: JxStyle, at: string | undefined): void => {
    for (const [key, value] of Object.entries(style)) {
      if (!isBlock(value)) continue;
      if (key.startsWith("@")) {
        nested(owner, value, key);
        continue;
      }
      const selector = key.startsWith("&")
        ? `${owner}${key.slice(1)}`
        : /^[:.[]/.test(key)
          ? `${owner}${key}`
          : `${owner} ${key}`;
      const now = restated(selector);
      if (now !== undefined) rule(now, at === undefined ? value : { [at]: value });
    }
  };
  for (const [name, entry] of ctx.css.classes) {
    const own = restated(`.${name}`);
    if (own !== undefined) rule(own, entry.style);
    else nested(`.${name}`, entry.style, undefined);
  }
  for (const [selector, style] of ctx.css.other) {
    const now = restated(selector);
    if (now !== undefined) rule(now, style);
  }
  if (count > 0) {
    approximated(
      ctx,
      block,
      "state-rules",
      `${count} rule${count === 1 ? "" : "s"} of the stylesheets select the classes the scripts toggle (cc-tab-active, cc-accordion-active…); they are written again for the state the native element has (a checked tab, an open details).`,
    );
  }
}

// ── Accordions ───────────────────────────────────────────────────────────────────────────────────

/** The state classes the script toggles; the open state is the `open` attribute, so none of them is printed. */
const ACCORDION_STATE = /^cc-accordion-(?:active|hidden|transition)$/;

/**
 * The exclusive group a container or an accordion names (`accordionLinked` with `accordionGroup`), as the
 * attribute value it is written as: a literal `${` in it would be evaluated by the build.
 */
function accordionGroup(ctx: ConvertCtx, block: WpBlock): string | undefined {
  const a = block.attrs;
  const group = on(a.accordionLinked) ? text(a.accordionGroup) : undefined;
  return group === undefined ? undefined : literalFinal(ctx, group);
}

/** What the script reads from a component's parameters has no static value: said, and the accordion stays closed and ungrouped. */
function componentAccordion(ctx: ConvertCtx, block: WpBlock): void {
  const a = block.attrs;
  if (text(a.accordionLinkedComp) !== undefined || text(a.accordionGroupComp) !== undefined) {
    dropped(
      ctx,
      block,
      "accordion-group-parameter",
      "The accordion's exclusive group is a component parameter, which a static page cannot read: the accordions of the group are independent.",
    );
  }
}

const accordions: BlockConverter = (block, ctx) => {
  const env = prepareState(block, ctx);
  if (!env) return [];
  componentAccordion(ctx, block);
  const group = accordionGroup(ctx, block);
  const children = ctx.convert(block.innerBlocks);
  if (group !== undefined) {
    for (const node of children) {
      if (isElement(node) && node.tagName === "details" && node.attributes?.name === undefined)
        node.attributes = { ...node.attributes, name: group };
    }
  }
  return assemble(env, {
    tag: "div",
    link: "none",
    children,
    attributes: savedLike(env, /^data-cc-accordions/),
  }).nodes;
};

const accordion: BlockConverter = (block, ctx) => {
  const found = prepareState(block, ctx);
  if (!found) return [];
  const env = withoutClasses(found, ACCORDION_STATE);
  componentAccordion(ctx, block);
  const a = block.attrs;
  const group = accordionGroup(ctx, block);
  const parameter = /!ref=([\w-]+)!/.exec(text(a.accordionOpenComp) ?? "")?.[1];
  let open: AttrValue | undefined = on(a.accordionOpen) ? true : undefined;
  if (parameter !== undefined) {
    const key = ctx.props?.get(parameter);
    if (key !== undefined)
      open = `\${state.${key} === true || state.${key} === 'true' ? true : false}`;
    else
      dropped(
        ctx,
        block,
        "accordion-open-parameter",
        `The accordion's open state is the parameter ${parameter}, which is not one of this component's parameters: it starts closed.`,
      );
  }
  if (a.accordionNoTransition !== true && text(a.accordionTransitionDuration) !== undefined) {
    approximated(
      ctx,
      block,
      "accordion-transition",
      "The accordion opens without the height transition the script animated.",
    );
  }
  return assemble(env, {
    forceTag: "details",
    link: "none",
    children: ctx.convert(block.innerBlocks),
    attributes: {
      ...savedLike(env, /^data-cc-accordion/),
      ...(group === undefined ? {} : { name: group }),
      ...(open === undefined ? {} : { open }),
    },
  }).nodes;
};

const accordionHeader: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, (env) => ({
    forceTag: "summary",
    link: "none",
    children: ctx.convert(block.innerBlocks),
    attributes: { ...savedLike(env, /^(?:data-cc-accordion|aria-expanded)/) },
    // A button has no marker and shows a pointer (`base.css`); a summary has a disclosure triangle.
    style: {
      ...missing(env, { listStyle: "none", cursor: "pointer" }),
      "&::-webkit-details-marker": { display: "none" },
    },
  }));

const accordionContent: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, (env) => ({
    tag: "div",
    link: "none",
    children: ctx.convert(block.innerBlocks),
    attributes: savedLike(env, /^(?:data-cc-accordion|aria-labelledby)/),
  }));

// ── Tabs ─────────────────────────────────────────────────────────────────────────────────────────

/** The tab states the script toggles on tabs and panels; the radio group is the state. */
const TAB_STATE = /^cc-tab(?:-content)?-(?:active|hidden)$/;

const radioId = (group: string, index: number): string => `${group}-tab-${index}`;
const panelId = (group: string, index: number): string => `${group}-panel-${index}`;

/**
 * The id the tab list and its panels name each other by, as the attribute value it is written as. The
 * tab list (`tabContentsID`) and the panels' container (its `id`) each derive it, so both go through the
 * same step: a literal `${` is split once, the same way, on both sides.
 */
function groupOf(ctx: ConvertCtx, raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : literalFinal(ctx, raw);
}

/** The tab buttons are labels around a radio that is there for the keyboard and the state, not to be seen. */
function hoistTabRules(ctx: ConvertCtx, block: WpBlock): void {
  hoistRule(ctx, block, {
    selector: ".cc-tab-radio",
    style: {
      position: "absolute",
      opacity: "0",
      width: "1px",
      height: "1px",
      margin: "0",
      padding: "0",
      pointerEvents: "none",
    },
  });
  hoistRule(ctx, block, {
    selector: ".cc-tab-label:has(> .cc-tab-radio:focus-visible)",
    style: { outline: "2px solid currentcolor", outlineOffset: "2px" },
  });
}

/**
 * One tab of a tab list: a label with the radio that carries its state. `index` is the tab's place among
 * its list's tabs and `active` whether it starts selected.
 */
function tabNodes(
  block: WpBlock,
  ctx: ConvertCtx,
  group: string,
  index: number,
  active: boolean,
): JxNode[] {
  const found = prepareState(block, ctx);
  if (!found) return [];
  const env = withoutClasses(found, TAB_STATE);
  const radio: JxElement = {
    tagName: "input",
    className: "cc-tab-radio",
    attributes: {
      type: "radio",
      name: `${group}-tabs`,
      id: radioId(group, index),
      ...(active ? { checked: true } : {}),
    },
  };
  return assemble(env, {
    forceTag: "label",
    link: "none",
    classes: ["cc-tab-label"],
    children: [radio, ...ctx.convert(block.innerBlocks)],
    attributes: without("type", "role", "tabindex", "aria-selected", "aria-controls"),
    // A button is inline-block, centres its text and shows a pointer; a label is none of those.
    style: missing(env, {
      display: "inline-block",
      position: "relative",
      cursor: "pointer",
      textAlign: "center",
    }),
  }).nodes;
}

const tablist: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  const a = block.attrs;
  const group = groupOf(ctx, text(a.tabContentsID));
  if (group === undefined) {
    dropped(
      ctx,
      block,
      "tabs-unlinked",
      "The tab list names no panels (tabContentsID), so its tabs cannot switch anything: they are kept as plain buttons.",
    );
  } else {
    hoistTabRules(ctx, block);
  }
  if (text(env.styling.element?.attributes["data-cc-tabs-trigger"]) === "hover") {
    approximated(
      ctx,
      block,
      "tabs-hover",
      "The tabs open on hover in the script; here they open when chosen.",
    );
  }
  const tabs = block.innerBlocks.filter((b) => b.name === "cwicly/tab");
  // The plugin prints the list's `tabContentsActive` (1-based) as `data-cc-tabs-default` and its script
  // opens that child, else the first. A tab's own `tabContentActive` only sets its saved aria state.
  const wanted = Number.parseInt(text(a.tabContentsActive) ?? "", 10);
  const active = wanted >= 1 && wanted <= tabs.length ? wanted - 1 : 0;
  let index = 0;
  const children: JxNode[] = [];
  for (const child of block.innerBlocks) {
    if (child.name === "cwicly/tab" && group !== undefined) {
      children.push(...tabNodes(child, ctx, group, index, index === active));
      index++;
    } else {
      children.push(...ctx.convert([child]));
    }
  }
  return assemble(env, {
    tag: "div",
    link: "none",
    children,
    attributes: without(
      "role",
      "aria-orientation",
      "dir",
      "data-cc-tabs",
      "data-cc-tabs-trigger",
      "data-cc-tabs-default",
    ),
  }).nodes;
};

/** A tab outside a tab list has no panels to switch: the button it was. */
const tab: BlockConverter = (block, ctx) => {
  dropped(
    ctx,
    block,
    "tab-orphan",
    "A tab block outside a tab list switches nothing here; it stays a plain button.",
    "info",
  );
  return buildBlock(block, ctx, () => ({
    tag: "button",
    link: "none",
    children: ctx.convert(block.innerBlocks),
    attributes: without("role", "tabindex", "aria-selected", "aria-controls"),
  }));
};

const tabcontents: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  const group = groupOf(ctx, text(env.styling.id) ?? text(block.attrs.id));
  let index = 0;
  const children: JxNode[] = [];
  for (const child of block.innerBlocks) {
    if (child.name === "cwicly/tabcontent" && group !== undefined) {
      children.push(...panelNodes(child, ctx, group, index));
      index++;
    } else {
      children.push(...ctx.convert([child]));
    }
  }
  return assemble(env, {
    tag: "div",
    link: "none",
    children,
    ...(env.styling.id === undefined
      ? {}
      : { attributes: { id: literalFinal(ctx, env.styling.id) } }),
  }).nodes;
};

/** One panel: hidden by a rule while its tab's radio is not the checked one. */
function panelNodes(block: WpBlock, ctx: ConvertCtx, group: string, index: number): JxNode[] {
  const found = prepare(block, ctx);
  if (!found) return [];
  const env = withoutClasses(found, TAB_STATE);
  // The block's id is printed only when it asks (`forceShowID`); a panel the rule names needs one anyway.
  const id = literalFinal(ctx, text(env.styling.id) ?? panelId(group, index));
  hoistRule(ctx, block, {
    // `:has(#radio:not(:checked))` is false when there is no such radio, so a panel without a tab stays visible.
    selector: `:root:has(#${cssIdent(radioId(group, index))}:not(:checked)) #${cssIdent(id)}`,
    style: { display: "none" },
  });
  return assemble(env, {
    tag: "div",
    link: "none",
    children: ctx.convert(block.innerBlocks),
    attributes: { id, ...without("role", "aria-labelledby") },
  }).nodes;
}

const tabcontent: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, () => ({
    tag: "div",
    link: "none",
    children: ctx.convert(block.innerBlocks),
    attributes: without("role", "aria-labelledby"),
  }));

// ── Modals ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The attributes of the modal's shell that only the script reads. `data-preventpagescroll` and
 * `data-closeoverlay` are carried out (the scroll lock and the dimming layer's close button) and the
 * rest is reported where it mattered.
 */
const MODAL_RUNTIME =
  /^data-(?:classid|preventpagescroll|closeoverlay|preventesc|resetscrollposition|modalduration|every|never|upto|after|ccself|openclick|onload|inactive|url|urlcondition|onscroll|scrolldirection|exitintent|addedtocart|hidelogged|scrollelement)$/;

/** What opens a modal by itself: a script's timers and listeners. */
const MODAL_AUTO: Record<string, string> = {
  load: "when the page loads",
  inactivity: "after the visitor is inactive",
  url: "when the address matches",
  scroll: "when the page is scrolled",
  exit: "when the pointer leaves the window",
  addedtocart: "when a product is added to the cart",
  scrollelement: "when an element scrolls into view",
};

/** The flags of a modal the editor can bind to a component parameter, and what each does. */
const MODAL_PARAMETER_FLAGS: [attribute: string, what: string][] = [
  ["modalCloseOverlayComp", "close on a click outside"],
  ["modalPreventScrollComp", "page scroll lock"],
  ["modalPreventEscComp", "Escape key handling"],
  ["modalResetScrollPositionComp", "scroll position reset"],
];

/**
 * A flag the editor bound to a component parameter is written `{component=parameter=…}` into the saved
 * tag, where the plain flag is `true`: no static page can read the instance's value, so the modal is
 * built as if the flag were off, and that is said.
 */
function modalParameters(ctx: ConvertCtx, block: WpBlock): void {
  const bound = MODAL_PARAMETER_FLAGS.filter(
    ([attribute]) => text(block.attrs[attribute]) !== undefined,
  );
  if (bound.length === 0) return;
  dropped(
    ctx,
    block,
    "modal-flag-parameter",
    `The modal's ${bound.map(([, what]) => what).join(", ")} ${bound.length === 1 ? "is a component parameter" : "are component parameters"}, which a static page cannot read: ${bound.length === 1 ? "it is" : "they are"} left off.`,
  );
}

const modal: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  const a = block.attrs;
  const trigger = text(a.modalTriggerWhen);
  if (trigger !== undefined && trigger !== "click") {
    dropped(
      ctx,
      block,
      `modal-trigger-${trigger}`,
      `The modal opens by itself ${MODAL_AUTO[trigger] ?? `on "${trigger}"`}, which takes a script: it opens only from its openers.`,
    );
  } else if (trigger === "click" && text(a.modalTriggerCondition) !== undefined) {
    dropped(
      ctx,
      block,
      "modal-trigger-click",
      `The modal opens when "${text(a.modalTriggerCondition)}" is clicked, which takes a script: it opens only from its openers.`,
    );
  }
  if (text(a.modalTriggerShowAgain) !== undefined && text(a.modalTriggerShowAgain) !== "every") {
    dropped(
      ctx,
      block,
      "modal-show-again",
      "The modal's rule for showing again (a count or a number of days kept in the browser) is a script's.",
    );
  }
  const built: Built = assemble(env, {
    tag: "div",
    link: "none",
    children: ctx.convert(block.innerBlocks),
  });
  const shell = built.nodes[0];
  if (!isElement(shell)) return built.nodes;
  const wrapper = env.styling.wrappers[0];
  const rawId = text(wrapper?.id) ?? text(a.id);
  const id = rawId === undefined ? undefined : literalFinal(ctx, rawId);
  const saved = wrapper?.attributes ?? {};
  modalParameters(ctx, block);
  const closes = saved["data-closeoverlay"] === "true";
  const lockScroll = saved["data-preventpagescroll"] === "true";
  const keepOpen = saved["data-preventesc"] === "true";
  const attributes: NonNullable<JxElement["attributes"]> = { ...shell.attributes };
  for (const name of Object.keys(attributes)) if (MODAL_RUNTIME.test(name)) delete attributes[name];
  if (id !== undefined) attributes.id = id;
  attributes.popover = keepOpen ? "manual" : "auto";
  shell.attributes = attributes;
  // The dimming layer: the plugin's `a.cc-mdl-close` is a click target that closes the modal, which a
  // button with `popovertarget` is; one that closes nothing is a plain box.
  const layer = env.styling.beside.find((b) => b.className.split(/\s+/).includes("cc-mdl-close"));
  const dimmer: JxElement =
    closes && id !== undefined
      ? {
          tagName: "button",
          className: "cc-mdl-close",
          attributes: {
            type: "button",
            "aria-label": "Close",
            popovertarget: id,
            popovertargetaction: "hide",
          },
        }
      : { tagName: "div", className: "cc-mdl-close", attributes: { "aria-hidden": "true" } };
  if (layer !== undefined || closes) shell.children = [dimmer, ...(shell.children as JxNode[])];
  if (id === undefined) {
    dropped(
      ctx,
      block,
      "modal-no-id",
      "The modal has no id, so no opener can name it: it cannot be opened.",
    );
    return built.nodes;
  }
  const selector = `#${cssIdent(id)}`;
  // The plugin shows a modal with `.active` or `:target` (left: 0, the dimmer and the container fade/slide in);
  // the same for the state a popover is in. `.cc-mdl[popover]` outweighs the plugin's `.cc-mdl.active` rules.
  hoistRule(ctx, block, {
    selector: ".cc-mdl[popover]",
    style: {
      margin: "0",
      padding: "0",
      border: "0",
      maxWidth: "none",
      maxHeight: "none",
      color: "inherit",
      background: "transparent",
      inset: "0",
    },
  });
  hoistRule(ctx, block, {
    selector: ".cc-mdl[popover]:not(:popover-open)",
    style: { display: "none" },
  });
  hoistRule(ctx, block, {
    selector: ".cc-mdl[popover]:popover-open",
    style: { left: "0", transition: "opacity var(--modalduration, 0.4s), left 0s" },
  });
  hoistRule(ctx, block, {
    selector: ".cc-mdl[popover]:popover-open > .cc-mdl-close",
    style: { left: "0", opacity: "1", transition: "opacity var(--modalduration, 0.4s), left 0s" },
  });
  hoistRule(ctx, block, {
    selector: ".cc-mdl[popover]:popover-open .cc-modaler",
    style: { opacity: "1", transform: "none" },
  });
  hoistRule(ctx, block, {
    selector: "button.cc-mdl-close",
    style: { border: "0", padding: "0", cursor: "pointer", font: "inherit" },
  });
  if (lockScroll) {
    hoistRule(ctx, block, {
      selector: `body:has(${selector}:popover-open)`,
      style: { overflow: "hidden" },
    });
  }
  return built.nodes;
};

// ── Popovers ─────────────────────────────────────────────────────────────────────────────────────

/** Floating UI's placement as the CSS anchor positioning area that puts the box where it does. */
function positionArea(placement: string): string | undefined {
  const m = /^(top|bottom|left|right)(?:-(start|end))?$/.exec(placement);
  if (!m) return undefined;
  const side = m[1] as "top" | "bottom" | "left" | "right";
  const align = m[2];
  if (align === undefined) return side;
  // `-start` lines the box's start edge with the trigger's start edge, so it extends away from it.
  if (side === "top" || side === "bottom")
    return `${side} ${align === "start" ? "span-right" : "span-left"}`;
  return `${side} ${align === "start" ? "span-bottom" : "span-top"}`;
}

const POPOVER_RUNTIME = /^(?:data-ccp-.*|data-interaction)$/;

const popover: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  const a = block.attrs;
  const options = record(a.popoverOptions) ?? {};
  const trigger = text(options.trigger);
  const triggerType = text(options.triggerType) ?? "click";
  const placement = text(options.placement) ?? "bottom";
  const rawId = text(env.styling.id) ?? text(a.id);
  const id = rawId === undefined ? undefined : literalFinal(ctx, rawId);
  const area = positionArea(placement);
  if (text(options.animation) !== undefined || options.delayDuration || options.delayDurationOut) {
    approximated(
      ctx,
      block,
      "popover-animation",
      "The popover appears without its animation and its show and hide delays.",
    );
  }
  if (options.shift || options.flip) {
    approximated(
      ctx,
      block,
      "popover-flip",
      "The popover does not shift or flip to stay inside the window the way the script did.",
    );
  }
  const offset = Number.parseInt(text(options.offset) ?? "", 10);
  if (offset) {
    approximated(
      ctx,
      block,
      "popover-offset",
      `The popover is not set ${offset}px away from its trigger, as the script placed it.`,
    );
  }
  if (text(options.position) === "fixed") {
    approximated(
      ctx,
      block,
      "popover-position",
      "The popover is not fixed to the window, as the script positioned it: it is placed beside its trigger.",
    );
  }
  if (text(options.hide) !== undefined) {
    approximated(
      ctx,
      block,
      "popover-hide",
      `The popover does not follow the script's hide rule (${text(options.hide)}): it hides when its trigger loses the hover or the focus.`,
    );
  }
  // The id is written as the final attribute value, so the selectors below name what the page has.
  const own = id === undefined ? {} : { id };
  // Opened by an element: show it while that element is hovered or holds the focus.
  if (trigger !== undefined && id !== undefined) {
    if (triggerType !== "hover") {
      approximated(
        ctx,
        block,
        "popover-click",
        `The popover opens when #${trigger} is clicked in the script; here it opens while that element holds the focus (a link or a button does, other elements cannot).`,
      );
    }
    const anchor = anchorName(id);
    const t = `#${cssIdent(trigger)}`;
    const p = `#${cssIdent(id)}`;
    hoistRule(ctx, block, { selector: t, style: { anchorName: anchor } });
    hoistRule(ctx, block, {
      selector: p,
      style: {
        visibility: "hidden",
        opacity: "0",
        pointerEvents: "none",
        positionAnchor: anchor,
        ...(area === undefined ? {} : { positionArea: area }),
        ...(options.flip ? { positionTryFallbacks: "flip-block, flip-inline" } : {}),
      },
    });
    const shown = [
      ...(triggerType === "hover" ? [`:root:has(${t}:hover) ${p}`] : []),
      `:root:has(${t}:focus-within) ${p}`,
      ...(options.interactive
        ? [`:root:has(${p}:hover) ${p}`, `:root:has(${p}:focus-within) ${p}`]
        : []),
    ];
    hoistRule(ctx, block, {
      selector: shown.join(", "),
      style: { visibility: "visible", opacity: "1", pointerEvents: "auto" },
    });
    return assemble(env, {
      tag: "div",
      link: "none",
      children: ctx.convert(block.innerBlocks),
      attributes: { ...savedLike(env, POPOVER_RUNTIME), ...own },
    }).nodes;
  }
  // No trigger: the openers are the buttons of the link module (`popovertarget`), so the box is a native popover.
  if (id === undefined) {
    dropped(ctx, block, "popover-no-id", "The popover has no id, so nothing can open it.");
  } else {
    // A native popover is anchored to the button that opened it (the invoker is its implicit anchor), so
    // the placement is the same area the trigger-element road uses; `inset` must be auto for the area to apply.
    hoistRule(ctx, block, {
      selector: ".popover-box[popover]",
      style: {
        margin: "0",
        padding: "0",
        border: "0",
        maxWidth: "none",
        maxHeight: "none",
        color: "inherit",
        background: "transparent",
        overflow: "visible",
        inset: "auto",
      },
    });
    // The UA hides a closed popover with `display: none`, which a rule of the block's own that sets `display` outweighs.
    hoistRule(ctx, block, {
      selector: ".popover-box[popover]:not(:popover-open)",
      style: { display: "none" },
    });
    if (area !== undefined) {
      hoistRule(ctx, block, {
        selector: `#${cssIdent(id)}[popover]`,
        style: {
          positionArea: area,
          ...(options.flip ? { positionTryFallbacks: "flip-block, flip-inline" } : {}),
        },
      });
    }
  }
  return assemble(env, {
    tag: "div",
    link: "none",
    classes: id === undefined ? [] : ["popover-box"],
    children: ctx.convert(block.innerBlocks),
    attributes: {
      ...savedLike(env, POPOVER_RUNTIME),
      ...own,
      ...(id === undefined ? {} : { popover: "auto" }),
    },
  }).nodes;
};

// ── Sliders ──────────────────────────────────────────────────────────────────────────────────────

/** Swiper's features and the attribute that turns each on; none has a static form. */
const SLIDER_FEATURES: [attribute: string, feature: string, what: string][] = [
  ["sliderAutoPlay", "autoplay", "its autoplay"],
  ["sliderLoop", "loop", "its endless loop"],
  ["sliderFade", "fade", "its fade between slides"],
  ["sliderFreeScroll", "free-scroll", "its free scroll"],
  ["sliderThumbs", "thumbs", "its thumbnail strip"],
  ["sliderController", "controller", "its controller (another slider that follows this one)"],
  ["sliderAdaptiveHeight", "adaptive-height", "its adaptive height"],
  ["sliderHoverPause", "hover-pause", "pausing on hover"],
  ["sliderGrabCursor", "grab-cursor", "its grab cursor"],
];

const slider: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  const a = block.attrs;
  const used = SLIDER_FEATURES.filter(([attribute]) => on(a[attribute]));
  const arrows = (env.styling.inner ?? []).some((s) =>
    s.className.split(/\s+/).includes("swiper-button-prev"),
  );
  const dots = (env.styling.inner ?? []).some((s) =>
    s.className.split(/\s+/).includes("swiper-pagination"),
  );
  const lost = [
    ...used.map(([, , what]) => what),
    ...(arrows ? ["its previous and next arrows"] : []),
    ...(dots ? ["its dots"] : []),
  ];
  if (lost.length > 0) {
    dropped(
      ctx,
      block,
      "slider-features",
      `The slider is a row of slides to scroll and snap to; ${lost.join(", ")} ${lost.length === 1 ? "is" : "are"} Swiper's and not carried over.`,
    );
  }
  approximated(
    ctx,
    block,
    "slider",
    "The slider is a scroll-snap row (touch, wheel and keyboard scrolling) in place of Swiper.",
  );
  const perView = responsive(a.sliderNumberPerWindow);
  const gap = responsive(a.sliderSpaceBetween);
  const vertical =
    a.sliderDirection === "vertical" ||
    text(env.styling.element?.attributes["data-slidedirection"]) === "vertical";
  const style: JxStyle = mergeStyle(
    perBreakpoint(ctx, perView, (v) => ({ "--cc-slides": v })),
    perBreakpoint(ctx, gap, (v) => ({
      "--cc-slide-gap": /^\d+(?:\.\d+)?$/.test(v) ? `${v}px` : v,
    })),
  );
  // The plugin's own `.swiper` hides what overflows and `.swiper-wrapper` is a flex row of 100%-wide slides.
  const scroller: JxElement = {
    tagName: "div",
    className: "swiper",
    children: [
      {
        tagName: "div",
        className: "swiper-wrapper",
        children: ctx.convert(block.innerBlocks),
      },
    ],
  };
  return assemble(env, {
    tag: "div",
    link: "none",
    children: [scroller],
    attributes: savedLike(
      env,
      /^data-(?:slider|slidedirection|autoheight|slides|spacebt|loop|tduration|autoplay|draggable|hoverpause|align|effect|thumbs|free)/,
    ),
    style: {
      ...style,
      "& .swiper": {
        overflowX: vertical ? "hidden" : "auto",
        overflowY: vertical ? "auto" : "hidden",
        scrollSnapType: `${vertical ? "y" : "x"} mandatory`,
        overscrollBehavior: "contain",
        scrollbarWidth: "thin",
      },
      "& .swiper-wrapper": {
        gap: "var(--cc-slide-gap, 0px)",
        ...(vertical ? { flexDirection: "column" } : {}),
      },
      "& .swiper-slide": {
        scrollSnapAlign: "start",
        flex: "0 0 auto",
        width:
          "calc((100% - var(--cc-slide-gap, 0px) * (var(--cc-slides, 1) - 1)) / var(--cc-slides, 1))",
      },
    },
  }).nodes;
};

const sliderchild: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, () => ({
    tag: "div",
    link: "none",
    children: ctx.convert(block.innerBlocks),
  }));

// ── Navigation ───────────────────────────────────────────────────────────────────────────────────

/** The element standing in for an inner block while the saved markup is parsed. */
const INNER = "wp2jx-inner";
const innerMarker = (index: number): string =>
  `<${INNER} data-i="${index}" style="display:block"></${INNER}>`;

/** The block's saved markup with a marker where each inner block goes. */
function savedMarkup(block: WpBlock): string {
  const parts = block.innerContent ?? [block.innerHTML];
  let at = 0;
  let html = "";
  for (const part of parts) html += part === null ? innerMarker(at++) : part;
  for (; at < block.innerBlocks.length; at++) html += innerMarker(at);
  return html;
}

/**
 * The block's saved markup as nodes, its tokens resolved and its addresses moved like any markup's, with
 * the inline siblings (a button, an SVG, a link side by side) kept as children: the default keeps them as
 * one `innerHTML` string, where the inner blocks' markers could not be replaced.
 */
function parseSaved(markup: string, ctx: ConvertCtx, block: WpBlock): JxNode[] {
  const marked = resolveMarked(markup, ctx, block, true);
  const { externalLinks } = contentOptions(ctx);
  return finishNodes(
    htmlNodes(marked, ctx, {
      inlineGaps: "children",
      ...(externalLinks === undefined ? {} : { externalLinks }),
    }),
    () => literalTemplate(ctx),
  );
}

/** The element the saved markup roots at, whatever the conversion wrapped it in. */
function rootOf(nodes: JxNode[], tag: string): JxElement | undefined {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    if (node.tagName === tag) return node;
    const inner = Array.isArray(node.children) ? rootOf(node.children, tag) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** `nodes` with each inner-block marker replaced by the nodes of that inner block. */
function fillInner(nodes: JxNode[], inner: JxNode[][]): JxNode[] {
  return nodes.flatMap((node) => {
    if (!isElement(node)) return [node];
    if (node.tagName === INNER) return inner[Number(node.attributes?.["data-i"])] ?? [];
    if (Array.isArray(node.children)) node.children = fillInner(node.children, inner);
    return [node];
  });
}

const classesOf = (el: JxElement): string[] =>
  (typeof el.className === "string" ? el.className : "").split(/\s+/).filter(Boolean);

const hasClass = (el: JxElement, name: string): boolean => classesOf(el).includes(name);

/** Every element of a forest, parents first. */
function* elementsIn(nodes: readonly JxNode[]): Generator<JxElement> {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    yield node;
    if (Array.isArray(node.children)) yield* elementsIn(node.children);
  }
}

/** A forest without the elements `drop` names. */
function pruned(nodes: JxNode[], drop: (el: JxElement) => boolean): JxNode[] {
  const out: JxNode[] = [];
  for (const node of nodes) {
    if (isElement(node)) {
      if (drop(node)) continue;
      if (Array.isArray(node.children)) node.children = pruned(node.children, drop);
    }
    out.push(node);
  }
  return out;
}

function removeAttributes(el: JxElement, ...names: string[]): void {
  if (!el.attributes) return;
  const rest = { ...el.attributes };
  for (const name of names) delete rest[name];
  if (Object.keys(rest).length === 0) delete el.attributes;
  else el.attributes = rest;
}

function setAttributes(el: JxElement, attrs: Record<string, AttrValue>): void {
  el.attributes = { ...el.attributes, ...attrs };
}

/** Whether `style` holds a nested block (a nested selector or an at-rule). */
const isBlock = (v: unknown): v is JxStyle =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The media query that is the opposite of the breakpoint's: where the nav is NOT in its modal state. */
function complementOf(bp: Breakpoint): string {
  return bp.direction === "min"
    ? `@(max-width: ${bp.width - 0.02}px)`
    : `@(min-width: ${bp.width + 0.02}px)`;
}

/** The breakpoint the nav turns into a modal below, from the key its saved tag (or its attributes) names. */
function modalBreakpoint(ctx: ConvertCtx, key: string | undefined): Breakpoint | undefined {
  if (key === undefined) return undefined;
  return ctx.cwicly.breakpoints.find((b) => b.key === key);
}

/**
 * The block's own rules, with the state the script sets on the nav written as the media query it
 * stands for. Cwicly's editor writes rules for the nav while it is a modal as `&[is-modal=true] …` and
 * for the desktop bar as `&:not([is-modal=true]) …`; the script sets `is-modal` below the breakpoint,
 * and nothing sets it here. The first becomes `&[breakpoint="md"] …` (the saved tag has the
 * attribute), written under the media query when it was not already, and the second the same rule under
 * the opposite media query. A nav that is never modal has no use for the first and keeps the second.
 */
function modalStyle(
  style: JxStyle,
  bp: Breakpoint | undefined,
  ctx: ConvertCtx,
  block: WpBlock,
): JxStyle {
  let changed = false;
  const MODAL = "[is-modal=true]";
  const DESKTOP = ":not([is-modal=true])";
  const walk = (from: JxStyle, inAt: boolean): JxStyle => {
    const out: JxStyle = {};
    const put = (at: string | undefined, key: string, value: unknown): void => {
      if (at === undefined) {
        out[key] = value as never;
        return;
      }
      const into = isBlock(out[at]) ? (out[at] as JxStyle) : {};
      into[key] = value as never;
      out[at] = into;
    };
    for (const [key, value] of Object.entries(from)) {
      if (!isBlock(value) || key.startsWith("@") || !key.includes(MODAL)) {
        out[key] = isBlock(value) && key.startsWith("@") ? walk(value, true) : (value as never);
        continue;
      }
      changed = true;
      if (key.includes(DESKTOP)) {
        const plain = key.replaceAll(DESKTOP, "");
        if (bp === undefined) put(undefined, plain, value);
        else if (!bp.isMain) put(inAt ? undefined : complementOf(bp), plain, value);
      } else if (bp !== undefined) {
        const modal = key.replaceAll(MODAL, `[breakpoint="${bp.key}"]`);
        put(inAt || bp.isMain ? undefined : `@--${bp.key}`, modal, value);
      }
    }
    return out;
  };
  const result = walk(style, false);
  if (changed) {
    approximated(
      ctx,
      block,
      "nav-state-rules",
      "The rules the editor wrote for the nav while it is open as a modal ([is-modal=true]) are written for the breakpoint's media query, and the desktop-only ones for the opposite query: the script that set the state is not carried.",
    );
  }
  return result;
}

function withStyle(env: BlockEnv, style: JxStyle): BlockEnv {
  return { ...env, styling: { ...env.styling, style } };
}

/** The `<wp2jx-menu>` placeholder of a menu block: the menu's id and the block's own options. */
function menuPlaceholder(block: WpBlock): JxElement {
  const a = block.attrs;
  const id = text(a.menuSelected);
  const options = Object.fromEntries(
    Object.entries(a).filter(([key]) => /^menu[A-Z]/.test(key) && key !== "menuItems"),
  );
  return placeholder(
    { ...block, attrs: options },
    "menu",
    "",
    id !== undefined && /^\d+$/.test(id) ? { "data-menu": id } : {},
  );
}

/**
 * The rules every dropdown needs, whatever the nav: the script showed `.cc-nav-dropdown__content` by
 * switching `aria-hidden` and placing it with Floating UI; here it is shown while its item is
 * hovered or holds the focus, under the item.
 */
function hoistDropdownRules(ctx: ConvertCtx, block: WpBlock): void {
  hoistRule(ctx, block, { selector: ".cc-nav-dropdown", style: { position: "relative" } });
  hoistRule(ctx, block, {
    selector: ".cc-nav-dropdown > .cc-nav-dropdown__content",
    style: {
      top: "100%",
      left: "0",
      visibility: "hidden",
      opacity: "0",
      transition:
        "opacity var(--cc-nav-da-duration, 0.3s) ease-in-out, visibility var(--cc-nav-da-duration, 0.3s)",
    },
  });
  hoistRule(ctx, block, {
    selector:
      ".cc-nav-dropdown:hover > .cc-nav-dropdown__content, .cc-nav-dropdown:focus-within > .cc-nav-dropdown__content",
    style: { visibility: "visible", opacity: "1" },
  });
}

/**
 * What the nav looks like while it is the open modal, written for the media query it applies in: the
 * plugin's `[is-modal=true] …` rules (build/style-index.css) for the parts this conversion keeps, and
 * the wrapper as a popover. Selectors name the breakpoint's attribute, which the saved tag has.
 */
function hoistModalRules(ctx: ConvertCtx, block: WpBlock, bp: Breakpoint): void {
  const nav = `.cc-nav[breakpoint="${bp.key}"]`;
  const wrap = (style: JxStyle): JxStyle => (bp.isMain ? style : { [`@--${bp.key}`]: style });
  const rule = (selector: string, style: JxStyle): void =>
    hoistRule(ctx, block, { selector, style: wrap(style) });
  // A popover that is not open is `display: none`; outside the modal state the wrapper is the plain box it was, so every
  // property the UA gives a popover is put back (at the specificity of the plugin's own modal rule or below it).
  hoistRule(ctx, block, {
    selector: ":where(.cc-nav[breakpoint]) > .cc-nav-wrapper[popover]",
    style: {
      display: "block",
      position: "static",
      inset: "auto",
      width: "auto",
      height: "auto",
      maxWidth: "none",
      maxHeight: "none",
      margin: "0",
      padding: "0",
      border: "0",
      overflow: "visible",
      color: "inherit",
      background: "transparent",
    },
  });
  rule(`${nav} > .cc-nav-toggle`, { display: "block" });
  rule(`${nav} > .cc-nav-wrapper[popover]:not(:popover-open)`, { display: "none" });
  rule(`${nav} > .cc-nav-wrapper[popover]:popover-open`, {
    display: "block",
    visibility: "visible",
    inset: "0 auto auto 0",
    margin: "0",
  });
  rule(`${nav}[d-placement="right"] > .cc-nav-wrapper[popover]:popover-open`, {
    inset: "0 0 auto auto",
  });
  rule(`${nav}[modal="fullscreen"] > .cc-nav-wrapper[popover]`, { "--cc-nav-m-width": "100%" });
  rule(`${nav} > .cc-nav-wrapper[popover]::backdrop`, { background: "rgba(0, 0, 0, 0.5)" });
  rule(`${nav} .cc-nav-header`, { display: "flex" });
  rule(`${nav} .cc-nav-content`, { flexDirection: "column" });
  rule(`${nav} .cc-nav-items`, { flexDirection: "column" });
  rule(`${nav} .cc-nav-item`, { width: "100%" });
  rule(`${nav} .cc-nav__section`, { flexDirection: "column", padding: "0" });
  // The sublevel panels the script slid in are one list here: the dropdowns are open, inline, and need no caret.
  rule(`${nav} .cc-nav-dropdown > .cc-nav-dropdown__content`, {
    position: "static",
    visibility: "visible",
    opacity: "1",
    width: "100%",
    transform: "none",
  });
  rule(`${nav} .cc-nav-dropdown__button--icon`, { display: "none" });
  rule(`body:has(${nav} > .cc-nav-wrapper[popover]:popover-open)`, { overflow: "hidden" });
}

const nav: BlockConverter = (block, ctx) => {
  const found = prepare(block, ctx);
  if (!found) return [];
  const a = block.attrs;
  const saved = found.styling.element?.attributes ?? {};
  const bp = modalBreakpoint(ctx, text(saved.breakpoint) ?? text(a.menuModalBreakpoint));
  const env = withStyle(found, modalStyle(found.styling.style, bp, ctx, block));
  const inner = block.innerBlocks.map((child) => ctx.convert([child]));
  const tree = rootOf(parseSaved(savedMarkup(block), ctx, block), found.styling.tag ?? "div");
  if (tree === undefined || !Array.isArray(tree.children)) {
    dropped(
      ctx,
      block,
      "nav-markup",
      "The nav's saved markup could not be read; its inner blocks are kept without the wrapper, header and toggle.",
    );
    return assemble(env, { tag: "div", link: "none", children: inner.flat() }).nodes;
  }
  let chrome = fillInner(tree.children, inner);
  if (JSON.stringify(chrome).includes(`<${INNER}`)) {
    dropped(
      ctx,
      block,
      "nav-inner",
      "An inner block of the nav could not be placed in its markup.",
    );
  }
  // The dimming link is the popover's `::backdrop` now.
  chrome = pruned(chrome, (el) => hasClass(el, "cc-nav-backdrop"));
  const wrapperId = `${text(found.styling.id) ?? text(a.id) ?? text(a.classID) ?? "nav"}-wrapper`;
  const toggle = [...elementsIn(chrome)].find((el) => hasClass(el, "cc-nav-toggle"));
  const close = [...elementsIn(chrome)].find((el) => hasClass(el, "cc-nav-toggle--close"));
  const wrapper = [...elementsIn(chrome)].find((el) => hasClass(el, "cc-nav-wrapper"));
  if (bp !== undefined && wrapper !== undefined) {
    setAttributes(wrapper, { id: wrapperId, popover: "auto" });
    if (toggle !== undefined) {
      toggle.tagName = "button";
      setAttributes(toggle, {
        type: "button",
        popovertarget: wrapperId,
        popovertargetaction: "show",
      });
    }
    if (close !== undefined) {
      removeAttributes(close, "disabled", "aria-hidden");
      setAttributes(close, {
        type: "button",
        "aria-label": "Close menu",
        popovertarget: wrapperId,
        popovertargetaction: "hide",
      });
      // The animated hamburger is one control that turns into a cross; here the open panel covers it, so the
      // cross is drawn on the close button from the toggle's own lines.
      if (
        hasClass(close, "cc-hamburger") &&
        (close.children === undefined ||
          (Array.isArray(close.children) && close.children.length === 0))
      ) {
        const type =
          toggle === undefined
            ? undefined
            : classesOf(toggle).find((c) => c.startsWith("cc-hamburger-"));
        close.className = joinClass(close.className, "active", type);
        if (toggle !== undefined && Array.isArray(toggle.children)) {
          close.children = structuredClone(toggle.children);
        }
      }
    }
    hoistModalRules(ctx, block, bp);
    approximated(
      ctx,
      block,
      "nav-modal",
      `Below the ${bp.key} breakpoint the menu opens as a popover from the hamburger, with the page behind it dimmed; its slide or fade animation, the sliding sublevel panels and the animated hamburger are not carried over.`,
    );
  } else if (bp !== undefined) {
    dropped(
      ctx,
      block,
      "nav-no-wrapper",
      "The nav has a mobile breakpoint but no wrapper to open: it stays the desktop bar.",
    );
  }
  if (toggle !== undefined && bp === undefined) chrome = pruned(chrome, (el) => el === toggle);
  hoistDropdownRules(ctx, block);
  return assemble(env, {
    tag: "div",
    link: "none",
    children: chrome,
    // The script's dropdown animations are keyed on this attribute and on `aria-hidden`, which no longer exist.
    attributes: without("animation", "open-dropdown", "sublevel"),
  }).nodes;
};

const navitems: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, () => ({
    tag: "ul",
    link: "none",
    children: ctx.convert(block.innerBlocks),
  }));

/** A nav link: the list item and the anchor `cc-nav-item` the plugin's stylesheet targets. */
const navlink: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, (env) => {
    const link = env.link;
    const content = inlineContent(block, ctx);
    const hasAnchor =
      content !== undefined &&
      (/<a\b/i.test(content.innerHTML ?? "") ||
        (content.children ?? []).some((c) => isElement(c) && c.tagName === "a"));
    if (hasAnchor) {
      // The author's own link is inside the text; a second one around it would nest anchors.
      say(
        ctx,
        block,
        "nav.nested-link",
        "info",
        "The nav link's text holds its own link, so the link wrapper is not added around it (anchors cannot nest).",
        { detail: "nested-link" },
      );
      return { forceTag: "li", link: "none", ...(content ? { content } : {}) };
    }
    const opener = triggerOf(link?.action);
    const anchor: JxElement = opener
      ? { tagName: opener.tag, className: "cc-nav-item", attributes: opener.attributes, ...content }
      : {
          tagName: "a",
          className: "cc-nav-item",
          ...(link === undefined || Object.keys(linkAttributes(link)).length === 0
            ? {}
            : { attributes: linkAttributes(link) }),
          ...content,
        };
    // A list item whatever the author chose for the tag (a real block saved a `<button>` inside the list).
    return { forceTag: "li", link: "none", children: [anchor] };
  });

/**
 * A dropdown: the saved markup (its title link, its toggle button and the content with its groups of
 * links, or the inner blocks of a custom dropdown) with the state the script wrote taken out, because
 * the stylesheet shows the content while its item is hovered or focused.
 */
const navdropdown: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  const inner = block.innerBlocks.map((child) => ctx.convert([child]));
  const tree = rootOf(parseSaved(savedMarkup(block), ctx, block), env.styling.tag ?? "li");
  if (tree === undefined || !Array.isArray(tree.children)) {
    dropped(
      ctx,
      block,
      "nav-dropdown-markup",
      "The dropdown's saved markup could not be read: its title is kept without the links.",
    );
    return assemble(env, { tag: "li", link: "none", children: inner.flat() }).nodes;
  }
  const chrome = fillInner(tree.children, inner);
  for (const el of elementsIn(chrome)) {
    if (hasClass(el, "cc-nav-dropdown__content")) removeAttributes(el, "aria-hidden");
    if (hasClass(el, "cc-nav-dropdown__button--icon"))
      removeAttributes(el, "aria-expanded", "is-trigger");
  }
  hoistDropdownRules(ctx, block);
  if (text(block.attrs.menuDropdownOpenOn) === "click") {
    approximated(
      ctx,
      block,
      "dropdown-click",
      "The dropdown opens on click in the script; here it opens while the item is hovered or focused.",
    );
  }
  const a = block.attrs;
  const placement = text(a.menuDropdownPlacement);
  const offset = Object.values(record(a.menuDropdownOffset) ?? {}).some(
    (v) => text(v) !== undefined,
  );
  const full = on(a.menuDropdownFullwidth);
  const chosen = [
    ...(placement === undefined ? [] : [`placement (${placement})`]),
    ...(offset ? ["offset"] : []),
    ...(full ? ["full width"] : []),
  ];
  if (chosen.length > 0) {
    approximated(
      ctx,
      block,
      "dropdown-placement",
      `The dropdown's ${chosen.join(", ")} are Floating UI's: here the content opens under its item, level with the item's left edge, with no gap and no full-width panel.`,
    );
  }
  return assemble(env, { tag: "li", link: "none", children: chrome }).nodes;
};

// ── Menus ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A horizontal menu's script puts the class `active` on the item that is hovered, and the block's
 * own rule shows the dropdown of `li.active`. Nothing here sets the class, so the rule names the state
 * the item has instead: hovered, or holding the focus (the script's keyboard handling did the same). A
 * pseudo-class weighs what the class did, so the open rule still outweighs the closed one.
 */
const MENU_ACTIVE = /(?<![\w-])li\.active(?![\w-])/g;

function menuActive(key: string): string | undefined {
  const now = key.replaceAll(MENU_ACTIVE, "li:is(:hover, :focus-within)");
  return now === key ? undefined : now;
}

/** `<nav aria-label>` around the placeholder the menus emitter replaces with the menu's own list. */
const menu: BlockConverter = (block, ctx) => {
  const found = prepare(block, ctx);
  if (!found) return [];
  const { style, changed } = rewriteKeys(found.styling.style, menuActive);
  if (changed) {
    approximated(
      ctx,
      block,
      "menu-dropdown",
      "The menu's dropdowns open while their item is hovered or holds the focus, where the script put an active class on the hovered item.",
    );
  }
  // A vertical menu's script opens an item's dropdown with a click (a slide down, the class `active`). The
  // click gives the item's link the focus, which keeps the dropdown open until the focus leaves.
  const vertical = Object.fromEntries(
    Object.entries(responsive(block.attrs.menuLayout)).filter(
      ([, layout]) => layout === "vertical",
    ),
  );
  const expand = perBreakpoint(ctx, vertical, () => ({
    "& ul.cc-menu li:focus-within > .cc-menu-dropdown": { display: "block" },
  }));
  if (Object.keys(vertical).length > 0) {
    approximated(
      ctx,
      block,
      "menu-vertical",
      "The vertical menu's dropdowns open while their item holds the focus (a click on its link gives it), not by the script's click that toggles them.",
    );
  }
  return assemble(withStyle(found, style), {
    tag: "nav",
    link: "none",
    children: [menuPlaceholder(block)],
    style: expand,
  }).nodes;
};

/** A menu with no element of its own: the saved markup is `{nav_menu=<id>}` and nothing else. */
const navmenu: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  const node = menuPlaceholder(block);
  if (env.visibility.hidden === undefined && env.visibility.deviceHide === undefined) return [node];
  return assemble(env, { tag: "div", link: "none", children: [node] }).nodes;
};

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────

/** What a filter's own templates are, as the control they stand for. */
const TEMPLATE_TYPE: Record<string, string> = {
  filtercheckbox: "checkbox",
  filterradio: "radio",
  filtersearch: "search",
};

/** The attributes an input block's attributes give it when its saved markup has no tag to read them from. */
function inputAttributes(ctx: ConvertCtx, a: Record<string, unknown>): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  const set = (name: string, value: unknown): void => {
    if (typeof value === "string" && value !== "") out[name] = literalFinal(ctx, value);
    else if (typeof value === "number") out[name] = value;
  };
  set("type", a.inputType);
  set("name", a.inputName);
  set("placeholder", a.inputPlaceholder);
  set("value", a.inputValue);
  set("autocomplete", a.inputAutocomplete);
  set("pattern", a.inputPattern);
  set("title", a.inputTitle);
  set("min", a.inputMin);
  set("max", a.inputMax);
  set("step", a.inputStep);
  set("minlength", a.inputMinLength);
  set("maxlength", a.inputMaxLength);
  for (const [attribute, name] of [
    ["inputRequired", "required"],
    ["inputDisabled", "disabled"],
    ["inputReadonly", "readonly"],
    ["inputChecked", "checked"],
    ["inputMultiple", "multiple"],
    ["inputAutofocus", "autofocus"],
  ] as const) {
    if (on(a[attribute])) out[name] = true;
  }
  return out;
}

const input: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, (env) => {
    const a = block.attrs;
    const template = text(a.inputTemplate);
    const saved = env.styling.element?.attributes ?? {};
    if (template?.startsWith("comment")) {
      dropped(
        ctx,
        block,
        "comment-form",
        "The control belongs to a comment form, which WordPress posts to its own server: it stays on the page, and posts nothing.",
      );
    }
    const handlers = Object.keys(saved).filter((n) => /^on[a-z]+$/.test(n));
    if (handlers.length > 0) {
      dropped(
        ctx,
        block,
        "input-handlers",
        `The control's inline script (${handlers.join(", ")}) is not carried over.`,
        "info",
      );
    }
    const type = TEMPLATE_TYPE[template ?? ""];
    const textarea = env.styling.tag === "textarea" || template === "commenttextarea";
    return {
      tag: textarea ? "textarea" : "input",
      link: "none",
      attributes: {
        ...without(...handlers),
        ...(env.styling.element === undefined ? inputAttributes(ctx, a) : {}),
        ...(type !== undefined && saved.type === undefined ? { type } : {}),
      },
    };
  });

// ── Filters ──────────────────────────────────────────────────────────────────────────────────────

/** A list of ids as the editor saves it: numbers, numeric strings or `{value}` objects. */
function idsOf(v: unknown): number[] {
  const list = Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v];
  return list
    .map((item) => Number(record(item)?.value ?? item))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * How MySQL's `utf8mb4_unicode_ci` compares two names, as near as the runtime can: letters by their base
 * letter, so case and accents do not count (`Apple`, `eagle`, `Épée`, `Zebra`), where a comparison of
 * code units puts every accented letter after `z`.
 */
const collation = new Intl.Collator("en", { sensitivity: "base" });

/**
 * The terms a taxonomy filter lists, chosen and ordered as the `WP_Term_Query` the live filter runs would
 * for its arguments. The frontend script sends the taxonomy list, `include`, `exclude`, `orderby`,
 * `order`, `childless` and `hide_empty`, and nothing else: `filterParent` and `filterMaximum` belong to the
 * editor's own preview (and `filterMaximum` is a boolean there), so neither is read. WordPress clears
 * `exclude` when `include` is set.
 */
function filterTerms(
  ctx: ConvertCtx,
  taxonomies: readonly string[],
  a: Record<string, unknown>,
): WpTerm[] {
  const all = [...ctx.model.terms.values()].filter((t) => taxonomies.includes(t.taxonomy));
  let terms = all;
  if (on(a.filterHideEmpty)) terms = terms.filter((t) => t.count > 0);
  if (on(a.filterChildless)) terms = terms.filter((t) => !all.some((o) => o.parent === t.termId));
  const include = idsOf(a.filterInclude);
  const exclude = include.length > 0 ? [] : idsOf(a.filterExclude);
  if (include.length > 0) terms = terms.filter((t) => include.includes(t.termId));
  if (exclude.length > 0) terms = terms.filter((t) => !exclude.includes(t.termId));
  const by = text(a.filterOrderBy) ?? "name";
  const key = (t: WpTerm): string | number =>
    by === "count"
      ? t.count
      : by === "id" || by === "term_id"
        ? t.termId
        : by === "slug"
          ? t.slug
          : decodeEntities(t.name);
  const sign = text(a.filterOrder)?.toLowerCase() === "desc" ? -1 : 1;
  return [...terms].sort((x, y) => {
    const kx = key(x);
    const ky = key(y);
    const order =
      typeof kx === "number" && typeof ky === "number"
        ? kx - ky
        : collation.compare(String(kx), String(ky));
    return (order === 0 ? x.termId - y.termId : order) * sign;
  });
}

/** A filter's template block for one term: the `{filter=…}` tokens and the `dynamic: "filter"` text it holds written out. */
function termTemplate(block: WpBlock, term: WpTerm): WpBlock {
  const name = decodeEntities(term.name);
  const values: Record<string, string> = {
    name,
    slug: term.slug,
    id: String(term.termId),
    count: String(term.count),
    description: decodeEntities(term.description),
  };
  const fill = (s: string): string =>
    s.replaceAll(/\{filter=([a-z_]+)\}/g, (whole, field: string) => {
      const value = values[field];
      return value === undefined ? whole : escapeHtml(value);
    });
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block.attrs)) {
    attrs[key] = typeof value === "string" ? fill(value) : value;
  }
  if (attrs.dynamic === "filter") {
    const field = text(attrs.dynamicWordPressType) ?? "name";
    delete attrs.dynamic;
    delete attrs.dynamicWordPressType;
    attrs.content = escapeHtml(values[field] ?? name);
  }
  return {
    ...block,
    attrs,
    innerHTML: fill(block.innerHTML),
    innerContent: block.innerContent.map((part) => (part === null ? part : fill(part))),
    innerBlocks: block.innerBlocks.map((child) => termTemplate(child, term)),
  };
}

const filter: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  const a = block.attrs;
  const type = text(a.filterType) ?? "";
  const rootAttributes = without("cc-filter", "data-filter-q_id", "data-filter-target");
  const empty = (): JxNode[] =>
    assemble(env, { tag: "div", link: "none", attributes: rootAttributes }).nodes;

  if (type === "userselection" || type === "clearselection") {
    say(
      ctx,
      block,
      "filter.static",
      "info",
      type === "userselection"
        ? "The filter shows what the visitor has chosen in the other filters, which a static page never has: it is left empty, as the live page prints it before anything is chosen."
        : "The filter clears the visitor's choices in the other filters, and a static page has none: it is left empty.",
      { detail: type, filterType: type },
    );
    return empty();
  }

  // The live filter asks for the terms of EVERY taxonomy its data names, in one query.
  const taxonomies = [
    ...new Set(
      (Array.isArray(a.filterData) ? a.filterData : []).flatMap(
        (d) => text(record(d)?.value) ?? [],
      ),
    ),
  ];
  const taxonomy = taxonomies.join(", ");
  if (a.filterSource === "dynamic" && a.filterDataType === "taxonomy" && taxonomies.length > 0) {
    const terms = filterTerms(ctx, taxonomies, a);
    if (terms.length === 0) {
      say(
        ctx,
        block,
        "filter.static",
        "warn",
        `The filter lists the terms of ${taxonomy}, and the site has none that it would show: it is left empty.`,
        { detail: `${taxonomy}|empty`, taxonomy },
      );
      return empty();
    }
    approximated(
      ctx,
      block,
      "filter-taxonomy",
      `The filter narrows a list in place with a script; each term of ${taxonomy} is a link to its archive page instead, which is the same list already narrowed.`,
    );
    const template = block.innerBlocks[0];
    const items: JxNode[] = [];
    let unlinked = 0;
    for (const term of terms) {
      const url = ctx.urlFor("term", term.termId);
      if (url === undefined) unlinked++;
      const name = decodeEntities(term.name);
      let content: JxNode[];
      // The live checkbox, button and list filters print no count (a count shows only where a query supplies
      // a counter), and a number written now would go stale: `{filter=count}` in a template is the term's own.
      if (template === undefined || template.name === "cwicly/input") {
        content = [name];
      } else {
        content = ctx.convert([termTemplate(template, term)]);
      }
      // A `display: contents` anchor takes no focus (Chrome's `focus()` returns false), so no keyboard visitor
      // could reach the link: the anchor is a box of its own.
      const wrapped: JxElement =
        url === undefined
          ? { tagName: "span", children: content }
          : { tagName: "a", attributes: { href: url }, children: content };
      items.push(
        template === undefined || template.name === "cwicly/input"
          ? { tagName: "li", children: [wrapped] }
          : wrapped,
      );
    }
    if (unlinked > 0) {
      say(
        ctx,
        block,
        "filter.static",
        "warn",
        `${unlinked} term${unlinked === 1 ? "" : "s"} of ${taxonomy} have no archive page on the converted site, so their filter options are not links.`,
        { detail: `${taxonomy}|unlinked`, taxonomy, count: unlinked },
      );
    }
    const list = template === undefined || template.name === "cwicly/input";
    return assemble(env, {
      tag: "div",
      link: "none",
      attributes: rootAttributes,
      children: list
        ? [
            {
              tagName: "ul",
              style: { listStyle: "none", margin: "0", padding: "0" },
              children: items,
            },
          ]
        : items,
    }).nodes;
  }

  say(
    ctx,
    block,
    "filter.static",
    "warn",
    type === "custom" && a.filterSource === "userinput"
      ? `The filter is a search box that narrows a query as the visitor types; a static page cannot run a query, so its controls are kept and do nothing.`
      : `The filter narrows a query by ${text(a.filterSource) ?? "a value"}${text(a.filterDataType) ? ` (${text(a.filterDataType)})` : ""}, which a static page cannot do: it is left empty.`,
    { detail: `${type}|${text(a.filterSource) ?? ""}`, filterType: type },
  );
  if (a.filterSource === "userinput") {
    return assemble(env, {
      tag: "div",
      link: "none",
      attributes: rootAttributes,
      children: ctx.convert(block.innerBlocks),
    }).nodes;
  }
  return empty();
};

/** A range slider only has a meaning as a filter of a query. */
const rangeslider: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, () => {
    say(
      ctx,
      block,
      "filter.static",
      "warn",
      "The range slider sets the range a query is filtered by, which a static page cannot do: it is left empty.",
      { detail: "rangeslider", feature: "rangeslider" },
    );
    return { tag: "div", link: "none" };
  });

/** A swatch shows the colour or image of a WooCommerce product attribute, and there is no shop. */
const swatch: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  say(
    ctx,
    block,
    "block.unsupported",
    "warn",
    "The swatch shows a WooCommerce product attribute, and the converted site has no shop: it is left out.",
    { detail: "swatch", feature: "woocommerce", swatch: text(block.attrs.swatchSlug) ?? null },
  );
  return [];
};

// ── The table ────────────────────────────────────────────────────────────────────────────────────

export const interactiveConverters: Record<string, BlockConverter> = {
  "cwicly/accordions": accordions,
  "cwicly/accordion": accordion,
  "cwicly/accordionheader": accordionHeader,
  "cwicly/accordioncontent": accordionContent,
  "cwicly/tablist": tablist,
  "cwicly/tab": tab,
  "cwicly/tabcontents": tabcontents,
  "cwicly/tabcontent": tabcontent,
  "cwicly/modal": modal,
  "cwicly/popover": popover,
  "cwicly/slider": slider,
  "cwicly/sliderchild": sliderchild,
  "cwicly/nav": nav,
  "cwicly/navitems": navitems,
  "cwicly/navlink": navlink,
  "cwicly/navmenu": navmenu,
  "cwicly/navdropdown": navdropdown,
  "cwicly/menu": menu,
  "cwicly/input": input,
  "cwicly/filter": filter,
  "cwicly/rangeslider": rangeslider,
  "cwicly/swatch": swatch,
};
