/**
 * `src/core/block-css.ts`: WordPress core-block CSS as Jx-native project style.
 *
 * Real data first. The rendered pages under `tests/fixtures/<site>/html` are the ground truth: each
 * carries, inline, the exact WordPress stylesheets the live site served for the blocks it renders. A
 * page's emitted style is checked three ways, none of which shares logic with the module:
 *
 *   1. canonical form: the rules of the original sheets that the page's classes can reach (reduced by
 *      an independent regex-and-postcss `reachable()` below) equal the rules the REAL Jx style builder
 *      writes for the emitted entries;
 *   2. the cascade: for every element of the page, at four widths and three states, the declaration
 *      that wins in the original sheets is the one that wins in the emitted CSS (this is what notices a
 *      rule that kept its text and lost its place);
 *   3. a real `jx build` of a project that carries the style.
 *
 * Wherever a WordPress tree (`WP2JX_WP_TREE`, default the fineline checkout) and PHP exist, the
 * block library as a whole and the preset algorithm are compared with WordPress's own files and with
 * WordPress's own `WP_Theme_JSON`; those suites are skipped, not faked, where they do not.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { buildSiteStyleCSS } from "@jxsuite/site/site-style";
import { parse } from "parse5";
import postcss from "postcss";
import {
  collectWpClasses,
  collectWpClassesFromHtml,
  coreBlockStyle,
  inlineWpCss,
  wpCoreCssSources,
  wpKebabCase,
  wpPresetCss,
  wpThemeJsonLayers,
  type CoreBlockStyle,
  type CssSourceText,
  type ThemeJsonLayer,
} from "../../src/core/block-css.ts";
import { createReport } from "../../src/report.ts";
import type { JxNode, ReportEntry } from "../../src/types.ts";
import { countBlocks, walkBlocks } from "../../src/wp/blocks.ts";
import { allSubjects, loadSite, subjectBlocks } from "../helpers/ctx.ts";
import {
  analysedRulesOf,
  canonicalCss,
  canonicalDiff,
  cascadeDiff,
  cascadeOf,
  mediaQueriesFor,
} from "../helpers/css-oracle.ts";
import { FIXTURE_BREAKPOINTS, FIXTURE_SITES } from "../helpers/fixture-css.ts";
import { FIXTURES } from "../helpers/fixture-db.ts";
import { buildJxProject, cleanupJxProjects, TMP_ROOT } from "../helpers/jx-build.ts";

afterAll(() => cleanupJxProjects());

const BP = FIXTURE_BREAKPOINTS;
const MEDIA = mediaQueriesFor(BP);
const WP_TREE = process.env.WP2JX_WP_TREE ?? "/home/batonac/Development/site-finelinepainting";
const HAVE_TREE =
  existsSync(join(WP_TREE, "wp-includes/blocks")) &&
  existsSync(join(WP_TREE, "wp-includes/theme.json"));
const HAVE_PHP = Bun.which("php") !== null;

const PAGES = FIXTURE_SITES.flatMap((site) =>
  readdirSync(join(FIXTURES, site, "html"))
    .filter((file) => file.endsWith(".html"))
    .sort()
    .map((file) => ({
      site,
      file,
      html: readFileSync(join(FIXTURES, site, "html", file), "utf8"),
    })),
);

/** The CSS Jx writes for a result, by the builder the compiler writes every page's project style with. */
function cssOf(out: Pick<CoreBlockStyle, "style" | "custom">): string {
  return buildSiteStyleCSS({ ...out.custom, ...out.style }, MEDIA, (value) => value);
}

function style(
  css: string,
  used: string[],
  options: Parameters<typeof coreBlockStyle>[4] = {},
  origin = "test.css",
): { out: CoreBlockStyle; report: ReportEntry[]; css: string } {
  const report = createReport();
  const out = coreBlockStyle(used, [{ css, origin }], BP, report, options);
  return { out, report: [...report.entries()], css: cssOf(out) };
}

// ── An independent oracle: which rules of a stylesheet can a class set reach? ───────────────────

/**
 * The rules of `css` whose every class is in `used`, written without the module's selector reader:
 * `:not()` groups, strings and attribute tests are cut out of each selector member with regexes, the
 * `[class*=…]` family is judged by hand, and what is left is split into `.class` tokens. A rule that
 * names no class is kept when `ambient`. Limits, all of which the real corpus stays inside: a
 * `:is()`/`:where()` is read as if every member were required (no sheet here has one whose members
 * name different classes), and `@keyframes` are not modelled.
 */
function reachable(css: string, used: ReadonlySet<string>, ambient: boolean): string {
  const root = postcss.parse(css, { from: undefined });
  const keep = (member: string): boolean => {
    let m = member;
    for (let i = 0; i < 6; i++) m = m.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "");
    const tests = [...m.matchAll(/\[class([*^$~|]?)=("?)([^\]"]*)\2\s*i?\]/g)];
    for (const [, op, , value] of tests) {
      const names = [...used];
      const v = value ?? "";
      const ok =
        op === "*"
          ? names.some((n) => n.includes(v))
          : op === "^"
            ? names.some((n) => n.startsWith(v))
            : op === "$"
              ? names.some((n) => n.endsWith(v))
              : names.includes(v);
      if (!ok) return false;
    }
    m = m.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"|'[^']*'/g, "");
    if (/#[A-Za-z]/.test(m)) return false;
    const classes = [...m.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((x) => x[1]!);
    if (classes.length === 0 && tests.length === 0) return ambient;
    return classes.every((name) => used.has(name));
  };
  const out: string[] = [];
  const walk = (container: postcss.Container, wrap: string[]): void => {
    for (const node of container.nodes ?? []) {
      if (node.type === "rule") {
        const members = postcss.list.comma(node.selector).filter(keep);
        const body = (node.nodes ?? [])
          .filter((n): n is postcss.Declaration => n.type === "decl")
          .map((n) => n.toString())
          .join(";");
        if (members.length === 0 || body === "") continue;
        let text = `${members.join(",")}{${body}}`;
        for (const w of wrap.toReversed()) text = `${w}{${text}}`;
        out.push(text);
      } else if (
        node.type === "atrule" &&
        ["media", "supports"].includes(node.name) &&
        node.nodes
      ) {
        walk(node, [...wrap, `@${node.name} ${node.params}`]);
      }
    }
  };
  walk(root, []);
  return out.join("\n");
}

/** Whether a sheet's origin names a block whose class is not in use (the module's per-block ambient rule, restated). */
function blockOfSheet(origin: string): string | null {
  return /\/blocks\/([a-z0-9-]+)\//.exec(origin)?.[1] ?? null;
}

function reachableOfSources(sources: readonly CssSourceText[], used: ReadonlySet<string>): string {
  let text = "";
  for (const source of sources) {
    const block = blockOfSheet(source.origin);
    const blockUsed =
      block === null ||
      [...used].some(
        (c) =>
          c === `wp-block-${block}` ||
          c.startsWith(`wp-block-${block}-`) ||
          c.startsWith(`wp-block-${block}__`),
      );
    text += `${reachable(source.css.replace(/:root\{[^}]*\}/g, "").replace(/@media \(min-resolution:192dpi\)\{\}/g, ""), used, blockUsed)}\n`;
  }
  return text;
}

// ── collectWpClasses / collectWpClassesFromHtml ─────────────────────────────────────────────────

describe("collectWpClassesFromHtml", () => {
  test("reads every class attribute, splitting on ASCII whitespace only", () => {
    const found = collectWpClassesFromHtml(
      '<div class="wp-block-group  has-background\talign\nfull"><p class="a\u00a0b">x</p><img class="wp-image-3"></div>',
    );
    expect([...found].toSorted()).toEqual(
      ["a\u00a0b", "align", "full", "has-background", "wp-block-group", "wp-image-3"].toSorted(),
    );
  });

  test("a class-looking text in a script, a comment or another attribute is not a class", () => {
    const found = collectWpClassesFromHtml(
      '<script>var s = \'<p class="not-a-class">\'</script><!-- <p class="in-comment"> --><a title=\'class="nope"\' data-x="class=nope" class="real">t</a>',
    );
    expect([...found]).toEqual(["real"]);
  });

  test("reads inside <template> contents and nested elements", () => {
    const found = collectWpClassesFromHtml(
      '<template><div class="in-template"><span class="deep">x</span></div></template>',
    );
    expect([...found].toSorted()).toEqual(["deep", "in-template"]);
  });

  test("a ${…} expression is dropped and the static names around it are kept", () => {
    const found = collectWpClassesFromHtml('<p class="wp-block-x ${state.cls} has-y${z}">');
    expect([...found].toSorted()).toEqual(["has-y", "wp-block-x"]);
  });

  test("markup with no class attribute, and the empty string, find nothing", () => {
    expect(collectWpClassesFromHtml("").size).toBe(0);
    expect(collectWpClassesFromHtml("<p>a</p>").size).toBe(0);
    expect(collectWpClassesFromHtml('<p class="">a</p>').size).toBe(0);
  });

  test("on the live pages it finds the block classes of both sites", () => {
    for (const { site, file, html } of PAGES) {
      const found = collectWpClassesFromHtml(html);
      // `<body class>` and `<html class>` belong to the document: a fragment parse would drop them.
      expect(found.has("wp-embed-responsive"), `${site}/${file}`).toBe(true);
      expect(found.has("wp-theme-cwicly"), `${site}/${file}`).toBe(true);
      // The class a script mentions in text is not one: the page's own cookie banner script holds `class=` strings.
      for (const name of found) expect(name, `${site}/${file}`).not.toMatch(/["'<>=]/);
    }
    const ap = collectWpClassesFromHtml(
      PAGES.find((p) => p.file === "essays__get-in-the-way-of-evil.html")!.html,
    );
    for (const name of [
      "wp-block-image",
      "aligncenter",
      "wp-image-173",
      "has-text-align-left",
      "wp-block-search__input",
    ]) {
      expect(ap.has(name), name).toBe(true);
    }
  });
});

describe("collectWpClasses", () => {
  test("className, attributes.class, children, innerHTML markup", () => {
    const nodes: JxNode[] = [
      "text",
      {
        tagName: "div",
        className: "wp-block-group has-background",
        attributes: { class: "alignwide" },
        children: [
          { tagName: "p", className: "has-large-font-size" },
          "more text",
          { tagName: "figure", innerHTML: '<img class="wp-image-9"><svg class="icon"></svg>' },
        ],
      },
    ];
    expect([...collectWpClasses(nodes)].toSorted()).toEqual([
      "alignwide",
      "has-background",
      "has-large-font-size",
      "icon",
      "wp-block-group",
      "wp-image-9",
    ]);
  });

  test("a repeater's map, a $switch's cases and a children map are walked", () => {
    const nodes = [
      {
        tagName: "ul",
        children: {
          $prototype: "Array",
          items: [],
          map: { tagName: "li", className: "wp-block-list-item" },
        },
      },
      {
        tagName: "section",
        $switch: { $ref: "#/state/x" },
        cases: {
          a: { tagName: "p", className: "has-text-align-center" },
          b: { tagName: "p", className: "alignfull" },
        },
      },
      {
        tagName: "div",
        $prototype: "Array",
        items: [],
        map: { tagName: "span", className: "mapped" },
      },
    ] as unknown as JxNode[];
    expect([...collectWpClasses(nodes)].toSorted()).toEqual([
      "alignfull",
      "has-text-align-center",
      "mapped",
      "wp-block-list-item",
    ]);
  });

  test("a template expression inside a class string is dropped, its static neighbours kept", () => {
    const found = collectWpClasses([
      { tagName: "p", className: "wp-block-x ${$map.item.cls} is-style-${x}-y has-z" },
    ]);
    expect([...found].toSorted()).toEqual(["has-z", "is-style-", "-y", "wp-block-x"].toSorted());
  });

  test("nothing, and a tree without classes, find nothing", () => {
    expect(collectWpClasses([]).size).toBe(0);
    expect(collectWpClasses(["a", { tagName: "p", textContent: "x" }]).size).toBe(0);
  });

  test("agrees with the HTML reader on the same markup", () => {
    const html =
      '<div class="wp-block-columns has-3-columns"><div class="wp-block-column is-vertically-aligned-center"><p class="has-text-align-right">x</p></div></div>';
    const tree: JxNode = {
      tagName: "div",
      className: "wp-block-columns has-3-columns",
      children: [
        {
          tagName: "div",
          className: "wp-block-column is-vertically-aligned-center",
          children: [{ tagName: "p", className: "has-text-align-right", textContent: "x" }],
        },
      ],
    };
    expect([...collectWpClasses([tree])].toSorted()).toEqual(
      [...collectWpClassesFromHtml(html)].toSorted(),
    );
  });

  test("a deep tree does not blow the stack", () => {
    let node: JxNode = { tagName: "p", className: "leaf" };
    for (let i = 0; i < 20_000; i++)
      node = { tagName: "div", className: `d${i % 3}`, children: [node] };
    expect([...collectWpClasses([node])].toSorted()).toEqual(["d0", "d1", "d2", "leaf"]);
  });
});

// ── inlineWpCss ─────────────────────────────────────────────────────────────────────────────────

describe("inlineWpCss", () => {
  test("every saved page: WordPress's own inline sheets, origin from the sourceURL, comment removed, other styles left alone", () => {
    for (const { site, file, html } of PAGES) {
      const sources = inlineWpCss(html);
      const where = `${site}/${file}`;
      const origins = sources.map((s) => s.origin);
      // The sourceURL WordPress stamps is a path or a URL, whichever the site was configured with.
      expect(
        origins.some((o) => o.endsWith("/wp-includes/css/dist/block-library/common.min.css")),
        where,
      ).toBe(true);
      for (const source of sources) {
        expect(source.css, where).not.toContain("sourceURL");
        expect(source.css.trim(), where).toBe(source.css);
        expect(source.css.length, where).toBeGreaterThan(0);
      }
      // Cwicly's own inline sheet, the skip link and the Customizer's CSS are not WordPress block CSS.
      expect(sources.map((s) => s.css).join("\n"), where).not.toContain("--cc-color-1");
      expect(sources.map((s) => s.css).join("\n"), where).not.toContain(".skip-link");
    }
  });

  test("the pages that render blocks with their own sheets carry them", () => {
    const all = PAGES.flatMap(({ html }) => inlineWpCss(html).map((s) => s.origin));
    for (const block of ["image", "paragraph", "group", "list", "table"]) {
      expect(
        all.some((o) => o.endsWith(`/wp-includes/blocks/${block}/style.min.css`)),
        block,
      ).toBe(true);
    }
  });

  test("document order: the per-block sheets as printed, then wp-block-library's common sheet where the page puts it", () => {
    const html = PAGES.find((p) => p.file === "essays__get-in-the-way-of-evil.html")!.html;
    const ids = [...html.matchAll(/<style[^>]*id=["'](wp-block-[a-z-]+-inline-css)["']/g)].map(
      (m) => m[1]!.replace(/-inline-css$/, ""),
    );
    const origins = inlineWpCss(html).map(
      (s) => /blocks\/([a-z-]+)\//.exec(s.origin)?.[1] ?? "wp-block-library",
    );
    const expected = ids.map((id) =>
      id === "wp-block-library" ? id : id.replace(/^wp-block-/, ""),
    );
    expect(origins).toEqual(expected);
  });

  test("global-styles, classic-theme-styles, core-block-supports and a block sheet with no sourceURL are read; origin falls back to inline:<id>", () => {
    const html = `<html><head>
      <style id="global-styles-inline-css">:root{--wp--preset--color--x:red}</style>
      <style id="classic-theme-styles-inline-css">/*! comment */ .wp-block-button__link{color:inherit}</style>
      <style id='core-block-supports-inline-css'>.wp-container-core-group-is-layout-1{flex-wrap:nowrap}</style>
      <style id="wp-block-quote-inline-css">.wp-block-quote{margin:0}\n/*# sourceURL=https://x.test/wp-includes/blocks/quote/style.min.css */</style>
      <style id="wp-block-empty-inline-css">   </style>
      <style id="wp-img-auto-sizes-contain-inline-css">img:is([sizes=auto i]){contain-intrinsic-size:3000px 1500px}</style>
      <style>.no-id{color:red}</style>
      </head><body></body></html>`;
    const sources = inlineWpCss(html);
    expect(sources).toEqual([
      { css: ":root{--wp--preset--color--x:red}", origin: "inline:global-styles" },
      {
        css: "/*! comment */ .wp-block-button__link{color:inherit}",
        origin: "inline:classic-theme-styles",
      },
      {
        css: ".wp-container-core-group-is-layout-1{flex-wrap:nowrap}",
        origin: "inline:core-block-supports",
      },
      {
        css: ".wp-block-quote{margin:0}",
        origin: "https://x.test/wp-includes/blocks/quote/style.min.css",
      },
    ]);
  });

  test("no <style> at all, and the empty string, give no sources", () => {
    expect(inlineWpCss("")).toEqual([]);
    expect(inlineWpCss("<p>no styles</p>")).toEqual([]);
  });

  test("a <style> inside <template> contents is found too", () => {
    const sources = inlineWpCss(
      '<template><style id="wp-block-code-inline-css">.wp-block-code{border:1px solid}</style></template>',
    );
    expect(sources.map((s) => s.origin)).toEqual(["inline:wp-block-code"]);
  });
});

// ── wpCoreCssSources ────────────────────────────────────────────────────────────────────────────

describe("wpCoreCssSources", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function tree(files: Record<string, string>): string {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, "wpcss-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries(files)) {
      const target = join(dir, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, text);
    }
    return dir;
  }

  test("a checkout: each block's own sheet in name order, then the common sheet last", async () => {
    const root = tree({
      "wp-includes/blocks/image/style.min.css": ".wp-block-image{margin:0}",
      "wp-includes/blocks/columns/style.min.css": ".wp-block-columns{display:flex}",
      "wp-includes/blocks/columns/style.css": ".wp-block-columns{display:block}",
      "wp-includes/blocks/paragraph/style.css": ".wp-block-paragraph{overflow-wrap:break-word}",
      "wp-includes/blocks/paragraph/theme.css": ".wp-block-paragraph{color:red}",
      "wp-includes/blocks/empty/style.min.css": "  \n",
      "wp-includes/blocks/Not_A_Block/style.min.css": ".x{}",
      "wp-includes/blocks/block.json": "{}",
      "wp-includes/css/dist/block-library/common.min.css":
        ".screen-reader-text{clip:rect(1px,1px,1px,1px)}",
      "wp-includes/css/dist/block-library/style.min.css": ".combined{color:red}",
    });
    const sources = await wpCoreCssSources(root);
    expect(sources.map((s) => s.origin)).toEqual([
      "wp-includes/blocks/columns/style.min.css",
      "wp-includes/blocks/image/style.min.css",
      "wp-includes/blocks/paragraph/style.css",
      "wp-includes/css/dist/block-library/common.min.css",
    ]);
    expect(sources[0]!.css).toBe(".wp-block-columns{display:flex}");
  });

  test("blocks: names only those blocks (deduplicated, sorted); a name that is not a block name is ignored", async () => {
    const root = tree({
      "wp-includes/blocks/image/style.min.css": ".wp-block-image{margin:0}",
      "wp-includes/blocks/columns/style.min.css": ".wp-block-columns{display:flex}",
      "wp-includes/css/dist/block-library/common.min.css": ".c{}",
    });
    const sources = await wpCoreCssSources(root, {
      blocks: ["image", "image", "../etc", "missing", "columns"],
    });
    expect(sources.map((s) => s.origin)).toEqual([
      "wp-includes/blocks/columns/style.min.css",
      "wp-includes/blocks/image/style.min.css",
      "wp-includes/css/dist/block-library/common.min.css",
    ]);
  });

  test("a tree without per-block sheets gets the combined style.min.css; theme: true adds the theme sheets", async () => {
    const root = tree({
      "wp-includes/css/dist/block-library/style.min.css": ".wp-block-image{margin:0}",
      "wp-includes/css/dist/block-library/theme.min.css":
        ".wp-block-quote{border-left:.25em solid}",
    });
    expect((await wpCoreCssSources(root)).map((s) => s.origin)).toEqual([
      "wp-includes/css/dist/block-library/style.min.css",
    ]);
    const withTheme = await wpCoreCssSources(root, { theme: true });
    expect(withTheme.map((s) => s.origin)).toEqual([
      "wp-includes/css/dist/block-library/style.min.css",
      "wp-includes/css/dist/block-library/theme.min.css",
    ]);
  });

  test("theme: true reads each block's theme sheet before the library's", async () => {
    const root = tree({
      "wp-includes/blocks/quote/style.min.css": ".wp-block-quote{margin:0}",
      "wp-includes/blocks/quote/theme.min.css": ".wp-block-quote{border-left:1px solid}",
      "wp-includes/css/dist/block-library/common.min.css": ".c{}",
      "wp-includes/css/dist/block-library/theme.min.css": ".t{}",
    });
    const sources = await wpCoreCssSources(root, { theme: true });
    expect(sources.map((s) => s.origin)).toEqual([
      "wp-includes/blocks/quote/style.min.css",
      "wp-includes/css/dist/block-library/common.min.css",
      "wp-includes/blocks/quote/theme.min.css",
      "wp-includes/css/dist/block-library/theme.min.css",
    ]);
  });

  test("nothing found under a root: no sources, and a corecss.sources-missing warning naming the root", async () => {
    const root = tree({ "readme.txt": "x" });
    const report = createReport();
    expect(await wpCoreCssSources(root, { report })).toEqual([]);
    const [entry] = report.entries();
    expect(entry).toMatchObject({
      severity: "warn",
      code: "corecss.sources-missing",
      data: { root },
    });
    // No report given: silent, still empty.
    expect(await wpCoreCssSources(root)).toEqual([]);
  });

  test("a live URL: the combined sheet by default, per-block sheets when blocks are named, 404 and an HTML 200 are 'absent'", async () => {
    const asked: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith("/blocks/image/style.min.css"))
        return new Response(".wp-block-image{margin:0}", {
          headers: { "content-type": "text/css" },
        });
      if (url.endsWith("/blocks/gone/style.min.css") || url.endsWith("/blocks/gone/style.css"))
        return new Response("nope", { status: 404 });
      if (url.endsWith("/blocks/soft/style.min.css") || url.endsWith("/blocks/soft/style.css"))
        return new Response("<html>not found</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      if (url.endsWith("/block-library/common.min.css"))
        return new Response(".common{color:red}", { headers: { "content-type": "text/css" } });
      if (url.endsWith("/block-library/style.min.css"))
        return new Response(".combined{color:red}", { headers: { "content-type": "text/css" } });
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const combined = await wpCoreCssSources("https://example.test/", { fetch: fetcher });
    expect(combined).toEqual([
      {
        css: ".combined{color:red}",
        origin: "https://example.test/wp-includes/css/dist/block-library/style.min.css",
      },
    ]);
    asked.length = 0;
    const named = await wpCoreCssSources("https://example.test", {
      fetch: fetcher,
      blocks: ["image", "gone", "soft"],
    });
    expect(named.map((s) => s.origin)).toEqual([
      "https://example.test/wp-includes/blocks/image/style.min.css",
      "https://example.test/wp-includes/css/dist/block-library/common.min.css",
    ]);
    // `.min.css` first, the plain file as the fallback.
    expect(asked).toContain("https://example.test/wp-includes/blocks/gone/style.css");
  });

  test("a live URL that fails (5xx, refused) throws instead of pretending the sheet is absent", async () => {
    const serverError = (async () =>
      new Response("boom", {
        status: 503,
        statusText: "Service Unavailable",
      })) as unknown as typeof fetch;
    await expect(
      wpCoreCssSources("https://example.test", { fetch: serverError, blocks: ["image"] }),
    ).rejects.toThrow(/503/);
    const refused = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      wpCoreCssSources("https://example.test", { fetch: refused, blocks: ["image"] }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  test("a 410 is as absent as a 404; a root whose wp-includes/blocks is a file (ENOTDIR) is read as having no per-block sheets", async () => {
    const gone = (async (input: string | URL | Request) =>
      String(input).includes("/blocks/")
        ? new Response("", { status: 410 })
        : new Response(".common{color:red}", {
            headers: { "content-type": "text/css" },
          })) as typeof fetch;
    const sources = await wpCoreCssSources("https://example.test", {
      fetch: gone,
      blocks: ["image"],
    });
    expect(sources.map((s) => s.origin)).toEqual([
      "https://example.test/wp-includes/css/dist/block-library/common.min.css",
    ]);
    const root = tree({
      "wp-includes/blocks": "not a directory",
      "wp-includes/css/dist/block-library/style.min.css": ".combined{color:red}",
    });
    expect((await wpCoreCssSources(root)).map((s) => s.origin)).toEqual([
      "wp-includes/css/dist/block-library/style.min.css",
    ]);
  });

  test("a failure that is not 'absent' (here a directory where a sheet should be: EISDIR) throws", async () => {
    const root = tree({
      "wp-includes/blocks/image/style.min.css/inner.txt": "x",
      "wp-includes/css/dist/block-library/common.min.css": ".c{}",
    });
    await expect(wpCoreCssSources(root, { blocks: ["image"] })).rejects.toThrow(/EISDIR/);
  });

  test.skipIf(!HAVE_TREE)(
    "the real checkout: 88 block sheets and the common sheet, last",
    async () => {
      const sources = await wpCoreCssSources(WP_TREE);
      expect(sources.length).toBeGreaterThan(60);
      expect(sources.at(-1)!.origin).toBe("wp-includes/css/dist/block-library/common.min.css");
      const names = sources.slice(0, -1).map((s) => blockOfSheet(s.origin));
      expect(names).toEqual(names.toSorted());
      for (const source of sources) expect(source.css.trim().length).toBeGreaterThan(0);
    },
  );
});

// ── coreBlockStyle: the saved pages as the oracle ───────────────────────────────────────────────

describe("coreBlockStyle on every saved page (both sites)", () => {
  for (const { site, file, html } of PAGES) {
    describe(`${site}/${file}`, () => {
      const used = collectWpClassesFromHtml(html);
      const sources = inlineWpCss(html);
      const report = createReport();
      const out = coreBlockStyle(used, sources, BP, report, {
        where: `page:${file}`,
        url: `https://example.test/${file}`,
      });
      const css = cssOf(out);

      test("the canonical form of the emitted CSS equals the rules of the original sheets the page's classes can reach", () => {
        const expected = canonicalCss(reachableOfSources(sources, used), BP);
        const actual = canonicalCss(css, BP);
        expect(Object.keys(expected.rules).length).toBeGreaterThan(5);
        const diff = canonicalDiff(expected, actual, 20).filter(
          (line) => !/:root \{\} --wp--preset--font-size--(?:normal|huge)/.test(line),
        );
        expect(diff).toEqual([]);
      });

      test("the custom properties are exactly the ones the kept rules read, with the values the page's sheet declares", () => {
        const declared = new Map<string, string>();
        for (const source of sources) {
          for (const m of source.css.matchAll(/:root\{([^}]*)\}/g)) {
            for (const d of m[1]!.split(";")) {
              const [name, value] = d.split(/:(.*)/s);
              if (name?.startsWith("--") && value !== undefined) declared.set(name, value);
            }
          }
        }
        const read = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!));
        const expected = Object.fromEntries([...declared].filter(([name]) => read.has(name)));
        expect(out.custom).toEqual(expected);
      });

      test("the cascade: every element of the page gets the same winning declarations at four widths and three states", () => {
        const original = analysedRulesOf(sources.map((s) => s.css).join("\n"));
        const emitted = analysedRulesOf(css);
        const elements = new Map<string, { tag: string; classes: string[] }>();
        const walk = (node: {
          tagName?: string;
          attrs?: { name: string; value: string }[];
          childNodes?: unknown[];
        }): void => {
          if (node.tagName !== undefined) {
            const classes = (node.attrs?.find((a) => a.name === "class")?.value ?? "")
              .split(/\s+/)
              .filter(Boolean);
            elements.set(`${node.tagName}.${classes.join(".")}`, { tag: node.tagName, classes });
          }
          for (const child of (node.childNodes ?? []) as (typeof node)[]) walk(child);
        };
        walk(parse(html) as never);
        expect(elements.size).toBeGreaterThan(100);
        // A descendant target (`html :where(.has-border-color)`) is compared as text by the oracle, so a rule whose
        // target needs a class no element of the page carries is tree-shaken on purpose and shows up as a difference.
        const reachableTarget = (target: string): boolean => {
          for (const m of target.matchAll(/\.([\w-]+)/g)) if (!used.has(m[1]!)) return false;
          for (const m of target.matchAll(/\[class\*=([\w-]+)\]/g))
            if (![...used].some((u) => u.includes(m[1]!))) return false;
          return true;
        };
        let queries = 0;
        const problems: string[] = [];
        for (const { tag, classes } of elements.values()) {
          for (const width of [400, 700, 800, 1400]) {
            for (const states of [[], [":hover"], [":focus"]]) {
              queries += 1;
              const query = { classes, tag, width, states };
              const diff = cascadeDiff(
                cascadeOf(original, query),
                cascadeOf(emitted, query),
              ).filter((line) => reachableTarget(line.split("|")[0]!));
              if (diff.length > 0)
                problems.push(
                  `${tag}.${classes.join(".")} @${width}${states.join("")}: ${diff[0]}`,
                );
            }
          }
        }
        expect(queries).toBeGreaterThan(1000);
        expect(problems.slice(0, 5)).toEqual([]);
      });

      test("tree-shaken: no entry names a class the page does not use, and the page's classes are not all kept", () => {
        const names = new Set<string>();
        for (const key of Object.keys(out.style)) {
          const stripped = key
            .replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "")
            .replace(/\[[^\]]*\]/g, "");
          for (const m of stripped.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(m[1]!);
        }
        for (const name of names) expect(used.has(name), `.${name}`).toBe(true);
        const library = coreBlockStyle(
          [...used, "wp-block-columns", "wp-block-button__link", "wp-block-cover"],
          [
            {
              css: ".wp-block-columns{display:flex}.wp-block-cover{min-height:430px}.wp-block-button__link{padding:1em}.unused{x:y}",
              origin: "x.css",
            },
          ],
          BP,
        );
        expect(Object.keys(library.style)).not.toContain(".unused");
      });

      test("nothing is reported above info, and what is reported carries the page's location and URL", () => {
        const entries = report.entries();
        expect(
          entries.filter((e) => e.severity !== "info").map((e) => `${e.code}: ${e.message}`),
        ).toEqual([]);
        for (const entry of entries) {
          expect(entry.where).toBe(`page:${file}`);
          expect(entry.url).toBe(`https://example.test/${file}`);
        }
      });
    });
  }

  test("a style built from a page runs through a real `jx build` and the CSS lands in the page, unchanged", async () => {
    const { html } = PAGES.find((p) => p.file === "essays__get-in-the-way-of-evil.html")!;
    const used = collectWpClassesFromHtml(html);
    const sources = inlineWpCss(html);
    const out = coreBlockStyle(used, sources, BP);
    const site = await buildJxProject(
      {
        "project.json": {
          name: "t",
          url: "https://example.com",
          $media: { "--": "1366px", ...MEDIA },
          style: { ...out.custom, ...out.style },
        },
        "pages/index.json": {
          title: "x",
          children: [
            {
              tagName: "figure",
              className: "wp-block-image aligncenter",
              children: [{ tagName: "img", attributes: { src: "/a.png", alt: "" } }],
            },
            { tagName: "p", className: "has-text-align-left", textContent: "hi" },
          ],
        },
      },
      { name: "corecss" },
    );
    expect(site.code).toBe(0);
    const built = site.html("/");
    const emitted = [...built.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1]!)
      .join("\n");
    const expected = canonicalCss(reachableOfSources(sources, used), BP);
    const actual = canonicalCss(emitted, BP);
    const diff = canonicalDiff(expected, actual, 20).filter(
      (line) => !/:root \{\} --wp--preset--font-size--(?:normal|huge)/.test(line),
    );
    expect(diff).toEqual([]);
    expect(emitted).toContain(".wp-block-image img");
    expect(emitted).toContain(":root .has-text-align-left");
  });
});

// ── coreBlockStyle: the corpus ──────────────────────────────────────────────────────────────────

describe("coreBlockStyle over the whole corpus of core-block markup", () => {
  // Every inline sheet any saved page carries, deduplicated by origin: the block library as the live sites serve it.
  const library = new Map<string, CssSourceText>();
  for (const { html } of PAGES)
    for (const source of inlineWpCss(html))
      library.set(source.origin.replace(/^https?:\/\/[^/]+\//, ""), source);
  const librarySources = [...library.values()];

  for (const site of FIXTURE_SITES) {
    test(`${site}: the classes of every core block in every post, template, part, component and reusable block`, async () => {
      const loaded = await loadSite(site);
      const used = new Set<string>();
      let blocks = 0;
      for (const subject of allSubjects(loaded)) {
        walkBlocks(subjectBlocks(loaded, subject), (block) => {
          if (!block.name?.startsWith("core/")) return;
          blocks += 1;
          for (const name of collectWpClassesFromHtml(
            block.innerContent.filter((x) => x !== null).join(""),
          ))
            used.add(name);
        });
      }
      expect(blocks).toBeGreaterThan(500);
      const report = createReport();
      const out = coreBlockStyle(used, librarySources, BP, report);
      const css = cssOf(out);
      const expected = canonicalCss(reachableOfSources(librarySources, used), BP);
      const actual = canonicalCss(css, BP);
      expect(
        canonicalDiff(expected, actual, 20).filter(
          (line) => !/:root \{\} --wp--preset--font-size--(?:normal|huge)/.test(line),
        ),
      ).toEqual([]);
      expect(Object.keys(out.style).length).toBeGreaterThan(10);
      expect(report.entries().filter((e) => e.severity !== "info")).toEqual([]);
      // The classes the corpus uses that WordPress styles from theme.json are named, not invented.
      const unstyled = report
        .entries()
        .filter((e) => e.code === "corecss.preset-unstyled")
        .map((e) => (e.data as { class: string }).class);
      expect(unstyled.length).toBeGreaterThan(0);
      for (const name of unstyled) expect(out.style[`.${name}`], name).toBeUndefined();
    });
  }
});

// ── coreBlockStyle: hand-written edge cases ─────────────────────────────────────────────────────

describe("coreBlockStyle: what is kept", () => {
  test("a rule is kept when every class it names is in use, and not otherwise", () => {
    const { out } = style(
      ".a{color:red}.b{color:blue}.a.b{margin:0}.c .a{padding:0}.a:hover{color:green}",
      ["a", "b"],
    );
    expect(Object.keys(out.style)).toEqual([".a", ".b", ".a.b", ".a:hover"]);
  });

  test("a class inside :not() is not required; :where()/:is() are satisfied by one member", () => {
    const css =
      ".a:not(.zz){x:1}.zz:not(.a){x:2}:where(.q,.a) .b{x:3}:is(.q,.r) .b{x:4}.b:not(:where(.q)){x:5}";
    const { out } = style(css.replaceAll("x:", "top:"), ["a", "b"]);
    expect(Object.keys(out.style).toSorted()).toEqual(
      [".a:not(.zz)", ".b:not(:where(.q))", ":where(.q,.a) .b"].toSorted(),
    );
  });

  test("[class*=…] tests are judged against the used names; other attribute tests are assumed to hold", () => {
    const css =
      '[class*="wp-image-"]{height:auto}[class^=has-]{top:0}[class$=-end]{left:0}[class~=exact]{right:0}[class|=lang]{bottom:0}[class*=nope]{margin:0}[style*=border]{padding:0}[class="a b"]{width:1px}[class="a z"]{width:2px}';
    const { out } = style(css, ["wp-image-3", "has-x", "ends-end", "exact", "lang-en", "a", "b"]);
    expect(Object.keys(out.style)).toEqual([
      '[class*="wp-image-"]',
      "[class^=has-]",
      "[class$=-end]",
      "[class~=exact]",
      "[class|=lang]",
      "[style*=border]",
      '[class="a b"]',
    ]);
  });

  test("the i flag on a [class] test folds case", () => {
    const css = "[class*=WP-Image i]{height:auto}[class*=WP-Image]{top:0}";
    expect(Object.keys(style(css, ["wp-image-3"]).out.style)).toEqual(["[class*=WP-Image i]"]);
  });

  test("consecutive rules that say the same thing are one entry under their selector list, as a stylesheet writes them", () => {
    const { out } = style(
      ".a > a, .a > figure > a{display:inline-block}.a img{height:auto}.b, .c{margin:0}.d{margin:0}",
      ["a", "b", "c"],
    );
    expect(Object.entries(out.style)).toEqual([
      [".a > a, .a > figure > a", { display: "inline-block" }],
      [".a img", { height: "auto" }],
      [".b, .c", { margin: "0" }],
    ]);
  });

  test("each [class] operator tests the used names the way CSS does", () => {
    const used = ["wp-image-3", "exact", "langx", "lang-en"];
    expect(
      Object.keys(
        style("[class*=image]{top:0}[class*=-3]{left:0}[class*=zzz]{right:0}", used).out.style,
      ),
    ).toEqual(["[class*=image]", "[class*=-3]"]);
    expect(Object.keys(style("[class~=exa]{top:0}[class~=exact]{left:0}", used).out.style)).toEqual(
      ["[class~=exact]"],
    );
    expect(
      Object.keys(style("[class|=lang]{top:0}[class|=lan]{left:0}", ["langx"]).out.style),
    ).toEqual([]);
    expect(Object.keys(style("[class|=lang]{top:0}", ["lang-en"]).out.style)).toEqual([
      "[class|=lang]",
    ]);
    expect(Object.keys(style("[class|=lang]{top:0}", ["lang"]).out.style)).toEqual([
      "[class|=lang]",
    ]);
  });

  test("a bare [class] holds only when some class is in use", () => {
    expect(style("[class]{top:0}", []).out.style).toEqual({});
    expect(style("[class]{top:0}", ["a"]).out.style).toEqual({ "[class]": { top: "0" } });
  });

  test("a rule that tests the class attribute is not classless (so ambient:false keeps it); a :is() with a type member is", () => {
    expect(
      Object.keys(style("[class*=wp-image]{top:0}", ["wp-image-3"], { ambient: false }).out.style),
    ).toEqual(["[class*=wp-image]"]);
    expect(Object.keys(style(":is(.q, p){top:0}", ["q"], { ambient: false }).out.style)).toEqual(
      [],
    );
    expect(Object.keys(style(":is(.q, .r){top:0}", ["q"], { ambient: false }).out.style)).toEqual([
      ":is(.q, .r)",
    ]);
  });

  test("a classless rule is ambient: kept by default, dropped with ambient:false; a block's own sheet keeps it only when the block is used", () => {
    const css = "p{margin:0}.a{color:red}";
    expect(Object.keys(style(css, ["a"]).out.style)).toEqual(["p", ".a"]);
    expect(Object.keys(style(css, ["a"], { ambient: false }).out.style)).toEqual([".a"]);
    const sheet = "wp-includes/blocks/search/style.min.css";
    expect(Object.keys(style(css, ["a"], {}, sheet).out.style)).toEqual([".a"]);
    expect(Object.keys(style(css, ["a", "wp-block-search__input"], {}, sheet).out.style)).toEqual([
      "p",
      ".a",
    ]);
    expect(
      Object.keys(
        style(
          css,
          ["wp-block-search"],
          {},
          "https://x.test/wp-includes/blocks/search/style.min.css",
        ).out.style,
      ),
    ).toEqual(["p"]);
  });

  test("an id selector matches only the ids the caller lists", () => {
    expect(Object.keys(style("#x{color:red}.a#y{top:0}.a#x{left:0}", ["a"]).out.style)).toEqual([]);
    expect(
      Object.keys(style("#x{color:red}.a#y{top:0}.a#x{left:0}", ["a"], { ids: ["x"] }).out.style),
    ).toEqual(["#x", ".a#x"]);
  });

  test("pseudo-classes and pseudo-elements stay, legacy :before is the same as ::before", () => {
    const { out } = style(
      '.a:hover{color:red}.a::before{content:""}.a:before{color:blue}.a:focus-visible{outline:0}',
      ["a"],
    );
    expect(out.style[".a:hover"]).toEqual({ color: "red" });
    expect(out.style[".a::before"]).toEqual({ content: '""', color: "blue" });
    expect(out.style[".a:focus-visible"]).toEqual({ outline: "0" });
  });

  test("nothing used, nothing needed: no classes gives only the ambient rules, no sources gives nothing", () => {
    expect(Object.keys(style(".a{color:red}p{margin:0}", []).out.style)).toEqual(["p"]);
    const empty = coreBlockStyle(["a"], [], BP);
    expect(empty).toEqual({ style: {}, custom: {}, verbatim: "" });
  });

  test("blank class names are ignored, names are trimmed", () => {
    expect(Object.keys(style(".a{color:red}", ["", "  ", " a "]).out.style)).toEqual([".a"]);
  });
});

describe("coreBlockStyle: media queries", () => {
  test("a literal query is a literal @(...) key, nested inside the rule's entry", () => {
    const { out, css } = style(".a{display:block}@media (min-width:782px){.a{display:flex}}", [
      "a",
    ]);
    expect(out.style).toEqual({
      ".a": { display: "block", "@(min-width: 782px)": { display: "flex" } },
    });
    expect(css).toContain("@media (min-width: 782px) { .a { display: flex } }");
  });

  test("a query that equals a declared breakpoint becomes its $media name", () => {
    const { out, css } = style(
      "@media (max-width:992px){.a{color:blue}}@media (max-width: 576px){.a{color:red}}@media (max-width:781px){.a{color:green}}",
      ["a"],
    );
    expect(out.style).toEqual({
      ".a": {
        "@--md": { color: "blue" },
        "@--sm": { color: "red" },
        "@(max-width: 781px)": { color: "green" },
      },
    });
    expect(css).toContain("@media (max-width: 992px) { .a { color: blue } }");
  });

  test("@supports and nested conditions stay nested", () => {
    const { out } = style("@media (min-width:600px){@supports (display:grid){.a{display:grid}}}", [
      "a",
    ]);
    expect(out.style).toEqual({
      ".a": { "@(min-width: 600px)": { "@supports (display:grid)": { display: "grid" } } },
    });
  });

  test("columns: the base rule, the stacked query and the unstacked query as WordPress writes them", () => {
    const css =
      ".wp-block-columns{display:flex;flex-wrap:wrap!important}@media (min-width:782px){.wp-block-columns{flex-wrap:nowrap!important}}.wp-block-columns:not(.is-not-stacked-on-mobile)>.wp-block-column{flex-basis:100%!important}@media (min-width:782px){.wp-block-columns:not(.is-not-stacked-on-mobile)>.wp-block-column{flex-basis:0;flex-grow:1}}";
    const { out } = style(css, ["wp-block-columns", "wp-block-column"]);
    expect(out.style).toEqual({
      ".wp-block-columns": {
        display: "flex",
        flexWrap: "wrap !important",
        "@(min-width: 782px)": { flexWrap: "nowrap !important" },
      },
      ".wp-block-columns:not(.is-not-stacked-on-mobile) > .wp-block-column": {
        flexBasis: "100% !important",
        "@(min-width: 782px)": { flexBasis: "0", flexGrow: "1" },
      },
    });
  });
});

describe("coreBlockStyle: the cascade keeps its order", () => {
  test("a later rule that cannot be overridden by what sits between joins the entry", () => {
    const { out } = style(".a{color:red}.b{margin:0}.a{padding:0}", ["a", "b"]);
    expect(out.style).toEqual({ ".a": { color: "red", padding: "0" }, ".b": { margin: "0" } });
  });

  test("a later rule of the same selector that overrides a rule of equal specificity in between gets an entry of its own, after it", () => {
    const { out, report, css } = style(".a{color:red}.b{color:blue}.a{color:green}", ["a", "b"]);
    expect(Object.entries(out.style)).toEqual([
      [".a", { color: "red" }],
      [".b", { color: "blue" }],
      [".a, .a", { color: "green" }],
    ]);
    expect(report.map((e) => e.code)).toEqual(["corecss.rekeyed"]);
    // Both classes on one element: `.b` (earlier) loses to the later `.a`, as in the file.
    const rules = analysedRulesOf(css);
    expect(cascadeOf(rules, { classes: ["a", "b"], width: 1000 })["|color"]).toBe("color: green");
  });

  test("a base rule that follows a responsive rule of the same selector and property stays after it (the reader's class tree would not)", () => {
    const { out, report, css } = style(
      ".a{color:red}@media (min-width:600px){.a{color:blue}}.a{color:green}",
      ["a"],
    );
    expect(Object.keys(out.style)).toEqual([".a", ".a, .a"]);
    const rules = analysedRulesOf(css);
    expect(cascadeOf(rules, { classes: ["a"], width: 800 })["|color"]).toBe("color: green");
    expect(cascadeOf(rules, { classes: ["a"], width: 400 })["|color"]).toBe("color: green");
    // The reader's own warning about that order does not reach the report: this module does not have the problem it names.
    expect(report.map((e) => e.code)).toEqual(["corecss.rekeyed"]);
  });

  test("a base rule that follows a responsive rule of ANOTHER property can still join the entry", () => {
    const { out } = style(
      ".a{color:red}@media (min-width:600px){.a{color:blue}}.a{background:green}",
      ["a"],
    );
    expect(out.style).toEqual({
      ".a": { color: "red", "@(min-width: 600px)": { color: "blue" }, background: "green" },
    });
  });

  test("a more specific rule between two of a selector does not stop the merge (it wins either way)", () => {
    const { out } = style(".a{color:red}.a.b{color:blue}.a{color:green}", ["a", "b"]);
    expect(out.style).toEqual({ ".a": { color: "green" }, ".a.b": { color: "blue" } });
  });

  test("!important keeps its rank: a later plain declaration does not displace an earlier important one, the reverse does", () => {
    expect(style(".a{color:red!important}.a{color:blue}", ["a"]).out.style).toEqual({
      ".a": { color: "red !important" },
    });
    expect(style(".a{color:red}.a{color:blue!important}", ["a"]).out.style).toEqual({
      ".a": { color: "blue !important" },
    });
  });

  test("a shorthand after its longhand still overrides it; a longhand after its shorthand moves behind it", () => {
    const first = style(".a{margin-top:1px}.a{margin:0}", ["a"]);
    expect(Object.keys(first.out.style[".a"] as object)).toEqual(["marginTop", "margin"]);
    expect(
      cascadeOf(analysedRulesOf(first.css), { classes: ["a"], width: 1000 })["|margin-top"],
    ).toBe("margin: 0");
    const second = style(".a{margin-top:1px;margin:0}.a{margin-top:2px}", ["a"]);
    expect(Object.keys(second.out.style[".a"] as object)).toEqual(["margin", "marginTop"]);
    expect(
      cascadeOf(analysedRulesOf(second.css), { classes: ["a"], width: 1000 })["|margin-top"],
    ).toBe("margin-top: 2px");
  });

  test("a tag selector and a class selector of the same specificity may not trade places", () => {
    // `p.a` and `.a` differ in specificity; `.a` twice around `.b` of the same specificity must not reorder.
    const { css } = style("p{margin:0}.a{margin:1px}p{margin:2px}", ["a"]);
    const rules = analysedRulesOf(css);
    expect(cascadeOf(rules, { classes: ["a"], tag: "p", width: 1000 })["|margin-top"]).toBe(
      "margin: 1px",
    );
    expect(cascadeOf(rules, { classes: [], tag: "p", width: 1000 })["|margin-top"]).toBe(
      "margin: 2px",
    );
  });
});

describe("coreBlockStyle: when a later rule may join an earlier entry", () => {
  const keys = (
    css: string,
    used: string[],
    options: Parameters<typeof coreBlockStyle>[4] = {},
  ): string[] => Object.keys(style(css, used, options).out.style);

  test(":where() has no specificity, so a rule behind it may still join (it does not tie with the class rule)", () => {
    expect(keys(".a{color:red}:where(.a){color:blue}.a{color:green}", ["a"])).toEqual([
      ".a",
      ":where(.a)",
    ]);
  });

  test(":not() counts its argument: a compound inside it ties with a rule of the same specificity", () => {
    expect(
      keys(".x:not(.y.z){color:red}.x.y.z{color:blue}.x:not(.y.z){color:green}", ["x", "y", "z"]),
    ).toEqual([".x:not(.y.z)", ".x.y.z", ".x:not(.y.z), .x:not(.y.z)"]);
  });

  test("an attribute test counts as a class: it ties with a two-class rule", () => {
    expect(
      keys(".x[data-a]{color:red}.x.y{color:blue}.x[data-a]{color:green}", ["x", "y"]),
    ).toEqual([".x[data-a]", ".x.y", ".x[data-a], .x[data-a]"]);
  });

  test("an id outranks a class, so a rule behind an id rule may still join a class rule", () => {
    expect(keys(".a{color:red}#x{color:blue}.a{color:green}", ["a"], { ids: ["x"] })).toEqual([
      ".a",
      "#x",
    ]);
  });

  test("a type selector adds to specificity: p.a does not tie with .a", () => {
    expect(keys(".a{color:red}p.a{color:blue}.a{color:green}", ["a"])).toEqual([".a", ".a:is(p)"]);
  });

  test("an important declaration cannot be overridden by a plain one, so they do not tie", () => {
    expect(keys(".a{color:red}.b{color:blue!important}.a{color:green}", ["a", "b"])).toEqual([
      ".a",
      ".b",
    ]);
    expect(keys(".a{color:red}.b{color:blue}.a{color:green}", ["a", "b"])).toEqual([
      ".a",
      ".b",
      ".a, .a",
    ]);
  });

  test("media ranges that cannot hold at once do not tie (literal, named and em widths); ranges that overlap do", () => {
    expect(
      keys(
        ".a{color:red}@media (max-width:500px){.b{color:blue}}@media (min-width:600px){.a{color:green}}",
        ["a", "b"],
      ),
    ).toEqual([".a", ".b"]);
    expect(
      keys(
        ".a{color:red}@media (max-width:576px){.b{color:blue}}@media (min-width:600px){.a{color:green}}",
        ["a", "b"],
      ),
    ).toEqual([".a", ".b"]);
    expect(
      keys(
        ".a{color:red}@media (max-width:500px){.b{color:blue}}@media (min-width:40em){.a{color:green}}",
        ["a", "b"],
      ),
    ).toEqual([".a", ".b"]);
    expect(
      keys(
        ".a{color:red}@media (max-width:700px){.b{color:blue}}@media (min-width:600px){.a{color:green}}",
        ["a", "b"],
      ),
    ).toEqual([".a", ".b", ".a, .a"]);
    expect(
      keys(
        ".a{color:red}@media (max-width:992px){.b{color:blue}}@media (min-width:600px){.a{color:green}}",
        ["a", "b"],
      ),
    ).toEqual([".a", ".b", ".a, .a"]);
  });

  test("rules for different element types, or different pseudo-elements, do not tie", () => {
    expect(keys("p.a{color:red}div.a{color:blue}p.a{color:green}", ["a"])).toEqual([
      ".a:is(p)",
      ".a:is(div)",
    ]);
    expect(keys("p.a{color:red}.a::before{color:blue}p.a{color:green}", ["a"])).toEqual([
      ".a:is(p)",
      ".a::before",
    ]);
  });

  test("a rule that sets everything (all) ties with any property", () => {
    expect(keys(".a{color:red}.b{all:unset}.a{color:blue}", ["a", "b"])).toEqual([
      ".a",
      ".b",
      ".a, .a",
    ]);
  });
});

describe("coreBlockStyle: the cascade, generated", () => {
  test("a rekeyed entry's key is never the key of a rule of its own (the second would replace the first)", () => {
    // `.b.c` is rekeyed to `.b.c, .b.c` to stay behind a rule of equal specificity; a later rule whose own selector list is
    // spelled `.b.c, .b.c` must not take that key over.
    const css =
      "@media (max-width:576px){.b.c{border-top-width:blue;margin-top:red}}" +
      "@media (min-width:600px){.a, .a:not(.c){top:none!important;row-gap:red!important;padding:2px}}" +
      "@media (min-width:400px) and (max-width:800px){.b.c{row-gap:green;top:none;gap:blue!important}}" +
      "@media (max-width:576px){.b.c, .b.c{border:block}}";
    const { out, css: emitted } = style(css, ["a", "b", "c"]);
    expect(Object.keys(out.style)).toEqual([
      ".b.c",
      ".a, .a:not(.c)",
      ".b.c, .b.c",
      ".b.c, .b.c, .b.c",
    ]);
    const original = analysedRulesOf(css);
    const rules = analysedRulesOf(emitted);
    for (const width of [300, 500, 700, 850]) {
      const query = { classes: ["b", "c"], width };
      expect(cascadeDiff(cascadeOf(original, query), cascadeOf(rules, query))).toEqual([]);
    }
    expect(cascadeOf(rules, { classes: ["b", "c"], width: 500 })["|gap"]).toBe(
      "gap: blue !important",
    );
  });

  test("1,200 random stylesheets (selectors, specificities, media ranges, !important, shorthands): the same declaration wins as in the original, for every class set, tag, width and state", () => {
    let seed = 20_260_930;
    const rnd = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return Math.floor((seed / 2_147_483_648) * n);
    };
    const pick = <T>(items: readonly T[]): T => items[rnd(items.length)]!;
    const selectors = [
      ".a",
      ".a",
      ".a",
      ".b",
      ".b",
      ".c",
      ".a::before",
      ".b::before",
      "p::before",
      ".a:is(p)",
      ".a:focus",
      ".b:hover:focus",
      ".a.b",
      "p.a",
      ".a:hover",
      ".b:hover",
      "p",
      ".a .b",
      ".b.c",
      "div.b",
      ":where(.a)",
      ".a:not(.c)",
      "p.b:hover",
    ];
    const props = [
      "color",
      "margin",
      "margin-top",
      "padding",
      "display",
      "background",
      "border",
      "border-top-width",
      "width",
      "gap",
      "row-gap",
      "inset",
      "top",
    ];
    const values = ["red", "blue", "0", "1px", "2px", "block", "none", "green"];
    const medias = [
      "",
      "",
      "",
      "@media (min-width:600px)",
      "@media (max-width:900px)",
      "@media (min-width:400px) and (max-width:800px)",
      "@media (max-width:992px)",
      "@media (max-width:576px)",
    ];
    const sets = [["a"], ["b"], ["c"], ["a", "b"], ["b", "c"], ["a", "c"], ["a", "b", "c"], []];
    let rekeyed = 0;
    let compared = 0;
    for (let i = 0; i < 1200; i++) {
      let css = "";
      for (let k = 2 + rnd(14); k > 0; k--) {
        const selector = rnd(5) === 0 ? `${pick(selectors)}, ${pick(selectors)}` : pick(selectors);
        const body = Array.from(
          { length: 1 + rnd(3) },
          () => `${pick(props)}:${pick(values)}${rnd(8) === 0 ? "!important" : ""}`,
        ).join(";");
        const media = pick(medias);
        css += media === "" ? `${selector}{${body}}` : `${media}{${selector}{${body}}}`;
      }
      const { out, css: emitted, report } = style(css, ["a", "b", "c"]);
      if (report.some((e) => e.code === "corecss.rekeyed")) rekeyed += 1;
      const original = analysedRulesOf(css);
      const rules = analysedRulesOf(emitted);
      for (const classes of sets) {
        for (const tag of ["div", "p"]) {
          for (const width of [300, 500, 700, 850, 1000]) {
            for (const states of [[], [":hover"]]) {
              compared += 1;
              const diff = cascadeDiff(
                cascadeOf(original, { classes, tag, width, states }),
                cascadeOf(rules, { classes, tag, width, states }),
              );
              if (diff.length > 0) {
                throw new Error(
                  `${diff[0]} for ${tag}.${classes.join(".")} at ${width} ${states.join("")}\n${css}\n=> ${JSON.stringify(out.style)}`,
                );
              }
            }
          }
        }
      }
    }
    // The generator exercises the hard case: about a third of the sheets need a rule kept behind another.
    expect(rekeyed).toBeGreaterThan(200);
    expect(compared).toBe(1200 * 160);
  });
});

describe("coreBlockStyle: custom properties", () => {
  test(":root custom properties are not rules; those the kept rules read are carried, transitively", () => {
    const { out, css } = style(
      ":root{--x:var(--y);--y:1px;--z:2px}.a{margin:var(--x)}.b{margin:var(--z)}",
      ["a"],
    );
    expect(out.style).toEqual({ ".a": { margin: "var(--x)" } });
    expect(out.custom).toEqual({ "--x": "var(--y)", "--y": "1px" });
    expect(css.split("\n")[0]).toBe(":root { --x: var(--y); --y: 1px }");
  });

  test("a custom property under a media query is a conditional entry at the end, only when needed", () => {
    const { out, css } = style(
      ":root{--p:1px}@media (min-width:600px){:root{--p:2px;--unused:3px}}.a{margin:var(--p)}",
      ["a"],
    );
    expect(out.custom).toEqual({ "--p": "1px" });
    expect(out.style).toEqual({
      ".a": { margin: "var(--p)" },
      "@(min-width: 600px)": { "--p": "2px" },
    });
    expect(css).toContain("@media (min-width: 600px) { :root { --p: 2px } }");
    expect(css).not.toContain("--unused");
  });

  test("a custom property under nested conditions cannot be an entry: kept as CSS text and reported", () => {
    const { out, report } = style(
      "@media (min-width:600px){@supports (display:grid){:root{--p:2px}}}.a{margin:var(--p)}",
      ["a"],
    );
    expect(out.verbatim).toBe(
      "@media (min-width: 600px) { @supports (display:grid) { :root { --p: 2px } } }",
    );
    expect(report.map((e) => [e.severity, e.code, (e.data as { reason: string }).reason])).toEqual([
      ["warn", "corecss.verbatim", "nested-condition"],
    ]);
  });

  test("a rule on html: with custom properties and other declarations keeps the declarations as a rule", () => {
    const { out } = style("html{--x:1px;scroll-behavior:smooth}.a{margin:var(--x)}", ["a"]);
    expect(out.custom).toEqual({ "--x": "1px" });
    expect(out.style.html).toEqual({ scrollBehavior: "smooth" });
  });

  test("a property no sheet declares is reported (warn), unless a fallback is given, the caller knows it, or it is WordPress's own --wp--* (info)", () => {
    const css =
      ".a{margin:var(--q);padding:var(--r,1px);top:var(--k);left:var(--wp--style--block-gap)}";
    const { report } = style(css, ["a"], { knownVars: ["--k"] });
    expect(report.map((e) => [e.severity, (e.data as { property: string }).property])).toEqual([
      ["warn", "--q"],
      ["info", "--wp--style--block-gap"],
    ]);
    expect(report.every((e) => e.code === "corecss.var-unresolved")).toBe(true);
  });
});

describe("coreBlockStyle: what a style object cannot carry", () => {
  test("a rule with a literal ${ in a value is kept as CSS text, in full, and reported", () => {
    const { out, report } = style('.a{content:"${";color:red}.a{margin:0}', ["a"]);
    expect(out.style).toEqual({ ".a": { margin: "0" } });
    expect(out.verbatim).toBe('.a { content: "${"; color: red }');
    expect(report.map((e) => [e.code, (e.data as { reason: string }).reason])).toEqual([
      ["corecss.verbatim", "template"],
    ]);
  });

  test("a statement at-rule (@import) is kept as CSS text; one from a block's unused sheet is not", () => {
    const { out, report } = style("@import url(foo.css);.a{color:red}", ["a"]);
    expect(out.verbatim).toBe("@import url(foo.css);");
    expect(report.map((e) => [e.code, (e.data as { reason: string }).reason])).toEqual([
      ["corecss.verbatim", "statement"],
    ]);
    expect(
      style("@import url(foo.css);.a{color:red}", ["a"], {}, "wp-includes/blocks/x/style.min.css")
        .out.verbatim,
    ).toBe("");
  });

  test("an unparseable stretch is reported as corecss.unreadable and the rest is kept", () => {
    const { out, report } = style(".a{color:red}}} .b{", ["a"]);
    expect(out.style).toEqual({ ".a": { color: "red" } });
    expect(report.map((e) => e.code)).toEqual(["corecss.unreadable"]);
    expect(report[0]!.message).toContain("test.css");
  });

  test("an unresolved token the reader removes is reported for a rule that is in use and not for one that is not", () => {
    expect(style('.a{content:"${x}";color:red}', ["a"]).report.map((e) => e.code)).toEqual([
      "corecss.unreadable",
    ]);
    expect(style('.b{content:"${x}";color:red}', ["a"]).report).toEqual([]);
  });

  test("every report entry carries where and url when the caller gives them", () => {
    const report = createReport();
    coreBlockStyle(
      ["a", "has-large-font-size"],
      [
        {
          css: ".a{color:red}.b{color:blue}.a{color:green}.a{margin:var(--q)}.a{width:1px;width:2px}",
          origin: "s.css",
        },
      ],
      BP,
      report,
      { where: "post:7", url: "https://example.test/x/" },
    );
    const entries = report.entries();
    expect(new Set(entries.map((e) => e.code))).toEqual(
      new Set(["corecss.var-unresolved", "corecss.fallback", "corecss.preset-unstyled"]),
    );
    for (const entry of entries) {
      expect(entry.where).toBe("post:7");
      expect(entry.url).toBe("https://example.test/x/");
    }
    const bare = createReport();
    coreBlockStyle(["a"], [{ css: ".a{margin:var(--q)}", origin: "s.css" }], BP, bare);
    expect(bare.entries()[0]).not.toHaveProperty("where");
    expect(bare.entries()[0]).not.toHaveProperty("url");
  });

  test("a later @keyframes of the same name replaces the earlier one, as in a stylesheet", () => {
    const { out } = style(
      "@keyframes spin{from{top:0}to{top:1px}}@keyframes spin{from{left:0}to{left:2px}}.a{animation:spin 1s}",
      ["a"],
    );
    expect(out.style["@keyframes spin"]).toEqual({ from: { left: "0" }, to: { left: "2px" } });
  });

  test("a declaration written twice (a fallback) keeps the later value and says so", () => {
    const { out, report } = style(
      ".a{display:-webkit-box;display:flex;width:50%;width:calc(50% - 1px);color:red;color:red}",
      ["a"],
    );
    expect(out.style).toEqual({
      ".a": { display: "flex", width: "calc(50% - 1px)", color: "red" },
    });
    expect(report.map((e) => [e.code, (e.data as { property: string }).property])).toEqual([
      ["corecss.fallback", "width"],
    ]);
  });

  test("@keyframes are kept only when an animation names them, with the custom properties they read", () => {
    const css =
      ":root{--c:red}@keyframes spin{from{color:var(--c)}to{opacity:1}}@keyframes unused{from{top:0}to{top:1px}}.a{animation:spin 1s}.b{animation-name:unused}";
    const { out, css: emitted } = style(css, ["a"]);
    expect(out.style).toEqual({
      ".a": { animation: "spin 1s" },
      "@keyframes spin": { from: { color: "var(--c)" }, to: { opacity: "1" } },
    });
    expect(out.custom).toEqual({ "--c": "red" });
    expect(emitted).toContain("@keyframes spin { from { color: var(--c) } to { opacity: 1 } }");
  });

  test("@font-face is kept for the family a kept rule names: one face as an entry, several as CSS text (Jx's project builder drops the list form)", () => {
    const one = style(
      '@font-face{font-family:"Foo";src:url(a.woff2)}@font-face{font-family:"Bar";src:url(b.woff2)}.a{font-family:Foo,sans-serif}',
      ["a"],
    );
    expect(one.out.style["@font-face"]).toEqual({ fontFamily: '"Foo"', src: "url(a.woff2)" });
    expect(one.css).toContain('@font-face { font-family: "Foo"; src: url(a.woff2) }');
    expect(one.out.verbatim).toBe("");
    const two = style(
      '@font-face{font-family:"Foo";src:url(a.woff2);font-weight:400}@font-face{font-family:"Foo";src:url(b.woff2);font-weight:700}.a{font-family:Foo}',
      ["a"],
    );
    expect(two.out.style["@font-face"]).toBeUndefined();
    expect(two.out.verbatim).toBe(
      '@font-face { font-family: "Foo"; src: url(a.woff2); font-weight: 400 }\n@font-face { font-family: "Foo"; src: url(b.woff2); font-weight: 700 }',
    );
    expect(two.report.map((e) => [e.code, (e.data as { reason: string }).reason])).toEqual([
      ["corecss.verbatim", "font-face-list"],
      ["corecss.verbatim", "font-face-list"],
    ]);
  });

  test("@property is kept when a rule uses its name", () => {
    const { out } = style(
      '@property --angle{syntax:"<angle>";inherits:false;initial-value:0deg}.a{rotate:var(--angle)}',
      ["a"],
    );
    expect(Object.keys(out.style)).toContain("@property --angle");
  });
});

describe("coreBlockStyle: has-* classes WordPress styles from theme.json", () => {
  test("a preset class with no rule in the sources is reported once per class, as info; one the sources style is not", () => {
    const css = ".has-text-color{color:inherit}.a{color:red}";
    const { report } = style(css, [
      "a",
      "has-large-font-size",
      "has-cc-color-1-color",
      "has-text-color",
      "has-regular-font-size",
      "has-cc-color-1-background-color",
    ]);
    expect(report.map((e) => [e.severity, e.code, (e.data as { class: string }).class])).toEqual([
      ["info", "corecss.preset-unstyled", "has-large-font-size"],
      ["info", "corecss.preset-unstyled", "has-cc-color-1-color"],
      ["info", "corecss.preset-unstyled", "has-regular-font-size"],
      ["info", "corecss.preset-unstyled", "has-cc-color-1-background-color"],
    ]);
  });

  test("has-text-color, has-link-color, has-border-color and friends name no preset, so they are never reported", () => {
    const { report } = style(".a{color:red}", [
      "a",
      "has-text-color",
      "has-link-color",
      "has-border-color",
      "has-inline-color",
      "has-background-color",
      "has-background",
    ]);
    expect(report).toEqual([]);
  });

  test("styledElsewhere silences the classes another stylesheet styles (Cwicly's own .has-cc-<id>-color)", () => {
    const { report } = style(
      ".a{color:red}",
      ["a", "has-cc-xew-3-h-color", "has-large-font-size"],
      { styledElsewhere: ["has-cc-xew-3-h-color"] },
    );
    expect(report.map((e) => (e.data as { class: string }).class)).toEqual(["has-large-font-size"]);
  });

  test("with the preset source added, the same classes are styled, the variables they read are carried, and nothing is reported", () => {
    const layers: ThemeJsonLayer[] = [
      {
        origin: "default",
        json: {
          version: 3,
          settings: {
            typography: { fontSizes: [{ slug: "large", name: "Large", size: "36px" }] },
            color: { palette: [{ slug: "black", name: "Black", color: "#000000" }] },
          },
        },
      },
    ];
    const report = createReport();
    const out = coreBlockStyle(
      ["has-large-font-size", "has-black-color"],
      [wpPresetCss(layers)],
      BP,
      report,
    );
    expect(out.style).toEqual({
      ".has-black-color": { color: "var(--wp--preset--color--black) !important" },
      ".has-large-font-size": { fontSize: "var(--wp--preset--font-size--large) !important" },
    });
    expect(out.custom).toEqual({
      "--wp--preset--color--black": "#000000",
      "--wp--preset--font-size--large": "36px",
    });
    expect(report.entries()).toEqual([]);
  });
});

describe("coreBlockStyle: the shape of the result", () => {
  test("project style entries only: keys are selectors or at-rules, values are objects or declaration strings", () => {
    const sources = PAGES.flatMap(({ html }) => inlineWpCss(html));
    const out = coreBlockStyle(
      PAGES.flatMap(({ html }) => [...collectWpClassesFromHtml(html)]),
      sources,
      BP,
    );
    for (const [key, value] of Object.entries(out.style)) {
      expect(key.trim(), key).toBe(key);
      expect(typeof value === "object" && value !== null, key).toBe(true);
      const check = (block: Record<string, unknown>): void => {
        for (const [k, v] of Object.entries(block)) {
          if (typeof v === "object" && v !== null) check(v as Record<string, unknown>);
          else expect(typeof v, `${key} ${k}`).toBe("string");
        }
      };
      check(value as Record<string, unknown>);
    }
    for (const [name, value] of Object.entries(out.custom)) {
      expect(name).toMatch(/^--/);
      expect(typeof value).toBe("string");
    }
  });

  test("deterministic: the same input twice gives byte-identical output; the input sources are not modified", () => {
    const html = PAGES.find((p) => p.file === "essays__get-in-the-way-of-evil.html")!.html;
    const sources = inlineWpCss(html);
    const before = JSON.stringify(sources);
    const used = collectWpClassesFromHtml(html);
    const first = JSON.stringify(coreBlockStyle(used, sources, BP));
    const second = JSON.stringify(coreBlockStyle([...used].toReversed(), sources, BP));
    expect(second).toBe(first);
    expect(JSON.stringify(sources)).toBe(before);
  });

  test("monotonic: using one more class never removes an entry, and adds only rules that name it", () => {
    const html = PAGES.find((p) => p.file === "essays__get-in-the-way-of-evil.html")!.html;
    const sources = inlineWpCss(html);
    const used = collectWpClassesFromHtml(html);
    const base = coreBlockStyle(used, sources, BP);
    const without = coreBlockStyle(
      [...used].filter((c) => c !== "wp-block-image"),
      sources,
      BP,
    );
    const baseKeys = new Set(Object.keys(base.style));
    for (const key of Object.keys(without.style))
      expect(baseKeys.has(key) || key.includes("wp-block-image"), key).toBe(true);
    expect(Object.keys(without.style).length).toBeLessThan(baseKeys.size);
    for (const key of baseKeys)
      if (!(key in without.style)) expect(key).toContain("wp-block-image");
  });
});

// ── The whole block library (needs a WordPress tree) ────────────────────────────────────────────

describe.skipIf(!HAVE_TREE)("the whole block library from a WordPress checkout", () => {
  for (const theme of [false, true]) {
    test(`every class in use: all of it comes out as the same rules (theme sheets ${theme ? "on" : "off"}), through the real Jx builder`, async () => {
      const sources = await wpCoreCssSources(WP_TREE, { theme });
      const used = new Set<string>();
      const ids = new Set<string>();
      for (const source of sources) {
        for (const m of source.css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) used.add(m[1]!);
        for (const m of source.css.matchAll(/#([A-Za-z_][\w-]*)/g)) ids.add(m[1]!);
        used.add("wp-image-1");
      }
      const report = createReport();
      const out = coreBlockStyle(used, sources, BP, report, { ids });
      const css = cssOf(out);
      const original = sources.map((s) => s.css.replace(/:root\{[^}]*\}/g, "")).join("\n");
      const diff = canonicalDiff(canonicalCss(original, BP), canonicalCss(css, BP), 20).filter(
        (line) => !/:root \{\} --wp--preset--font-size--(?:normal|huge)/.test(line),
      );
      expect(diff).toEqual([]);
      // Only what WordPress leaves to other layers is unresolved, and nothing needs the escape hatch.
      expect(out.verbatim).toBe("");
      const unresolved = report
        .entries()
        .filter((e) => e.code === "corecss.var-unresolved")
        .map((e) => (e.data as { property: string }).property);
      expect(
        unresolved.filter((name) => !name.startsWith("--wp--") && !name.startsWith("--wfp-")),
      ).toEqual([]);
      expect(
        report
          .entries()
          .filter((e) => e.severity === "warn" && e.code !== "corecss.var-unresolved"),
      ).toEqual([]);
      // The at-rules the library uses survive: keyframes and the conditions its media queries use.
      for (const head of [
        "@media (min-width: 782px)",
        "@media (prefers-reduced-motion: reduce)",
        "@keyframes lightbox-zoom-in",
        "@supports (position:sticky)",
      ]) {
        expect(css, head).toContain(head);
      }
    });
  }

  test("the 12 saved pages' used classes against the checkout's sheets match the sheets the live pages carried", async () => {
    const sources = await wpCoreCssSources(WP_TREE);
    for (const { site, file, html } of PAGES) {
      const used = collectWpClassesFromHtml(html);
      const live = coreBlockStyle(used, inlineWpCss(html), BP);
      const fromTree = coreBlockStyle(used, sources, BP);
      // Same WordPress version, so the checkout's rules for the page's classes are the live ones.
      const liveRules = canonicalCss(cssOf(live), BP);
      const treeRules = canonicalCss(cssOf(fromTree), BP);
      const missing = canonicalDiff(liveRules, treeRules, 10).filter((line) =>
        line.startsWith("- "),
      );
      expect(missing, `${site}/${file}`).toEqual([]);
    }
  });
});

// ── theme.json presets ──────────────────────────────────────────────────────────────────────────

describe("wpKebabCase (WordPress's _wp_to_kebab_case)", () => {
  test("splits at case changes, digits and separators, as lodash does", () => {
    expect(wpKebabCase("cc-color-1")).toBe("cc-color-1");
    expect(wpKebabCase("cc-xew3h")).toBe("cc-xew-3-h");
    expect(wpKebabCase("Odd Name_1")).toBe("odd-name-1");
    expect(wpKebabCase("h1Big")).toBe("h-1-big");
    expect(wpKebabCase("ABCDef")).toBe("abc-def");
    expect(wpKebabCase("x-large")).toBe("x-large");
    expect(wpKebabCase("2xl")).toBe("2-xl");
    expect(wpKebabCase("1st-thing")).toBe("1st-thing");
    expect(wpKebabCase("it's")).toBe("its");
    expect(wpKebabCase("")).toBe("");
  });

  test("lower-cases ASCII only (PHP's strtolower), and reads \\b as Unicode like PCRE /u", () => {
    expect(wpKebabCase("É")).toBe("É");
    expect(wpKebabCase("Énd")).toBe("Énd");
    expect(wpKebabCase("1stßst")).toBe("1-stßst");
    // \d is Unicode too: Arabic-Indic digits split like ASCII ones (values checked against WordPress).
    expect(["x٣", "٣x", "a٣b١", "٣rd", "٣٣th"].map(wpKebabCase)).toEqual([
      "x-٣",
      "٣-x",
      "a-٣-b-١",
      "٣-rd",
      "٣٣th",
    ]);
  });
});

/** Core's theme.json, reduced to what the cases need. */
const CORE = {
  version: 3,
  settings: {
    color: {
      defaultPalette: true,
      palette: [
        { slug: "black", name: "Black", color: "#000000" },
        { slug: "white", name: "White", color: "#ffffff" },
      ],
      gradients: [{ slug: "dusk", name: "Dusk", gradient: "linear-gradient(red,blue)" }],
    },
    typography: {
      defaultFontSizes: true,
      fontSizes: [
        { slug: "small", name: "Small", size: "13px" },
        { slug: "large", name: "Large", size: "36px" },
      ],
    },
    spacing: {
      defaultSpacingSizes: true,
      spacingScale: { operator: "*", increment: 1.5, steps: 7, mediumStep: 1.5, unit: "rem" },
    },
    shadow: {
      defaultPresets: true,
      presets: [{ slug: "natural", name: "Natural", shadow: "6px 6px 9px rgba(0, 0, 0, 0.2)" }],
    },
  },
};
const CORE_LAYER: ThemeJsonLayer = { origin: "default", json: CORE };

/** WordPress's `variables` and `presets` stylesheets for the same layers, by `WP_Theme_JSON` itself. */
const PHP_ORACLE = String.raw`<?php
$root = $argv[1];
define('ABSPATH', $root . '/'); define('WPINC', 'wp-includes'); define('WP_CONTENT_DIR', $root . '/wp-content'); define('WP_DEBUG', false);
foreach (['MINUTE_IN_SECONDS'=>60,'HOUR_IN_SECONDS'=>3600,'DAY_IN_SECONDS'=>86400,'WEEK_IN_SECONDS'=>604800,'MONTH_IN_SECONDS'=>2592000,'YEAR_IN_SECONDS'=>31536000,'KB_IN_BYTES'=>1024,'MB_IN_BYTES'=>1048576,'GB_IN_BYTES'=>1073741824,'TB_IN_BYTES'=>1099511627776,'EMPTY_TRASH_DAYS'=>30] as $k=>$v) define($k,$v);
error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE & ~E_WARNING);
$GLOBALS['wp_version'] = '7.1';
foreach (['version','compat','plugin','pomo/translations','l10n','class-wp-error','formatting','functions','load','kses','class-wp-block-type','class-wp-block-type-registry','class-wp-block-styles-registry','class-wp-theme-json-schema'] as $f) require ABSPATH . WPINC . '/' . $f . '.php';
foreach (glob(ABSPATH . WPINC . '/style-engine/*.php') as $f) require_once $f;
require ABSPATH . WPINC . '/style-engine.php';
function wp_get_global_settings($path = [], $context = []) { return []; }
require ABSPATH . WPINC . '/class-wp-block-supports.php';
require ABSPATH . WPINC . '/block-supports/typography.php';
require ABSPATH . WPINC . '/class-wp-theme-json.php';
$in = json_decode(stream_get_contents(STDIN), true);
$tj = new WP_Theme_JSON($in['core'] ?? ['version' => 3], 'default');
if (isset($in['theme'])) $tj->merge(new WP_Theme_JSON($in['theme'], 'theme'));
if (isset($in['user'])) $tj->merge(new WP_Theme_JSON($in['user'], 'custom'));
$origins = ['default', 'theme', 'custom'];
echo json_encode(['variables' => $tj->get_stylesheet(['variables'], $origins), 'presets' => $tj->get_stylesheet(['presets'], $origins)], JSON_UNESCAPED_SLASHES);
`;

let oracleDir: string | undefined;
async function wordpressSays(layers: readonly ThemeJsonLayer[]): Promise<string> {
  if (oracleDir === undefined) {
    mkdirSync(TMP_ROOT, { recursive: true });
    oracleDir = mkdtempSync(join(TMP_ROOT, "wpjson-"));
    writeFileSync(join(oracleDir, "oracle.php"), PHP_ORACLE);
  }
  const pick = (origin: string): unknown => layers.find((l) => l.origin === origin)?.json;
  const proc = Bun.spawn(["php", join(oracleDir, "oracle.php"), WP_TREE], {
    stdin: new Blob([
      JSON.stringify({ core: pick("default"), theme: pick("theme"), user: pick("custom") }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  try {
    const parsed = JSON.parse(stdout) as { variables: string; presets: string };
    return parsed.variables + parsed.presets;
  } catch {
    throw new Error(`the PHP oracle failed: ${stderr || stdout}`.slice(0, 600));
  }
}
afterAll(() => {
  if (oracleDir !== undefined) rmSync(oracleDir, { recursive: true, force: true });
});

describe("wpPresetCss: WordPress's preset algorithm, with hand-checked expectations", () => {
  test("core alone: custom properties first in preset order, then one class per slug for each class template", () => {
    const { css, origin } = wpPresetCss([CORE_LAYER]);
    expect(origin).toBe("theme.json:presets");
    expect(css).toBe(
      ":root{--wp--preset--color--black: #000000;--wp--preset--color--white: #ffffff;--wp--preset--gradient--dusk: linear-gradient(red,blue);--wp--preset--font-size--small: 13px;--wp--preset--font-size--large: 36px;--wp--preset--spacing--20: 0.44rem;--wp--preset--spacing--30: 0.67rem;--wp--preset--spacing--40: 1rem;--wp--preset--spacing--50: 1.5rem;--wp--preset--spacing--60: 2.25rem;--wp--preset--spacing--70: 3.38rem;--wp--preset--spacing--80: 5.06rem;--wp--preset--shadow--natural: 6px 6px 9px rgba(0, 0, 0, 0.2);}" +
        ".has-black-color{color: var(--wp--preset--color--black) !important;}.has-white-color{color: var(--wp--preset--color--white) !important;}" +
        ".has-black-background-color{background-color: var(--wp--preset--color--black) !important;}.has-white-background-color{background-color: var(--wp--preset--color--white) !important;}" +
        ".has-black-border-color{border-color: var(--wp--preset--color--black) !important;}.has-white-border-color{border-color: var(--wp--preset--color--white) !important;}" +
        ".has-dusk-gradient-background{background: var(--wp--preset--gradient--dusk) !important;}" +
        ".has-small-font-size{font-size: var(--wp--preset--font-size--small) !important;}.has-large-font-size{font-size: var(--wp--preset--font-size--large) !important;}",
    );
  });

  test("a theme cannot take a default's slug while the defaults are on; with defaultPalette:false it can, in the default's place", () => {
    const palette = [
      { slug: "black", name: "B", color: "#111111" },
      { slug: "brand", name: "Brand", color: "#c00" },
    ];
    const blocked = wpPresetCss([
      CORE_LAYER,
      { origin: "theme", json: { version: 3, settings: { color: { palette } } } },
    ]).css;
    expect(blocked).toContain(
      "--wp--preset--color--black: #000000;--wp--preset--color--white: #ffffff;--wp--preset--color--brand: #c00;",
    );
    const allowed = wpPresetCss([
      CORE_LAYER,
      {
        origin: "theme",
        json: { version: 3, settings: { color: { defaultPalette: false, palette } } },
      },
    ]).css;
    expect(allowed).toContain(
      "--wp--preset--color--black: #111111;--wp--preset--color--white: #ffffff;--wp--preset--color--brand: #c00;",
    );
    // One class per slug whatever the origins say.
    expect(allowed.match(/\.has-black-color\{/g)).toHaveLength(1);
  });

  test("a version 2 theme that lists font sizes turns the default sizes' protection off (the v2 to v3 migration)", () => {
    const sizes = [
      { slug: "large", size: "2rem" },
      { slug: "Huge Size", size: "3rem" },
    ];
    const v2 = wpPresetCss([
      CORE_LAYER,
      { origin: "theme", json: { version: 2, settings: { typography: { fontSizes: sizes } } } },
    ]).css;
    expect(v2).toContain(
      "--wp--preset--font-size--small: 13px;--wp--preset--font-size--large: 2rem;--wp--preset--font-size--huge-size: 3rem;",
    );
    const v3 = wpPresetCss([
      CORE_LAYER,
      { origin: "theme", json: { version: 3, settings: { typography: { fontSizes: sizes } } } },
    ]).css;
    expect(v3).toContain(
      "--wp--preset--font-size--large: 36px;--wp--preset--font-size--huge-size: 3rem;",
    );
  });

  test("the Site Editor's saved palette ({theme:[…]}) keeps its origin keys, and a slug is kebab-cased once", () => {
    const user: ThemeJsonLayer = {
      origin: "custom",
      json: {
        version: 2,
        settings: {
          color: {
            palette: {
              theme: [
                { slug: "cc-color-1", name: "", color: "#2c324d" },
                { slug: "cc-xew3h", name: "", color: "#fff" },
              ],
            },
          },
        },
      },
    };
    const { css } = wpPresetCss([CORE_LAYER, user]);
    expect(css).toContain(
      "--wp--preset--color--cc-color-1: #2c324d;--wp--preset--color--cc-xew-3-h: #fff;",
    );
    expect(css).toContain(
      ".has-cc-xew-3-h-color{color: var(--wp--preset--color--cc-xew-3-h) !important;}",
    );
    expect(css).toContain(
      ".has-cc-color-1-border-color{border-color: var(--wp--preset--color--cc-color-1) !important;}",
    );
  });

  test("a user document without a version contributes nothing (WordPress replaces it with an empty one)", () => {
    const user: ThemeJsonLayer = {
      origin: "custom",
      json: { settings: { color: { palette: { custom: [{ slug: "zzz", color: "#000" }] } } } },
    };
    expect(wpPresetCss([CORE_LAYER, user]).css).toBe(wpPresetCss([CORE_LAYER]).css);
  });

  test("custom-origin presets: the user's own colours, a font family, and a value that replaces a default's", () => {
    const user: ThemeJsonLayer = {
      origin: "custom",
      json: {
        version: 3,
        settings: {
          color: {
            palette: {
              custom: [
                { slug: "zzz", color: "#010203" },
                { slug: "white", color: "#fefefe" },
              ],
            },
          },
          typography: {
            fontFamilies: [{ slug: "sans", name: "Sans", fontFamily: "Arial, sans-serif" }],
          },
        },
      },
    };
    const { css } = wpPresetCss([CORE_LAYER, user]);
    expect(css).toContain(
      "--wp--preset--color--black: #000000;--wp--preset--color--white: #fefefe;--wp--preset--color--zzz: #010203;",
    );
    expect(css).toContain("--wp--preset--font-family--sans: Arial, sans-serif;");
    expect(css).toContain(
      ".has-sans-font-family{font-family: var(--wp--preset--font-family--sans) !important;}",
    );
  });

  test("spacing: a scale expands into the 20..80 steps (operator *, then +), explicit sizes merge over them in slug order", () => {
    const plus = wpPresetCss([
      {
        origin: "default",
        json: {
          version: 3,
          settings: {
            spacing: {
              spacingScale: { operator: "+", increment: 2, steps: 4, mediumStep: 16, unit: "px" },
            },
          },
        },
      },
    ]);
    expect(plus.css).toBe(
      ":root{--wp--preset--spacing--40: 14px;--wp--preset--spacing--50: 16px;--wp--preset--spacing--60: 18px;--wp--preset--spacing--70: 20px;}",
    );
    const merged = wpPresetCss([
      CORE_LAYER,
      {
        origin: "theme",
        json: {
          version: 3,
          settings: {
            spacing: {
              spacingSizes: [
                { slug: "30", name: "x", size: "10px" },
                { slug: "90", name: "y", size: "9rem" },
              ],
            },
          },
        },
      },
    ]).css;
    expect(merged).toContain(
      "--wp--preset--spacing--20: 0.44rem;--wp--preset--spacing--30: 0.67rem;",
    );
    expect(merged).toContain("--wp--preset--spacing--80: 5.06rem;--wp--preset--spacing--90: 9rem;");
    // An invalid scale generates nothing.
    expect(
      wpPresetCss([
        {
          origin: "default",
          json: {
            version: 3,
            settings: {
              spacing: {
                spacingScale: { operator: "/", increment: 2, steps: 4, mediumStep: 16, unit: "px" },
              },
            },
          },
        },
      ]).css,
    ).toBe("");
  });

  test("an empty theme palette replaces the theme's colours with none; the defaults stay", () => {
    const { css } = wpPresetCss([
      CORE_LAYER,
      { origin: "theme", json: { version: 3, settings: { color: { palette: [] } } } },
    ]);
    expect(css).toContain(
      "--wp--preset--color--black: #000000;--wp--preset--color--white: #ffffff;",
    );
  });

  test("a preset with no usable value still gets its class (WordPress prints the class for every slug) but no custom property", () => {
    const { css } = wpPresetCss([
      {
        origin: "default",
        json: {
          version: 3,
          settings: {
            color: {
              palette: [
                { slug: "ghost", name: "G" },
                { slug: "real", name: "R", color: "red" },
              ],
            },
          },
        },
      },
    ]);
    expect(css).toContain(":root{--wp--preset--color--real: red;}");
    expect(css).toContain(".has-ghost-color{color: var(--wp--preset--color--ghost) !important;}");
  });

  test("a numeric value is printed as is (WordPress converts numbers to strings)", () => {
    expect(
      wpPresetCss([
        {
          origin: "default",
          json: { version: 3, settings: { typography: { fontSizes: [{ slug: "n", size: 20 }] } } },
        },
      ]).css,
    ).toContain("--wp--preset--font-size--n: 20;");
  });

  test("a version 2 theme that lists spacing sizes drops its spacingScale; the custom origin is not migrated", () => {
    const theme = {
      version: 2,
      settings: {
        spacing: {
          spacingSizes: [{ slug: "50", name: "m", size: "1px" }],
          spacingScale: { operator: "+", increment: 1, steps: 3, mediumStep: 2, unit: "px" },
        },
      },
    };
    expect(wpPresetCss([{ origin: "theme", json: theme }]).css).toBe(
      ":root{--wp--preset--spacing--50: 1px;}",
    );
    // v3 merges the two, so the scale's 40 and 60 appear.
    expect(wpPresetCss([{ origin: "theme", json: { ...theme, version: 3 } }]).css).toBe(
      ":root{--wp--preset--spacing--40: 1px;--wp--preset--spacing--50: 1px;--wp--preset--spacing--60: 3px;}",
    );
    // The custom origin keeps flags as it finds them: a v2 user document does not turn the default font sizes off.
    const user = {
      version: 2,
      settings: { typography: { fontSizes: { custom: [{ slug: "large", size: "9px" }] } } },
    };
    const css = wpPresetCss([CORE_LAYER, { origin: "custom", json: user }]).css;
    expect(css).toContain(
      "--wp--preset--font-size--small: 13px;--wp--preset--font-size--large: 9px;",
    );
  });

  test("a font size with its own fluid setting is reported even when the theme's fluid switch is off", () => {
    const report = createReport();
    wpPresetCss(
      [
        {
          origin: "theme",
          json: {
            version: 3,
            settings: {
              typography: {
                fontSizes: [{ slug: "big", size: "2rem", fluid: { min: "1rem", max: "3rem" } }],
              },
            },
          },
        },
      ],
      { report },
    );
    expect(report.entries().map((e) => e.code)).toEqual(["corecss.preset-fluid"]);
  });

  test("the custom origin is not migrated: a v2 user document's theme-origin sizes still cannot take a default's slug", () => {
    const user = {
      version: 2,
      settings: {
        typography: {
          fontSizes: {
            theme: [
              { slug: "large", size: "9px" },
              { slug: "mine", size: "5px" },
            ],
          },
        },
      },
    };
    const css = wpPresetCss([CORE_LAYER, { origin: "custom", json: user }]).css;
    expect(css).toContain(
      "--wp--preset--font-size--large: 36px;--wp--preset--font-size--mine: 5px;",
    );
  });

  test("a spacingScale that is already keyed by origin generates sizes for that origin; sizes sort by slug", () => {
    const keyed = {
      version: 3,
      settings: {
        spacing: {
          spacingScale: {
            default: { operator: "+", increment: 2, steps: 4, mediumStep: 16, unit: "px" },
          },
        },
      },
    };
    expect(wpPresetCss([{ origin: "default", json: keyed }]).css).toBe(
      ":root{--wp--preset--spacing--40: 14px;--wp--preset--spacing--50: 16px;--wp--preset--spacing--60: 18px;--wp--preset--spacing--70: 20px;}",
    );
    const sorted = wpPresetCss([
      {
        origin: "default",
        json: {
          version: 3,
          settings: {
            spacing: {
              spacingScale: { operator: "+", increment: 2, steps: 4, mediumStep: 16, unit: "px" },
              spacingSizes: [
                { slug: "45", size: "15px" },
                { slug: "10", size: "1px" },
              ],
            },
          },
        },
      },
    ]).css;
    expect(sorted).toBe(
      ":root{--wp--preset--spacing--10: 1px;--wp--preset--spacing--40: 14px;--wp--preset--spacing--45: 15px;--wp--preset--spacing--50: 16px;--wp--preset--spacing--60: 18px;--wp--preset--spacing--70: 20px;}",
    );
  });

  test("an explicit size takes the place of the scale's size of the same slug", () => {
    const css = wpPresetCss([
      {
        origin: "default",
        json: {
          version: 3,
          settings: {
            spacing: {
              spacingScale: { operator: "+", increment: 2, steps: 4, mediumStep: 16, unit: "px" },
              spacingSizes: [{ slug: "50", size: "99px" }],
            },
          },
        },
      },
    ]).css;
    expect(css).toContain("--wp--preset--spacing--50: 99px;");
    expect(css).not.toContain("--wp--preset--spacing--50: 16px;");
  });

  test("an empty object where a preset list goes is an empty list, which replaces the earlier list of its origin", () => {
    const css = wpPresetCss([
      {
        origin: "theme",
        json: { version: 3, settings: { color: { palette: [{ slug: "brand", color: "#c00" }] } } },
      },
      { origin: "theme", json: { version: 3, settings: { color: { palette: {} } } } },
    ]).css;
    expect(css).toBe("");
  });

  test("layers with nothing in them give an empty stylesheet", () => {
    expect(wpPresetCss([]).css).toBe("");
    expect(
      wpPresetCss([
        { origin: "theme", json: null },
        { origin: "theme", json: { version: 3 } },
        { origin: "custom", json: "text" },
      ]).css,
    ).toBe("");
  });

  test("what is not reproduced is reported as info, once per kind: block-scoped presets, settings.custom, fluid sizes, duotone (core's own are not)", () => {
    const report = createReport();
    wpPresetCss(
      [
        {
          origin: "default",
          json: {
            version: 3,
            settings: {
              color: { duotone: [{ slug: "d", colors: [] }] },
              blocks: {
                "core/button": { dimensions: { dimensionSizes: [{ slug: "25", size: "25%" }] } },
              },
            },
          },
        },
        {
          origin: "theme",
          json: {
            version: 3,
            settings: {
              typography: {
                fluid: { minFontSize: "14px" },
                fontSizes: [{ slug: "big", size: "2rem", fluid: { min: "1rem", max: "3rem" } }],
              },
              custom: { lineHeight: { body: 1.7 } },
              color: { duotone: [{ slug: "d2", colors: [] }] },
              blocks: { "core/quote": { color: { palette: [{ slug: "q", color: "red" }] } } },
            },
          },
        },
      ],
      { report, where: "site", url: "https://example.test/" },
    );
    expect(report.entries().map((e) => [e.severity, e.code, e.where, e.url])).toEqual([
      ["info", "corecss.preset-block-scoped", "site", "https://example.test/"],
      ["info", "corecss.preset-custom", "site", "https://example.test/"],
      ["info", "corecss.preset-fluid", "site", "https://example.test/"],
      ["info", "corecss.preset-duotone", "site", "https://example.test/"],
    ]);
    // Core's own layer reported nothing: its duotone list and button widths are not a loss (nothing reads them).
    expect(report.entries().every((e) => (e.data as { layer: string }).layer !== "default")).toBe(
      true,
    );
  });
});

describe.skipIf(!HAVE_TREE || !HAVE_PHP)(
  "wpPresetCss against WordPress's own WP_Theme_JSON",
  () => {
    const cases: Record<string, ThemeJsonLayer[]> = {
      "core only": [CORE_LAYER],
      "theme palette, defaults on": [
        CORE_LAYER,
        {
          origin: "theme",
          json: {
            version: 3,
            settings: {
              color: {
                palette: [
                  { slug: "black", name: "B", color: "#111111" },
                  { slug: "brand", name: "Brand", color: "#c00" },
                ],
              },
            },
          },
        },
      ],
      "theme palette, defaults off": [
        CORE_LAYER,
        {
          origin: "theme",
          json: {
            version: 3,
            settings: {
              color: {
                defaultPalette: false,
                palette: [
                  { slug: "black", name: "B", color: "#111111" },
                  { slug: "brand", name: "Brand", color: "#c00" },
                ],
              },
            },
          },
        },
      ],
      "v2 theme with font sizes": [
        CORE_LAYER,
        {
          origin: "theme",
          json: {
            version: 2,
            settings: {
              typography: {
                fontSizes: [
                  { slug: "large", size: "2rem" },
                  { slug: "Huge Size", size: "3rem" },
                ],
              },
            },
          },
        },
      ],
      "user palette keyed by origin": [
        CORE_LAYER,
        {
          origin: "theme",
          json: {
            version: 3,
            settings: { color: { palette: [{ slug: "brand", name: "Brand", color: "#c00" }] } },
          },
        },
        {
          origin: "custom",
          json: {
            version: 2,
            settings: {
              color: {
                palette: {
                  theme: [
                    { slug: "cc-color-1", name: "", color: "#2c324d" },
                    { slug: "cc-xew3h", name: "", color: "#fff" },
                  ],
                },
              },
            },
          },
        },
      ],
      "user document without a version": [
        CORE_LAYER,
        {
          origin: "custom",
          json: { settings: { color: { palette: { custom: [{ slug: "zzz", color: "#000" }] } } } },
        },
      ],
      "user custom origin": [
        CORE_LAYER,
        {
          origin: "custom",
          json: {
            version: 3,
            settings: {
              color: {
                palette: {
                  custom: [
                    { slug: "zzz", color: "#010203" },
                    { slug: "white", color: "#fefefe" },
                  ],
                },
              },
              typography: {
                fontFamilies: [{ slug: "sans", name: "Sans", fontFamily: "Arial, sans-serif" }],
              },
            },
          },
        },
      ],
      "spacing sizes over the scale": [
        CORE_LAYER,
        {
          origin: "theme",
          json: {
            version: 3,
            settings: {
              spacing: {
                spacingSizes: [
                  { slug: "30", name: "x", size: "10px" },
                  { slug: "90", name: "y", size: "9rem" },
                ],
              },
            },
          },
        },
      ],
      "spacing scale with +": [
        {
          origin: "default",
          json: {
            version: 3,
            settings: {
              spacing: {
                spacingScale: { operator: "+", increment: 2, steps: 4, mediumStep: 16, unit: "px" },
              },
            },
          },
        },
      ],
      "v2 theme with spacing sizes and a scale": [
        CORE_LAYER,
        {
          origin: "theme",
          json: {
            version: 2,
            settings: {
              spacing: {
                spacingSizes: [{ slug: "50", name: "m", size: "1px" }],
                spacingScale: { operator: "+", increment: 1, steps: 3, mediumStep: 2, unit: "px" },
              },
            },
          },
        },
      ],
      "shadows off": [
        CORE_LAYER,
        {
          origin: "theme",
          json: {
            version: 3,
            settings: {
              shadow: {
                defaultPresets: false,
                presets: [{ slug: "natural", name: "N", shadow: "1px 1px red" }],
              },
            },
          },
        },
      ],
      "keyed spacing scale in a theme layer": [
        CORE_LAYER,
        {
          origin: "theme",
          json: {
            version: 3,
            settings: {
              spacing: {
                spacingScale: {
                  default: { operator: "+", increment: 2, steps: 4, mediumStep: 16, unit: "px" },
                },
              },
            },
          },
        },
      ],
      "keyed spacing scale": [
        {
          origin: "default",
          json: {
            version: 3,
            settings: {
              spacing: {
                spacingScale: {
                  default: { operator: "+", increment: 2, steps: 4, mediumStep: 16, unit: "px" },
                },
              },
            },
          },
        },
      ],
      "user v2 theme-keyed font sizes": [
        CORE_LAYER,
        {
          origin: "custom",
          json: {
            version: 2,
            settings: {
              typography: {
                fontSizes: {
                  theme: [
                    { slug: "large", size: "9px" },
                    { slug: "mine", size: "5px" },
                  ],
                },
              },
            },
          },
        },
      ],
      "numeric font size": [
        CORE_LAYER,
        {
          origin: "theme",
          json: { version: 3, settings: { typography: { fontSizes: [{ slug: "n", size: 20 }] } } },
        },
      ],
      "user v2 font sizes keyed custom": [
        CORE_LAYER,
        {
          origin: "custom",
          json: {
            version: 2,
            settings: { typography: { fontSizes: { custom: [{ slug: "large", size: "9px" }] } } },
          },
        },
      ],
      "empty theme palette": [
        CORE_LAYER,
        { origin: "theme", json: { version: 3, settings: { color: { palette: [] } } } },
      ],
    };
    for (const [name, layers] of Object.entries(cases)) {
      test(name, async () => {
        expect(wpPresetCss(layers).css).toBe(await wordpressSays(layers));
      });
    }

    test("randomised layers: 60 generated theme and user documents, byte for byte", async () => {
      const real: unknown = JSON.parse(
        readFileSync(join(WP_TREE, "wp-includes/theme.json"), "utf8"),
      );
      const core: ThemeJsonLayer = { origin: "default", json: real };
      let seed = 20_260_930;
      const rnd = (n: number): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed % n;
      };
      const pick = <T>(items: readonly T[]): T => items[rnd(items.length)]!;
      const slugs = [
        "black",
        "white",
        "large",
        "small",
        "x-large",
        "cc-color-1",
        "cc-xew3h",
        "Odd Name_1",
        "primary",
        "My_Brand",
        "50",
        "20",
        "foo",
        "1st-thing",
        "ABCDef",
      ];
      const colors = () =>
        Array.from({ length: rnd(4) }, () => ({
          slug: pick(slugs),
          name: "n",
          color: pick(["#111", "#222", "red", "rgb(1,2,3)"]),
        }));
      const sizes = () =>
        Array.from({ length: rnd(4) }, () => ({
          slug: pick(slugs),
          name: "n",
          size: pick(["1rem", "12px", "2em"]),
        }));
      const scale = () => ({
        operator: pick(["+", "*"]),
        increment: pick([1.5, 2, 0.5, 1.25, 3]),
        steps: pick([1, 3, 5, 7, 9, 4]),
        mediumStep: pick([1.5, 16, 10, 0.1]),
        unit: pick(["rem", "px", "em", "%"]),
      });
      const document = (user: boolean): unknown => {
        const settings: Record<string, Record<string, unknown>> = {};
        if (rnd(2)) {
          settings.color = {};
          if (rnd(2)) settings.color.palette = user && rnd(2) ? { theme: colors() } : colors();
          if (rnd(3) === 0) settings.color.defaultPalette = rnd(2) === 0;
        }
        if (rnd(2)) {
          settings.typography = {};
          if (rnd(2)) settings.typography.fontSizes = user && rnd(2) ? { theme: sizes() } : sizes();
          if (rnd(3) === 0) settings.typography.defaultFontSizes = rnd(2) === 0;
        }
        if (rnd(2)) {
          settings.spacing = {};
          if (rnd(2))
            settings.spacing.spacingSizes = Array.from({ length: rnd(3) }, () => ({
              slug: pick(["20", "30", "50", "90"]),
              name: "n",
              size: pick(["1rem", "5px"]),
            }));
          if (rnd(2)) settings.spacing.spacingScale = scale();
          if (rnd(4) === 0) settings.spacing.defaultSpacingSizes = rnd(2) === 0;
        }
        return { version: user ? pick([2, 3]) : pick([1, 2, 3]), settings };
      };
      for (let i = 0; i < 60; i++) {
        const layers: ThemeJsonLayer[] = [core, { origin: "theme", json: document(false) }];
        if (rnd(3) > 0) layers.push({ origin: "custom", json: document(true) });
        expect(wpPresetCss(layers).css, JSON.stringify(layers.slice(1))).toBe(
          await wordpressSays(layers),
        );
      }
    });
  },
);

describe("wpThemeJsonLayers", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function tree(files: Record<string, string>): string {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, "wptheme-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries(files)) {
      const target = join(dir, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, text);
    }
    return dir;
  }
  const post = (slug: string, content: string, status = "publish", type = "wp_global_styles") => ({
    type,
    status,
    slug,
    content,
  });
  const model = (options: Record<string, string>, posts: ReturnType<typeof post>[]) => ({
    options: new Map(Object.entries(options)),
    posts: new Map(posts.map((p, i) => [i + 1, p])),
  });

  test("core, then the theme, then the Site Editor's post for the active stylesheet, in merge order and origins", async () => {
    const root = tree({
      "wp-includes/theme.json": JSON.stringify(CORE),
      "wp-content/themes/cwicly/theme.json": JSON.stringify({
        version: 2,
        settings: { color: { palette: [{ slug: "brand", color: "#c00" }] } },
      }),
    });
    const user = {
      version: 2,
      settings: {
        color: { palette: { theme: [{ slug: "cc-color-1", name: "", color: "#2c324d" }] } },
      },
      isGlobalStylesUserThemeJSON: true,
    };
    const layers = await wpThemeJsonLayers(
      root,
      model({ stylesheet: "cwicly", template: "cwicly" }, [
        post("wp-global-styles-blocksy", '{"version":2}'),
        post(
          "wp-global-styles-cwicly",
          '{"version":2,"settings":{"color":{"palette":[{"slug":"wrong","color":"#000"}]}}}',
          "publish",
          "page",
        ),
        post("wp-global-styles-cwicly", JSON.stringify({ version: 2, settings: {} }), "draft"),
        post("wp-global-styles-cwicly", JSON.stringify(user)),
      ]),
    );
    expect(layers.map((l) => [l.origin, l.label])).toEqual([
      ["default", "wp-includes/theme.json"],
      ["theme", "wp-content/themes/cwicly/theme.json"],
      ["custom", "post:wp-global-styles-cwicly"],
    ]);
    expect(layers[2]!.json).toEqual(user);
    const css = wpPresetCss(layers).css;
    expect(css).toContain("--wp--preset--color--cc-color-1: #2c324d;");
    // The Site Editor's list is keyed `theme`: it REPLACES the theme.json palette (WordPress does the same).
    expect(css).not.toContain("--wp--preset--color--brand");
  });

  test("a site with only a template option (no stylesheet) uses the template's theme.json", async () => {
    const root = tree({
      "wp-includes/theme.json": JSON.stringify(CORE),
      "wp-content/themes/cwicly/theme.json": JSON.stringify({ version: 3, settings: {} }),
    });
    const layers = await wpThemeJsonLayers(root, model({ template: "cwicly" }, []));
    expect(layers.map((l) => l.label)).toEqual([
      "wp-includes/theme.json",
      "wp-content/themes/cwicly/theme.json",
    ]);
  });

  test("a child theme merges over its parent's theme.json, and its post name is the stylesheet url-encoded", async () => {
    const root = tree({
      "wp-includes/theme.json": JSON.stringify(CORE),
      "wp-content/themes/parent/theme.json": JSON.stringify({
        version: 3,
        settings: { color: { palette: [{ slug: "p", color: "#111" }] } },
      }),
      "wp-content/themes/child theme/theme.json": JSON.stringify({
        version: 3,
        settings: { color: { palette: [{ slug: "c", color: "#222" }] } },
      }),
    });
    const layers = await wpThemeJsonLayers(
      root,
      model({ stylesheet: "child theme", template: "parent" }, [
        post("wp-global-styles-child%20theme", '{"version":3,"settings":{}}'),
      ]),
    );
    expect(layers.map((l) => l.label)).toEqual([
      "wp-includes/theme.json",
      "wp-content/themes/parent/theme.json",
      "wp-content/themes/child theme/theme.json",
      "post:wp-global-styles-child%20theme",
    ]);
    // The child's palette replaces the parent's (same origin).
    const css = wpPresetCss(layers).css;
    expect(css).toContain("--wp--preset--color--c: #222;");
    expect(css).not.toContain("--wp--preset--color--p:");
  });

  test("a missing layer is skipped and reported as info; invalid JSON is a warning; neither throws", async () => {
    const root = tree({
      "wp-content/themes/cwicly/theme.json": "{ not json",
    });
    const report = createReport();
    const layers = await wpThemeJsonLayers(
      root,
      model({ stylesheet: "cwicly" }, [post("wp-global-styles-cwicly", "also { not json")]),
      { report, where: "site" },
    );
    expect(layers).toEqual([]);
    expect(report.entries().map((e) => [e.severity, e.code, e.where])).toEqual([
      ["info", "corecss.preset-layer-missing", "site"],
      ["warn", "corecss.preset-layer-malformed", "site"],
      ["warn", "corecss.preset-layer-malformed", "site"],
    ]);
  });

  test("coreRoot reads core's file from another tree (a site repository holds wp-content only)", async () => {
    const core = tree({ "wp-includes/theme.json": JSON.stringify(CORE) });
    const site = tree({
      "wp-content/themes/cwicly/theme.json": JSON.stringify({ version: 3, settings: {} }),
    });
    const layers = await wpThemeJsonLayers(site, model({ stylesheet: "cwicly" }, []), {
      coreRoot: core,
    });
    expect(layers.map((l) => l.origin)).toEqual(["default", "theme"]);
  });

  test("no stylesheet option: only core is read", async () => {
    const root = tree({ "wp-includes/theme.json": JSON.stringify(CORE) });
    expect((await wpThemeJsonLayers(root, model({}, []))).map((l) => l.origin)).toEqual([
      "default",
    ]);
  });

  test("a byte-order mark in theme.json is tolerated", async () => {
    const root = tree({ "wp-includes/theme.json": `﻿${JSON.stringify(CORE)}` });
    expect((await wpThemeJsonLayers(root, model({}, []))).map((l) => l.origin)).toEqual([
      "default",
    ]);
  });

  for (const site of FIXTURE_SITES) {
    test(`${site}: the real wp_global_styles post is found by its slug (the fixture's rows)`, async () => {
      const loaded = await loadSite(site);
      const root = tree({
        "wp-includes/theme.json": JSON.stringify(CORE),
        "wp-content/themes/cwicly/theme.json": JSON.stringify({ version: 2, settings: {} }),
      });
      const layers = await wpThemeJsonLayers(root, loaded.model);
      expect(layers.map((l) => l.origin)).toEqual(["default", "theme", "custom"]);
      expect(layers[2]!.label).toBe("post:wp-global-styles-cwicly");
      expect((layers[2]!.json as { version: number }).version).toBeGreaterThan(0);
    });
  }

  test("fineline: the Site Editor's palette is cc-color-1..4, so the classes the content uses are styled once the preset source is added", async () => {
    const loaded = await loadSite("fineline");
    const root = tree({
      "wp-includes/theme.json": JSON.stringify(CORE),
      "wp-content/themes/cwicly/theme.json": JSON.stringify({ version: 2, settings: {} }),
    });
    const layers = await wpThemeJsonLayers(root, loaded.model);
    const css = wpPresetCss(layers).css;
    for (const slug of ["cc-color-1", "cc-color-2", "cc-color-3", "cc-color-4"]) {
      expect(css).toContain(
        `.has-${slug}-color{color: var(--wp--preset--color--${slug}) !important;}`,
      );
      expect(css).toContain(`.has-${slug}-background-color{`);
    }
    const out = coreBlockStyle(
      ["has-cc-color-3-color", "has-cc-color-1-background-color"],
      [wpPresetCss(layers)],
      BP,
    );
    expect(out.custom).toEqual({
      "--wp--preset--color--cc-color-1": "#2c324d",
      "--wp--preset--color--cc-color-3": "#ffffff",
    });
  });

  test.skipIf(!HAVE_TREE || !HAVE_PHP)(
    "both fixture sites with the real core and theme files: byte for byte what WP_Theme_JSON prints",
    async () => {
      for (const site of FIXTURE_SITES) {
        const loaded = await loadSite(site);
        const layers = await wpThemeJsonLayers(WP_TREE, loaded.model);
        expect(
          layers.map((l) => l.origin),
          site,
        ).toEqual(["default", "theme", "custom"]);
        const mine = wpPresetCss(layers).css;
        expect(mine.length).toBeGreaterThan(5000);
        expect(mine, site).toBe(await wordpressSays(layers));
      }
    },
  );
});

// ── The cascade across shorthands, longhands and aliases ────────────────────────────────────────

describe("coreBlockStyle: properties that set one another under different names", () => {
  /** The winning declaration of the original and of the emitted CSS must agree for an element with every class. */
  function agrees(css: string, classes: string[]): { keys: string[]; diff: string[] } {
    const { out, css: emitted } = style(css, classes);
    const original = analysedRulesOf(css);
    const rules = analysedRulesOf(emitted);
    const diff: string[] = [];
    for (const width of [300, 700, 1000]) {
      const query = { classes, width };
      diff.push(...cascadeDiff(cascadeOf(original, query), cascadeOf(rules, query)));
    }
    return { keys: Object.keys(out.style), diff };
  }

  for (const [shorthand, longhand, other] of [
    ["place-content", "align-content", "start"],
    ["place-content", "justify-content", "start"],
    ["place-items", "align-items", "start"],
    ["place-items", "justify-items", "start"],
    ["place-self", "align-self", "start"],
    ["place-self", "justify-self", "start"],
    ["flex-flow", "flex-direction", "row"],
    ["flex-flow", "flex-wrap", "wrap"],
  ] as const) {
    test(`${shorthand} between two ${longhand} rules: the later longhand still wins for an element with both classes`, () => {
      // `.b` sits between two `.a` rules of one specificity: merging the second `.a` into the first
      // entry would put it ahead of `.b`, and `.b`'s shorthand would win instead.
      const css = `.a{${longhand}:${other}}.b{${shorthand}:center}.a{${longhand}:end}`;
      const { keys, diff } = agrees(css, ["a", "b"]);
      expect(diff).toEqual([]);
      expect(keys).toEqual([".a", ".b", ".a, .a"]);
    });
  }

  for (const [first, second] of [
    ["width", "inline-size"],
    ["height", "block-size"],
    ["word-wrap", "overflow-wrap"],
    ["page-break-before", "break-before"],
    ["page-break-after", "break-after"],
    ["page-break-inside", "break-inside"],
  ] as const) {
    test(`${first} and ${second} set the same property: a rule between two of them is not reordered`, () => {
      // The oracle does not model these aliases, so the order is read off the entries themselves.
      const css = `.a{${first}:1px}.b{${second}:2px}.a{${first}:3px}`;
      const { out, report } = style(css, ["a", "b"]);
      expect(Object.keys(out.style)).toEqual([".a", ".b", ".a, .a"]);
      expect(report.map((entry) => entry.code)).toContain("corecss.rekeyed");
      // And the reverse spelling, the longhand name the later rule uses.
      const reverse = style(`.a{${second}:1px}.b{${first}:2px}.a{${second}:3px}`, ["a", "b"]);
      expect(Object.keys(reverse.out.style)).toEqual([".a", ".b", ".a, .a"]);
    });
  }

  test("properties that do not set one another still share an entry (the families are not widened to everything)", () => {
    const { out } = style(".a{width:1px}.b{height:2px}.a{width:3px}", ["a", "b"]);
    expect(Object.keys(out.style)).toEqual([".a", ".b"]);
    const flex = style(".a{flex-grow:1}.b{flex-flow:row wrap}.a{flex-grow:2}", ["a", "b"]);
    expect(Object.keys(flex.out.style)).toEqual([".a", ".b"]);
  });

  test("300 random sheets over the shorthands and their longhands (nested @media and @supports): the same declaration wins as in the original", () => {
    let seed = 7_410_113;
    const rnd = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return Math.floor((seed / 2_147_483_648) * n);
    };
    const pick = <T>(items: readonly T[]): T => items[rnd(items.length)]!;
    const selectors = [".a", ".a", ".b", ".b", ".c", ".a.b", ".a:hover", "p.a", ".a:not(.c)"];
    const props = [
      "align-items",
      "place-items",
      "justify-items",
      "place-self",
      "align-self",
      "justify-self",
      "flex-direction",
      "flex-flow",
      "flex-wrap",
      "align-content",
      "place-content",
      "justify-content",
    ];
    const values = ["red", "blue", "0", "1px", "block", "none"];
    const wraps = [
      "",
      "",
      "@media (min-width:600px)",
      "@media (max-width:900px)",
      "@supports (display:grid)",
      "@media (min-width:600px){@supports (display:grid)",
      "@supports (display:grid){@media (max-width:900px)",
    ];
    const sets = [["a"], ["b"], ["a", "b"], ["b", "c"], ["a", "b", "c"]];
    let rekeyed = 0;
    for (let i = 0; i < 300; i++) {
      let css = "";
      for (let k = 2 + rnd(12); k > 0; k--) {
        const selector = pick(selectors);
        const body = Array.from(
          { length: 1 + rnd(2) },
          () => `${pick(props)}:${pick(values)}${rnd(8) === 0 ? "!important" : ""}`,
        ).join(";");
        const wrap = pick(wraps);
        const opens = (wrap.match(/\{/g) ?? []).length;
        css +=
          wrap === ""
            ? `${selector}{${body}}`
            : `${wrap}{${selector}{${body}}${"}".repeat(1 + opens)}`;
      }
      const { out, css: emitted, report } = style(css, ["a", "b", "c"]);
      if (report.some((entry) => entry.code === "corecss.rekeyed")) rekeyed += 1;
      const original = analysedRulesOf(css);
      const rules = analysedRulesOf(emitted);
      for (const classes of sets) {
        for (const tag of ["div", "p"]) {
          for (const width of [300, 700, 1000]) {
            for (const states of [[], [":hover"]]) {
              const query = { classes, tag, width, states };
              const diff = cascadeDiff(cascadeOf(original, query), cascadeOf(rules, query));
              if (diff.length > 0) {
                throw new Error(
                  `${diff[0]} for ${tag}.${classes.join(".")} at ${width}\n${css}\n=> ${JSON.stringify(out.style)}`,
                );
              }
            }
          }
        }
      }
    }
    expect(rekeyed).toBeGreaterThan(50);
  });
});

// ── Which blocks' sheets, and which of their rules, a converted page keeps ──────────────────────

describe("wpCoreCssSources and coreBlockStyle: the blocks a page renders", () => {
  const ESSAY = "essays__the-way-we-live-is-the-way-we-educate.html";
  const html = readFileSync(join(FIXTURES, "ap", "html", ESSAY), "utf8");
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  /** The page's own sheets laid out as a WordPress checkout holds them, under the path their origin names. */
  function checkoutOf(page: string): string {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, "wpblocks-"));
    dirs.push(dir);
    for (const source of inlineWpCss(page)) {
      const relative = source.origin.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, "");
      const target = join(dir, relative);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, source.css);
    }
    return dir;
  }

  test("the registered names the converter counts (core/list) find the same sheets as the directory names", async () => {
    const loaded = await loadSite("ap");
    const root = checkoutOf(html);
    for (const id of [7260, 8819]) {
      const counted = [...countBlocks(subjectBlocks(loaded, { kind: "post", id })).keys()];
      expect(counted.every((name) => name.startsWith("core/"))).toBe(true);
      const report = createReport();
      const registered = await wpCoreCssSources(root, { blocks: counted, report });
      const bare = await wpCoreCssSources(root, { blocks: counted.map((name) => name.slice(5)) });
      expect(registered.map((source) => source.origin)).toEqual(bare.map((s) => s.origin));
      expect(registered.map((source) => source.origin)).toEqual([
        "wp-includes/blocks/list/style.min.css",
        "wp-includes/blocks/paragraph/style.min.css",
        "wp-includes/css/dist/block-library/common.min.css",
      ]);
      // The blocks with no sheet of their own are named, not silently absent.
      const named = report
        .entries()
        .filter((entry) => entry.code === "corecss.sources-missing")
        .flatMap((entry) => (entry.data as { blocks: string[] }).blocks);
      expect(named.toSorted()).toEqual(
        counted
          .map((name) => name.slice(5))
          .filter((name) => name !== "list" && name !== "paragraph")
          .toSorted(),
      );
      expect(report.entries().filter((entry) => entry.severity !== "info")).toEqual([]);
    }
  });

  test("a block name that cannot name a core sheet is reported by why: invalid (warn), a plugin's (info), none of its own (info)", async () => {
    const root = checkoutOf(html);
    const report = createReport();
    const sources = await wpCoreCssSources(root, {
      blocks: ["core/paragraph", "Image", "post_terms", "cwicly/div", "core/list-item", "../etc"],
      report,
    });
    expect(sources.map((source) => source.origin)).toEqual([
      "wp-includes/blocks/paragraph/style.min.css",
      "wp-includes/css/dist/block-library/common.min.css",
    ]);
    const byReason = Object.fromEntries(
      report.entries().map((entry) => {
        const data = entry.data as { reason: string; blocks: string[] };
        return [data.reason, { severity: entry.severity, blocks: data.blocks }];
      }),
    );
    expect(byReason).toEqual({
      "invalid-name": { severity: "warn", blocks: ["Image", "post_terms", "../etc"] },
      "not-core": { severity: "info", blocks: ["cwicly/div"] },
      "no-sheet": { severity: "info", blocks: ["list-item"] },
    });
  });

  test("reading the whole library says so: without `blocks` a checkout's sheets are not the ones the page loads", async () => {
    const root = checkoutOf(html);
    const unscoped = createReport();
    await wpCoreCssSources(root, { report: unscoped });
    expect(unscoped.entries().map((entry) => [entry.severity, entry.code])).toEqual([
      ["info", "corecss.sources-unscoped"],
    ]);
    const scoped = createReport();
    await wpCoreCssSources(root, { blocks: ["list"], report: scoped });
    expect(scoped.entries().map((entry) => entry.code)).not.toContain("corecss.sources-unscoped");
  });

  test("a list the converter leaves without wp-block-list keeps the block's classless rule once the block is named; without it the drop is reported", async () => {
    const loaded = await loadSite("ap");
    // What the converted markup carries: the classes of the saved content (4 lists, none with a wp-block-list class).
    const saved = collectWpClassesFromHtml(subjectPostContent(loaded, 7260));
    expect(saved.has("wp-block-list")).toBe(false);
    const sources = inlineWpCss(html);

    const guessed = createReport();
    const without = coreBlockStyle(saved, sources, BP, guessed);
    expect(Object.keys(without.style)).not.toContain("ol, ul");
    const entry = guessed.entries().find((e) => e.code === "corecss.ambient-dropped");
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe("info");
    const data = entry!.data as { blocks: string[]; selectors: string[] };
    expect(data.blocks).toContain("list");
    expect(data.selectors).toEqual(["ol", "ul"]);

    const named = createReport();
    const blocks = [...countBlocks(subjectBlocks(loaded, { kind: "post", id: 7260 })).keys()];
    const withBlocks = coreBlockStyle(saved, sources, BP, named, { blocks });
    expect(withBlocks.style["ol, ul"]).toEqual({ boxSizing: "border-box" });
    // The rule the live page serves for the same elements: every ol and ul of the page gets it.
    const live = coreBlockStyle(collectWpClassesFromHtml(html), sources, BP);
    expect(live.style[".wp-block-post-terms, ol, ul"]).toEqual({ boxSizing: "border-box" });
    expect(named.entries().map((e) => e.code)).not.toContain("corecss.ambient-dropped");
    // Naming a block that is not rendered keeps nothing of it: the sheet of `search` is on the page,
    // but a converted page that names only `list` does not load it.
    expect(Object.keys(withBlocks.style).filter((key) => key.includes("search"))).toEqual([]);
  });

  test("`blocks` takes registered names and bare ones alike, and a block that is not named is still judged by its classes", () => {
    const css = ".wp-block-x{color:red}ol,ul{margin:0}";
    const sheet = [{ css, origin: "wp-includes/blocks/x/style.min.css" }];
    for (const blocks of [["core/x"], ["x"]]) {
      expect(Object.keys(coreBlockStyle([], sheet, BP, undefined, { blocks }).style)).toEqual([
        "ol, ul",
      ]);
    }
    expect(Object.keys(coreBlockStyle([], sheet, BP, undefined, { blocks: ["y"] }).style)).toEqual(
      [],
    );
    expect(Object.keys(coreBlockStyle(["wp-block-x"], sheet, BP).style)).toEqual([
      ".wp-block-x",
      "ol, ul",
    ]);
    // ambient:false still keeps classless rules out, whatever is named.
    expect(
      Object.keys(
        coreBlockStyle([], sheet, BP, undefined, { blocks: ["x"], ambient: false }).style,
      ),
    ).toEqual([]);
  });

  test.skipIf(!HAVE_TREE)(
    "the faithful recipe: a checkout read for the blocks a page renders styles every element as the page's own sheets do (all 12 saved pages)",
    async () => {
      for (const { site, file, html: page } of PAGES) {
        const live = inlineWpCss(page);
        const rendered = live.flatMap((source) => {
          const block = /\/blocks\/([a-z0-9-]+)\//.exec(source.origin)?.[1];
          return block === undefined ? [] : [block];
        });
        const used = collectWpClassesFromHtml(page);
        const fromTree = await wpCoreCssSources(WP_TREE, { blocks: rendered });
        const original = analysedRulesOf(
          cssOf(coreBlockStyle(used, live, BP, undefined, { blocks: rendered })),
        );
        const emitted = analysedRulesOf(
          cssOf(coreBlockStyle(used, fromTree, BP, undefined, { blocks: rendered })),
        );
        const elements = new Map<string, { tag: string; classes: string[] }>();
        const walk = (node: {
          tagName?: string;
          attrs?: { name: string; value: string }[];
          childNodes?: unknown[];
        }): void => {
          if (node.tagName !== undefined) {
            const classes = (node.attrs?.find((a) => a.name === "class")?.value ?? "")
              .split(/\s+/)
              .filter(Boolean);
            elements.set(`${node.tagName}.${classes.join(".")}`, { tag: node.tagName, classes });
          }
          for (const child of (node.childNodes ?? []) as (typeof node)[]) walk(child);
        };
        walk(parse(page) as never);
        const problems: string[] = [];
        for (const { tag, classes } of elements.values()) {
          for (const width of [400, 800, 1400]) {
            for (const states of [[], [":hover"]]) {
              const query = { classes, tag, width, states };
              const diff = cascadeDiff(cascadeOf(original, query), cascadeOf(emitted, query));
              if (diff.length > 0) {
                problems.push(
                  `${tag}.${classes.join(".")} @${width}${states.join("")}: ${diff[0]}`,
                );
              }
            }
          }
        }
        expect(problems.slice(0, 3), `${site}/${file}`).toEqual([]);
      }
    },
  );
});

/** A post's saved content, as the converter reads it. */
function subjectPostContent(loaded: Awaited<ReturnType<typeof loadSite>>, id: number): string {
  return loaded.model.posts.get(id)?.content ?? "";
}

// ── Custom properties keep their source order ───────────────────────────────────────────────────

describe("coreBlockStyle: a custom property's cascade across conditions", () => {
  /** What `--p` computes to on `.x` at a width, read off the emitted CSS (plus its verbatim text) by the browser rules that matter: later wins at equal specificity. */
  const valueAt = (out: CoreBlockStyle, width: number): string | undefined => {
    const rules = [
      ...cssOf({ custom: out.custom, style: out.style }).matchAll(
        /(?:@media \(min-width:\s*(\d+)px\)\s*\{\s*)?:root\s*\{\s*--p:\s*([^;}]+);?\s*\}/g,
      ),
      ...out.verbatim.matchAll(
        /(?:@media \(min-width:\s*(\d+)px\)\s*\{\s*)?:root\s*\{\s*--p:\s*([^;}]+);?\s*\}/g,
      ),
    ];
    let winner: string | undefined;
    for (const match of rules) {
      if (match[1] === undefined || width >= Number(match[1])) winner = match[2]!.trim();
    }
    return winner;
  };

  test("a later unconditional declaration beats an earlier conditional one at every width", () => {
    const css = "@media (min-width:600px){:root{--p:1px}}:root{--p:2px}.x{width:var(--p)}";
    const { out } = style(css, ["x"]);
    expect(out.custom).toEqual({ "--p": "2px" });
    expect(Object.keys(out.style)).toEqual([".x"]);
    for (const width of [300, 700, 1400]) expect(valueAt(out, width)).toBe("2px");
  });

  test("an unconditional declaration followed by a conditional one keeps both, the condition after", () => {
    const css = ":root{--p:2px}@media (min-width:600px){:root{--p:1px}}.x{width:var(--p)}";
    const { out } = style(css, ["x"]);
    expect(out.custom).toEqual({ "--p": "2px" });
    expect(out.style["@(min-width: 600px)"]).toEqual({ "--p": "1px" });
    expect(valueAt(out, 300)).toBe("2px");
    expect(valueAt(out, 700)).toBe("1px");
  });

  test("the last of two declarations under one condition wins, and moves behind a different condition that came between them", () => {
    const css =
      "@media (min-width:600px){:root{--p:1px}}@media (min-width:900px){:root{--p:2px}}" +
      "@media (min-width:600px){:root{--p:3px}}.x{width:var(--p)}";
    const { out } = style(css, ["x"]);
    // At 1000px both conditions hold and the source's last word is 3px.
    for (const [width, expected] of [
      [300, undefined],
      [700, "3px"],
      [1000, "3px"],
    ] as const) {
      expect(valueAt(out, width), `${width}px`).toBe(expected);
    }
  });

  test("a condition that cannot sit after the one it must follow goes to CSS text, reported", () => {
    // `--q` opens the 600px entry first, so a 600px entry for `--p` cannot be emitted after the 900px one.
    const css =
      "@media (min-width:600px){:root{--q:1px}}@media (min-width:900px){:root{--p:2px}}" +
      "@media (min-width:600px){:root{--p:3px}}.x{width:var(--p);height:var(--q)}";
    const { out, report } = style(css, ["x"]);
    expect(out.style["@(min-width: 900px)"]).toEqual({ "--p": "2px" });
    expect(out.style["@(min-width: 600px)"]).toEqual({ "--q": "1px" });
    expect(out.verbatim).toContain("--p: 3px");
    expect(report.filter((entry) => entry.code === "corecss.verbatim")).toHaveLength(1);
    for (const [width, expected] of [
      [700, "3px"],
      [1000, "3px"],
    ] as const) {
      expect(valueAt(out, width), `${width}px`).toBe(expected);
    }
  });

  test("a superseded conditional value does not drag its own custom properties in", () => {
    const css =
      "@media (min-width:600px){:root{--p:var(--gone)}}:root{--p:2px;--gone:red}.x{width:var(--p)}";
    const { out } = style(css, ["x"]);
    expect(out.custom).toEqual({ "--p": "2px" });
  });
});

// ── What the Site Editor's layer holds besides presets ──────────────────────────────────────────

describe("wpPresetCss: a layer's `styles` are not reproduced, and it says so", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function tree(files: Record<string, string>): string {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, "wpstyles-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries(files)) {
      const target = join(dir, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, text);
    }
    return dir;
  }

  test("fineline: the Site Editor's post holds body colours, a heading weight and a font size, and each is named", async () => {
    const loaded = await loadSite("fineline");
    const root = tree({
      "wp-includes/theme.json": JSON.stringify({
        version: 3,
        settings: { color: { palette: [{ slug: "black", color: "#000" }] } },
        // Core's own styles are what a theme-less WordPress prints and are not a loss to name.
        styles: { elements: { button: { color: { text: "#fff" } } } },
      }),
      "wp-content/themes/cwicly/theme.json": JSON.stringify({ version: 2, settings: {} }),
    });
    const layers = await wpThemeJsonLayers(root, loaded.model);
    const report = createReport();
    wpPresetCss(layers, { report, where: "site" });
    const styles = report.entries().filter((entry) => entry.code === "corecss.preset-styles");
    expect(styles).toHaveLength(1);
    expect(styles[0]).toMatchObject({
      severity: "info",
      where: "site",
      data: {
        layer: "post:wp-global-styles-cwicly",
        keys: ["color", "blocks", "typography"],
        blocks: ["core/heading"],
      },
    });
    expect(styles[0]!.message).toContain("post:wp-global-styles-cwicly");
    // The presets of the same layer are still produced.
    expect(wpPresetCss(layers).css).toContain("--wp--preset--color--cc-color-1");
  });

  test("one entry per layer that has styles, none for an empty `styles`, a layer with no version, or core's own", () => {
    const report = createReport();
    wpPresetCss(
      [
        {
          origin: "default",
          json: { version: 3, styles: { color: { text: "#000" } } },
          label: "core",
        },
        {
          origin: "theme",
          json: { version: 3, styles: { spacing: { blockGap: "0" } } },
          label: "theme",
        },
        { origin: "theme", json: { version: 3, styles: {} }, label: "empty" },
        { origin: "custom", json: { styles: { color: { text: "#000" } } }, label: "no-version" },
        { origin: "custom", json: { version: 3, styles: { typography: {} } }, label: "user" },
      ],
      { report },
    );
    expect(
      report
        .entries()
        .filter((entry) => entry.code === "corecss.preset-styles")
        .map((entry) => (entry.data as { layer: string; blocks: string[] }).layer),
    ).toEqual(["theme", "user"]);
  });
});

// ── Behaviour a mutation check found nothing holding down ───────────────────────────────────────

describe("order of sources, theme sheets and theme names", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function tree(files: Record<string, string>): string {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, "wpsurvivors-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries(files)) {
      const target = join(dir, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, text);
    }
    return dir;
  }

  test("a `:root` custom property declared by two sources has the value of the later one: the preset source, last, overrides the block library's", () => {
    const page = readFileSync(
      join(FIXTURES, "ap", "html", "essays__the-way-we-live-is-the-way-we-educate.html"),
      "utf8",
    );
    const library = inlineWpCss(page);
    const preset = wpPresetCss([
      {
        origin: "custom",
        json: {
          version: 3,
          settings: { typography: { fontSizes: [{ slug: "normal", size: "20px" }] } },
        },
      },
    ]);
    const used = ["has-normal-font-size"];
    // The page's own common sheet declares 16px; the Site Editor's choice comes after it.
    expect(coreBlockStyle(used, library, BP).custom).toEqual({
      "--wp--preset--font-size--normal": "16px",
    });
    expect(coreBlockStyle(used, [...library, preset], BP).custom).toEqual({
      "--wp--preset--font-size--normal": "20px",
    });
    // And the other way round: the sheet that comes later is the one that wins.
    expect(coreBlockStyle(used, [preset, ...library], BP).custom).toEqual({
      "--wp--preset--font-size--normal": "16px",
    });
  });

  test("a block's theme.min.css belongs to the block: its classless rules are kept only when the block is in use", async () => {
    const root = tree({
      "wp-includes/blocks/quote/style.min.css": ".wp-block-quote{margin:0 0 1em}",
      "wp-includes/blocks/quote/theme.min.css":
        ".wp-block-quote{border-left:.25em solid}blockquote{padding:0}",
      "wp-includes/css/dist/block-library/common.min.css": ".screen-reader-text{width:1px}",
    });
    const sources = await wpCoreCssSources(root, { theme: true, blocks: ["quote"] });
    expect(sources.map((source) => source.origin)).toContain(
      "wp-includes/blocks/quote/theme.min.css",
    );
    const unused = coreBlockStyle(["screen-reader-text"], sources, BP);
    expect(Object.keys(unused.style)).toEqual([".screen-reader-text"]);
    const used = coreBlockStyle(["wp-block-quote"], sources, BP);
    expect(used.style["blockquote"]).toEqual({ padding: "0" });
    expect(used.style[".wp-block-quote"]).toMatchObject({ borderLeft: ".25em solid" });
  });

  test("the Site Editor's post of a theme directory with capitals is found by its lower-cased slug", async () => {
    const root = tree({
      "wp-includes/theme.json": JSON.stringify({ version: 3, settings: {} }),
    });
    const posts = new Map([
      [
        1,
        {
          type: "wp_global_styles",
          status: "publish",
          slug: "wp-global-styles-mytheme",
          content: JSON.stringify({ version: 3, settings: { color: { palette: [] } } }),
        },
      ],
    ]);
    const layers = await wpThemeJsonLayers(root, {
      options: new Map([["stylesheet", "MyTheme"]]),
      posts,
    });
    expect(layers.map((layer) => [layer.origin, layer.label])).toEqual([
      ["default", "wp-includes/theme.json"],
      ["custom", "post:wp-global-styles-mytheme"],
    ]);
  });
});
