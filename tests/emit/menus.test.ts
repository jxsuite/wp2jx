/**
 * emit/menus.ts against the real fixture sites: every menu of fineline and anabaptistperspectives
 * converts, the structure of the menus the live headers print (tests/fixtures/<site>/html, the ground
 * truth) is the structure written, the real header parts have their placeholders replaced, and a
 * built page carries the no-script dropdown rules in a way that wins the cascade over the block's
 * own hiding rules. The dropdown itself and the computed styles are checked in a real browser by
 * hand (see the report); a unit test cannot hover.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHtml } from "hast-util-from-html";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { convertSubject } from "../../src/convert.ts";
import {
  authoredClasses,
  CURRENT_PAGE_SCRIPT,
  DROPDOWN_STYLE,
  findMenu,
  isGeneratedClass,
  menuBlockOptions,
  menuEntries,
  menuLocations,
  menuNodes,
  menuResolvers,
  menuTerms,
  navigationPost,
  newUsed,
  replaceMenus,
  type MenuOptions,
} from "../../src/emit/menus.ts";
import { nodesToHtml } from "../../src/html.ts";
import { collectPlaceholders, placeholderElement, walkElements } from "../../src/placeholders.ts";
import { replacePlaceholders } from "../../src/placeholders.ts";
import { createReport } from "../../src/report.ts";
import type { JxElement, JxNode, Report, WpMenuItem, WpPost } from "../../src/types.ts";
import { loadSite, type LoadedSite, type SiteName } from "../helpers/ctx.ts";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "../helpers/jx-build.ts";

setDefaultTimeout(180_000);
afterAll(cleanupJxProjects);

const FIXTURES = join(import.meta.dir, "../fixtures");
const SITES: SiteName[] = ["fineline", "ap"];

// ── Reading markup ───────────────────────────────────────────────────────────────────────────────

type Hast = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Hast[];
};

const classesOf = (el: Hast): string[] => {
  const value = el.properties?.className;
  return Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? value.split(" ")
      : [];
};

function textOf(node: Hast, skip: Set<string> = new Set()): string {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "element" && skip.has(node.tagName ?? "")) return "";
  return (node.children ?? []).map((c) => textOf(c, skip)).join("");
}

function find(node: Hast, test: (el: Hast) => boolean, out: Hast[] = []): Hast[] {
  if (node.type === "element" && test(node)) out.push(node);
  for (const child of node.children ?? []) find(child, test, out);
  return out;
}

const elementChildren = (el: Hast): Hast[] =>
  (el.children ?? []).filter((c) => c.type === "element");

/** One item of a menu as a reader sees it. */
interface Item {
  label: string;
  /** The path (and query, hash) of the link, `undefined` when it has no address. */
  href: string | undefined;
  /** Of the classes the plugin's stylesheet and the block's rules can name. */
  classes: string[];
  popup: boolean;
  /** The label of the dropdown list, when there is one. */
  dropdownLabel?: string;
  children: Item[];
}

const KEPT_CLASS = /^(?:cc-menu-main|cc-menu-sub|menu-id-\d+)$/;

function pathOf(href: string | undefined, origins: readonly string[]): string | undefined {
  if (href === undefined || href === "") return undefined;
  for (const origin of origins) {
    if (href === origin) return "/";
    if (
      href.startsWith(`${origin}/`) ||
      href.startsWith(`${origin}?`) ||
      href.startsWith(`${origin}#`)
    ) {
      return href.slice(origin.length);
    }
  }
  return href;
}

function itemsOf(ul: Hast, origins: readonly string[]): Item[] {
  return elementChildren(ul)
    .filter((li) => li.tagName === "li")
    .map((li): Item => {
      const kids = elementChildren(li);
      const a = kids.find((k) => k.tagName === "a")!;
      const dropdown = kids.find((k) => k.tagName === "ul");
      const href = a.properties?.href;
      return {
        label: textOf(a, new Set(["svg"])).trim(),
        href: pathOf(typeof href === "string" ? href : undefined, origins),
        classes: classesOf(a).filter((c) => KEPT_CLASS.test(c)),
        popup: a.properties?.ariaHasPopup === "true",
        ...(dropdown ? { dropdownLabel: String(dropdown.properties?.ariaLabel ?? "") } : {}),
        children: dropdown ? itemsOf(dropdown, origins) : [],
      };
    });
}

/** The `ul.cc-menu` lists of a document, in order, with their layout and their items. */
function menusOf(root: Hast, origins: readonly string[]) {
  return find(root, (el) => el.tagName === "ul" && classesOf(el).includes("cc-menu")).map((ul) => ({
    layout: classesOf(ul).includes("hor") ? "hor" : "ver",
    items: itemsOf(ul, origins),
  }));
}

const parse = (html: string): Hast => fromHtml(html, { fragment: true }) as unknown as Hast;

const originsOf = (site: LoadedSite): string[] =>
  [site.model.site.url, site.model.site.home].map((u) => u.replace(/\/$/, ""));

/** Render nodes and read them back as the lists a browser would see. */
const readNodes = (site: LoadedSite, nodes: JxNode[]) =>
  menusOf(parse(nodesToHtml(nodes)), originsOf(site));

function liveFiles(site: SiteName): string[] {
  const dir = join(FIXTURES, site, "html");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".html"))
    .sort()
    .map((f) => join(dir, f));
}

const liveMenus = (site: LoadedSite, file: string) =>
  menusOf(parse(readFileSync(file, "utf8")), originsOf(site));

/** The paths of an item list, flattened: `Services > Doors` per line, for a readable diff. */
function flat(items: Item[], trail = ""): string[] {
  return items.flatMap((item) => [
    `${trail}${item.label} -> ${item.href ?? "(no href)"} [${item.classes.join(" ")}]${item.popup ? " popup" : ""}${item.dropdownLabel === undefined ? "" : ` list=${item.dropdownLabel}`}`,
    ...flat(item.children, `${trail}${item.label} > `),
  ]);
}

/** Lines in `a` that `b` lacks, and the reverse. */
function difference(live: string[], ours: string[]): { onlyLive: string[]; onlyOurs: string[] } {
  const l = new Set(live);
  const o = new Set(ours);
  return { onlyLive: live.filter((x) => !o.has(x)), onlyOurs: ours.filter((x) => !l.has(x)) };
}

/**
 * A live vertical list as this module writes it. The plugin's script cancelled the click on every
 * parent of a vertical list and slid its dropdown open, so the parent's link was never followed; without
 * the script a tap would follow it and hide the children, so a parent with a real link is the dropdown's
 * label (no address) and its link is the first item inside the dropdown.
 */
function liftedLinks(items: Item[]): Item[] {
  return items.map((item) => {
    const kids = liftedLinks(item.children);
    if (kids.length === 0 || item.href === undefined || item.href === "#") {
      return { ...item, children: kids };
    }
    const own: Item = {
      label: item.label,
      href: item.href,
      classes: item.classes.map((c) => (c === "cc-menu-main" ? "cc-menu-sub" : c)),
      popup: false,
      children: [],
    };
    return { ...item, href: undefined, children: [own, ...kids] };
  });
}

// ── Fixtures of one kind: a copy of a site with its model changed ─────────────────────────────────

type Model = LoadedSite["model"];
interface Edit {
  posts?: (posts: Map<number, WpPost>) => void;
  meta?: (meta: Map<number, Record<string, unknown[]>>) => void;
  items?: (items: WpMenuItem[]) => WpMenuItem[];
  options?: (options: Map<string, string>) => void;
}

function withModel(site: LoadedSite, edit: Edit): LoadedSite {
  const posts = new Map(site.model.posts);
  const postMeta = new Map(site.model.postMeta) as Map<number, Record<string, unknown[]>>;
  const options = new Map(site.model.options);
  edit.posts?.(posts);
  edit.meta?.(postMeta);
  edit.options?.(options);
  const menuItems = edit.items
    ? edit.items(site.model.menuItems.map((i) => ({ ...i })))
    : site.model.menuItems;
  const model: Model = { ...site.model, posts, postMeta, options, menuItems };
  return { ...site, model };
}

let nextId = 900_000;
/** An item of menu `menu`, as `loadMenuItems` makes one. */
function item(menu: number, over: Partial<WpMenuItem> & Pick<WpMenuItem, "title">): WpMenuItem {
  const id = over.id ?? ++nextId;
  return {
    id,
    menuTermId: menu,
    parent: 0,
    order: 1,
    kind: "custom",
    objectId: id,
    object: "custom",
    url: "",
    classes: [],
    target: "",
    ...over,
  };
}

/** The menu 5 items of fineline replaced by `items` (and posts for them). */
function fineWith(site: LoadedSite, items: WpMenuItem[], edit: Edit = {}): LoadedSite {
  return withModel(site, {
    ...edit,
    items: (all) => [...all.filter((i) => i.menuTermId !== 5), ...items],
    posts: (posts) => {
      for (const it of items) {
        if (!posts.has(it.id)) {
          posts.set(it.id, {
            id: it.id,
            type: "nav_menu_item",
            status: "publish",
            slug: String(it.id),
            title: it.title,
            content: "",
            excerpt: "",
            date: "2026-01-01T00:00:00.000Z",
            modified: "2026-01-01T00:00:00.000Z",
            parent: 0,
            menuOrder: it.order,
            authorId: 1,
            guid: "",
            passwordProtected: false,
          });
        }
      }
      edit.posts?.(posts);
    },
  });
}

const codes = (report: Report): string[] => report.entries().map((e) => e.code);
const where = (report: Report, code: string) => report.entries().filter((e) => e.code === code);
const render = (site: LoadedSite, id: number | string, opts: MenuOptions = {}) => {
  const out = menuNodes(site, id, opts);
  return { ...out, html: nodesToHtml(out.nodes), menus: readNodes(site, out.nodes) };
};

// ── Every menu of both sites ─────────────────────────────────────────────────────────────────────

describe.each(SITES)("%s: every menu converts", (name) => {
  test("each nav_menu term renders all of its published items, nothing dropped, no error", async () => {
    const site = await loadSite(name);
    const terms = menuTerms(site);
    expect(terms.length).toBeGreaterThan(0);
    for (const term of terms) {
      const expected = site.model.menuItems.filter((i) => i.menuTermId === term.termId).length;
      const out = menuNodes(site, term.termId);
      expect(out.used.items).toBe(expected);
      expect(out.used.dropped).toBe(0);
      expect(out.report.entries().filter((e) => e.severity === "error")).toEqual([]);
      expect(out.used.menus.has(term.termId)).toBe(true);
      expect(out.nodes).toHaveLength(1);
      // The rendered list holds as many anchors as the menu has items.
      expect(find(parse(nodesToHtml(out.nodes)), (el) => el.tagName === "a")).toHaveLength(
        expected,
      );
    }
  });

  test("an item has the plugin's class, its id class and nothing WordPress generated", async () => {
    const site = await loadSite(name);
    for (const term of menuTerms(site)) {
      const { html } = render(site, term.termId);
      for (const a of find(parse(html), (el) => el.tagName === "a")) {
        const classes = classesOf(a);
        expect(classes[0]).toMatch(/^cc-menu-(main|sub)$/);
        expect(classes[1]).toMatch(/^menu-id-\d+$/);
        expect(classes.slice(2)).toEqual([]);
      }
    }
  });
});

// ── Against the live headers ─────────────────────────────────────────────────────────────────────

describe("the structure equals the menus the live pages print", () => {
  test("fineline: the main menu (5) is the live desktop list, line for line", async () => {
    const site = await loadSite("fineline");
    for (const file of liveFiles("fineline")) {
      const live = liveMenus(site, file);
      expect(live.map((m) => m.layout)).toEqual(["hor", "ver"]);
      const ours = render(site, 5).menus[0]!;
      expect(ours.layout).toBe("hor");
      expect(difference(flat(live[0]!.items), flat(ours.items))).toEqual({
        onlyLive: [],
        onlyOurs: [],
      });
      expect(flat(live[0]!.items)).toEqual(flat(ours.items));
    }
  });

  test("fineline: the mobile menu (271) is the live vertical list, but for the item added after the dump", async () => {
    const site = await loadSite("fineline");
    const block = { menuLayout: { lg: "vertical" } };
    for (const file of liveFiles("fineline")) {
      const live = liveMenus(site, file)[1]!;
      const ours = render(site, 271, { block }).menus[0]!;
      expect(ours.layout).toBe("ver");
      // The live site is newer than the database dump: its Services item (6959) is a custom link with no address
      // that holds an extra "All Services" page link (6113, now a child); the dump has the page link itself as the parent.
      // Ours is the dump's Services page link with children, which as a parent of the vertical list is the label of its dropdown
      // and holds its own link first: the shape the live custom link and its "All Services" item have.
      expect(difference(flat(liftedLinks(live.items)), flat(ours.items))).toEqual({
        onlyLive: [
          "Services -> (no href) [cc-menu-main menu-id-6959] popup list=Services",
          "Services > All Services -> /services/ [cc-menu-sub menu-id-6113]",
        ],
        onlyOurs: [
          "Services -> (no href) [cc-menu-main menu-id-6113] popup list=Services",
          "Services > Services -> /services/ [cc-menu-sub menu-id-6113]",
        ],
      });
      // Everything else, in the same order: the live children of Services are the dump's.
      const strip = (lines: string[]) => lines.filter((l) => !/menu-id-(6959|6113)\b/.test(l));
      expect(strip(flat(liftedLinks(live.items)))).toEqual(strip(flat(ours.items)));
    }
  });

  test("ap: the main menu (225) is both live lists, line for line", async () => {
    const site = await loadSite("ap");
    for (const file of liveFiles("ap")) {
      const live = liveMenus(site, file);
      expect(live.map((m) => m.layout)).toEqual(["hor", "ver"]);
      const hor = render(site, 225).menus[0]!;
      const ver = render(site, 225, { block: { menuLayout: { lg: "vertical" } } }).menus[0]!;
      expect(flat(live[0]!.items)).toEqual(flat(hor.items));
      expect(flat(liftedLinks(live[1]!.items))).toEqual(flat(ver.items));
      expect([hor.layout, ver.layout]).toEqual(["hor", "ver"]);
    }
  });

  test("the first live item of each list is a plain link, the parent keeps its dropdown label", async () => {
    const site = await loadSite("ap");
    const live = liveMenus(site, liveFiles("ap")[0]!)[0]!;
    expect(live.items[0]!.dropdownLabel).toBe("Content");
    const ours = render(site, 225).menus[0]!;
    expect(ours.items[0]).toEqual(live.items[0]!);
  });
});

// ── The tree and the items ───────────────────────────────────────────────────────────────────────

describe("the tree", () => {
  test("items are ordered by menu_order and nested under their parent, whatever order they are stored in", async () => {
    const site = await loadSite("fineline");
    const parent = item(5, { title: "Parent", order: 2 });
    const first = item(5, { title: "First", order: 1, url: "/first/" });
    const kidB = item(5, { title: "Kid B", order: 2, parent: parent.id, url: "/b/" });
    const kidA = item(5, { title: "Kid A", order: 1, parent: parent.id, url: "/a/" });
    const grand = item(5, { title: "Grand", order: 1, parent: kidA.id, url: "/g/" });
    const out = render(fineWith(site, [kidB, grand, parent, first, kidA]), 5);
    expect(flat(out.menus[0]!.items).map((l) => l.replace(/ \[.*$/, ""))).toEqual([
      "First -> /first/",
      "Parent -> (no href)",
      "Parent > Kid A -> /a/",
      "Parent > Kid A > Grand -> /g/",
      "Parent > Kid B -> /b/",
    ]);
    // A second level repeats the structure with the sub class, the third nests another dropdown.
    expect(out.html).toContain('class="cc-menu-sub menu-id-' + kidA.id + '"');
    expect(out.html).toContain('<ul class="cc-menu-dropdown" aria-label="Kid A">');
  });

  test("an item whose parent is not in the menu is unreachable, as in WordPress, and reported with its subtree", async () => {
    const site = await loadSite("fineline");
    const lost = item(5, { title: "Lost", parent: 424242, url: "/lost/" });
    const under = item(5, { title: "Under", parent: lost.id, url: "/under/" });
    const ok = item(5, { title: "Ok", url: "/ok/" });
    const out = render(fineWith(site, [lost, under, ok]), 5);
    expect(out.html).not.toContain("Lost");
    expect(out.html).not.toContain("Under");
    expect(out.used.dropped).toBe(2);
    const [entry] = where(out.report, "menu.item-orphan");
    expect(entry).toMatchObject({ severity: "warn", where: "menu:5" });
    expect(entry!.data).toMatchObject({ item: lost.id, parent: 424242, descendants: 1 });
  });

  test("a loop of parents is cut, not followed, and reported", async () => {
    const site = await loadSite("fineline");
    const a = item(5, { title: "A", id: 800_001, parent: 800_002, url: "/a/" });
    const b = item(5, { title: "B", id: 800_002, parent: 800_001, url: "/b/" });
    const ok = item(5, { title: "Ok", url: "/ok/" });
    const out = render(fineWith(site, [a, b, ok]), 5);
    expect(flat(out.menus[0]!.items)).toHaveLength(1);
    expect(where(out.report, "menu.item-cycle")).toHaveLength(1);
    expect(where(out.report, "menu.item-orphan")).toHaveLength(0);
  });

  test("an item for a deleted target is dropped with everything below it (WordPress hides it too)", async () => {
    const site = await loadSite("fineline");
    const gone = item(5, {
      title: "Gone",
      kind: "post_type",
      object: "page",
      objectId: 987_654_321,
    });
    const below = item(5, { title: "Below", parent: gone.id, url: "/below/" });
    const out = render(fineWith(site, [gone, below]), 5);
    expect(out.menus[0]!.items).toEqual([]);
    expect(where(out.report, "menu.item-missing")).toHaveLength(1);
    expect(where(out.report, "menu.item-missing")[0]!.data).toMatchObject({
      item: gone.id,
      descendants: 1,
      title: "Gone",
    });
    expect(out.used.dropped).toBe(2);
  });

  test("an item for a trashed target is missing too, even where the model kept the post", async () => {
    const site = await loadSite("fineline");
    const trashed = item(5, { title: "Trashed", kind: "post_type", object: "page", objectId: 195 });
    const edited = fineWith(site, [trashed], {
      posts: (posts) => posts.set(195, { ...posts.get(195)!, status: "trash" }),
    });
    const out = render(edited, 5);
    expect(out.menus[0]!.items).toEqual([]);
    expect(where(out.report, "menu.item-missing")).toHaveLength(1);
  });

  test("an item for a page the Jx site does not publish is dropped and says why", async () => {
    const site = await loadSite("fineline");
    // Page 22 is a draft: WordPress links it to ?p=22, the Jx site has no page for it.
    const draft = item(5, { title: "", kind: "post_type", object: "page", objectId: 22 });
    const out = render(fineWith(site, [draft]), 5);
    expect(out.menus[0]!.items).toEqual([]);
    const [entry] = where(out.report, "menu.item-unroutable");
    expect(entry!.data).toMatchObject({ status: "draft", objectId: 22 });
    // The title it would have shown is in the report, so the person fixing it knows which item it is.
    expect(entry!.data!.title).toBe("Home-OG");
  });
});

describe("links and labels", () => {
  test("an object item links to the object's Jx route, not to the URL stored with the item", async () => {
    const site = await loadSite("fineline");
    const page = item(5, {
      title: "Residential",
      kind: "post_type",
      object: "page",
      objectId: 195,
      url: "https://stale.example/old/",
    });
    const term = item(5, {
      title: "A term",
      kind: "taxonomy",
      object: "project_tag",
      objectId: 35,
      url: "https://stale.example/t/",
    });
    const archive = item(5, {
      title: "Projects",
      kind: "post_type_archive",
      object: "project",
      objectId: 0,
    });
    const out = render(fineWith(site, [page, term, archive]), 5);
    expect(flat(out.menus[0]!.items).map((l) => l.replace(/ \[.*$/, ""))).toEqual([
      "Residential -> /residential/",
      "A term -> /project_tag/agricultural-projects/",
      "Projects -> /projects/",
    ]);
    expect(out.report.entries().filter((e) => e.code.startsWith("url."))).toEqual([]);
  });

  test("an archive the Jx site lacks is dropped; a custom link is rewritten and an external one kept", async () => {
    const site = await loadSite("fineline");
    const archive = item(5, {
      title: "Nothing",
      kind: "post_type_archive",
      object: "no_such_type",
    });
    const same = item(5, { title: "Same", url: "https://finelinepainting.pro/residential/#top" });
    const ext = item(5, { title: "Ext", url: "https://example.org/x?y=1", target: "_blank" });
    const tel = item(5, { title: "Call", url: "tel:7172286606" });
    const out = render(fineWith(site, [archive, same, ext, tel]), 5);
    expect(where(out.report, "menu.item-unroutable")).toHaveLength(1);
    expect(flat(out.menus[0]!.items).map((l) => l.replace(/ \[.*$/, ""))).toEqual([
      "Same -> /residential/#top",
      "Ext -> https://example.org/x?y=1",
      "Call -> tel:7172286606",
    ]);
    expect(out.html).toContain('target="_blank"');
  });

  test("the title is the item's own, as stored (it is HTML), else the target's: a post's is texturized, a term's and a typed one are not", async () => {
    const site = await loadSite("fineline");
    const typed = item(5, { title: "Don't &amp; <em>stop</em>", url: "/t/" });
    const post = item(5, { title: "", kind: "post_type", object: "page", objectId: 195 });
    const withTerm = item(5, { title: "", kind: "taxonomy", object: "project_tag", objectId: 35 });
    const edited = fineWith(site, [typed, post, withTerm], {
      posts: (posts) => posts.set(195, { ...posts.get(195)!, title: "Women's Care - Home" }),
    });
    const termName = (edited.model.terms.get(35)?.name ?? "").length;
    expect(termName).toBeGreaterThan(0);
    const out = render(edited, 5);
    expect(out.html).toContain("Don't &amp; <em>stop</em>");
    expect(out.html).toContain("Women’s Care – Home");
    // The typed title is a real emphasis element, and its text is what a reader gets.
    const [a] = find(parse(out.html), (el) => el.tagName === "a");
    expect(textOf(a!)).toBe("Don't & stop");
    expect(find(a!, (el) => el.tagName === "em")).toHaveLength(1);
  });

  test("a term name stored with its entities reads as the character (Missions & Evangelism)", async () => {
    const site = await loadSite("ap");
    const entry = menuEntries(
      {
        site,
        report: createReport(),
        where: "t",
        url: undefined,
        used: newUsed(),
        urls: site.urls.bind(createReport()),
      },
      230,
    ).find((e) => e.id === 1885)!;
    expect(entry.label).toBe("Missions &amp; Evangelism");
    expect(readNodes(site, menuNodes(site, 230).nodes)[0]!.items.map((i) => i.label)).toContain(
      "Missions & Evangelism",
    );
  });

  test("target, XFN rel and the link's title attribute are carried", async () => {
    const site = await loadSite("fineline");
    const it = item(5, { title: "Out", url: "https://example.org/", target: "_blank" });
    const edited = fineWith(site, [it], {
      posts: (posts) => posts.set(it.id, { ...posts.get(it.id)!, excerpt: "Where this goes" }),
      meta: (meta) => meta.set(it.id, { _menu_item_xfn: ["nofollow noopener"] }),
    });
    const [a] = find(parse(render(edited, 5).html), (el) => el.tagName === "a");
    expect(a!.properties).toMatchObject({
      target: "_blank",
      rel: ["nofollow", "noopener"],
      title: "Where this goes",
    });
  });

  test("classes: the author's stay, every class WordPress generates goes", async () => {
    const site = await loadSite("fineline");
    const it = item(5, {
      title: "Btn",
      url: "/btn/",
      classes: [
        "",
        "menu-item",
        "menu-item-type-post_type",
        "menu-item-object-page",
        "menu-item-home",
        "menu-item-has-children",
        "menu-item-77",
        "current-menu-item",
        "current_page_parent",
        "current-page-ancestor",
        "page_item",
        "page-item-5",
        "btn",
        "btn-primary",
        "my-menu-item",
      ],
    });
    const [a] = find(parse(render(fineWith(site, [it]), 5).html), (el) => el.tagName === "a");
    expect(classesOf(a!)).toEqual([
      "cc-menu-main",
      `menu-id-${it.id}`,
      "btn",
      "btn-primary",
      "my-menu-item",
    ]);
    expect(isGeneratedClass("menu-item-type-custom")).toBe(true);
    expect(isGeneratedClass("menu-items")).toBe(false);
    expect(authoredClasses(["menu-item", "x", "", "current"])).toEqual(["x", "current"]);
  });

  test("an item's description is not printed by the plugin either: reported, not carried", async () => {
    const site = await loadSite("fineline");
    const it = item(5, { title: "Described", url: "/d/" });
    const edited = fineWith(site, [it], {
      posts: (posts) => posts.set(it.id, { ...posts.get(it.id)!, content: "About this page" }),
    });
    const out = render(edited, 5);
    expect(out.html).not.toContain("About this page");
    expect(where(out.report, "menu.description-dropped")[0]!.data).toMatchObject({ item: it.id });
  });

  test("an item with no title is kept and reported", async () => {
    const site = await loadSite("fineline");
    const it = item(5, { title: "", url: "/blank/" });
    const out = render(fineWith(site, [it]), 5);
    expect(out.menus[0]!.items).toHaveLength(1);
    expect(where(out.report, "menu.item-untitled")).toHaveLength(1);
  });

  test("a literal dollar-brace in a title survives as text; in an attribute it is split and reported", async () => {
    const site = await loadSite("fineline");
    const it = item(5, { title: "Cost ${price}", url: "/x?a=${b}" });
    const out = menuNodes(fineWith(site, [it]), 5);
    const walked = [...walkElements(out.nodes)].filter((el) => el.tagName === "a");
    expect(walked).toHaveLength(1);
    const a = walked[0]!;
    // Text goes through htmlToContent (innerHTML with the reference), the attribute is split.
    expect(JSON.stringify(a)).not.toContain("${price}");
    expect(a.attributes!.href).toBe(`/x?a=$${String.fromCharCode(0x200b)}{b}`);
    expect(where(out.report, "menu.literal-template")).toHaveLength(1);
  });
});

describe("links that go nowhere", () => {
  test("a parent with an empty or # address is a focusable label with no href", async () => {
    const site = await loadSite("fineline");
    const empty = item(5, { title: "Empty", order: 1 });
    const hash = item(5, { title: "Hash", order: 2, url: "#" });
    const real = item(5, { title: "Real", order: 3, url: "/real/" });
    const kids = [empty, hash, real].map((p, i) =>
      item(5, { title: `k${i}`, parent: p.id, url: `/k${i}/` }),
    );
    const out = menuNodes(fineWith(site, [empty, hash, real, ...kids]), 5);
    const anchors = [...walkElements(out.nodes)].filter(
      (el) =>
        el.tagName === "a" && (el.attributes as Record<string, string>)["aria-haspopup"] === "true",
    );
    expect(anchors.map((a) => a.attributes)).toEqual([
      { tabindex: "0", "aria-haspopup": "true" },
      { tabindex: "0", "aria-haspopup": "true" },
      { href: "/real/", "aria-haspopup": "true" },
    ]);
    const [info] = where(out.report, "menu.empty-url");
    expect(info).toMatchObject({ severity: "info" });
    expect(where(out.report, "menu.empty-url")).toHaveLength(1);
  });

  test("a leaf with no address is warned about; a leaf with # keeps it", async () => {
    const site = await loadSite("fineline");
    const none = item(5, { title: "None", order: 1 });
    const hash = item(5, { title: "Hash", order: 2, url: "#" });
    const out = render(fineWith(site, [none, hash]), 5);
    expect(flat(out.menus[0]!.items).map((l) => l.replace(/ \[.*$/, ""))).toEqual([
      "None -> (no href)",
      "Hash -> #",
    ]);
    const entries = where(out.report, "menu.empty-url");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ severity: "warn" });
  });
});

describe("the block's options", () => {
  test("the plugin's defaults: horizontal on the main breakpoint, an icon for parents when the block has one", async () => {
    const site = await loadSite("fineline");
    expect(menuBlockOptions(site)).toEqual({
      horizontal: true,
      main: { markup: undefined, position: "before" },
      sub: { markup: undefined, position: "before" },
    });
    // A saved layout replaces the default whole: a layout with no value for the main breakpoint is vertical.
    expect(menuBlockOptions(site, { menuLayout: { md: "horizontal" } }).horizontal).toBe(false);
    expect(menuBlockOptions(site, { menuLayout: { lg: "vertical" } }).horizontal).toBe(false);
    expect(
      menuBlockOptions(site, { menuMainMenuIconActive: false, menuMainMenuIconUnicode: "<svg/>" })
        .main.markup,
    ).toBeUndefined();
    expect(
      menuBlockOptions(site, { menuSubMenuIconUnicode: "<i/>", menuSubMenuIconPosition: "after" })
        .sub,
    ).toEqual({
      markup: "<i/>",
      position: "after",
    });
  });

  test("the main icon goes after the title of a parent (fineline's chevron), and only on parents", async () => {
    const site = await loadSite("fineline");
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><path d="M1 1"></path></svg>';
    const { html } = render(site, 5, {
      block: { menuMainMenuIconUnicode: svg, menuMainMenuIconPosition: "after" },
    });
    expect(html.match(/<svg/g)).toHaveLength(1);
    expect(html).toContain(`>Services${svg}</a>`);
    const before = render(site, 5, { block: { menuMainMenuIconUnicode: svg } }).html;
    expect(before).toContain(`>${svg}Services</a>`);
  });

  test("the live vertical list is `ver`, the horizontal `hor`; neither carries the script's roles", async () => {
    const site = await loadSite("ap");
    const ver = render(site, 225, { block: { menuLayout: { lg: "vertical" } } }).html;
    const hor = render(site, 225).html;
    expect(ver.startsWith('<ul class="cc-menu ver">')).toBe(true);
    expect(hor.startsWith('<ul class="cc-menu hor">')).toBe(true);
    for (const html of [ver, hor])
      expect(html).not.toMatch(/role=|aria-owns|aria-expanded|id="cc-menu/);
  });
});

// ── Which menu ───────────────────────────────────────────────────────────────────────────────────

describe("which menu", () => {
  test("a term id, a location, a slug and a name all find the same menu", async () => {
    const site = await loadSite("ap");
    expect(menuLocations(site)).toEqual({ "cc-menu": 225 });
    for (const id of [225, "225", " 225 ", "cc-menu", "main", "Main"]) {
      expect(findMenu(site, id)?.term).toEqual({ termId: 225, slug: "main", name: "Main" });
    }
    expect(findMenu(site, "cc-menu")?.via).toBe("location");
    expect(findMenu(site, "main")?.via).toBe("slug");
    expect(findMenu(site, "Footer service links")?.term.termId).toBe(228);
    expect(findMenu(site, "nope")).toBeUndefined();
    expect(findMenu(site, 31337)).toBeUndefined();
    // A term that is not a menu is not found by its id.
    expect(findMenu(site, 2)).toBeUndefined();
  });

  test("fineline assigns no location; its menus are named by id", async () => {
    const site = await loadSite("fineline");
    expect(menuLocations(site)).toEqual({});
    expect(menuTerms(site).map((t) => [t.termId, t.name])).toEqual([
      [5, "Main Menu"],
      [271, "Mobile Main Menu"],
    ]);
  });

  test("a menu that does not exist is an error and an empty list, as the plugin prints", async () => {
    const site = await loadSite("fineline");
    for (const id of [999, "primary"]) {
      const out = render(site, id);
      expect(out.html).toBe('<ul class="cc-menu hor"></ul>');
      expect(codes(out.report)).toEqual(["menu.not-found"]);
      expect(out.report.entries()[0]).toMatchObject({ severity: "error", where: `menu:${id}` });
    }
    // The nav flavour has no list of its own to leave empty.
    expect(menuNodes(site, 999, { flavor: "nav" }).nodes).toEqual([]);
  });

  test("a menu with no items says so once", async () => {
    const site = await loadSite("ap");
    const out = render(site, 364);
    expect(out.html).toBe('<ul class="cc-menu hor"></ul>');
    expect(where(out.report, "menu.empty")).toHaveLength(1);
    expect(out.report.entries().filter((e) => e.severity !== "info")).toEqual([]);
  });

  test("the current page and the script are reported for every menu rendered, with what a replacement could do", async () => {
    const site = await loadSite("ap");
    const out = render(site, 225);
    const current = where(out.report, "menu.current-page");
    expect(current).toHaveLength(1);
    expect(current[0]!.severity).toBe("info");
    expect(current[0]!.message).toMatch(/location\.pathname/);
    expect(where(out.report, "menu.script-dropped")).toHaveLength(1);
    // The nav flavour has no roving-tabindex script to report, but the current page still cannot be known.
    const nav = menuNodes(site, 225, { flavor: "nav" });
    expect(codes(nav.report)).toContain("menu.current-page");
    expect(codes(nav.report)).not.toContain("menu.script-dropped");
  });
});

// ── Placeholders ─────────────────────────────────────────────────────────────────────────────────

const menuPlaceholder = (
  attrs: Record<string, string>,
  block?: { name: string; attrs: Record<string, unknown> },
) => placeholderElement("menu", attrs, block ? { block } : {});

describe("replacing the placeholders", () => {
  test("a menu block's placeholder becomes the menu, with the block's own layout", async () => {
    const site = await loadSite("ap");
    const hor = menuPlaceholder(
      { "data-menu": "225" },
      { name: "cwicly/menu", attrs: { menuSelected: "225" } },
    );
    const ver = menuPlaceholder(
      { "data-menu": "225" },
      { name: "cwicly/menu", attrs: { menuSelected: "225", menuLayout: { lg: "vertical" } } },
    );
    const out = replaceMenus([hor, ver], site);
    expect(out.map((n) => (n as JxElement).className)).toEqual(["cc-menu hor", "cc-menu ver"]);
    expect(collectPlaceholders(out).size).toBe(0);
    // The input is not touched.
    expect((hor as JxElement).tagName).toBe("wp2jx-menu");
  });

  test("no menu id means the menu of the theme location `cc-menu`", async () => {
    const ap = await loadSite("ap");
    const report = createReport();
    const [list] = replaceMenus([menuPlaceholder({})], ap, {
      report,
      where: "template:cwicly//header",
    });
    expect(readNodes(ap, [list!])[0]!.items.map((i) => i.label)).toEqual([
      "Content",
      "Anabaptist Origins",
      "Follow",
      "Partners",
      "Donate",
      "Phone Line",
    ]);
    expect(report.entries().every((e) => e.where === "template:cwicly//header")).toBe(true);
    expect(report.entries().filter((e) => e.severity === "error")).toEqual([]);
    // A theme with no such location (fineline's) has nothing to answer: an error, and an empty list.
    const fine = await loadSite("fineline");
    const lost = createReport();
    const [empty] = replaceMenus([menuPlaceholder({})], fine, { report: lost });
    expect(nodesToHtml([empty!])).toBe('<ul class="cc-menu hor"></ul>');
    expect(codes(lost)).toEqual(["menu.not-found"]);
    expect(lost.entries()[0]!.where).toBe("location:cc-menu");
  });

  test("a menu that is a property of the enclosing component cannot be answered, and says so", async () => {
    const site = await loadSite("ap");
    const report = createReport();
    const el = menuPlaceholder(
      {},
      { name: "cwicly/menu", attrs: { menuSelected: "!ref=abcd12!" } },
    );
    const [list] = replaceMenus([el], site, { report });
    expect(nodesToHtml([list!])).toBe('<ul class="cc-menu hor"></ul>');
    expect(codes(report)).toEqual(["menu.component-prop"]);
    expect(report.entries()[0]!.data).toEqual({ menuSelected: "!ref=abcd12!" });
  });

  test("a navmenu block's placeholder becomes the nav items, with no list of its own", async () => {
    const site = await loadSite("fineline");
    const el = menuPlaceholder(
      { "data-menu": "5" },
      { name: "cwicly/navmenu", attrs: { menuSelected: "5" } },
    );
    const out = replaceMenus([el], site);
    expect(out).toHaveLength(19 - 14);
    expect(out.every((n) => (n as JxElement).tagName === "li")).toBe(true);
    expect(out.map((n) => (n as JxElement).className)).toEqual([
      "cc-nav-link",
      "cc-nav-link",
      "cc-nav-link",
      "cc-nav-link",
      "cc-nav-dropdown",
    ]);
  });

  test("the `{menu}` token's placeholder (no block) is a menu list", async () => {
    const site = await loadSite("fineline");
    const out = replaceMenus([{ tagName: "wp2jx-menu", attributes: { "data-menu": "271" } }], site);
    expect(out).toHaveLength(1);
    expect((out[0] as JxElement).className).toBe("cc-menu hor");
  });

  test("a placeholder inside another element is found; other placeholders stay and are not reported", async () => {
    const site = await loadSite("fineline");
    const report = createReport();
    const tree: JxNode[] = [
      {
        tagName: "header",
        children: [
          menuPlaceholder({ "data-menu": "5" }),
          placeholderElement("shortcode", { "data-shortcode": "x", "data-source": "[x]" }),
        ],
      },
    ];
    const out = replaceMenus(tree, site, { report });
    expect(nodesToHtml(out)).toContain('<ul class="cc-menu hor">');
    expect([...collectPlaceholders(out).keys()]).toEqual(["wp2jx-shortcode"]);
    expect(codes(report)).not.toContain("placeholder.unresolved");
    // One menu, rendered twice, reports its standing findings once per call.
    const twice = createReport();
    replaceMenus(
      [menuPlaceholder({ "data-menu": "5" }), menuPlaceholder({ "data-menu": "5" })],
      site,
      {
        report: twice,
      },
    );
    expect(where(twice, "menu.current-page")).toHaveLength(1);
    // Two menus in one call report once each; the nav flavour of the same menu is another finding.
    const several = createReport();
    replaceMenus(
      [
        menuPlaceholder({ "data-menu": "5" }),
        menuPlaceholder({ "data-menu": "271" }),
        menuPlaceholder({ "data-menu": "5" }, { name: "cwicly/navmenu", attrs: {} }),
      ],
      site,
      { report: several },
    );
    expect(where(several, "menu.current-page").map((e) => [e.data!.menu, e.data!.flavor])).toEqual([
      [5, "menu"],
      [271, "menu"],
      [5, "nav"],
    ]);
  });

  test("menuResolvers fits replacePlaceholders next to the resolvers of other kinds", async () => {
    const site = await loadSite("fineline");
    const used = newUsed();
    const out = replacePlaceholders(
      [
        menuPlaceholder({ "data-menu": "271" }),
        placeholderElement("shortcode", { "data-shortcode": "x", "data-source": "[x]" }),
      ],
      {
        ...menuResolvers(site, { used }),
        "wp2jx-shortcode": () => ({ tagName: "p", textContent: "shortcode" }),
      },
    );
    expect(nodesToHtml(out)).toContain("<p>shortcode</p>");
    expect([...used.menus]).toEqual([271]);
    expect(used.items).toBe(26);
    expect(used.classes.has("cc-menu-dropdown")).toBe(true);
  });
});

// ── wp_navigation and core/navigation ────────────────────────────────────────────────────────────

describe("the block-based menu", () => {
  const navPlaceholder = (attrs: Record<string, string>, children: JxNode[] = []) =>
    placeholderElement("navigation", attrs, { className: "wp-block-navigation", children });

  test("ap's wp_navigation post is the nav core prints, with the stripped ampersand escapes repaired", async () => {
    const site = await loadSite("ap");
    expect(navigationPost(site, 5936)?.title).toBe("Category pages");
    expect(navigationPost(site, 225)).toBeUndefined();
    const report = createReport();
    const used = newUsed();
    const [nav] = replaceMenus([navPlaceholder({ "data-ref": "5936" })], site, { report, used });
    const root = parse(nodesToHtml([nav!]));
    const links = find(root, (el) => classesOf(el).includes("wp-block-navigation-item__content"));
    expect(links.map((a) => [textOf(a), a.properties?.href])).toEqual([
      ["Bible", "/category/bible/"],
      ["Christian Living", "/category/christian-living/"],
      ["Church", "/category/church/"],
      ["Current Issues", "/category/current-issues/"],
      ["History", "/category/history/"],
      ["Missions & Evangelism", "/category/missions-evangelism/"],
      ["Study & Education", "/category/study-education/"],
      ["Testimony & Life Experience", "/category/testimony-life-experience/"],
      ["Theology", "/category/theology/"],
    ]);
    expect((nav as JxElement).tagName).toBe("nav");
    expect(
      find(root, (el) => classesOf(el).includes("wp-block-navigation__container")),
    ).toHaveLength(1);
    expect(where(report, "menu.label-repaired")).toHaveLength(3);
    expect(where(report, "menu.navigation-simplified")).toHaveLength(1);
    expect([...used.navigations]).toEqual([5936]);
    expect(used.items).toBe(9);
    // `menu-item menu-item-type-taxonomy …` is what the editor stored in the block's className; none of it is kept.
    expect(nodesToHtml([nav!])).not.toContain("menu-item");
  });

  test("fineline's: links to draft pages are dropped and reported, the rest go through the routes", async () => {
    const site = await loadSite("fineline");
    const report = createReport();
    const used = newUsed();
    const [nav] = replaceMenus([navPlaceholder({ "data-ref": "1107" })], site, { report, used });
    const links = find(parse(nodesToHtml([nav!])), (el) =>
      classesOf(el).includes("wp-block-navigation-item__content"),
    );
    expect(links.map((a) => [textOf(a), a.properties?.href])).toEqual([
      ["Residential", "/residential/"],
      ["Commercial", "/commercial/"],
      ["Commercial", "/commercial/"],
      ["Projects", "/projects/"],
      ["Quote", "/quote/"],
    ]);
    // Home (22), Agricultural (189) and Line Painting (916) are drafts.
    expect(
      where(report, "menu.item-unroutable").map((e) => [e.data!.objectId, e.data!.status]),
    ).toEqual([
      [22, "draft"],
      [189, "draft"],
      [916, "draft"],
    ]);
    expect(used.dropped).toBe(3);
    expect(used.items).toBe(5);
    // A link to an object the site does not have at all keeps its stored address (rewritten, and reported by the URL tools).
    const edited = withModel(site, {
      posts: (posts) =>
        posts.set(1107, {
          ...posts.get(1107)!,
          content:
            '<!-- wp:navigation-link {"label":"Old","id":777777,"kind":"post-type","type":"page","url":"https://finelinepainting.pro/old-page/"} /-->',
        }),
    });
    const [old] = replaceMenus([navPlaceholder({ "data-ref": "1107" })], edited);
    expect(nodesToHtml([old!])).toContain('href="https://finelinepainting.pro/old-page/"');
  });

  test("with no ref the links the block held are the menu; with a ref that is gone they are the fallback", async () => {
    const site = await loadSite("fineline");
    const link: JxNode = {
      tagName: "li",
      className: "wp-block-navigation-item wp-block-navigation-link",
      children: [{ tagName: "a", attributes: { href: "/x/" }, textContent: "X" }],
    };
    const inline = createReport();
    const [a] = replaceMenus([navPlaceholder({}, [link])], site, { report: inline });
    expect(nodesToHtml([a!])).toContain('<a href="/x/">X</a>');
    expect(inline.entries().filter((e) => e.severity !== "info")).toEqual([]);
    const missing = createReport();
    const [b] = replaceMenus([navPlaceholder({ "data-ref": "424242" }, [link])], site, {
      report: missing,
    });
    expect(nodesToHtml([b!])).toContain('<a href="/x/">X</a>');
    expect(missing.entries()[0]).toMatchObject({
      code: "menu.navigation-missing",
      severity: "warn",
    });
    const nothing = createReport();
    const [c] = replaceMenus([navPlaceholder({ "data-ref": "424242" })], site, { report: nothing });
    expect(find(parse(nodesToHtml([c!])), (el) => el.tagName === "li")).toEqual([]);
    expect(nothing.entries()[0]).toMatchObject({
      code: "menu.navigation-missing",
      severity: "error",
    });
  });

  test("submenus nest, and blocks that are not links are reported, not carried", async () => {
    const site = await loadSite("fineline");
    const content = [
      '<!-- wp:navigation-submenu {"label":"More","url":"https://example.org/m/"} -->',
      '<!-- wp:navigation-link {"label":"Inner","url":"/inner/","opensInNewTab":true,"title":"Hint"} /-->',
      "<!-- /wp:navigation-submenu -->",
      "<!-- wp:page-list /-->",
      '<!-- wp:home-link {"label":"Start"} /-->',
      '<!-- wp:navigation-link {"url":"/nolabel/"} /-->',
    ].join("");
    const edited = withModel(site, {
      posts: (posts) => posts.set(1107, { ...posts.get(1107)!, content }),
    });
    const report = createReport();
    const [nav] = replaceMenus([navPlaceholder({ "data-ref": "1107" })], edited, { report });
    const root = parse(nodesToHtml([nav!]));
    const sub = find(root, (el) => classesOf(el).includes("wp-block-navigation-submenu"));
    expect(sub).toHaveLength(1);
    expect(classesOf(sub[0]!)).toContain("has-child");
    const inner = find(sub[0]!, (el) =>
      classesOf(el).includes("wp-block-navigation__submenu-container"),
    );
    expect(inner).toHaveLength(1);
    const innerLink = find(inner[0]!, (el) => el.tagName === "a")[0]!;
    expect(innerLink.properties).toMatchObject({
      href: "/inner/",
      target: "_blank",
      rel: ["noopener"],
      title: "Hint",
    });
    expect(
      find(root, (el) => classesOf(el).includes("wp-block-navigation-item__content")).map((a) =>
        textOf(a),
      ),
    ).toEqual(["More", "Inner", "Start"]);
    expect(where(report, "menu.navigation-block")).toHaveLength(1);
    expect(where(report, "menu.navigation-block")[0]!.data).toEqual({ block: "core/page-list" });
  });
});

// ── The nav family (`{nav_menu=ID}`) ─────────────────────────────────────────────────────────────

describe("the cc-nav items", () => {
  test("a leaf is li.cc-nav-link > a.cc-nav-item; a parent is li.cc-nav-dropdown with a button, its content and its sections", async () => {
    const site = await loadSite("fineline");
    const icon = { viewBox: "0 0 28 28", paths: [null, { d: "M1 1", fill: "#fff" }] };
    const out = menuNodes(site, 5, {
      flavor: "nav",
      block: { menuDropdownIconActive: true, menuDropdownIcon: icon },
    });
    const root = parse(nodesToHtml(out.nodes));
    const lis = elementChildren(root);
    expect(lis.map((li) => classesOf(li))).toEqual([
      ["cc-nav-link"],
      ["cc-nav-link"],
      ["cc-nav-link"],
      ["cc-nav-link"],
      ["cc-nav-dropdown"],
    ]);
    const dropdown = lis[4]!;
    const [button, content] = elementChildren(dropdown);
    expect(classesOf(button!)).toEqual(["cc-nav-item", "cc-nav-dropdown__button"]);
    const title = find(button!, (el) =>
      classesOf(el).includes("cc-nav-dropdown__button--title"),
    )[0]!;
    expect(title.tagName).toBe("a");
    expect(title.properties?.href).toBe("/services/");
    const iconEl = find(button!, (el) =>
      classesOf(el).includes("cc-nav-dropdown__button--icon"),
    )[0]!;
    expect(find(iconEl, (el) => el.tagName === "path")[0]!.properties).toEqual({
      d: "M1 1",
      fill: "#fff",
    });
    expect(classesOf(content!)).toEqual(["cc-nav-dropdown__content"]);
    const links = find(content!, (el) => classesOf(el).includes("cc-nav__submenu-item--link"));
    expect(links).toHaveLength(14);
    expect(textOf(links[0]!)).toBe("Barn Roof Painting");
    expect(find(content!, (el) => el.tagName === "h2")).toHaveLength(1);
    expect(out.used.items).toBe(19);
  });

  test("a parent with no address is a button, children with children make groups, the footer switch makes the footer section", async () => {
    const site = await loadSite("fineline");
    const top = item(5, { title: "Mega", order: 1 });
    const groupA = item(5, { title: "Group A", parent: top.id, order: 1, url: "/ga/" });
    const a1 = item(5, { title: "A1", parent: groupA.id, order: 1, url: "/a1/" });
    const a2 = item(5, {
      title: "A2",
      parent: groupA.id,
      order: 2,
      url: "/a2/",
      classes: ["menu-item", "hot"],
    });
    const foot = item(5, { title: "Foot", parent: top.id, order: 2 });
    const f1 = item(5, { title: "F1", parent: foot.id, order: 1, url: "/f1/", target: "_blank" });
    const edited = fineWith(site, [top, groupA, a1, a2, foot, f1], {
      meta: (meta) => meta.set(foot.id, { _is_footer: ["on"] }),
      posts: (posts) => posts.set(a1.id, { ...posts.get(a1.id)!, content: "Details" }),
    });
    const out = menuNodes(edited, 5, { flavor: "nav", block: { navMenuDropdownHideTitles: true } });
    const root = parse(nodesToHtml(out.nodes));
    const li = elementChildren(root)[0]!;
    expect(classesOf(li)).toEqual(["cc-nav-dropdown"]);
    const button = elementChildren(li)[0]!;
    expect(button.tagName).toBe("button");
    expect(button.properties).toMatchObject({ type: "button", ariaHasPopup: "true" });
    // A hidden title leaves no header; the body section holds Group A's own list; the footer is its own section.
    expect(find(li, (el) => classesOf(el).includes("cc-nav__section-header"))).toEqual([]);
    const sections = find(li, (el) => classesOf(el).includes("cc-nav__section"));
    expect(sections.map(classesOf)).toEqual([
      ["cc-nav__section"],
      ["cc-nav__section", "cc-nav__section--footer"],
    ]);
    const body = find(sections[0]!, (el) => classesOf(el).includes("cc-nav__submenu-item--link"));
    expect(body.map((a) => [textOf(a), a.properties?.href])).toEqual([
      ["A1Details", "/a1/"],
      ["A2", "/a2/"],
    ]);
    expect(
      classesOf(
        find(
          sections[0]!,
          (el) => el.tagName === "a" && classesOf(el).includes("cc-nav__submenu-header"),
        )[0]!,
      ),
    ).toContain("cc-nav__submenu-header");
    const footLink = find(sections[1]!, (el) =>
      classesOf(el).includes("cc-nav__submenu-item--link"),
    )[0]!;
    expect(footLink.properties).toMatchObject({
      href: "/f1/",
      target: "_blank",
      rel: ["noopener"],
    });
    // A2's authored class is on its list item, the generated one is not.
    expect(
      find(sections[0]!, (el) => el.tagName === "li" && classesOf(el).includes("hot")),
    ).toHaveLength(1);
  });
});

// ── The real header parts ────────────────────────────────────────────────────────────────────────

const PARTS: Record<SiteName, string[]> = {
  fineline: ["header"],
  ap: ["header", "header-light", "mobile-menu"],
};

describe.each(SITES)("%s: the converted template parts", (name) => {
  test("every menu placeholder of every part with a menu is replaced, nothing else is touched", async () => {
    const site = await loadSite(name);
    for (const slug of PARTS[name]) {
      const converted = await convertSubject(site, { kind: "part", slug });
      const before = collectPlaceholders(converted.nodes);
      const menus = before.get("wp2jx-menu") ?? 0;
      expect(menus).toBeGreaterThan(0);
      const report = createReport();
      const used = newUsed();
      const out = replaceMenus(converted.nodes, site, { report, used, where: `template:${slug}` });
      const after = collectPlaceholders(out);
      expect(after.get("wp2jx-menu")).toBeUndefined();
      // What else the part holds (a template part, a shortcode) is still there, as many as there were.
      for (const [tag, count] of before)
        if (tag !== "wp2jx-menu") expect(after.get(tag)).toBe(count);
      const lists = find(
        parse(nodesToHtml(out)),
        (el) => el.tagName === "ul" && classesOf(el).includes("cc-menu"),
      );
      expect(lists).toHaveLength(menus);
      expect(report.entries().filter((e) => e.severity !== "info")).toEqual([]);
      expect(report.entries().every((e) => e.where === `template:${slug}`)).toBe(true);
      expect(used.items).toBeGreaterThan(0);
    }
  });

  test("the lists of the parts are the live page's lists (the layout the block saved decides hor or ver)", async () => {
    const site = await loadSite(name);
    const ours = [];
    for (const slug of PARTS[name]) {
      const converted = await convertSubject(site, { kind: "part", slug });
      ours.push(
        ...menusOf(parse(nodesToHtml(replaceMenus(converted.nodes, site))), originsOf(site)),
      );
    }
    const live = liveMenus(site, liveFiles(name)[0]!);
    expect(live.length).toBe(2);
    // A block that a page's own conditions hide on the live site is converted too, so ours may hold more lists.
    expect(ours.length).toBeGreaterThanOrEqual(live.length);
    for (const list of live) {
      // The vertical list as this module writes it (see liftedLinks); the horizontal one is the live one.
      const wanted = flat(list.layout === "ver" ? liftedLinks(list.items) : list.items);
      const same = ours.filter(
        (o) => o.layout === list.layout && flat(o.items).join("\n") === wanted.join("\n"),
      );
      if (name === "fineline" && list.layout === "ver") {
        // The live mobile list is newer than the dump (the Services item 6959): ours is the dump's menu 271,
        // whose Services page link is a label and its own first item, as many lines as the live pair.
        expect(ours.some((o) => o.layout === "ver" && flat(o.items).length === wanted.length)).toBe(
          true,
        );
      } else {
        expect(same.length).toBeGreaterThan(0);
      }
    }
  });
});

// ── A built page ─────────────────────────────────────────────────────────────────────────────────

type Spec = [number, number, number];
const cmp = (a: Spec, b: Spec): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const add = (a: Spec, b: Spec): Spec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const max = (list: Spec[]): Spec =>
  list.reduce((m, x) => (cmp(x, m) > 0 ? x : m), [0, 0, 0] as Spec);

/** The specificity of one complex selector (selectors level 4: `:where` is nothing, `:is`/`:not`/`:has` take their strongest argument). */
function specificity(selector: selectorParser.Selector): Spec {
  let total: Spec = [0, 0, 0];
  selector.walk((node) => {
    if (node.parent?.type === "pseudo" && node.type === "selector") return;
    switch (node.type) {
      case "id":
        total = add(total, [1, 0, 0]);
        break;
      case "class":
      case "attribute":
        total = add(total, [0, 1, 0]);
        break;
      case "tag":
        total = add(total, [0, 0, 1]);
        break;
      case "pseudo": {
        const name = node.value.toLowerCase();
        if (name === ":where") break;
        if ([":is", ":not", ":has", ":matches"].includes(name)) {
          total = add(total, max(node.nodes.map((n) => specificity(n as selectorParser.Selector))));
        } else if (
          name.startsWith("::") ||
          [":before", ":after", ":first-line", ":first-letter"].includes(name)
        ) {
          total = add(total, [0, 0, 1]);
        } else total = add(total, [0, 1, 0]);
        break;
      }
      default:
    }
  });
  return total;
}

interface Rule {
  selector: string;
  spec: Spec;
  decls: Record<string, string>;
}

/** Every rule of a stylesheet, one per selector of a list, `@media` contents included. */
function rulesOf(css: string): Rule[] {
  const out: Rule[] = [];
  postcss.parse(css).walkRules((rule) => {
    const decls: Record<string, string> = {};
    rule.walkDecls((d) => {
      decls[d.prop] = d.value.replace(/\s*!important\s*$/, "");
    });
    selectorParser((selectors) => {
      selectors.each((sel) => {
        out.push({ selector: sel.toString().trim(), spec: specificity(sel), decls });
      });
    }).processSync(rule.selector);
  });
  return out;
}

const styleOf = (html: string): string =>
  [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");

/** A project holding the converted parts (menus replaced), one page. */
async function buildHeader(name: SiteName) {
  const site = await loadSite(name);
  const rules: { selector: string; style: never }[] = [];
  const children: JxNode[] = [];
  for (const slug of PARTS[name].filter((s) => s !== "header-light")) {
    const converted = await convertSubject(site, { kind: "part", slug });
    rules.push(...(converted.hoisted as never[]));
    children.push(...converted.nodes);
  }
  const nodes = replacePlaceholders(replaceMenus(children, site), {
    "wp2jx-template-part": () => [],
  });
  const dir = await buildJxProject(
    {
      "project.json": { name: "menus", url: site.model.site.home, $media: site.options.media },
      "pages/index.json": { title: "Menus", children: nodes },
    },
    { name: `menus-${name}`, build: true },
  );
  return { site, built: dir, nodes };
}

describe.each(SITES)("%s: a built page", (name) => {
  test("the page validates and builds, with every menu in it and no placeholder left", async () => {
    const { built, nodes } = await buildHeader(name);
    const validation = await validateJxProject(built.dir);
    expect(validation.problems).toEqual([]);
    expect(validation.ok).toBe(true);
    const html = built.html("/");
    expect(html).not.toContain("wp2jx-");
    expect(html).not.toContain("${");
    const lists = find(
      parse(html),
      (el) => el.tagName === "ul" && classesOf(el).includes("cc-menu"),
    );
    expect(lists.length).toBe(
      find(
        parse(nodesToHtml(nodes)),
        (el) => el.tagName === "ul" && classesOf(el).includes("cc-menu"),
      ).length,
    );
    // The page ships no script: a dropdown is CSS.
    expect(html).not.toMatch(/<script/);
  });

  test("the reveal rules are in the page, and each outranks every rule that hides a dropdown", async () => {
    const { built } = await buildHeader(name);
    const rules = rulesOf(styleOf(built.html("/")));
    const dropdown = rules.filter(
      (r) => r.selector.endsWith(".cc-menu-dropdown") && !/:(hover|focus-within)/.test(r.selector),
    );
    const reveal = rules.filter(
      (r) => /:(hover|focus-within)/.test(r.selector) && r.selector.endsWith(".cc-menu-dropdown"),
    );
    expect(reveal.length).toBeGreaterThanOrEqual(3);
    const hides: [string, (v: string) => boolean][] = [
      ["visibility", (v) => v === "hidden"],
      ["opacity", (v) => v === "0"],
      ["display", (v) => v === "none"],
    ];
    let checked = 0;
    for (const [prop, isHidden] of hides) {
      const hiding = dropdown.filter(
        (r) => r.decls[prop] !== undefined && isHidden(r.decls[prop]!),
      );
      const showing = reveal.filter((r) => r.decls[prop] !== undefined);
      if (hiding.length === 0) continue;
      expect(showing.length).toBeGreaterThan(0);
      const strongestHide = max(hiding.map((r) => r.spec));
      for (const r of showing) {
        expect(cmp(r.spec, strongestHide)).toBeGreaterThan(0);
        checked++;
      }
    }
    // Fineline hides with visibility and opacity (desktop) and display (mobile); ap the same.
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  test("the reveal rules say :hover and :focus-within for the same dropdown, and display flex for the vertical list", async () => {
    const { built } = await buildHeader(name);
    const css = styleOf(built.html("/"));
    expect(css).toMatch(
      /\.cc-menu li:hover > \.cc-menu-dropdown, \.cc-menu li:focus-within > \.cc-menu-dropdown \{ visibility: visible; opacity: 1 \}/,
    );
    expect(css).toMatch(
      /\.cc-menu\.ver li:hover > \.cc-menu-dropdown, \.cc-menu\.ver li:focus-within > \.cc-menu-dropdown \{ display: flex \}/,
    );
    expect(Object.keys(DROPDOWN_STYLE)).toHaveLength(2);
  });
});

// ── What review found ────────────────────────────────────────────────────────────────────────────

const firstId = (html: string): string | undefined => /menu-id-(\d+)/.exec(html)?.[1];

describe("a block's own selection", () => {
  const block = (menuSelected: unknown, name = "cwicly/menu") =>
    menuPlaceholder({}, { name, attrs: menuSelected === undefined ? {} : { menuSelected } });

  test("what the converter could not put in data-menu (a slug, a name, a padded or numeric id) still selects the menu, as the plugin reads it", async () => {
    const site = await loadSite("ap");
    const category = firstId(render(site, 230).html);
    expect(category).toBeDefined();
    expect(category).not.toBe(firstId(render(site, 225).html));
    for (const selected of ["230", "  230 ", 230, "category-pages", "Category pages"]) {
      const report = createReport();
      const out = replaceMenus([block(selected)], site, { report });
      expect(firstId(nodesToHtml(out))).toBe(category);
      expect(report.entries().filter((e) => e.severity !== "info")).toEqual([]);
    }
  });

  test("a block that chose no menu prints an empty list, never the theme location's menu", async () => {
    const site = await loadSite("ap");
    for (const selected of [undefined, "", "   ", "0", 0]) {
      const report = createReport();
      const out = replaceMenus([block(selected)], site, { report });
      expect(nodesToHtml(out)).toBe('<ul class="cc-menu hor"></ul>');
      expect(codes(report)).toEqual(["menu.unset"]);
      expect(report.entries()[0]).toMatchObject({ severity: "warn", where: "menu:unset" });
    }
    // The nav flavour has no list of its own to leave empty.
    expect(replaceMenus([block(undefined, "cwicly/navmenu")], site)).toEqual([]);
  });

  test("a selection that names no menu is an error and an empty list; a theme location is not a way to select one", async () => {
    const site = await loadSite("ap");
    for (const selected of ["230abc", "cc-menu", "nope"]) {
      const report = createReport();
      const out = replaceMenus([block(selected)], site, { report });
      expect(nodesToHtml(out)).toBe('<ul class="cc-menu hor"></ul>');
      expect(codes(report)).toEqual(["menu.not-found"]);
      expect(report.entries()[0]).toMatchObject({ severity: "error", where: `menu:${selected}` });
    }
    expect(findMenu(site, "cc-menu", { locations: false })).toBeUndefined();
    expect(findMenu(site, "cc-menu")?.term.termId).toBe(225);
    // A menu whose slug or name is itself the location still answers to it as a slug or name.
    expect(findMenu(site, "main", { locations: false })?.via).toBe("slug");
  });

  test("a bare {menu} token has nothing to go on, so it takes the location's menu and says so", async () => {
    const site = await loadSite("ap");
    const report = createReport();
    const out = replaceMenus([menuPlaceholder({})], site, { report });
    expect(firstId(nodesToHtml(out))).toBe(firstId(render(site, 225).html));
    expect(where(report, "menu.location-assumed")).toHaveLength(1);
    expect(where(report, "menu.location-assumed")[0]).toMatchObject({
      severity: "info",
      data: { menu: 225 },
    });
  });

  test("the component-property selection still wins over everything", async () => {
    const site = await loadSite("ap");
    const report = createReport();
    replaceMenus([block("!ref=abcd12!")], site, { report });
    expect(codes(report)).toEqual(["menu.component-prop"]);
  });
});

describe("the {nav_menu=ID} token is the cc-nav family", () => {
  test("a placeholder marked data-flavor=nav is rendered as the nav items, with or without a block", async () => {
    const site = await loadSite("ap");
    const out = replaceMenus([menuPlaceholder({ "data-menu": "225", "data-flavor": "nav" })], site);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((n) => (n as JxElement).tagName === "li")).toBe(true);
    expect(nodesToHtml(out)).toContain("cc-nav-dropdown");
    expect(nodesToHtml(out)).not.toContain("cc-menu");
    // Without the marker the token is still the list.
    const list = replaceMenus([menuPlaceholder({ "data-menu": "225" })], site);
    expect(list.map((n) => (n as JxElement).className)).toEqual(["cc-menu hor"]);
  });
});

describe("the options of a cwicly/navmenu block", () => {
  const nav = (site: LoadedSite, block: Record<string, unknown>) => {
    const report = createReport();
    const nodes = menuNodes(site, 225, { flavor: "nav", block, report }).nodes;
    const html = nodesToHtml(nodes);
    return { nodes, html, report, hast: parse(`<ul>${html}</ul>`) };
  };
  const titles = (hast: Hast) =>
    find(hast, (el) => classesOf(el).includes("cc-nav__section-title"));

  test("the navMenu* attributes the block saved decide the section titles", async () => {
    const site = await loadSite("ap");
    const plain = nav(site, {});
    expect(titles(plain.hast).length).toBeGreaterThan(0);
    expect(titles(plain.hast).every((el) => el.tagName === "h2")).toBe(true);
    const h3 = nav(site, { navMenuDropdownTitleTag: "h3" });
    expect(titles(h3.hast).every((el) => el.tagName === "h3")).toBe(true);
    const hidden = nav(site, { navMenuDropdownHideTitles: true, navMenuDropdownTitleTag: "h3" });
    expect(hidden.html).not.toContain("cc-nav__section-header");
    expect(hidden.html).toContain("cc-nav-dropdown__content");
  });

  test("a title tag is one of the plugin's, in any case; anything else would be an invalid element and falls back to h2, reported once", async () => {
    const site = await loadSite("ap");
    expect(titles(nav(site, { navMenuDropdownTitleTag: " H4 " }).hast)[0]!.tagName).toBe("h4");
    for (const tag of ["script", "h2 onclick=alert(1)", "${x}", "1h", "div><img src=x", "img"]) {
      const out = nav(site, { navMenuDropdownTitleTag: tag });
      expect(titles(out.hast).length).toBeGreaterThan(0);
      expect(titles(out.hast).every((el) => el.tagName === "h2")).toBe(true);
      expect(out.html).not.toMatch(/<script|onclick|<img/);
      expect(JSON.stringify(out.nodes)).not.toContain(tag);
      expect(where(out.report, "menu.title-tag")).toHaveLength(1);
      expect(where(out.report, "menu.title-tag")[0]).toMatchObject({
        severity: "warn",
        data: { tag },
      });
    }
    // A tag that is never printed (the titles are hidden) is not worth a finding.
    expect(
      where(
        nav(site, { navMenuDropdownHideTitles: true, navMenuDropdownTitleTag: "script" }).report,
        "menu.title-tag",
      ),
    ).toEqual([]);
  });

  test("the dropdown icon's markup is written for innerHTML: a literal dollar-brace in it is the character reference, so the build never evaluates it", async () => {
    const site = await loadSite("ap");
    const icon = {
      viewBox: "0 0 ${1+1} 10",
      paths: [{ d: "M${2+2}", fill: "${evil}", opacity: "${o}" }],
    };
    const out = nav(site, { menuDropdownIconActive: true, menuDropdownIcon: icon });
    expect(out.html).toContain("&#36;{2+2}");
    expect(out.html).not.toContain("${");
    const clean = nav(site, {
      menuDropdownIconActive: true,
      menuDropdownIcon: { viewBox: "0 0 10 10", paths: [{ d: "M0 0h10" }] },
    });
    expect(clean.html).toContain('<path d="M0 0h10"></path>');
    const built = await buildJxProject(
      {
        "project.json": { name: "menus", url: site.model.site.home },
        "pages/index.json": { title: "Menus", children: [{ tagName: "ul", children: out.nodes }] },
      },
      { name: "menus-icon", build: true },
    );
    const html = built.html("/");
    expect(html).toContain("cc-nav-dropdown__button--icon");
    expect(html).not.toContain("${");
    expect(html).not.toMatch(/<script/);
    expect(built.exists("app.js")).toBe(false);
  });
});

describe("the vertical list", () => {
  const vertical = { menuLayout: { lg: "vertical" } };

  test("a parent whose link goes somewhere is the label of its dropdown and the link is the first item inside it", async () => {
    const site = await loadSite("ap");
    const out = render(site, 225, { block: vertical });
    const content = out.menus[0]!.items[0]!;
    expect(content).toMatchObject({ label: "Content", href: undefined, popup: true });
    expect(content.children[0]).toMatchObject({
      label: "Content",
      href: "/",
      classes: ["cc-menu-sub", `menu-id-${14078}`],
      popup: false,
      children: [],
    });
    // The label can be focused (a tap gives it the focus, which opens the list) and holds no address.
    const label = find(parse(out.html), (el) => classesOf(el).includes("menu-id-14078"))[0]!;
    expect(label.properties?.href).toBeUndefined();
    expect(label.properties?.tabIndex).toBe(0);
    // One finding per lifted parent, and the items counted are the menu's own.
    expect(where(out.report, "menu.vertical-link").length).toBeGreaterThan(0);
    expect(out.used.items).toBe(site.model.menuItems.filter((i) => i.menuTermId === 225).length);
    expect(out.report.entries().filter((e) => e.severity !== "info")).toEqual([]);
  });

  test("the horizontal list keeps the parent's link, which hover and focus reach", async () => {
    const site = await loadSite("ap");
    const out = render(site, 225);
    expect(out.menus[0]!.items[0]).toMatchObject({ label: "Content", href: "/" });
    expect(where(out.report, "menu.vertical-link")).toEqual([]);
  });

  test("every level is lifted; a # parent and a leaf are left alone; the own link takes the parent's title attribute, target and rel", async () => {
    const base = await loadSite("fineline");
    const mine = [
      item(5, {
        id: 810_001,
        title: "A",
        url: "https://finelinepainting.pro/a/",
        order: 1,
        target: "_blank",
      }),
      item(5, {
        id: 810_002,
        title: "B",
        url: "https://finelinepainting.pro/a/b/",
        parent: 810_001,
        order: 1,
      }),
      item(5, {
        id: 810_003,
        title: "C",
        url: "https://finelinepainting.pro/a/b/c/",
        parent: 810_002,
        order: 1,
      }),
      item(5, { id: 810_004, title: "D", url: "#", order: 2 }),
      item(5, {
        id: 810_005,
        title: "E",
        url: "https://finelinepainting.pro/e/",
        parent: 810_004,
        order: 1,
      }),
      item(5, { id: 810_006, title: "F", url: "https://finelinepainting.pro/f/", order: 3 }),
    ];
    const site = fineWith(base, mine, {
      posts: (posts) => {
        posts.set(810_001, { ...posts.get(810_001)!, excerpt: "About A" });
      },
      meta: (meta) => meta.set(810_001, { _menu_item_xfn: ["nofollow"] }),
    });
    const out = render(site, 5, { block: vertical });
    const [a, d, f] = out.menus[0]!.items;
    expect(flat([a!])).toEqual([
      "A -> (no href) [cc-menu-main menu-id-810001] popup list=A",
      "A > A -> /a/ [cc-menu-sub menu-id-810001]",
      "A > B -> (no href) [cc-menu-sub menu-id-810002] popup list=B",
      "A > B > B -> /a/b/ [cc-menu-sub menu-id-810002]",
      "A > B > C -> /a/b/c/ [cc-menu-sub menu-id-810003]",
    ]);
    // `#` is already a label; a leaf has nothing to lift.
    expect(flat([d!])[0]).toBe("D -> (no href) [cc-menu-main menu-id-810004] popup list=D");
    expect(flat([f!])).toEqual(["F -> /f/ [cc-menu-main menu-id-810006]"]);
    const anchors = find(
      parse(out.html),
      (el) => el.tagName === "a" && classesOf(el).includes("menu-id-810001"),
    );
    expect(anchors).toHaveLength(2);
    const [label, own] = anchors;
    expect(label!.properties).toMatchObject({ tabIndex: 0 });
    expect(label!.properties?.target).toBeUndefined();
    expect(label!.properties?.rel).toBeUndefined();
    expect(label!.properties?.title).toBeUndefined();
    expect(own!.properties).toMatchObject({
      href: "https://finelinepainting.pro/a/",
      target: "_blank",
      rel: ["nofollow"],
      title: "About A",
    });
    expect(out.used.items).toBe(6);
  });
});

describe("items with no nav_menu_item post", () => {
  test("what lives only in the post (link title, XFN, description, the footer switch) is unknown, and said once per menu", async () => {
    const site = await loadSite("ap");
    const bare = withModel(site, {
      posts: (posts) => {
        for (const i of site.model.menuItems) posts.delete(i.id);
      },
    });
    const count = site.model.menuItems.filter((i) => i.menuTermId === 225).length;
    const out = render(bare, 225);
    expect(where(out.report, "menu.item-data-missing")).toHaveLength(1);
    expect(where(out.report, "menu.item-data-missing")[0]).toMatchObject({
      severity: "warn",
      data: { menu: 225, items: count },
    });
    const twice = createReport();
    replaceMenus(
      [menuPlaceholder({ "data-menu": "225" }), menuPlaceholder({ "data-menu": "225" })],
      bare,
      {
        report: twice,
      },
    );
    expect(where(twice, "menu.item-data-missing")).toHaveLength(1);
    // The same site with its posts loaded has nothing to say.
    expect(where(render(site, 225).report, "menu.item-data-missing")).toEqual([]);
  });
});

describe("the current page", () => {
  test("a rendered cc-menu list asks for the script, a nav's items do not", async () => {
    const site = await loadSite("ap");
    expect(menuNodes(site, 225).used.currentPage).toBe(true);
    expect(menuNodes(site, 225, { flavor: "nav" }).used.currentPage).toBe(false);
    expect(newUsed().currentPage).toBe(false);
    const used = newUsed();
    replaceMenus([menuPlaceholder({ "data-menu": "225" })], site, { used });
    expect(used.currentPage).toBe(true);
  });

  test("the script marks the anchor whose path is the page's, trailing slash or not, and no other", () => {
    expect(CURRENT_PAGE_SCRIPT).not.toContain("${");
    expect(CURRENT_PAGE_SCRIPT).not.toContain("</script");
    const run = (pathname: string, hrefs: string[]) => {
      const anchors = hrefs.map((href) => {
        const added: string[] = [];
        const attrs: Record<string, string> = {};
        return {
          added,
          attrs,
          getAttribute: () => href,
          classList: { add: (c: string) => added.push(c) },
          setAttribute: (k: string, v: string) => (attrs[k] = v),
        };
      });
      const seen: string[] = [];
      const document = {
        querySelectorAll: (q: string) => {
          seen.push(q);
          return anchors;
        },
      };
      const location = { pathname, origin: "https://ap.test", href: `https://ap.test${pathname}` };
      new Function("document", "location", "URL", CURRENT_PAGE_SCRIPT)(document, location, URL);
      expect(seen).toEqual(["ul.cc-menu a[href]"]);
      return anchors.map((a) => (a.added.length > 0 ? [a.added, a.attrs] : null));
    };
    const current = [["current"], { "aria-current": "page" }];
    expect(
      run("/follow/", [
        "/follow/",
        "/follow",
        "https://ap.test/follow/?x=1#top",
        "https://other.test/follow/",
        "#",
        "#top",
        "mailto:a@b.test",
        "/essays/",
        "/",
        "http://",
      ]),
    ).toEqual([current, current, current, null, null, null, null, null, null, null]);
    expect(run("/", ["/", "/follow/", "https://ap.test", "#"])).toEqual([
      current,
      null,
      current,
      null,
    ]);
  });
});

// @@MORE2

// @@MORE

// @@TESTS
