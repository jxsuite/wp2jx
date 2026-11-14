/**
 * Lists a `ContentCollection` can say, written as a mapped `Array` whatever they list
 * (`src/cwicly/blocks/empty-lists.ts`, `src/cwicly/blocks/data.ts`), measured against the real Jx
 * build. Case ids in square brackets are the names a document cites:
 *
 * - `[NL1]` a mapped `Array` over a collection the build resolved as nothing renders nothing among its
 *   siblings, which stay, and the page ships no JavaScript; one with items is spliced between them.
 * - `[NL2]` a mapped `Array` over an AUTHORED empty list is still a client render (why `terms_*`,
 *   `rows_*` and people lists of nothing are written as the build's own empty list).
 * - `[NL3]` a pointer to a field the entry does not have is still a client render (why an entry's own
 *   terms and repeater rows stay computed: an entry with none has no such key); a field the entry
 *   holds empty is nothing.
 * - `[NL4]` a paged list: the page of a term with no entries, and the one page of a list of nothing,
 *   build static and empty.
 * - `[NL5]` a rule that reads the page's entry (`#/state/entry/data/url`) is resolved on each route, an
 *   empty answer included.
 * - `[NL6]` the anabaptistperspectives lists as the converter writes them now, and for an older Jx.
 * - `[NL7]` the anabaptistperspectives posts page, paged as a mapped array: its first page is the live
 *   page's twenty, every page is static, and the older form builds the same pages.
 * - `[NL8]` a loop of an item over a field of the item (its terms of a taxonomy) is written as computed
 *   children inside the mapped array: an entry without the field is nothing and the page stays
 *   static, where the pointer leaves the whole list for the browser.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "parse5";
import { stringify } from "yaml";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "./helpers/jx-build.ts";
import type { BuiltProject, ProjectFile } from "./helpers/jx-build.ts";
import { loadSite, makeCtx } from "./helpers/ctx.ts";
import { fixtureCssDir } from "./helpers/fixture-css.ts";
import { HELP, parseConvertArgs } from "../src/cli.ts";
import type { Subject } from "./helpers/ctx.ts";
import { convertSubject, type Converted } from "../src/convert.ts";
import type { SubjectOptions } from "../src/site.ts";
import { replacePlaceholders, walkElements } from "../src/placeholders.ts";
import { pagedPage } from "../src/emit/paging.ts";
import { postData } from "../src/cwicly/tokens.ts";
import { BASE_PROPERTIES, BASE_REQUIRED } from "../src/wp/acf.ts";
import { entryPosts, loopChildren } from "../src/cwicly/blocks/data.ts";
import {
  jxEmptyListsStatic,
  nativeLists,
  rendersEmptyListsStatic,
  setNativeLists,
} from "../src/cwicly/blocks/empty-lists.ts";
import type { JxElement, JxNode } from "../src/types.ts";

setDefaultTimeout(180_000);
afterAll(cleanupJxProjects);

const COLLECTION_SRC = "@jxsuite/parser/ContentCollection.class.json";

/** What `run` gives with the lists written for a Jx whose build renders an empty mapped Array in the browser. */
async function forOlderJx<T>(run: () => T | Promise<T>): Promise<T> {
  setNativeLists(false);
  try {
    return await run();
  } finally {
    setNativeLists(undefined);
  }
}

/** Whether a built page loads a script of its own (the page's module, `app.js`), leaving out the import map every page has. */
const shipsJs = (html: string): boolean =>
  /<script[^>]*type="module"/.test(html.replace(/<script type="importmap">[\s\S]*?<\/script>/, ""));

/** The body of a built page, whitespace collapsed. */
const body = (html: string): string =>
  html.slice(html.indexOf("<body"), html.indexOf("</body>")).replaceAll(/\s+/g, " ");

const collection = (contentType: string, more: Record<string, unknown> = {}): object => ({
  $prototype: "ContentCollection",
  $src: COLLECTION_SRC,
  contentType,
  ...more,
  timing: "compiler",
});

const mapped = (pointer: string, map: object): object => ({
  $prototype: "Array",
  items: { $ref: pointer },
  map,
});

describe("the capability", () => {
  test("the installed compiler's site build tells the lists it resolved apart, and that is what is asked", () => {
    const file = join(import.meta.dir, "../node_modules/@jxsuite/compiler/src/site/site-build.ts");
    const source = readFileSync(file, "utf8");
    expect(rendersEmptyListsStatic(source)).toBe(true);
    // a site build without it (Jx before compiler 8.7.0) renders an empty mapped array in the browser
    expect(rendersEmptyListsStatic(source.replaceAll("buildResolvedStateKeys", "x"))).toBe(false);
    expect(jxEmptyListsStatic()).toBe(true);
    expect(nativeLists()).toBe(true);
    // the setting wins over the installed Jx, and `undefined` asks it again
    setNativeLists(false);
    expect(nativeLists()).toBe(false);
    setNativeLists(undefined);
    expect(nativeLists()).toBe(true);
  });
});

describe("the command line", () => {
  test("--native-lists and --no-native-lists settle the lists; neither leaves them to the installed Jx", () => {
    const io = { stdout: () => {}, stderr: () => {}, env: {}, cwd: join(import.meta.dir, "..") };
    const base = [
      "--db",
      "sqlite:/x.sqlite",
      "--out",
      "o",
      "--css-from",
      fixtureCssDir("fineline"),
    ];
    const parse = (...extra: string[]) => {
      const parsed = parseConvertArgs([...base, ...extra], io);
      if (parsed === "help") throw new Error("not help");
      return parsed;
    };
    expect(parse("--native-lists").nativeLists).toBe(true);
    expect(parse("--no-native-lists").nativeLists).toBe(false);
    expect(parse()).not.toHaveProperty("nativeLists");
    // the setting is the converter's, not the project's
    expect(parse("--no-native-lists").options).not.toHaveProperty("nativeLists");
    expect(() => parse("--native-lists", "--no-native-lists")).toThrow("say opposite things");
    expect(HELP).toContain("--native-lists, --no-native-lists");
  });
});

// ── The rules, on a tiny project ─────────────────────────────────────────────────────────────────

const ITEM = (slug: string, title: string, more = ""): string =>
  `---\ntitle: ${title}\nslug: ${slug}\nurl: /items/${slug}/\n${more}---\n\nBody.\n`;

const ENTRY = {
  $prototype: "ContentEntry",
  contentType: "items",
  field: "slug",
  id: { $ref: "#/$params/slug" },
  $src: "@jxsuite/parser/ContentEntry.class.json",
  timing: "compiler",
};

const LI = { tagName: "li", textContent: "${$map.item.data.title ?? ''}" };

/** A section with a heading before the list and a paragraph after it, the list among them. */
const among = (list: object): object => ({
  tagName: "section",
  children: [
    { tagName: "h2", textContent: "Before" },
    list,
    { tagName: "p", textContent: "After" },
  ],
});

describe("built by Jx", () => {
  let built: BuiltProject;
  const build = async (): Promise<BuiltProject> =>
    (built ??= await buildJxProject(
      {
        "project.json": {
          name: "native-lists",
          url: "https://x.org",
          extensions: ["@jxsuite/parser"],
          content: { items: { source: "content/items", format: "Markdown" } },
        },
        "content/items/foo.md": ITEM("foo", "Foo", "flag: true\nnone: []\n"),
        "content/items/bar.md": ITEM("bar", "Bar", "flag: false\n"),
        "pages/empty.json": {
          title: "t",
          state: {
            none: collection("items", { filter: [{ field: "url", op: "==", value: "/nothing/" }] }),
          },
          children: [among(mapped("#/state/none", LI))],
        },
        "pages/full.json": {
          title: "t",
          state: { all: collection("items", { sort: [{ field: "title", order: "asc" }] }) },
          children: [among(mapped("#/state/all", LI))],
        },
        "pages/authored.json": {
          title: "t",
          state: { none: [] },
          children: [among(mapped("#/state/none", LI))],
        },
        "pages/absent/[slug].json": {
          $paths: { contentType: "items", param: "slug", field: "slug" },
          title: "t",
          state: { entry: ENTRY },
          children: [among(mapped("#/state/entry/data/missing", LI))],
        },
        "pages/present/[slug].json": {
          $paths: { contentType: "items", param: "slug", field: "slug" },
          title: "t",
          state: { entry: ENTRY },
          children: [among(mapped("#/state/entry/data/none", LI))],
        },
        "pages/others/[slug].json": {
          $paths: { contentType: "items", param: "slug", field: "slug" },
          title: "t",
          // the entry first: a collection's rule reads the state resolved before it
          state: {
            entry: ENTRY,
            others: collection("items", {
              filter: [
                { field: "url", op: "!=", value: { $ref: "#/state/entry/data/url" } },
                { field: "flag", op: "==", value: true },
              ],
            }),
          },
          children: [among(mapped("#/state/others", LI))],
        },
      },
      { name: "native-lists" },
    ));

  test("[NL1] an empty list the build resolved is nothing among its siblings, and the page ships nothing; a full one is spliced between them", async () => {
    const b = await build();
    const empty = b.html("/empty/");
    expect(body(empty)).toContain("<section><h2>Before</h2> <p>After</p></section>");
    expect(empty).not.toContain("data-bind");
    expect(shipsJs(empty)).toBe(false);
    const full = b.html("/full/");
    expect(body(full)).toContain(
      "<section><h2>Before</h2> <li>Bar</li> <li>Foo</li> <p>After</p></section>",
    );
    expect(shipsJs(full)).toBe(false);
  });

  test("[NL2] an authored empty list is the browser's to fill: a client render, whatever the Jx", async () => {
    const page = (await build()).html("/authored/");
    expect(page).toContain("data-bind");
    expect(shipsJs(page)).toBe(true);
  });

  test("[NL3] a pointer to a field the entry does not have is no list: a client render; an empty field of the entry is nothing", async () => {
    const b = await build();
    const page = b.html("/absent/foo/");
    expect(page).toContain("data-bind");
    expect(shipsJs(page)).toBe(true);
    // the entry is resolved by the build, so a field of it that holds no rows is a list of nothing
    const present = b.html("/present/foo/");
    expect(body(present)).toContain("<section><h2>Before</h2> <p>After</p></section>");
    expect(shipsJs(present)).toBe(false);
  });

  test("[NL5] a rule that reads the page's entry is resolved per route, an empty answer static too", async () => {
    const b = await build();
    // bar's page lists the one other flagged entry; foo's has none, and keeps its siblings
    expect(body(b.html("/others/bar/"))).toContain(
      "<section><h2>Before</h2> <li>Foo</li> <p>After</p></section>",
    );
    const foo = b.html("/others/foo/");
    expect(body(foo)).toContain("<section><h2>Before</h2> <p>After</p></section>");
    expect(shipsJs(foo)).toBe(false);
    expect(shipsJs(b.html("/others/bar/"))).toBe(false);
  });

  test("[NL4] a paged list: a term with no entries and a list of nothing build their one page static and empty", async () => {
    const post = (slug: string, day: number, topic: string): string =>
      `---\ntitle: Post ${slug}\nslug: ${slug}\ndate: 2024-01-${String(day).padStart(2, "0")}\nurl: /${slug}/\n${topic === "" ? "" : `terms:\n  topic: [{ slug: ${topic}, name: ${topic}, url: /topic/${topic}/ }]\n`}---\n\nBody.\n`;
    const paged = pagedPage(
      "pages/topic/[slug].json",
      {
        $paths: { contentType: "topic", param: "slug", field: "slug" },
        title: "Topic",
        $layout: "./layouts/base.json",
        state: {
          post_q1: collection("post", {
            filter: [
              { field: "terms.topic.slug", op: "contains", value: { $ref: "#/$params/slug" } },
            ],
            sort: [{ field: "date", order: "desc" }],
          }),
        },
        children: [among(mapped("#/state/post_q1", LI))],
      },
      { key: "post_q1", pageSize: 2 },
    );
    const none = pagedPage(
      "pages/none.json",
      {
        title: "None",
        $layout: "./layouts/base.json",
        state: {
          post_q2: collection("post", {
            filter: [{ field: "url", op: "==", value: "/nothing/" }],
            sort: [{ field: "date", order: "desc" }],
          }),
        },
        children: [among(mapped("#/state/post_q2", LI))],
      },
      { key: "post_q2", pageSize: 2 },
    );
    const b = await buildJxProject(
      {
        "project.json": {
          name: "paged-empty",
          url: "https://x.org",
          extensions: ["@jxsuite/parser"],
          content: {
            post: { source: "content/post", format: "Markdown" },
            topic: { source: "content/topic", format: "Markdown" },
          },
        },
        "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
        "content/post/p1.md": post("p1", 10, "a"),
        "content/post/p2.md": post("p2", 11, "a"),
        "content/post/p3.md": post("p3", 12, "a"),
        "content/post/p4.md": post("p4", 13, ""),
        "content/topic/a.md": "---\ntitle: A\nslug: a\n---\n",
        "content/topic/b.md": "---\ntitle: B\nslug: b\n---\n",
        [paged.file]: paged.doc,
        [none.file]: none.doc,
      },
      { name: "paged-empty" },
    );
    expect(body(b.html("/topic/a/"))).toContain("<li>Post p3</li> <li>Post p2</li>");
    expect(body(b.html("/topic/a/2/"))).toContain("<h2>Before</h2> <li>Post p1</li> <p>After</p>");
    // the term with no entries: one page, the list nothing, its siblings kept, no script
    const empty = b.html("/topic/b/");
    expect(body(empty)).toContain("<section><h2>Before</h2> <p>After</p></section>");
    expect(empty).not.toContain("data-bind");
    expect(shipsJs(empty)).toBe(false);
    expect(b.exists("topic/b/2/index.html")).toBe(false);
    const nothing = b.html("/none/");
    expect(body(nothing)).toContain("<section><h2>Before</h2> <p>After</p></section>");
    expect(shipsJs(nothing)).toBe(false);
    expect((await validateJxProject(b.dir)).problems).toEqual([]);
  });

  test("[NL8] a loop of an item over the item's own terms: computed children inside the mapped array keep a page with an entry of none static, the pointer does not", async () => {
    const post = (slug: string, day: number, topic: string): string =>
      `---\ntitle: Post ${slug}\nslug: ${slug}\ndate: 2024-01-${String(day).padStart(2, "0")}\nurl: /${slug}/\n${topic === "" ? "" : `terms:\n  topic: [{ slug: ${topic}, name: ${topic}, url: /topic/${topic}/ }]\n`}---\n\nBody.\n`;
    // the item as the taxonomy-terms converter writes it inside a loop: a mapped array over the row's terms
    const item = {
      tagName: "div",
      className: "cc-query-item",
      children: [
        { tagName: "h3", textContent: "${$map.item.data.title ?? ''}" },
        {
          tagName: "div",
          className: "tt",
          children: [
            mapped("$map/item/data/terms/topic", {
              tagName: "span",
              textContent: "${$map.item.name ?? ''}",
            }),
          ],
        },
      ],
    } as JxElement;
    const page = (name: string, rowLoops: boolean) =>
      pagedPage(
        `pages/${name}.json`,
        {
          title: name,
          $layout: "./layouts/base.json",
          state: { post_q1: collection("post", { sort: [{ field: "date", order: "desc" }] }) },
          children: [
            {
              tagName: "div",
              attributes: { "cc-query-template": "" },
              children: loopChildren({ pointer: "#/state/post_q1" }, item, rowLoops),
            },
          ],
        },
        { key: "post_q1", pageSize: 2 },
      );
    const computed = page("computed", true);
    const pointer = page("pointer", false);
    const b = await buildJxProject(
      {
        "project.json": {
          name: "row-loops",
          url: "https://x.org",
          extensions: ["@jxsuite/parser"],
          content: { post: { source: "content/post", format: "Markdown" } },
        },
        "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
        "content/post/p1.md": post("p1", 10, "a"),
        "content/post/p2.md": post("p2", 11, ""),
        "content/post/p3.md": post("p3", 12, "b"),
        [computed.file]: computed.doc,
        [pointer.file]: pointer.doc,
      },
      { name: "row-loops" },
    );
    // the first page holds p3 and p2, which has no `terms.topic`
    const first = b.html("/computed/");
    expect(body(first)).toContain(
      '<div class="cc-query-item"><h3>Post p3</h3> <div class="tt"><span>b</span></div></div> <div class="cc-query-item"><h3>Post p2</h3> <div class="tt"></div></div>',
    );
    expect(first).not.toContain("data-bind");
    expect(shipsJs(first)).toBe(false);
    expect(body(b.html("/computed/2/"))).toContain(
      '<h3>Post p1</h3> <div class="tt"><span>a</span></div>',
    );
    // the same page with the item's loop a pointer: p2's missing terms leave the list to the browser
    const second = b.html("/pointer/");
    expect(second).toContain("data-bind");
    expect(shipsJs(second)).toBe(true);
    expect((await validateJxProject(b.dir)).problems).toEqual([]);
  });
});

// ── anabaptistperspectives ───────────────────────────────────────────────────────────────────────

/** The options the templates and pages emitters convert each kind of page with (`emit/templates.ts`, `emit/pages.ts`). */
const AP_SUBJECTS: [Subject, SubjectOptions][] = [
  [
    { kind: "template", slug: "index" },
    { mode: "static", target: "page", pageable: true },
  ],
  [
    { kind: "template", slug: "archive" },
    {
      mode: "static",
      termExpr: "state.term",
      target: "page",
      pageable: true,
      termArchive: { taxonomy: "category", param: "slug" },
    },
  ],
  [
    { kind: "template", slug: "taxonomy-series" },
    {
      mode: "static",
      termExpr: "state.term",
      target: "page",
      pageable: true,
      termArchive: { taxonomy: "series", param: "slug" },
    },
  ],
  [
    { kind: "template", slug: "author" },
    { mode: "entry", entryExpr: "state.author", target: "page", pageable: true },
  ],
  [
    { kind: "template", slug: "single-post" },
    { mode: "entry", entryExpr: "state.entry", entryType: "post", target: "page" },
  ],
  [
    { kind: "post", id: 819 },
    { mode: "static", target: "page", pageable: true },
  ],
  [
    { kind: "post", id: 826 },
    { mode: "static", target: "page", pageable: true },
  ],
  [
    { kind: "post", id: 834 },
    { mode: "static", target: "page", pageable: true },
  ],
];

/** Each loop of the nodes, in document order: `$ref` of a mapped array, or the head of a computed list. */
function loopsOf(nodes: readonly JxNode[]): string[] {
  const out: string[] = [];
  for (const element of walkElements(nodes)) {
    if (!Array.isArray(element.children)) continue;
    for (const child of element.children) {
      if (typeof child === "string" && child.startsWith("${(")) {
        out.push(`computed ${/^\$\{\((.{0,24})/.exec(child)![1]}`);
      } else if (typeof child === "object" && (child as JxElement).$prototype === "Array") {
        const ref = ((child as JxElement).items as { $ref: string }).$ref;
        if (ref !== "#/state/$page/pagination/pages") out.push(ref);
      }
    }
  }
  return out;
}

const convertAp = async (subject: Subject, opts: SubjectOptions): Promise<Converted> =>
  convertSubject(await loadSite("ap"), subject, opts);

describe("[NL6] anabaptistperspectives: the lists as written", () => {
  test("every list a collection can say is a mapped array over its collection, the paged ones too; the rest stay computed", async () => {
    const got: Record<string, { loops: string[]; paged?: string }> = {};
    for (const [subject, opts] of AP_SUBJECTS) {
      const out = await convertAp(subject, opts);
      got[JSON.stringify(subject)] = {
        loops: loopsOf(out.nodes),
        ...(out.paging === undefined ? {} : { paged: out.paging.key }),
      };
    }
    expect(got).toEqual({
      '{"kind":"template","slug":"index"}': { loops: ["#/state/post_q1"], paged: "post_q1" },
      '{"kind":"template","slug":"archive"}': { loops: ["#/state/post_q1"], paged: "post_q1" },
      '{"kind":"template","slug":"taxonomy-series"}': {
        loops: ["#/state/episode_q15"],
        paged: "episode_q15",
      },
      // the author's own list reads the page's entry, so it is not the paged list, and it is a collection
      '{"kind":"template","slug":"author"}': { loops: ["#/state/episode_q83"] },
      // the entry's tags (an entry with none has no such key), and the two "more from" lists of the
      // essay's first series and category: WordPress drops a term clause the entry has no term for
      '{"kind":"template","slug":"single-post"}': {
        loops: [
          "computed state.entry.data.terms?.",
          "computed (() => { const has = (e,",
          "computed (() => { const has = (e,",
        ],
      },
      '{"kind":"post","id":819}': {
        loops: ["#/state/episode_q213", "#/state/terms_post_tag_q348", "#/state/episode_q15"],
        paged: "episode_q15",
      },
      '{"kind":"post","id":826}': {
        loops: ["#/state/supporters_update_q15"],
        paged: "supporters_update_q15",
      },
      '{"kind":"post","id":834}': { loops: ["#/state/episode_q1"], paged: "episode_q1" },
    });
  });

  test("the item is the template's blocks as JSON, with bindings on `$map.item` Studio reads as fields", async () => {
    const out = await convertAp({ kind: "template", slug: "index" }, AP_SUBJECTS[0]![1]);
    const [list] = [...walkElements(out.nodes)].flatMap((e) =>
      Array.isArray(e.children)
        ? e.children.filter(
            (c): c is JxElement =>
              typeof c === "object" &&
              (c as JxElement).$prototype === "Array" &&
              ((c as JxElement).items as { $ref: string }).$ref === "#/state/post_q1",
          )
        : [],
    );
    expect(list).toBeDefined();
    const item = (list as unknown as { map: JxElement }).map;
    expect(item).toMatchObject({ tagName: "div", className: "cc-query-item" });
    const link = [...walkElements([item])].find((e) => e.tagName === "a")!;
    expect(link.attributes).toMatchObject({ href: "${$map.item.data.url ?? ''}" });
    const json = JSON.stringify(item);
    expect(json).toContain("${$map.item.data.title ?? ''}");
    expect(json).toContain("${$map.item.data.featuredImage?.alt ?? ''}");
    // and the collection it maps: the posts newest first, no limit (the build cuts it into pages)
    expect(out.state).toMatchObject({
      post_q1: {
        $prototype: "ContentCollection",
        contentType: "post",
        sort: [{ field: "date", order: "desc" }],
        timing: "compiler",
      },
    });
    expect(out.state?.post_q1).not.toHaveProperty("limit");
  });

  test("for an older Jx the paged lists, the archive's and the author's are computed children, as before", async () => {
    const got: Record<string, string[]> = {};
    for (const [subject, opts] of AP_SUBJECTS.slice(0, 4)) {
      const out = await forOlderJx(() => convertAp(subject, opts));
      got[JSON.stringify(subject)] = loopsOf(out.nodes);
    }
    expect(got).toEqual({
      '{"kind":"template","slug":"index"}': ["computed state.post_q1).map(($i0,"],
      '{"kind":"template","slug":"archive"}': ["computed state.post_q1).map(($i0,"],
      '{"kind":"template","slug":"taxonomy-series"}': ["computed state.episode_q15).map(("],
      '{"kind":"template","slug":"author"}': ["computed (() => { const by = (f, "],
    });
  });
});

// ── The posts page, built ────────────────────────────────────────────────────────────────────────

/** The `cc-query-item`s of a page: the first link of each. */
function itemLinks(html: string): string[] {
  const out: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const first = (n: any): any => {
    if (n.nodeName === "a") return n;
    for (const c of n.childNodes ?? []) {
      const found = first(c);
      if (found) return found;
    }
    return undefined;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any): void => {
    const cls = n.attrs?.find((a: { name: string }) => a.name === "class")?.value ?? "";
    if (/\bcc-query-item\b/.test(cls)) {
      out.push(first(n)?.attrs.find((x: { name: string }) => x.name === "href")?.value ?? "");
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(parse(html));
  return out;
}

describe("[NL7] anabaptistperspectives /essays/, paged as a mapped array", () => {
  test("the first page is the live page's twenty, every page static, and the older form builds the same pages", async () => {
    const site = await loadSite("ap");
    const ctx = await makeCtx("ap", { kind: "template", slug: "index" });
    const subject: Subject = { kind: "template", slug: "index" };
    const native = await convertAp(subject, AP_SUBJECTS[0]![1]);
    const older = await forOlderJx(() => convertAp(subject, AP_SUBJECTS[0]![1]));
    expect(native.paging).toEqual({ key: "post_q1", pageSize: 20 });
    expect(older.paging).toEqual(native.paging);
    const files: Record<string, ProjectFile> = {
      "project.json": {
        name: "ap-essays",
        url: "https://example.com",
        extensions: ["@jxsuite/parser"],
        $media: site.options.media,
        defaults: { layout: "./layouts/base.json" },
        content: {
          post: {
            source: "content/post",
            format: "Markdown",
            schema: { type: "object", properties: BASE_PROPERTIES, required: [...BASE_REQUIRED] },
          },
        },
      },
      "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
    };
    const posts = entryPosts(ctx, "post");
    for (const post of posts) {
      files[`content/post/${post.slug}.md`] = `---\n${stringify(postData(ctx, post))}---\n\n`;
    }
    for (const [name, out] of [
      ["a", native],
      ["b", older],
    ] as const) {
      const page = pagedPage(
        `pages/${name}.json`,
        {
          title: "Essays",
          state: out.state,
          children: replacePlaceholders(out.nodes, { "*": () => null }),
        },
        out.paging!,
      );
      files[page.file] = page.doc;
    }
    const built = await buildJxProject(files, { name: "ap-essays" });
    const pages = Math.ceil(posts.length / 20);
    expect(pages).toBeGreaterThan(1);
    // the first page: the twenty the live /essays/ printed, in its order
    const live = itemLinks(
      readFileSync(join(import.meta.dir, "fixtures/ap/html/essays.html"), "utf8"),
    )
      .filter((href) => href.includes("/essays/"))
      .map((href) => href.slice(site.model.site.url.length));
    expect(live).toHaveLength(20);
    expect(itemLinks(built.html("/a/"))).toEqual(live);
    let listed = 0;
    for (let n = 1; n <= pages; n++) {
      const route = n === 1 ? "/a/" : `/a/${n}/`;
      const html = built.html(route);
      expect(shipsJs(html)).toBe(false);
      expect(html).not.toContain("data-bind");
      listed += itemLinks(html).length;
      // the older form, computed children over the same slice, is the same page
      expect(body(built.html(route.replace("/a/", "/b/"))).replaceAll("/b/", "/a/")).toBe(
        body(html),
      );
    }
    expect(listed).toBe(posts.length);
    expect(built.exists(`a/${pages + 1}/index.html`)).toBe(false);
  });
});
