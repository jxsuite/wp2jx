/**
 * Navigation menus: WordPress `nav_menu` terms (and the block-based `wp_navigation` posts) as the
 * markup the Cwicly `{menu}` token prints, so the plugin's own stylesheet and the block's generated
 * rules style it unchanged.
 *
 * ## What is rendered
 *
 * {@link menuNodes} turns one menu into Jx nodes. The structure is `cc_menu_maker`'s
 * (`core/includes/dynamic/cc-menu.php`), checked against the live headers in
 * `tests/fixtures/<site>/html`: `<ul class="cc-menu hor|ver">` holding one `<li><a class="cc-menu-main
 * menu-id-N …">` per top-level item, and for an item with children an `aria-haspopup` anchor followed by
 * `<ul class="cc-menu-dropdown" aria-label="Title">` (the same again below it, with `cc-menu-sub`).
 *
 * - **The tree** is WordPress's. Items are the published `nav_menu_item`s of the menu term in
 *   `menu_order`; an item belongs under the item named by its parent; an item whose parent is not in
 *   the menu is unreachable (`cc_build_tree` starts at the roots), and so is everything below an item
 *   WordPress would not show.
 * - **Titles** are what the menu prints: the item's own title when it has one, printed as stored (it
 *   is HTML, so `Missions &amp; Evangelism` is an ampersand and a title may hold `<em>`), else the
 *   target's. Only a title taken from a post goes through `wptexturize`, because that is the one
 *   place WordPress's `the_title` filter runs; a title the author typed is printed raw, curly quotes
 *   and all or not.
 * - **Links** are the target's address in the Jx site, never the stored `_menu_item_url` of an object
 *   item (WordPress recomputes it from the object, and the stored one is stale): a page or entry
 *   through the route table (`site.urls`), a term the same, a post-type archive by its type. A custom
 *   link goes through `rewriteUrl`. `target`, the XFN `rel` and the link's title attribute
 *   (`post_excerpt`) are carried.
 * - **Classes** are `cc-menu-main` / `cc-menu-sub`, `menu-id-<item id>`, then the classes the author
 *   typed. The classes WordPress generates for the item (`menu-item`, `menu-item-type-*`,
 *   `menu-item-object-*`, `menu-item-home`, `current-menu-*`, `current_page_*`, `page_item`…) are
 *   not carried: they are stored in the item's meta from the moment it was last saved in the editor
 *   (`current_page_parent` is on fineline's Blog item for good), name no rule in either site's
 *   stylesheets, and WordPress itself recomputes the current ones per request.
 * - **Icons**: a parent item gets the block's main or sub-menu icon (`menuMainMenuIconUnicode`,
 *   `…Position`) inside its link, before or after the title.
 * - **The block's options** (`menuLayout`, the icon settings) come from the `cwicly/menu` block that
 *   made the placeholder, with the plugin's own defaults (`block.json`) for what it did not save.
 *
 * ## What changed, because the plugin's script is not ported
 *
 * `cc-menu-new.min.js` opened a dropdown by putting `.active` on the hovered `<li>` (the block's own
 * rule is `li.active > .cc-menu-dropdown { visibility: visible; opacity: 1 }`), moved the focus with the
 * arrow keys, and made the vertical layout an accordion that slides open on click. Here the list
 * carries its own two rules: a dropdown shows while its item is hovered or holds focus (`:hover`,
 * `:focus-within`), and in the vertical layout, whose block rule is `display: none`, it is displayed.
 * They are written to outrank the block's hiding rules by specificity alone (the test compares them
 * over the real stylesheets). A parent whose link goes nowhere (an empty or `#` address, the usual
 * dropdown label) has no `href` and `tabindex="0"`, so it can be focused and does not reload the page;
 * every link stays in the tab order, which is what lets `:focus-within` open a dropdown for a keyboard
 * user. The ARIA tree the script managed (`role="tree"`, `treeitem`, `aria-owns`, `aria-expanded`, the
 * `cc-menu-N` ids) is not written: a tree role promises arrow-key navigation that no longer exists, and
 * a static `aria-expanded="false"` would be false whenever a dropdown is open (reported once per menu as
 * `menu.script-dropped`).
 *
 * **The vertical layout's parents.** The script's accordion cancelled the click on every item with
 * children, so a parent's link never navigated there. A parent whose link goes somewhere is therefore
 * written as the dropdown's label (no `href`, focusable) with its own link as the first item inside the
 * list, the shape fineline's live "Services" / "All Services" already has (`menu.vertical-link`).
 *
 * **The current page** (`{currentpageclass}`; `a.current` and `aria-current="page"` on the link whose address
 * is the page's) cannot be known at build time: a menu is one component shared by every page. Nothing is
 * written for it and `menu.current-page` says so. {@link CURRENT_PAGE_SCRIPT} is the Jx-side mechanism (a few
 * lines for the page's `$head`, adding `current` and `aria-current` to the anchor whose pathname equals
 * `location.pathname`) and `MenusUsed.currentPage` tells the assembler a page needs it; anabaptistperspectives'
 * main menu is the one place a rule depends on it (`.menu-ccb55e8 .cc-menu > li > a.current`).
 *
 * ## The other two sources
 *
 * - **`cwicly/navmenu`** (`{nav_menu=ID}`, inside a `cwicly/nav`) prints the `cc-nav` family
 *   (`NavMenu::wp_nav_maker`): `li.cc-nav-link > a.cc-nav-item`, and for a parent `li.cc-nav-dropdown`
 *   with its button, its content and one `cc-nav__submenu-list` per group. It is rendered as list
 *   items (the nav block supplies the `<ul>`); the mega-menu extras (sub-level buttons, caret, group
 *   dividers, the second "footer" body) are simplified, `menu.navmenu-simplified`.
 * - **`wp_navigation`** (a `core/navigation` block, by `ref` or with its links inline) is a block
 *   list: `core/navigation-link` and `core/navigation-submenu`, rendered as core prints them
 *   (`nav.wp-block-navigation > ul.wp-block-navigation__container > li.wp-block-navigation-item`). The
 *   responsive overlay (hamburger) is core's script and is not carried, `menu.navigation-simplified`.
 *
 * ## Which menu
 *
 * A placeholder names a menu by its term id (`data-menu`). A menu block whose id the converter could not
 * write there (a slug, a name, an id with stray spaces) still carries it as `menuSelected`, which the plugin
 * hands to `wp_get_nav_menu_items`: an id, a slug or a name, never a theme location. A block that chose none
 * prints an empty list (`menu.unset`). Only a bare `{menu}` token, which the plugin answers from the block
 * it sits in, has nothing to go on and takes the menu of the theme location `cc-menu`
 * (`theme_mods_<theme>.nav_menu_locations`; `menu.location-assumed`). A string id given to {@link menuNodes}
 * may also be a location, a slug or a name. A menu that does not exist renders an empty list (what the
 * plugin prints) and is an error. `data-flavor="nav"` on a placeholder (the `{nav_menu=ID}` token) selects
 * the `cc-nav` items, as the Nav Menu block does.
 *
 * Report codes: `menu.not-found` (error), `menu.component-prop` (error), `menu.unset`, `menu.location-assumed`,
 * `menu.item-data-missing`, `menu.vertical-link`, `menu.title-tag`, `menu.empty`,
 * `menu.item-missing`, `menu.item-unroutable`, `menu.item-orphan`, `menu.item-cycle` (items WordPress
 * hides or the Jx site cannot link to, dropped with their subtree), `menu.item-untitled`,
 * `menu.empty-url`, `menu.description-dropped`, `menu.label-repaired`, `menu.literal-template`,
 * `menu.current-page`, `menu.script-dropped`, `menu.navmenu-simplified`, `menu.navigation-simplified`,
 * `menu.navigation-block`, `menu.navigation-missing`, plus `url.unresolved` from the URL tools.
 */
import { texturizeHtml } from "../cwicly/tokens.ts";
import { htmlToContent } from "../html.ts";
import { escapeTemplate, joinClass } from "../jx-util.ts";
import {
  replacePlaceholders,
  type Placeholder,
  type Resolution,
  type ResolverMap,
} from "../placeholders.ts";
import { createReport } from "../report.ts";
import type { SiteContext } from "../site.ts";
import type { JxElement, JxNode, JxStyle, Report, WpBlock, WpMenuItem, WpPost } from "../types.ts";
import { parseBlocks } from "../wp/blocks.ts";
import { decodeEntities, menuItemTitle } from "../wp/model.ts";
import { maybeUnserialize } from "../wp/phpser.ts";

// ── Contract ─────────────────────────────────────────────────────────────────────────────────────

/** The plugin's markup families: the `cc-menu` list of the Menu block and `{menu}`, the `cc-nav` items of `{nav_menu=ID}`. */
export type MenuFlavor = "menu" | "nav";

export interface MenuOptions {
  /** Markup family. Default `menu`. */
  flavor?: MenuFlavor;
  /**
   * The block's own options: the `menu*` attributes of a `cwicly/menu` block (`menuLayout`, the icon
   * settings), the `menu*`/`navMenu*` ones of a `cwicly/navmenu`. What the block did not save takes
   * the plugin's own default.
   */
  block?: Readonly<Record<string, unknown>>;
  /** Where findings go. Default: a fresh report, returned as `MenuResult.report`. */
  report?: Report;
  /** The location the findings carry: `template:cwicly//header`. Default `menu:<term id>`. */
  where?: string;
  /** The public URL of the page the menu is on, for the findings. */
  url?: string;
}

/** What the menus written so far used, for the assembler (the compatibility stylesheet's pruning, the report). */
export interface MenusUsed {
  /** The `nav_menu` terms rendered. */
  menus: Set<number>;
  /** The `wp_navigation` posts rendered. */
  navigations: Set<number>;
  /** How many items were written (a dropdown's children included). */
  items: number;
  /** How many items were left out, with a report entry each. */
  dropped: number;
  /** Every class name the nodes carry. */
  classes: Set<string>;
  /** Whether a `cc-menu` list was written: the page then needs {@link CURRENT_PAGE_SCRIPT} in its `$head` for the link of the current page to be marked. */
  currentPage: boolean;
}

export interface MenuResult {
  nodes: JxNode[];
  used: MenusUsed;
  report: Report;
}

export interface ResolveOptions {
  report?: Report;
  where?: string;
  url?: string;
  /** Filled in as menus are rendered, so one run can add up what its pages used. */
  used?: MenusUsed;
}

export const newUsed = (): MenusUsed => ({
  menus: new Set(),
  navigations: new Set(),
  items: 0,
  dropped: 0,
  classes: new Set(),
  currentPage: false,
});

// ── The menus of a site ──────────────────────────────────────────────────────────────────────────

/** A `nav_menu` term. */
export interface MenuTerm {
  termId: number;
  slug: string;
  /** Decoded: the text a person reads. */
  name: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every menu of the site, by term id. */
export function menuTerms(site: Pick<SiteContext, "model">): MenuTerm[] {
  const out: MenuTerm[] = [];
  for (const term of site.model.terms.values()) {
    if (term.taxonomy === "nav_menu") {
      out.push({ termId: term.termId, slug: term.slug, name: decodeEntities(term.name) });
    }
  }
  return out.sort((a, b) => a.termId - b.termId);
}

/**
 * The theme's menu locations: `theme_mods_<theme>.nav_menu_locations`, location name → menu term id.
 * (`cc-menu` is the one Cwicly registers; anabaptistperspectives maps it to its Main menu.)
 */
export function menuLocations(site: Pick<SiteContext, "model">): Record<string, number> {
  const raw = site.model.options.get(`theme_mods_${site.model.site.theme}`);
  const mods = raw === undefined ? undefined : maybeUnserialize(raw);
  const locations = isRecord(mods) ? mods.nav_menu_locations : undefined;
  const out: Record<string, number> = {};
  if (isRecord(locations)) {
    for (const [name, id] of Object.entries(locations)) {
      const n = Number(id);
      if (Number.isInteger(n) && n > 0) out[name] = n;
    }
  }
  return out;
}

/** The location a placeholder with no menu id stands for. */
export const DEFAULT_LOCATION = "cc-menu";

/**
 * A menu named the way a caller names it: a term id (number, or digits), else a theme location, a
 * slug, a name. Undefined when it names none. `locations: false` leaves the theme locations out, which
 * is how the plugin reads a block's own `menuSelected` (`wp_get_nav_menu_items`: an id, a slug or a name).
 */
export function findMenu(
  site: Pick<SiteContext, "model">,
  id: number | string,
  { locations = true }: { locations?: boolean } = {},
): { term: MenuTerm; via: "id" | "location" | "slug" | "name" } | undefined {
  const terms = menuTerms(site);
  const byId = (n: number): MenuTerm | undefined => terms.find((t) => t.termId === n);
  if (typeof id === "number" || /^\d+$/.test(id.trim())) {
    const term = byId(Number(id));
    return term && { term, via: "id" };
  }
  const key = id.trim();
  const located = locations ? menuLocations(site)[key] : undefined;
  if (located !== undefined) {
    const term = byId(located);
    if (term) return { term, via: "location" };
  }
  const slug = terms.find((t) => t.slug === key);
  if (slug) return { term: slug, via: "slug" };
  const name = terms.find((t) => t.name === key);
  return name && { term: name, via: "name" };
}

// ── The items ────────────────────────────────────────────────────────────────────────────────────

/** One item of a menu as the page shows it. */
export interface MenuEntry {
  /** The `nav_menu_item` post. */
  id: number;
  /** The menu's HTML for the title, icon not included. */
  label: string;
  /** The address in the Jx site; undefined for an item that goes nowhere (an empty or `#` custom link). */
  href: string | undefined;
  target: string | undefined;
  rel: string | undefined;
  /** The link's title attribute (`post_excerpt`). */
  titleAttr: string | undefined;
  /** The classes the author typed, the ones WordPress generates removed. */
  classes: string[];
  kind: string;
  objectId: number;
  /** The item's description (`post_content`), blank when none. */
  description: string;
  /** Whether Cwicly's "footer" switch (`_is_footer`) is on: the mega menu's second body. */
  isFooter: boolean;
  children: MenuEntry[];
}

/**
 * The classes WordPress writes into an item's `classes` (and its CSS class list) itself. The meta of
 * a menu item stores them from the last time it was saved in the editor, so they are everywhere in
 * real data and mean nothing the Jx site can use.
 */
const GENERATED_CLASS =
  /^(?:menu-item(?:-type-.+|-object-.+|-home|-has-children|-privacy-policy|-\d+)?|current[-_].*|page_item|page-item-\d+)$/;

export const isGeneratedClass = (name: string): boolean => GENERATED_CLASS.test(name);

/** The classes of an item that its author typed. */
export const authoredClasses = (classes: readonly string[]): string[] =>
  classes.filter((c) => c !== "" && !isGeneratedClass(c));

const metaOf = (site: Pick<SiteContext, "model">, id: number, key: string): string => {
  const value = site.model.postMeta.get(id)?.[key]?.[0];
  return typeof value === "string" ? value : "";
};

const BLANK = /^[\s ]*$/;

/** What a title prints as: HTML. */
function titleHtml(site: Pick<SiteContext, "model" | "acf">, item: WpMenuItem): string {
  if (item.title !== "") return item.title;
  // The target's own: a post's title passes through `the_title` (wptexturize), a term's name does not.
  if (item.kind === "post_type") return texturizeHtml(menuItemTitle(site.model, item));
  if (item.kind === "post_type_archive") {
    const type = site.acf.postTypes.get(item.object);
    return type?.labels.archives ?? type?.plural ?? "";
  }
  return menuItemTitle(site.model, item);
}

/** The text of a piece of HTML, for an attribute. */
const textOf = (html: string): string =>
  decodeEntities(html.replaceAll(/<[^>]*>/g, ""))
    .replaceAll(/\s+/g, " ")
    .trim();

// ── Rendering state ──────────────────────────────────────────────────────────────────────────────

/** What one rendering of one menu carries: where its findings go and what it counts. */
interface Env {
  site: SiteContext;
  report: Report;
  where: string;
  url: string | undefined;
  used: MenusUsed;
  urls: SiteContext["urls"];
}

function say(
  env: Env,
  severity: "info" | "warn" | "error",
  code: string,
  message: string,
  data: Record<string, unknown> = {},
): void {
  env.report.add({
    severity,
    code,
    message,
    where: env.where,
    ...(env.url === undefined ? {} : { url: env.url }),
    data,
  });
}

function envOf(site: SiteContext, where: string, opts: ResolveOptions | MenuOptions): Env {
  const report = opts.report ?? createReport();
  const used = "used" in opts && opts.used !== undefined ? opts.used : newUsed();
  return {
    site,
    report,
    where,
    url: opts.url,
    used,
    urls: site.urls.bind(report, where),
  };
}

/** What splits a literal dollar-brace so no Jx pass reads it as a template. */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/** A value for an attribute: a literal `${` has no spelling that survives there, so it is split (and said). */
function attributeValue(env: Env, value: string, what: string): string {
  if (!value.includes("${")) return value;
  say(
    env,
    "warn",
    "menu.literal-template",
    `The ${what} holds a literal dollar-brace, which Jx would evaluate and which has no escape in an attribute: it was split with a zero-width space.`,
    { value },
  );
  return value.replaceAll("${", `$${ZERO_WIDTH_SPACE}{`);
}

// ── Tree ─────────────────────────────────────────────────────────────────────────────────────────

/** An item that could not be shown, and why: the same drop for the whole subtree below it. */
interface Dropped {
  code: string;
  message: string;
  data: Record<string, unknown>;
}

/** The address of an item's target in the Jx site, or why the item cannot be shown. */
function targetOf(env: Env, item: WpMenuItem): { href: string | undefined } | Dropped {
  const { model } = env.site;
  const describe = { item: item.id, menu: item.menuTermId, kind: item.kind, object: item.object };
  switch (item.kind) {
    case "post_type": {
      const post = model.posts.get(item.objectId);
      if (post === undefined || post.status === "trash") {
        return {
          code: "menu.item-missing",
          message: `The menu item points at ${item.object} ${item.objectId}, which no longer exists, so WordPress does not show the item either.`,
          data: { ...describe, objectId: item.objectId },
        };
      }
      const href = env.urls.urlFor("post", item.objectId);
      if (href === undefined) {
        return {
          code: "menu.item-unroutable",
          message: `The menu item points at ${item.object} ${item.objectId} (${post.status}), which the Jx site has no page for: the link would lead nowhere.`,
          data: { ...describe, objectId: item.objectId, status: post.status },
        };
      }
      return { href };
    }
    case "taxonomy": {
      const term = model.terms.get(item.objectId);
      if (term === undefined) {
        return {
          code: "menu.item-missing",
          message: `The menu item points at ${item.object} term ${item.objectId}, which no longer exists, so WordPress does not show the item either.`,
          data: { ...describe, objectId: item.objectId },
        };
      }
      const href = env.urls.urlFor("term", item.objectId);
      if (href === undefined) {
        return {
          code: "menu.item-unroutable",
          message: `The menu item points at the ${item.object} term "${decodeEntities(term.name)}", which the Jx site has no archive for: the link would lead nowhere.`,
          data: { ...describe, objectId: item.objectId },
        };
      }
      return { href };
    }
    case "post_type_archive": {
      const href = env.urls.urlForArchive(item.object);
      if (href === undefined) {
        return {
          code: "menu.item-unroutable",
          message: `The menu item points at the archive of ${item.object}, which the Jx site does not have.`,
          data: describe,
        };
      }
      return { href };
    }
    default: {
      const url = item.url.trim();
      if (url === "") return { href: undefined };
      return { href: env.urls.rewriteUrl(url) };
    }
  }
}

/** The number of items below `id`, itself not counted. */
function below(children: ReadonlyMap<number, WpMenuItem[]>, id: number, seen = new Set<number>()) {
  let n = 0;
  for (const child of children.get(id) ?? []) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    n += 1 + below(children, child.id, seen);
  }
  return n;
}

/**
 * The entries of a menu, as WordPress's front end builds them: items in `menu_order`, each under the
 * item its parent names, the ones WordPress would not show (a deleted target) or that the Jx site cannot
 * link to left out with their subtree, every drop reported.
 */
export function menuEntries(env: Env, termId: number): MenuEntry[] {
  const { site } = env;
  const items = site.model.menuItems
    .filter((i) => i.menuTermId === termId)
    .sort((a, b) => a.order - b.order || a.id - b.id);
  const ids = new Set(items.map((i) => i.id));
  const children = new Map<number, WpMenuItem[]>();
  for (const item of items) {
    const list = children.get(item.parent) ?? [];
    children.set(item.parent, list);
    list.push(item);
  }

  const reached = new Set<number>();
  const drop = (item: WpMenuItem, why: Dropped): void => {
    const descendants = below(children, item.id);
    env.used.dropped += 1 + descendants;
    say(env, "warn", why.code, why.message, {
      ...why.data,
      title: decodeEntities(titleHtml(site, item)),
      ...(descendants > 0 ? { descendants } : {}),
    });
  };

  const markBelow = (id: number): void => {
    for (const child of children.get(id) ?? []) {
      if (reached.has(child.id)) continue;
      reached.add(child.id);
      markBelow(child.id);
    }
  };

  const build = (item: WpMenuItem): MenuEntry | undefined => {
    reached.add(item.id);
    const target = targetOf(env, item);
    if ("code" in target) {
      // The subtree is unreachable as well: mark it reached so it is not reported as an orphan.
      markBelow(item.id);
      drop(item, target);
      return undefined;
    }
    const kids: MenuEntry[] = [];
    for (const child of children.get(item.id) ?? []) {
      if (reached.has(child.id)) continue;
      const entry = build(child);
      if (entry) kids.push(entry);
    }
    const post = site.model.posts.get(item.id);
    const xfn = metaOf(site, item.id, "_menu_item_xfn").trim();
    const attrTitle = post?.excerpt ?? "";
    const label = titleHtml(site, item);
    return {
      id: item.id,
      label,
      href: target.href,
      target: item.target === "" ? undefined : item.target,
      rel: xfn === "" ? undefined : xfn,
      titleAttr: attrTitle === "" ? undefined : attrTitle,
      classes: authoredClasses(item.classes),
      kind: item.kind,
      objectId: item.objectId,
      description: post !== undefined && !BLANK.test(post.content) ? post.content.trim() : "",
      isFooter: metaOf(site, item.id, "_is_footer") === "on",
      children: kids,
    };
  };

  const out: MenuEntry[] = [];
  for (const root of children.get(0) ?? []) {
    if (reached.has(root.id)) continue;
    const entry = build(root);
    if (entry) out.push(entry);
  }
  // Whatever the walk from the roots did not reach hangs below an item that is not in the menu (or in a loop).
  for (const item of items) {
    if (reached.has(item.id)) continue;
    const orphan = !ids.has(item.parent);
    const descendants = below(children, item.id);
    env.used.dropped += 1 + descendants;
    reached.add(item.id);
    markBelow(item.id);
    say(
      env,
      "warn",
      orphan ? "menu.item-orphan" : "menu.item-cycle",
      orphan
        ? `The menu item's parent (${item.parent}) is not in this menu, so WordPress does not show the item.`
        : "The menu item is its own ancestor, so WordPress does not show it.",
      {
        item: item.id,
        menu: termId,
        parent: item.parent,
        title: decodeEntities(titleHtml(site, item)),
        ...(descendants > 0 ? { descendants } : {}),
      },
    );
  }
  return out;
}

// ── The block's options ──────────────────────────────────────────────────────────────────────────

/** Where an icon goes in a parent's link. */
interface IconSpec {
  /** The icon's markup (an `<svg>` the editor saved), when the block shows one. */
  markup: string | undefined;
  position: "before" | "after";
}

interface MenuBlockOptions {
  horizontal: boolean;
  main: IconSpec;
  sub: IconSpec;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** A switch the editor saved: `true`, or what a stale save left as a string. */
const flag = (v: unknown, fallback: boolean): boolean =>
  v === undefined ? fallback : v === true || v === "true" || v === 1 || v === "1";

/**
 * The options of a `cwicly/menu` block as `cc_menu_maker` reads them, with the defaults the block
 * registers (`core/includes/blocks/menu/block.json`): a horizontal list on the main breakpoint, an icon
 * for parents when the block has one, before the title.
 */
export function menuBlockOptions(
  site: Pick<SiteContext, "options">,
  block: Readonly<Record<string, unknown>> = {},
): MenuBlockOptions {
  const main = site.options.breakpoints.find((b) => b.isMain)?.key ?? "";
  // The default is an attribute value like any other: a block that saved its own `menuLayout` replaces it whole.
  const layout = block.menuLayout === undefined ? { lg: "horizontal" } : block.menuLayout;
  const horizontal = isRecord(layout) && layout[main] === "horizontal";
  const icon = (prefix: "menuMainMenu" | "menuSubMenu"): IconSpec => {
    const active = flag(block[`${prefix}IconActive`], true);
    const position = block[`${prefix}IconPosition`] === "after" ? "after" : "before";
    return { markup: active ? str(block[`${prefix}IconUnicode`]) : undefined, position };
  };
  return { horizontal, main: icon("menuMainMenu"), sub: icon("menuSubMenu") };
}

// ── The `cc-menu` list ───────────────────────────────────────────────────────────────────────────

/**
 * What makes a dropdown work with no script. The block's own rules hide it (`visibility: hidden;
 * opacity: 0` on the horizontal list, `display: none` on the vertical one) and the script's
 * `li.active` showed it; these two rules show it while its item is hovered or has focus inside. They
 * sit on the list's first class (`cc-menu`), so they apply to every menu, once per element.
 */
export const DROPDOWN_STYLE: JxStyle = {
  "& li:hover > .cc-menu-dropdown, & li:focus-within > .cc-menu-dropdown": {
    visibility: "visible",
    opacity: "1",
  },
  // The script's slide-down displayed a collapsed list as `flex` (the block sets its direction).
  "&.ver li:hover > .cc-menu-dropdown, &.ver li:focus-within > .cc-menu-dropdown": {
    display: "flex",
  },
};

/** An anchor's content: the title, with the parent's icon before or after it. */
function linkContent(label: string, icon: IconSpec | undefined): ReturnType<typeof htmlToContent> {
  const markup = icon?.markup;
  const html =
    markup === undefined ? label : icon?.position === "after" ? label + markup : markup + label;
  return htmlToContent(html);
}

/** A link that goes nowhere: an empty or `#` address on an item that opens a dropdown. */
const isTrigger = (entry: MenuEntry): boolean =>
  entry.children.length > 0 && (entry.href === undefined || entry.href === "#");

/** The attributes every item's anchor carries, from the item. */
function anchorAttributes(env: Env, entry: MenuEntry): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (isTrigger(entry)) attributes.tabindex = "0";
  else if (entry.href !== undefined) attributes.href = attributeValue(env, entry.href, "link");
  if (entry.titleAttr !== undefined)
    attributes.title = attributeValue(env, entry.titleAttr, "link title");
  if (entry.target !== undefined) attributes.target = entry.target;
  if (entry.rel !== undefined) attributes.rel = attributeValue(env, entry.rel, "link relationship");
  return attributes;
}

/** The authored classes of an item, with what no class attribute can carry left out. */
function itemClasses(env: Env, entry: MenuEntry): string[] {
  return entry.classes.filter((name) => {
    if (!name.includes("${")) return true;
    attributeValue(env, name, "class");
    return false;
  });
}

/**
 * What the vertical list does with a parent whose link goes somewhere. The script's accordion
 * (`CCMenuVer.handleClick`) ran on every item with children: it cancelled the click and slid the
 * dropdown open, so such a parent's link never navigated and its children were reached by tapping it.
 * With the script gone a tap would navigate and the children would be unreachable on a touch screen, so
 * the parent becomes the dropdown's label (no `href`, focusable: a tap focuses it and `:focus-within`
 * opens the list) and its own link is the first item inside the list, which is the shape the live
 * fineline mobile menu already has for "Services" / "All Services".
 */
function liftLink(entry: MenuEntry): MenuEntry {
  const own: MenuEntry = { ...entry, children: [], classes: [], description: "", isFooter: false };
  return {
    ...entry,
    href: undefined,
    target: undefined,
    rel: undefined,
    titleAttr: undefined,
    children: [own, ...entry.children],
  };
}

function ccItem(
  env: Env,
  given: MenuEntry,
  depth: number,
  options: MenuBlockOptions,
  synthetic = false,
): JxElement {
  if (!synthetic) env.used.items += 1;
  const lifted =
    !options.horizontal &&
    given.children.length > 0 &&
    given.href !== undefined &&
    given.href !== "#";
  const entry = lifted ? liftLink(given) : given;
  if (lifted) {
    say(
      env,
      "info",
      "menu.vertical-link",
      "In the vertical list a parent's link would navigate on a tap, where the plugin's script opened its dropdown: the parent is a label that opens the dropdown and its own link is the first item inside it.",
      { item: given.id, title: textOf(given.label), href: given.href },
    );
  }
  const parent = entry.children.length > 0;
  const className = joinClass(
    depth === 0 ? "cc-menu-main" : "cc-menu-sub",
    `menu-id-${entry.id}`,
    ...itemClasses(env, entry),
  );
  for (const name of className.split(" ")) env.used.classes.add(name);
  if (entry.href === undefined && !parent) {
    say(
      env,
      "warn",
      "menu.empty-url",
      "A custom link has no address, so the item is text that goes nowhere.",
      { item: entry.id, title: textOf(entry.label) },
    );
  } else if (isTrigger(entry) && entry.href === undefined && !lifted) {
    say(
      env,
      "info",
      "menu.empty-url",
      "The dropdown's own link has no address (WordPress prints an empty href that reloads the page): it is a focusable label with no href.",
      { item: entry.id, title: textOf(entry.label) },
    );
  }
  if (!synthetic && BLANK.test(textOf(entry.label)) && !/<svg|<img/i.test(entry.label)) {
    say(env, "warn", "menu.item-untitled", "The menu item has no title: its link has no text.", {
      item: entry.id,
    });
  }
  if (entry.description !== "") {
    say(
      env,
      "info",
      "menu.description-dropped",
      "The item's description is not printed by the Cwicly menu either; it is not carried.",
      { item: entry.id, description: entry.description.slice(0, 120) },
    );
  }
  const attributes = anchorAttributes(env, entry);
  const anchor: JxElement = {
    tagName: "a",
    className,
    attributes: parent ? { ...attributes, "aria-haspopup": "true" } : attributes,
    ...linkContent(entry.label, parent ? (depth === 0 ? options.main : options.sub) : undefined),
  };
  const children: JxNode[] = [anchor];
  if (parent) {
    env.used.classes.add("cc-menu-dropdown");
    children.push({
      tagName: "ul",
      className: "cc-menu-dropdown",
      attributes: { "aria-label": attributeValue(env, textOf(entry.label), "title") },
      children: entry.children.map((child, index) =>
        ccItem(env, child, depth + 1, options, lifted && index === 0),
      ),
    });
  }
  return { tagName: "li", children };
}

/**
 * What marks the link of the current page, which the plugin's script and `{currentpageclass}` did per
 * request: the anchor of a `cc-menu` list whose address is this page's gets `current` and
 * `aria-current="page"` (the block's own rules colour `a.current`). A menu is one component shared by
 * every page, so this cannot be written at build time; it is a script for the page's `$head`, which the
 * assembler places when `MenusUsed.currentPage` is set. Plain text with no dollar-brace, for a script element's `innerHTML`.
 */
export const CURRENT_PAGE_SCRIPT = [
  "(function(){",
  'var norm=function(p){return p.replace(/\\/+$/,"")||"/"};',
  "var here=norm(location.pathname);",
  'var links=document.querySelectorAll("ul.cc-menu a[href]");',
  "for(var i=0;i<links.length;i++){",
  'var a=links[i],h=a.getAttribute("href"),u;',
  // A `#` or `#anchor` link is this page by the URL rules and is not the page's own link.
  'if(!h||h.charAt(0)==="#")continue;',
  "try{u=new URL(h,location.href)}catch(e){continue}",
  "if(u.origin===location.origin&&norm(u.pathname)===here){",
  'a.classList.add("current");',
  'a.setAttribute("aria-current","page")',
  "}}})();",
].join("");

/** The list of a `cwicly/menu`: `cc_menu_maker`'s output, without the script's roles. */
function ccMenu(env: Env, entries: readonly MenuEntry[], options: MenuBlockOptions): JxElement {
  env.used.currentPage = true;
  for (const name of ["cc-menu", options.horizontal ? "hor" : "ver"]) env.used.classes.add(name);
  return {
    tagName: "ul",
    className: `cc-menu ${options.horizontal ? "hor" : "ver"}`,
    style: DROPDOWN_STYLE,
    children: entries.map((entry) => ccItem(env, entry, 0, options)),
  };
}

// ── The `cc-nav` items (`{nav_menu=ID}`) ─────────────────────────────────────────────────────────

/** `NavMenu::nav_attrs`: a `_blank` link with no XFN gets `rel="noopener"`. */
function navAnchorAttributes(env: Env, entry: MenuEntry): Record<string, string> {
  const attributes = anchorAttributes(env, entry);
  if (entry.target === "_blank" && entry.rel === undefined) attributes.rel = "noopener";
  return attributes;
}

/** The dropdown icon the block saved (`menuDropdownIcon`: `{viewBox, paths[{d, fill, opacity}]}`) as markup. */
function dropdownIcon(block: Readonly<Record<string, unknown>>): string | undefined {
  if (!flag(block.menuDropdownIconActive, false)) return undefined;
  const icon = block.menuDropdownIcon;
  if (!isRecord(icon) || typeof icon.viewBox !== "string" || !Array.isArray(icon.paths)) {
    return undefined;
  }
  const esc = (v: string): string => v.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const paths = icon.paths
    .filter(
      (p): p is Record<string, unknown> => isRecord(p) && typeof p.d === "string" && p.d !== "",
    )
    .map((p) => {
      const fill = typeof p.fill === "string" ? p.fill : "";
      const opacity =
        typeof p.opacity === "string" || typeof p.opacity === "number" ? p.opacity : "";
      // The plugin writes `fill=""` and `opacity=""` when the path has none; an empty attribute is not kept.
      const fillAttr = fill === "" ? "" : ` fill="${esc(fill)}"`;
      const opacityAttr = opacity === "" ? "" : ` opacity="${esc(String(opacity))}"`;
      return `<path d="${esc(String(p.d))}"${fillAttr}${opacityAttr}></path>`;
    });
  // It goes into an `innerHTML`, where a literal dollar-brace has to be the character reference or the build evaluates it.
  return paths.length === 0
    ? undefined
    : escapeTemplate(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${esc(icon.viewBox)}">${paths.join("")}</svg>`,
      );
}

/** The tags the plugin's "Title Tag" select offers for a dropdown's section title. */
const TITLE_TAGS: ReadonlySet<string> = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "div",
  "p",
  "span",
]);

/** The element a dropdown's section title is: the block's choice when it is one of the plugin's, else `h2` (the plugin's default), said. */
function titleTagOf(env: Env, block: Readonly<Record<string, unknown>>): string {
  const raw = str(block.navMenuDropdownTitleTag);
  if (raw === undefined) return "h2";
  const tag = raw.trim().toLowerCase();
  if (TITLE_TAGS.has(tag)) return tag;
  say(
    env,
    "warn",
    "menu.title-tag",
    `The dropdown title tag "${raw}" is not one the plugin offers (h1 to h6, div, p, span), and it would not be a valid element name: h2 is used.`,
    { tag: raw },
  );
  return "h2";
}

/** Every descendant of an entry, depth first (`NavMenu::get_children`). */
function descendants(entry: MenuEntry): MenuEntry[] {
  return entry.children.flatMap((child) => [child, ...descendants(child)]);
}

const withClasses = (env: Env, base: string, entry: MenuEntry): string => {
  const className = joinClass(base, ...itemClasses(env, entry));
  for (const name of className.split(" ")) env.used.classes.add(name);
  return className;
};

/** One link of a dropdown's list: `li.cc-nav__submenu-item > a.cc-nav__submenu-item--link`. */
function submenuLink(env: Env, entry: MenuEntry): JxElement {
  env.used.items += 1;
  const label: JxNode[] = [];
  if (!BLANK.test(textOf(entry.label))) {
    label.push({
      tagName: "span",
      className: "cc-nav__submenu-item--label",
      ...htmlToContent(entry.label),
    });
  }
  if (entry.description !== "") {
    label.push({
      tagName: "p",
      className: "cc-nav__submenu-item--description",
      ...htmlToContent(entry.description),
    });
  }
  return {
    tagName: "li",
    className: withClasses(env, "cc-nav__submenu-item", entry),
    children: [
      {
        tagName: "a",
        className: "cc-nav__submenu-item--link",
        attributes: navAnchorAttributes(env, entry),
        children: [
          {
            tagName: "span",
            className: "cc-nav__submenu-item--label-container",
            children: label,
          },
        ],
      },
    ],
  };
}

const list = (env: Env, entries: readonly MenuEntry[]): JxElement => ({
  tagName: "ul",
  className: "cc-nav__submenu-list",
  children: entries.map((entry) => submenuLink(env, entry)),
});

/** `NavMenu::dropdown_section`: the body or the footer of a parent's dropdown. */
function dropdownSection(env: Env, parent: MenuEntry, footer: boolean): JxElement | undefined {
  const hasChildren = parent.children.some((child) => child.children.length > 0);
  const className = footer ? "cc-nav__section cc-nav__section--footer" : "cc-nav__section";
  if (!hasChildren) {
    if (parent.isFooter !== footer) return undefined;
    return {
      tagName: "div",
      className,
      children: [
        {
          tagName: "div",
          className: "cc-nav__submenu",
          children: [list(env, descendants(parent))],
        },
      ],
    };
  }
  const groups = parent.children.filter((child) => child.isFooter === footer);
  if (groups.length === 0) return undefined;
  return {
    tagName: "div",
    className,
    children: groups.map((group): JxElement => ({
      tagName: "div",
      className: "cc-nav__submenu",
      children: [
        {
          tagName: group.href === undefined ? "span" : "a",
          className: withClasses(env, "cc-nav__submenu-header", group),
          ...(group.href === undefined ? {} : { attributes: navAnchorAttributes(env, group) }),
          children: [
            {
              tagName: "span",
              className: "cc-nav__submenu-header--title",
              ...htmlToContent(BLANK.test(group.label) ? ZERO_WIDTH_SPACE : group.label),
            },
          ],
        },
        list(env, descendants(group)),
      ],
    })),
  };
}

/** The `<li>`s of `{nav_menu=ID}`: what `NavMenu::wp_nav_maker` returns, for the nav block's own `<ul>`. */
function navItems(
  env: Env,
  entries: readonly MenuEntry[],
  block: Readonly<Record<string, unknown>>,
): JxElement[] {
  const icon = dropdownIcon(block);
  const hideTitles = flag(block.navMenuDropdownHideTitles, false);
  const titleTag = hideTitles ? "h2" : titleTagOf(env, block);
  return entries.map((entry): JxElement => {
    env.used.items += 1;
    if (entry.children.length === 0) {
      return {
        tagName: "li",
        className: withClasses(env, "cc-nav-link", entry),
        children: [
          {
            tagName: "a",
            className: "cc-nav-item",
            attributes: navAnchorAttributes(env, entry),
            ...htmlToContent(entry.label),
          },
        ],
      };
    }
    const linked = entry.href !== undefined && entry.href !== "#";
    const attributes = navAnchorAttributes(env, entry);
    delete attributes.tabindex;
    const title: JxElement = linked
      ? {
          tagName: "a",
          className: "cc-nav-dropdown__button--title",
          attributes,
          ...htmlToContent(entry.label),
        }
      : {
          tagName: "div",
          className: "cc-nav-dropdown__button--title",
          ...htmlToContent(entry.label),
        };
    const button: JxElement = {
      tagName: linked ? "div" : "button",
      className: "cc-nav-item cc-nav-dropdown__button",
      ...(linked ? {} : { attributes: { type: "button", "aria-haspopup": "true" } }),
      children: [
        title,
        ...(icon === undefined
          ? []
          : [
              {
                tagName: linked ? "button" : "div",
                className: "cc-nav-dropdown__button--icon",
                ...(linked
                  ? { attributes: { type: "button", "aria-label": "Toggle Submenu" } }
                  : {}),
                innerHTML: icon,
              } satisfies JxElement,
            ]),
      ],
    };
    const header: JxElement[] = hideTitles
      ? []
      : [
          {
            tagName: "div",
            className: "cc-nav__section-header",
            children: [
              {
                tagName: titleTag,
                className: "cc-nav__section-title",
                children: [
                  linked
                    ? { tagName: "a", attributes, ...htmlToContent(entry.label) }
                    : { tagName: "span", ...htmlToContent(entry.label) },
                ],
              },
            ],
          },
        ];
    const sections = [dropdownSection(env, entry, false), dropdownSection(env, entry, true)].filter(
      (s): s is JxElement => s !== undefined,
    );
    return {
      tagName: "li",
      className: withClasses(env, "cc-nav-dropdown", entry),
      children: [
        button,
        {
          tagName: "div",
          className: "cc-nav-dropdown__content",
          style: { position: "absolute" },
          children: [...header, ...sections],
        },
      ],
    };
  });
}

// ── `wp_navigation` (the block-based menu) ───────────────────────────────────────────────────────

/**
 * What the editor does to a link's label when it writes the block comment: `&` becomes `&`. Both
 * fixtures' `wp_navigation` posts hold `u0026amp;`, the backslash gone (a slash-stripping import), which
 * WordPress would print as the literal text "u0026amp;". The escapes are repaired, and said.
 */
const STRIPPED_ESCAPE = /(?<![\w\\])u00(26|3c|3e|22|27|2d)/gi;

function repairLabel(env: Env, label: string, id: unknown): string {
  const repaired = label.replaceAll(STRIPPED_ESCAPE, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
  if (repaired !== label) {
    say(
      env,
      "info",
      "menu.label-repaired",
      "A navigation link's label held a JSON escape with its backslash stripped (u0026 for an ampersand); it was repaired.",
      { id, label, repaired },
    );
  }
  return repaired;
}

/** The `wp_navigation` post a `ref` names. */
export function navigationPost(
  site: Pick<SiteContext, "model">,
  ref: number | string,
): WpPost | undefined {
  const post = site.model.posts.get(Number(ref));
  return post?.type === "wp_navigation" ? post : undefined;
}

/** The address of a navigation link: its object's route, else its URL rewritten. */
function navigationHref(
  env: Env,
  a: Record<string, unknown>,
  descendants = 0,
): { href: string | undefined } | { dropped: true } {
  const id = typeof a.id === "number" ? a.id : /^\d+$/.test(String(a.id ?? "")) ? Number(a.id) : 0;
  const kind = a.kind === "taxonomy" ? "term" : a.kind === "post-type" ? "post" : undefined;
  if (id > 0 && kind !== undefined) {
    const href = env.urls.urlFor(kind, id);
    if (href !== undefined) return { href };
    const { model } = env.site;
    const exists =
      kind === "post" ? model.posts.get(id)?.status !== undefined : model.terms.has(id);
    if (exists) {
      // The object is there but the Jx site has no page for it (a draft): the link would lead nowhere.
      env.used.dropped += 1 + descendants;
      say(
        env,
        "warn",
        "menu.item-unroutable",
        `The navigation link points at ${kind === "post" ? "post" : "term"} ${id}, which the Jx site has no page for: the link would lead nowhere, so it is not carried.`,
        {
          objectId: id,
          kind: a.kind,
          label: textOf(str(a.label) ?? ""),
          ...(descendants > 0 ? { descendants } : {}),
          ...(kind === "post" ? { status: model.posts.get(id)?.status } : {}),
        },
      );
      return { dropped: true };
    }
  }
  const url = str(a.url);
  if (url === undefined) return { href: undefined };
  return { href: env.urls.rewriteUrl(url) };
}

const countBlocks = (blocks: readonly WpBlock[]): number =>
  blocks.reduce((n, b) => n + 1 + countBlocks(b.innerBlocks), 0);

/** One `core/navigation-link` or `core/navigation-submenu`, as core prints it. */
function navigationItem(env: Env, block: WpBlock): JxElement | undefined {
  const a = block.attrs;
  if (block.name === "core/home-link") {
    env.used.items += 1;
    return coreItem(env, "wp-block-navigation-link", str(a.label) ?? "Home", "/", a, []);
  }
  if (block.name !== "core/navigation-link" && block.name !== "core/navigation-submenu") {
    say(
      env,
      "warn",
      "menu.navigation-block",
      `The navigation holds a ${block.name ?? "freeform"} block, which prints per request or is not a link, so it is not carried.`,
      { block: block.name },
    );
    env.used.dropped += 1;
    return undefined;
  }
  const label = str(a.label);
  if (label === undefined) return undefined;
  const target = navigationHref(env, a, countBlocks(block.innerBlocks));
  if ("dropped" in target) return undefined;
  env.used.items += 1;
  const submenu = block.name === "core/navigation-submenu";
  const kids = submenu
    ? block.innerBlocks.map((child) => navigationItem(env, child)).filter((c) => c !== undefined)
    : [];
  return coreItem(
    env,
    submenu ? "has-child wp-block-navigation-submenu" : "wp-block-navigation-link",
    repairLabel(env, label, a.id),
    target.href,
    a,
    kids,
  );
}

function coreItem(
  env: Env,
  kind: string,
  label: string,
  href: string | undefined,
  a: Record<string, unknown>,
  kids: readonly JxElement[],
): JxElement {
  const authored = authoredClasses(str(a.className)?.split(/\s+/) ?? []);
  const className = joinClass("wp-block-navigation-item", kind, ...authored);
  for (const name of className.split(" ")) env.used.classes.add(name);
  const attributes: Record<string, string> = {};
  if (href !== undefined) attributes.href = attributeValue(env, href, "link");
  if (a.opensInNewTab === true) {
    attributes.target = "_blank";
    attributes.rel = "noopener";
  } else if (str(a.rel) !== undefined)
    attributes.rel = attributeValue(env, str(a.rel)!, "link relationship");
  if (str(a.title) !== undefined)
    attributes.title = attributeValue(env, str(a.title)!, "link title");
  const anchor: JxElement = {
    tagName: "a",
    className: "wp-block-navigation-item__content",
    attributes,
    children: [
      {
        tagName: "span",
        className: "wp-block-navigation-item__label",
        ...htmlToContent(label),
      },
    ],
  };
  const children: JxNode[] = [anchor];
  if (kids.length > 0) {
    children.push({
      tagName: "ul",
      className: "wp-block-navigation__submenu-container",
      children: [...kids],
    });
  }
  return { tagName: "li", className, children };
}

/**
 * A `core/navigation` block as the nav WordPress prints. The links are the `wp_navigation` post's
 * (`ref`), or, with none, the ones the block held (already converted: `inline`).
 */
function navigationNodes(env: Env, placeholder: Placeholder, inline: readonly JxNode[]): JxNode[] {
  const ref = placeholder.attrs["data-ref"];
  let items: JxNode[] = [...inline];
  if (ref !== undefined) {
    const post = navigationPost(env.site, ref);
    if (post === undefined) {
      say(
        env,
        inline.length > 0 ? "warn" : "error",
        "menu.navigation-missing",
        inline.length > 0
          ? `The navigation names wp_navigation ${ref}, which does not exist; the links the block held itself are used.`
          : `The navigation names wp_navigation ${ref}, which does not exist, and the block held no links: it is empty.`,
        { ref },
      );
    } else {
      env.used.navigations.add(post.id);
      items = parseBlocks(post.content)
        .map((block) => navigationItem(env, block))
        .filter((item) => item !== undefined);
      if (items.length === 0) {
        say(env, "warn", "menu.empty", `The navigation "${post.title}" holds no links.`, {
          navigation: post.id,
        });
      }
    }
  } else if (inline.length === 0) {
    say(env, "warn", "menu.empty", "The navigation holds no links.", {});
  }
  say(
    env,
    "info",
    "menu.navigation-simplified",
    "A navigation block's responsive overlay (the hamburger and its panel) is core's script and is not carried: the links are a plain list.",
    { ref: ref ?? null },
  );
  const label = str(placeholder.blockAttrs.ariaLabel);
  const className = joinClass(
    placeholder.element.className as string | undefined,
    "wp-block-navigation",
  );
  for (const name of className.split(" ")) env.used.classes.add(name);
  env.used.classes.add("wp-block-navigation__container");
  return [
    {
      tagName: "nav",
      className,
      ...(label === undefined
        ? {}
        : { attributes: { "aria-label": attributeValue(env, label, "label") } }),
      children: [
        {
          tagName: "ul",
          className: "wp-block-navigation__container wp-block-navigation",
          children: items,
        },
      ],
    },
  ];
}

// ── One menu ─────────────────────────────────────────────────────────────────────────────────────

/** The findings every rendering of a menu repeats: what a static page cannot have. */
function standingFindings(env: Env, term: MenuTerm, flavor: MenuFlavor, once?: Set<string>): void {
  const first = (code: string): boolean => {
    if (once === undefined) return true;
    const key = `${code}\0${term.termId}\0${flavor}`;
    if (once.has(key)) return false;
    once.add(key);
    return true;
  };
  const unread = env.site.model.menuItems.filter(
    (i) => i.menuTermId === term.termId && !env.site.model.posts.has(i.id),
  ).length;
  if (unread > 0 && first("menu.item-data-missing")) {
    say(
      env,
      "warn",
      "menu.item-data-missing",
      `${unread} item(s) of the menu "${term.name}" have no nav_menu_item post in the model (the type was not among the loaded post types), so their link title attribute, XFN relationship, description and Cwicly footer switch are unknown and left out. Load \`nav_menu_item\` with the other post types.`,
      { menu: term.termId, items: unread },
    );
  }
  if (first("menu.current-page")) {
    say(
      env,
      "info",
      "menu.current-page",
      `The menu "${term.name}" is one component shared by every page, so the link of the current page cannot be marked at build time: WordPress's \`current\` class and aria-current="page" are not written. \`CURRENT_PAGE_SCRIPT\` (a few lines for the page's $head, flagged by MenusUsed.currentPage) adds both to the anchor whose pathname equals location.pathname; a static equivalent would need the menu rendered once per page.`,
      { menu: term.termId, flavor },
    );
  }
  if (flavor === "menu" && first("menu.script-dropped")) {
    say(
      env,
      "info",
      "menu.script-dropped",
      `The menu "${term.name}" was driven by cc-menu-new.min.js, which is not ported: dropdowns open on hover and focus in CSS, the arrow-key navigation, the roving tabindex, Escape to close and the vertical layout's slide-open accordion are gone, and the ARIA tree roles that script managed are not written (every link stays in the tab order).`,
      { menu: term.termId },
    );
  }
}

/** One menu, rendered for `flavor`. `once` limits the standing findings to one per menu. */
function renderMenu(
  env: Env,
  id: number | string,
  flavor: MenuFlavor,
  block: Readonly<Record<string, unknown>>,
  once?: Set<string>,
  locations = true,
): JxNode[] {
  const options = menuBlockOptions(env.site, block);
  const found = findMenu(env.site, id, { locations });
  if (found === undefined) {
    const named = typeof id === "number" || /^\d+$/.test(id.trim());
    say(
      env,
      "error",
      "menu.not-found",
      named
        ? `There is no navigation menu with the id ${id}; an empty list is written, as the plugin prints for a menu it cannot find.`
        : locations
          ? `There is no navigation menu for "${id}" (a theme location, slug or name; the theme assigns none to a location by that name); an empty list is written.`
          : `There is no navigation menu with the id, slug or name "${id}", which is how the plugin reads the menu a block selected; an empty list is written, as it prints.`,
      { menu: id },
    );
    return flavor === "menu" ? [ccMenu(env, [], options)] : [];
  }
  const { term } = found;
  env.used.menus.add(term.termId);
  const entries = menuEntries(env, term.termId);
  if (entries.length === 0 && !env.site.model.menuItems.some((i) => i.menuTermId === term.termId)) {
    say(env, "info", "menu.empty", `The menu "${term.name}" has no items.`, { menu: term.termId });
  }
  standingFindings(env, term, flavor, once);
  if (flavor === "nav") {
    say(
      env,
      "info",
      "menu.navmenu-simplified",
      `The menu "${term.name}" is rendered as the nav block's items: the dropdowns keep their sections and links, but the sub-level buttons, the caret and the group dividers of the plugin's mega menu are not carried.`,
      { menu: term.termId },
    );
    return navItems(env, entries, block);
  }
  return [ccMenu(env, entries, options)];
}

/**
 * Render a menu. `menuId` is a `nav_menu` term id, or (as a string) a theme location, a slug or a name.
 * With `flavor: "menu"` the nodes are one `<ul class="cc-menu …">`, for `"nav"` the `<li>` items of a
 * nav block. A menu that does not exist is an error and renders as an empty list.
 */
export function menuNodes(
  site: SiteContext,
  menuId: number | string,
  opts: MenuOptions = {},
): MenuResult {
  const found = findMenu(site, menuId);
  const where = opts.where ?? `menu:${found?.term.termId ?? menuId}`;
  const env = envOf(site, where, opts);
  const nodes = renderMenu(env, menuId, opts.flavor ?? "menu", opts.block ?? {});
  return { nodes, used: env.used, report: env.report };
}

// ── Placeholders ─────────────────────────────────────────────────────────────────────────────────

/** The markup family a placeholder stands for: the Nav Menu block and `{nav_menu=ID}` print `cc-nav` items, the Menu block and `{menu}` the `cc-menu` list. */
const flavorOf = (placeholder: Placeholder): MenuFlavor =>
  placeholder.block === "cwicly/navmenu" || placeholder.attrs["data-flavor"] === "nav"
    ? "nav"
    : "menu";

/**
 * The menu a block selected, as `cc_menu_maker` reads it: undefined when it chose none (PHP's `isset &&
 * truthy`: unset, empty, `"0"`), else the trimmed text of the id, slug or name.
 */
function selectedMenu(value: unknown): string | undefined {
  const text =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return text === "" || text === "0" ? undefined : text;
}

/**
 * The resolvers for the placeholders menus stand for: `wp2jx-menu` (the Menu block, `{menu}`,
 * `cwicly/navmenu`, `{nav_menu=ID}`) and `wp2jx-navigation` (`core/navigation`). Pass them to
 * `replacePlaceholders` next to the template, shortcode and block resolvers.
 */
export function menuResolvers(site: SiteContext, opts: ResolveOptions = {}): ResolverMap {
  const report = opts.report ?? createReport();
  const used = opts.used ?? newUsed();
  const once = new Set<string>();
  const envFor = (fallback: string): Env =>
    envOf(site, opts.where ?? fallback, {
      report,
      used,
      ...(opts.url === undefined ? {} : { url: opts.url }),
    });

  const menu = (placeholder: Placeholder): Resolution => {
    const flavor = flavorOf(placeholder);
    const empty = (env: Env): Resolution =>
      flavor === "menu" ? [ccMenu(env, [], menuBlockOptions(site, placeholder.blockAttrs))] : [];
    const given = placeholder.attrs["data-menu"];
    if (given !== undefined && given !== "") {
      return renderMenu(envFor(`menu:${given}`), given, flavor, placeholder.blockAttrs, once);
    }
    // What the converter could not put in `data-menu` (a slug, a name, an id with stray spaces) is still in the block's own attribute.
    const selected = selectedMenu(placeholder.blockAttrs.menuSelected);
    if (selected?.includes("!ref=")) {
      // The block takes its menu from a property of the component it is in: the instance decides.
      const env = envFor(`menu:${selected}`);
      say(
        env,
        "error",
        "menu.component-prop",
        "The menu block's menu is a property of the component it sits in (the instance chooses it), which a single component cannot answer: it is left empty.",
        { menuSelected: selected },
      );
      return empty(env);
    }
    if (selected !== undefined) {
      // `cc_menu_maker` hands the value to `wp_get_nav_menu_items`: an id, a slug or a name, never a theme location.
      return renderMenu(
        envFor(`menu:${selected}`),
        selected,
        flavor,
        placeholder.blockAttrs,
        once,
        false,
      );
    }
    if (placeholder.block !== undefined) {
      // A menu block that chose no menu prints an empty list on the live site (it never reads a theme location).
      const env = envFor("menu:unset");
      say(
        env,
        "warn",
        "menu.unset",
        "The menu block has no menu selected, so the plugin prints an empty list: an empty list is written.",
        { block: placeholder.block },
      );
      return empty(env);
    }
    // A bare `{menu}` token: the plugin answers with the menu of the block it sits in, which is not known
    // here. The theme's `cc-menu` location is the one menu a site designates, and the best guess there is.
    const env = envFor(`location:${DEFAULT_LOCATION}`);
    const located = findMenu(site, DEFAULT_LOCATION);
    if (located !== undefined) {
      say(
        env,
        "info",
        "menu.location-assumed",
        `A \`{menu}\` token names no menu: the theme's \`${DEFAULT_LOCATION}\` location, "${located.term.name}", was used.`,
        { menu: located.term.termId },
      );
    }
    return renderMenu(env, DEFAULT_LOCATION, flavor, placeholder.blockAttrs, once);
  };

  const navigation = (placeholder: Placeholder): Resolution => {
    const env = envFor(`navigation:${placeholder.attrs["data-ref"] ?? "inline"}`);
    const inline = Array.isArray(placeholder.element.children) ? placeholder.element.children : [];
    return navigationNodes(env, placeholder, inline);
  };

  return { "wp2jx-menu": menu, "wp2jx-navigation": navigation };
}

/**
 * Replace the menu and navigation placeholders in `nodes` (a copy; the input is not modified) with the
 * menus themselves. Other placeholders stay for their own resolvers and are not reported here.
 */
export function replaceMenus(
  nodes: readonly JxNode[],
  site: SiteContext,
  opts: ResolveOptions = {},
): JxNode[] {
  return replacePlaceholders(nodes, menuResolvers(site, opts));
}
