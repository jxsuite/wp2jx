import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { parse } from "parse5";
import {
  buildCompatCss,
  COMPAT_BASE_FILES,
  COMPAT_CSS_HREF,
  COMPAT_CSS_PATH,
  COMPAT_FEATURE_FILES,
  COMPAT_THEME_PATH,
  compatFeaturesForBlocks,
  dirPluginSource,
  dirThemeCss,
  fetchPluginSource,
  fetchThemeCss,
  memoryPluginSource,
  pluginVersion,
  pruneUnusedClasses,
  type CompatFeature,
} from "../../src/emit/compat-css.ts";
import { createReport } from "../../src/report.ts";
import { parseBlocks } from "../../src/wp/blocks.ts";
import { loadSite, subjectBlocks, type SiteName } from "../helpers/ctx.ts";
import { FIXTURES } from "../helpers/fixture-db.ts";

// ── Synthetic sources (always run) ───────────────────────────────────────────────────────────────

const BASE = "*,::after,::before{box-sizing:border-box}body{margin:0}";
const INDEX =
  ".cc-cntr,.cc-sct{width:100%}.cc-cntr{margin-left:auto;margin-right:auto;max-width:1366px}";
const HOVER = ".cc-grow{transition-duration:.5s}.cc-grow:hover{transform:scale(1.1)}";
const GALLERY = ".cc-grid .cc-gallery-card{height:var(--cc-gallery-height)}";
const LIGHTBOX = ".cc-lightbox{position:fixed}";
const AOS = "[data-aos|=fade]{opacity:0!important}";

const FILES: Record<string, string> = {
  "assets/css/base.css": BASE,
  "build/style-index.css": INDEX,
  "assets/css/hover-animation.css": HOVER,
  "assets/css/gallery.css": GALLERY,
  "assets/css/lightbox.css": LIGHTBOX,
  "assets/css/aos.css": AOS,
  "cwicly.php": "<?php\n/**\n * Plugin Name: Cwicly\n * Version:           1.4.7\n */",
};

describe("buildCompatCss, synthetic plugin files", () => {
  test("writes base.css then style-index.css under the project path, each under a comment naming it", () => {
    const out = buildCompatCss(memoryPluginSource(FILES));
    expect(out.path).toBe("public/css/cwicly-base.css");
    expect(out.path).toBe(COMPAT_CSS_PATH);
    expect(out.href).toBe("/css/cwicly-base.css");
    expect(out.href).toBe(COMPAT_CSS_HREF);
    expect(out.content).toBe(
      `/* assets/css/base.css (Cwicly 1.4.7) */\n${BASE}\n\n/* build/style-index.css (Cwicly 1.4.7) */\n${INDEX}\n`,
    );
    expect(out.files.map((f) => f.path)).toEqual([...COMPAT_BASE_FILES]);
    expect(out.skipped).toEqual([]);
    expect(out.pluginVersion).toBe("1.4.7");
    expect(out.pruned).toEqual({ rules: 0, bytes: 0 });
  });

  test("optional files come after the base ones, in the documented order, only when asked for", () => {
    const out = buildCompatCss(memoryPluginSource(FILES), {
      hoverAnimation: true,
      gallery: true,
      lightbox: true,
      modal: false,
    } satisfies Parameters<typeof buildCompatCss>[1]);
    expect(out.files.map((f) => f.path)).toEqual([
      "assets/css/base.css",
      "build/style-index.css",
      "assets/css/gallery.css",
      "assets/css/lightbox.css",
      "assets/css/hover-animation.css",
    ]);
    expect(out.content).toContain(GALLERY);
    expect(out.content).toContain(HOVER);
    // modal was switched off explicitly, and its file is not even in this source: not an error
    expect(out.skipped).toEqual([]);
  });

  test("aos.css is refused with the reason, in the file list and in the report", () => {
    const report = createReport();
    const out = buildCompatCss(memoryPluginSource(FILES), { aos: true, report });
    expect(out.content).not.toContain("data-aos");
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]!.path).toBe("assets/css/aos.css");
    expect(out.skipped[0]!.reason).toContain("opacity:0!important");
    const entries = report.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: "warn",
      code: "design.compat-skipped",
      where: "plugin:cwicly",
    });
  });

  test("a missing required file is an error in the report, and a throw without one", () => {
    const { "build/style-index.css": _gone, ...rest } = FILES;
    const report = createReport();
    const out = buildCompatCss(memoryPluginSource(rest, "https://x.test/"), { report });
    expect(out.files.map((f) => f.path)).toEqual(["assets/css/base.css"]);
    expect(out.skipped[0]).toEqual({
      path: "build/style-index.css",
      reason: "build/style-index.css is not available from https://x.test/",
    });
    expect(report.entries()).toHaveLength(1);
    expect(report.entries()[0]).toMatchObject({ severity: "error", code: "design.compat-missing" });
    expect(() => buildCompatCss(memoryPluginSource(rest))).toThrow(
      /style-index\.css is not available/,
    );
  });

  test("a missing optional file is a warning, not an error", () => {
    const { "assets/css/gallery.css": _gone, ...rest } = FILES;
    const report = createReport();
    const out = buildCompatCss(memoryPluginSource(rest), { gallery: true, report });
    expect(out.files).toHaveLength(2);
    expect(report.entries()[0]).toMatchObject({ severity: "warn", code: "design.compat-missing" });
  });

  test("the plugin version is read from the header of cwicly.php, else from readme.txt's stable tag", () => {
    expect(pluginVersion(memoryPluginSource({ "cwicly.php": " * Version:           1.6.0" }))).toBe(
      "1.6.0",
    );
    expect(
      pluginVersion(memoryPluginSource({ "readme.txt": "=== Cwicly ===\nStable tag: 1.4.7\n" })),
    ).toBe("1.4.7");
    expect(pluginVersion(memoryPluginSource({}))).toBeUndefined();
    // the header wins over the readme
    expect(
      pluginVersion(
        memoryPluginSource({ "cwicly.php": "Version: 2.0.0", "readme.txt": "Stable tag: 1.0.0" }),
      ),
    ).toBe("2.0.0");
  });

  test("a plugin copy of another version than the site's is reported; the same version is not", () => {
    const report = createReport();
    buildCompatCss(memoryPluginSource(FILES), { version: "1.4.7", report });
    expect(report.entries()).toEqual([]);
    buildCompatCss(memoryPluginSource(FILES, "/repo"), { version: "1.5.0", report });
    const [entry] = report.entries();
    expect(report.entries()).toHaveLength(1);
    expect(entry).toMatchObject({ severity: "warn", code: "design.plugin-version" });
    expect(entry!.data).toEqual({ pluginVersion: "1.4.7", siteVersion: "1.5.0", origin: "/repo" });
    // no version from the source: nothing to compare, nothing reported
    const quiet = createReport();
    buildCompatCss(memoryPluginSource({ ...FILES, "cwicly.php": "" }), {
      version: "9.9.9",
      report: quiet,
    });
    expect(quiet.entries()).toEqual([]);
  });
});

describe("plugin sources", () => {
  const dirs: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "wp2jx-compat-"));
    dirs.push(dir);
    return dir;
  };
  const write = (root: string, files: Record<string, string>): void => {
    for (const [path, text] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, text);
    }
  };

  test("a directory is the plugin itself, or a site whose wp-content/plugins/cwicly holds it", () => {
    const plugin = scratch();
    write(plugin, FILES);
    expect(dirPluginSource(plugin).get("assets/css/base.css")).toBe(BASE);
    expect(dirPluginSource(plugin).get("nope.css")).toBeNull();

    const site = scratch();
    write(join(site, "wp-content/plugins/cwicly"), FILES);
    const source = dirPluginSource(site);
    expect(source.get("build/style-index.css")).toBe(INDEX);
    expect(source.origin).toBe(join(site, "wp-content/plugins/cwicly"));
    expect(pluginVersion(source)).toBe("1.4.7");
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("the live site's copy is fetched once up front; a 404 or a network error is an absent file", async () => {
    const asked: string[] = [];
    const source = await fetchPluginSource("https://site.test/", {
      fetch: async (input) => {
        asked.push(input);
        const path = input.replace("https://site.test/wp-content/plugins/cwicly/", "");
        if (path === "assets/css/lightbox.css") throw new Error("connection reset");
        const body = FILES[path] ?? (path === "readme.txt" ? "Stable tag: 1.4.7" : undefined);
        return body === undefined
          ? new Response("not found", { status: 404 })
          : new Response(body, { status: 200 });
      },
    });
    expect(
      asked.every((url) => url.startsWith("https://site.test/wp-content/plugins/cwicly/")),
    ).toBe(true);
    expect(asked).toContain("https://site.test/wp-content/plugins/cwicly/build/style-index.css");
    expect(asked).toContain("https://site.test/wp-content/plugins/cwicly/readme.txt");
    expect(source.get("build/style-index.css")).toBe(INDEX);
    expect(source.get("assets/css/lightbox.css")).toBeNull();
    expect(source.get("assets/css/modal.min.css")).toBeNull();
    expect(source.origin).toBe("https://site.test/wp-content/plugins/cwicly/");
    // the live site does not serve cwicly.php's source, so the readme answers
    expect(pluginVersion(source)).toBe("1.4.7");
    expect(buildCompatCss(source).content).toContain(INDEX);
  });

  test("a 200 that is the site's 404 page is an absent file, whether it says so or only opens with markup", async () => {
    const page = "<!DOCTYPE html><html><body><h1>Page not found</h1></body></html>";
    const soft = await fetchPluginSource("https://site.test/", {
      fetch: async (input) => {
        const path = input.replace("https://site.test/wp-content/plugins/cwicly/", "");
        // a real file, a page that declares itself HTML, a page that does not (a bare 200 with no type)
        if (path === "assets/css/base.css") return new Response(BASE, { status: 200 });
        if (path === "build/style-index.css")
          return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
        return new Response(page, { status: 200 });
      },
    });
    expect(soft.get("assets/css/base.css")).toBe(BASE);
    expect(soft.get("build/style-index.css")).toBeNull();
    expect(soft.get("assets/css/gallery.css")).toBeNull();
    expect(soft.get("readme.txt")).toBeNull();
    // CSS that merely mentions markup in a comment is still CSS
    const commented = await fetchPluginSource("https://site.test/", {
      fetch: async () =>
        new Response("/* <b> */a{x:y}", { status: 200, headers: { "content-type": "text/css" } }),
    });
    expect(commented.get("build/style-index.css")).toBe("/* <b> */a{x:y}");
    // and what is absent is reported by the build, never shipped as a stylesheet
    const report = createReport();
    const out = buildCompatCss(soft, { report });
    expect(out.content).not.toContain("<");
    expect(out.files.map((f) => f.path)).toEqual(["assets/css/base.css"]);
    expect(out.skipped.map((f) => f.path)).toEqual(["build/style-index.css"]);
    expect(report.entries().map((e) => `${e.severity} ${e.code}`)).toEqual([
      "error design.compat-missing",
    ]);
  });
});

// ── The theme's own stylesheet ───────────────────────────────────────────────────────────────────

describe("the theme stylesheet", () => {
  const THEME =
    "/*\nTheme Name: Cwicly Theme\nVersion: 1.0.3\n*/\n\nbody {\n    position: relative;\n}\n\n.cc-comments h3#comments {\n    margin-bottom: 25px;\n}\n";
  const TAIL =
    "body {\n    position: relative;\n}\n\n.cc-comments h3#comments {\n    margin-bottom: 25px;\n}\n";

  test("it is the last file of the compat stylesheet, without its header comment, and is listed", () => {
    const out = buildCompatCss(memoryPluginSource(FILES), { hoverAnimation: true, theme: THEME });
    expect(out.files.map((f) => f.path)).toEqual([
      "assets/css/base.css",
      "build/style-index.css",
      "assets/css/hover-animation.css",
      COMPAT_THEME_PATH,
    ]);
    expect(out.content.endsWith(`/* ${COMPAT_THEME_PATH} (Cwicly 1.4.7) */\n${TAIL}`)).toBe(true);
    expect(out.content).not.toContain("Theme Name");
    // absent, null and blank all ship nothing
    for (const theme of [undefined, null, "  \n"]) {
      expect(buildCompatCss(memoryPluginSource(FILES), { theme }).files).toHaveLength(2);
    }
  });

  test("it is pruned with the rest: the comment form's rules go when no page carries it", () => {
    const out = buildCompatCss(memoryPluginSource(FILES), {
      theme: THEME,
      usedClasses: new Set(["cc-cntr"]),
    });
    expect(out.content).toContain("position: relative");
    expect(out.content).not.toContain("cc-comments");
  });

  test("a site checkout and the live site both give it, and a soft 404 is none", async () => {
    const root = mkdtempSync(join(tmpdir(), "wp2jx-theme-"));
    try {
      expect(dirThemeCss(root)).toBeNull();
      mkdirSync(join(root, "wp-content/themes/cwicly"), { recursive: true });
      writeFileSync(join(root, COMPAT_THEME_PATH), THEME);
      expect(dirThemeCss(root)).toBe(THEME);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const asked: string[] = [];
    expect(
      await fetchThemeCss("https://site.test/", {
        fetch: async (input) => {
          asked.push(input);
          return new Response(THEME, { status: 200 });
        },
      }),
    ).toBe(THEME);
    expect(asked).toEqual(["https://site.test/wp-content/themes/cwicly/style.css"]);
    expect(
      await fetchThemeCss("https://site.test", {
        fetch: async () => new Response("<html></html>", { status: 200 }),
      }),
    ).toBeNull();
    expect(
      await fetchThemeCss("https://site.test", {
        fetch: async () => new Response("", { status: 404 }),
      }),
    ).toBeNull();
  });
});

// ── Which features a set of blocks asks for ──────────────────────────────────────────────────────

describe("compatFeaturesForBlocks", () => {
  const blocks = (markup: string) => parseBlocks(markup);
  const featuresOf = (markup: string): CompatFeature[] =>
    [...compatFeaturesForBlocks(blocks(markup))].sort();

  test("each feature follows the attribute test the plugin's own render callback makes", () => {
    expect(featuresOf('<!-- wp:cwicly/image {"imageAnimation":"grow"} /-->')).toEqual([
      "hoverAnimation",
    ]);
    expect(featuresOf('<!-- wp:cwicly/image {"imageLightbox":true} /-->')).toEqual(["lightbox"]);
    expect(featuresOf("<!-- wp:cwicly/image /-->")).toEqual([]);
    expect(featuresOf('<!-- wp:cwicly/icon {"hoverAnimation":"pulse"} /-->')).toEqual([
      "hoverAnimation",
    ]);
    expect(featuresOf('<!-- wp:cwicly/navlink {"hoverAnimation":"pulse"} /-->')).toEqual([
      "hoverAnimation",
    ]);
    // button.php and query-template.php make the same tests as their siblings
    expect(featuresOf('<!-- wp:cwicly/button {"hoverAnimation":"cc-pop"} /-->')).toEqual([
      "hoverAnimation",
    ]);
    expect(featuresOf("<!-- wp:cwicly/button /-->")).toEqual([]);
    expect(featuresOf('<!-- wp:cwicly/query-template {"repeaterSlider":true} /-->')).toEqual([
      "splide",
    ]);
    expect(featuresOf("<!-- wp:cwicly/query-template /-->")).toEqual([]);
    expect(featuresOf("<!-- wp:cwicly/gallery /-->")).toEqual(["gallery"]);
    expect(featuresOf('<!-- wp:cwicly/gallery {"linkWrapperType":"lightbox"} /-->')).toEqual([
      "gallery",
      "lightbox",
    ]);
    expect(featuresOf("<!-- wp:cwicly/modal /-->")).toEqual(["modal"]);
    expect(featuresOf('<!-- wp:cwicly/query {"infiniteLoad":true} /-->')).toEqual(["loaders"]);
    expect(featuresOf("<!-- wp:cwicly/query /-->")).toEqual([]);
    expect(featuresOf("<!-- wp:cwicly/slider /-->")).toEqual(["swiper"]);
    expect(featuresOf('<!-- wp:cwicly/repeater {"repeaterSlider":true} /-->')).toEqual(["splide"]);
    expect(featuresOf('<!-- wp:cwicly/taxonomyterms {"repeaterSlider":true} /-->')).toEqual([
      "splide",
    ]);
    expect(featuresOf('<!-- wp:cwicly/div {"animateOnScrollType":"fade-in-up"} /-->')).toEqual([
      "aos",
    ]);
  });

  test("every optional stylesheet a live page linked is one its subjects' blocks ask for (both fixture sites)", async () => {
    let checked = 0;
    let loaded = 0;
    const byPath = new Map<string, string>(
      Object.entries(COMPAT_FEATURE_FILES).map(([feature, path]) => [path, feature]),
    );
    for (const name of ["fineline", "ap"] as SiteName[]) {
      const site = await loadSite(name);
      const dir = join(FIXTURES, name, "html");
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
        const html = readFileSync(join(dir, file), "utf8");
        // what the page linked from the plugin, as features
        const live = new Set<string>();
        for (const m of html.matchAll(/plugins\/cwicly\/(assets\/css\/[^?'"]+\.css)/g)) {
          const feature = byPath.get(m[1]!);
          if (feature !== undefined) live.add(feature);
        }
        // the blocks of every subject whose stylesheet the page linked: the page, its template and
        // parts, the components and the reusable blocks it renders
        const blocks = [];
        for (const m of html.matchAll(/uploads\/cwicly\/css\/cc-(post|tp|cm|rb)-([^?'"]+)\.css/g)) {
          const [, kind, id] = m;
          if (kind === "post")
            blocks.push(...subjectBlocks(site, { kind: "post", id: Number(id) }));
          if (kind === "cm") blocks.push(...subjectBlocks(site, { kind: "component", ref: id! }));
          if (kind === "rb")
            blocks.push(...subjectBlocks(site, { kind: "reusable", id: Number(id) }));
          if (kind === "tp") {
            const slug = id!.slice(site.model.site.theme.length + 1);
            blocks.push(
              ...subjectBlocks(site, { kind: "template", slug }),
              ...subjectBlocks(site, { kind: "part", slug }),
            );
          }
        }
        const asked = compatFeaturesForBlocks(blocks);
        for (const feature of live) {
          expect(asked.has(feature as CompatFeature)).toBe(true);
          loaded += 1;
        }
        // a block can ask for more than the page loaded (the comments part is only rendered where
        // comments are open), never for a stylesheet this module does not know
        for (const feature of asked) expect(feature in COMPAT_FEATURE_FILES).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBe(12);
    expect(loaded).toBeGreaterThan(8);
  });

  test("nested blocks count, and a page with none of them asks for nothing", () => {
    expect(
      featuresOf(
        "<!-- wp:cwicly/div --><!-- wp:cwicly/div --><!-- wp:cwicly/modal /--><!-- /wp:cwicly/div --><!-- /wp:cwicly/div -->",
      ),
    ).toEqual(["modal"]);
    expect(featuresOf("<!-- wp:paragraph --><p>hi</p><!-- /wp:paragraph -->")).toEqual([]);
  });
});

// ── Pruning ──────────────────────────────────────────────────────────────────────────────────────

describe("pruneUnusedClasses", () => {
  const used = (...names: string[]) => new Set(names);

  test("drops the rule whose every selector needs a class nothing carries, and keeps the rest byte for byte", () => {
    const css = ".a{color:red}.b{color:blue}.a .c{margin:0}";
    const out = pruneUnusedClasses(css, used("a", "c"));
    expect(out.css).toBe(".a{color:red}.a .c{margin:0}");
    expect(out.stats.rules).toBe(1);
    expect(out.stats.bytes).toBe(".b{color:blue}".length);
  });

  test("a selector list keeps the members that can match", () => {
    expect(pruneUnusedClasses(".a,.b,.c{x:y}", used("a", "c")).css).toBe(".a,.c{x:y}");
    expect(pruneUnusedClasses(".a,.b{x:y}", used("z")).css).toBe("");
  });

  test("every class of a compound is required, even a state class a script would add", () => {
    const css = ".nav.active{x:y}.nav{z:w}";
    expect(pruneUnusedClasses(css, used("nav")).css).toBe(".nav{z:w}");
    expect(pruneUnusedClasses(css, used("nav", "active")).css).toBe(css);
  });

  test("a class inside :not(), :is(), :where() or :has() is not required, so it never prunes", () => {
    const css = ".a:not(.gone){x:y}.a:is(.gone,.other){x:y}.a:where(.gone){x:y}.a:has(.gone){x:y}";
    expect(pruneUnusedClasses(css, used("a")).css).toBe(css);
  });

  test("a rule that names no class stays: attributes and tags are not evidence", () => {
    const css = "html{scroll-behavior:smooth}[data-aos|=fade]{opacity:0}video{max-width:100%}";
    expect(pruneUnusedClasses(css, used()).css).toBe(css);
  });

  test("a selector the parser cannot read is kept, because 'cannot match' has no evidence", () => {
    const css = ".a:{x:y}.b{x:y}";
    expect(pruneUnusedClasses(css, used("zzz")).css).toBe(".a:{x:y}");
  });

  test("text that is not CSS comes back untouched, with the reason, and the build ships it whole with a warning", () => {
    const broken = ".a{x:y";
    const out = pruneUnusedClasses(broken, used());
    expect(out.css).toBe(broken);
    expect(out.error).toMatch(/Unclosed block/);
    expect(out.stats).toEqual({ rules: 0, bytes: 0 });
    const report = createReport();
    const built = buildCompatCss(
      memoryPluginSource({ ...FILES, "build/style-index.css": broken }),
      {
        usedClasses: used("q"),
        report,
      },
    );
    expect(built.content).toContain(broken);
    expect(report.entries().map((e) => e.code)).toEqual(["design.compat-prune-failed"]);
  });

  test("rules inside @media and @supports are pruned in place and an emptied at-rule goes with them", () => {
    const css = "@media (max-width:992px){.a{x:y}.b{x:y}}@supports (display:grid){.b{x:y}}.a{z:w}";
    expect(pruneUnusedClasses(css, used("a")).css).toBe("@media (max-width:992px){.a{x:y}}.a{z:w}");
  });

  test("@keyframes stays exactly when a kept declaration names it", () => {
    const css =
      "@keyframes spin{to{transform:rotate(1turn)}}@keyframes gone{to{opacity:0}}.a{animation:spin 1s linear infinite}.b{animation:gone 1s}";
    const out = pruneUnusedClasses(css, used("a"));
    expect(out.css).toContain("@keyframes spin");
    expect(out.css).not.toContain("gone");
    expect(out.stats.rules).toBe(2);
    // animation-name is read too, and a prefixed at-rule is the same thing
    const named = pruneUnusedClasses(
      "@-webkit-keyframes k{to{opacity:0}}.a{animation-name:k}",
      used("a"),
    );
    expect(named.css).toContain("@-webkit-keyframes k");
  });

  test("buildCompatCss prunes every file it writes and reports what it left out", () => {
    const report = createReport();
    const out = buildCompatCss(
      memoryPluginSource({ ...FILES, "build/style-index.css": ".a{x:y}.b{x:y}" }),
      {
        usedClasses: used("a"),
        report,
      },
    );
    expect(out.content).toContain(".a{x:y}");
    expect(out.content).not.toContain(".b{x:y}");
    expect(out.pruned.rules).toBe(1);
    expect(report.entries().map((e) => e.code)).toEqual(["design.compat-pruned"]);
    expect(report.entries()[0]!.severity).toBe("info");
  });
});

// ── The real plugin files, against the live pages ────────────────────────────────────────────────

/**
 * The plugin copy a site runs lives outside this repository (the repository commits the pages and
 * the generated stylesheets, not the plugin). These tests read the checkouts next to it, or the
 * directories named by `WP2JX_PLUGIN_FINELINE`, `WP2JX_PLUGIN_AP` and `WP2JX_PLUGIN_REPO`, and are
 * skipped, loudly, where there is none.
 */
const DEV = resolve(import.meta.dir, "../../..");
const CHECKOUTS = {
  fineline: process.env.WP2JX_PLUGIN_FINELINE ?? join(DEV, "site-finelinepainting"),
  ap: process.env.WP2JX_PLUGIN_AP ?? join(DEV, "site-anabaptistperspectives"),
} as const;
const REPO = process.env.WP2JX_PLUGIN_REPO ?? join(DEV, "cwicly");
const have = (dir: string): boolean =>
  existsSync(join(dir, "wp-content/plugins/cwicly/build/style-index.css")) ||
  existsSync(join(dir, "build/style-index.css"));

type P5 = { nodeName: string; attrs?: { name: string; value: string }[]; childNodes?: P5[] };

interface LivePage {
  name: string;
  /** `plugins/cwicly/...` paths the page's stylesheet links name, without the query string. */
  pluginCss: string[];
  classes: Set<string>;
}

function livePages(site: "fineline" | "ap"): LivePage[] {
  const dir = join(FIXTURES, site, "html");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".html"))
    .sort()
    .map((file) => {
      const pluginCss: string[] = [];
      const classes = new Set<string>();
      const visit = (node: P5): void => {
        const attr = (name: string): string | undefined =>
          node.attrs?.find((a) => a.name === name)?.value;
        if (node.nodeName === "link" && attr("rel")?.includes("stylesheet")) {
          const match = /\/wp-content\/plugins\/cwicly\/([^?#]+\.css)/.exec(attr("href") ?? "");
          if (match) pluginCss.push(match[1]!);
        }
        for (const name of (attr("class") ?? "").split(/\s+/)) if (name) classes.add(name);
        for (const child of node.childNodes ?? []) visit(child);
      };
      visit(parse(readFileSync(join(dir, file), "utf8")) as unknown as P5);
      return { name: file, pluginCss, classes };
    });
}

/** Every class a stylesheet's selectors name, anywhere in them. */
function classesNamedBy(css: string): Set<string> {
  const names = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    selectorParser((root) => {
      root.walkClasses((node) => {
        names.add(node.value);
      });
    }).processSync(rule.selector);
  });
  return names;
}

for (const site of ["fineline", "ap"] as const) {
  const checkout = CHECKOUTS[site];
  const real = have(checkout);
  const suite = real ? describe : describe.skip;
  if (!real)
    console.warn(
      `compat-css: no Cwicly plugin copy at ${checkout}; the ${site} corpus tests are skipped`,
    );

  suite(`the real plugin files, ${site}`, () => {
    const source = dirPluginSource(checkout);
    const pages = livePages(site);

    test("the copy is the version the site runs, so nothing is reported", async () => {
      const { options } = await loadSite(site);
      const report = createReport();
      const out = buildCompatCss(source, { version: options.version, report });
      expect(options.version).toBe("1.4.7");
      expect(out.pluginVersion).toBe(options.version);
      expect(report.entries()).toEqual([]);
    });

    test("every live page loads base.css and style-index.css, and the others only by feature", () => {
      expect(pages).toHaveLength(6);
      const known = new Set<string>([...COMPAT_BASE_FILES, ...Object.values(COMPAT_FEATURE_FILES)]);
      const unsupported = new Set<string>();
      for (const page of pages) {
        expect(page.pluginCss).toContain("assets/css/base.css");
        expect(page.pluginCss).toContain("build/style-index.css");
        for (const path of page.pluginCss) if (!known.has(path)) unsupported.add(path);
      }
      // the only stylesheet a live page links that the compatibility file does not carry
      expect(
        [...unsupported].every((path) => /^assets\/js\/fr\/dist\/main-[\w-]+\.css$/.test(path)),
      ).toBe(true);
    });

    test("a compat file built for the features a page loaded carries every file it linked, verbatim", () => {
      const byFile = new Map<string, CompatFeature>(
        Object.entries(COMPAT_FEATURE_FILES).map(([f, p]) => [p, f as CompatFeature]),
      );
      for (const page of pages) {
        const wanted: Partial<Record<CompatFeature, boolean>> = {};
        for (const path of page.pluginCss) {
          const feature = byFile.get(path);
          if (feature !== undefined && feature !== "aos") wanted[feature] = true;
        }
        const out = buildCompatCss(source, wanted);
        for (const path of page.pluginCss) {
          if (!byFile.has(path) && !(COMPAT_BASE_FILES as readonly string[]).includes(path))
            continue;
          if (byFile.get(path) === "aos") continue;
          expect(out.content).toContain(source.get(path)!.trim());
        }
      }
    });

    test("the theme stylesheet every live page links is carried: body{position:relative}, the comment form, nothing else", () => {
      for (const page of pages) {
        const html = readFileSync(join(FIXTURES, site, "html", page.name), "utf8");
        expect(html).toContain("/wp-content/themes/cwicly/style.css");
      }
      const theme = dirThemeCss(checkout);
      expect(theme).not.toBeNull();
      const out = buildCompatCss(source, { theme });
      const root = postcss.parse(out.content);
      let found: Record<string, string> | undefined;
      root.walkRules((rule) => {
        if (rule.selector === "body" && rule.toString().includes("position")) {
          found = {};
          rule.walkDecls((decl) => {
            found![decl.prop] = decl.value;
          });
        }
      });
      expect(found).toEqual({ position: "relative" });
      expect(out.content).toContain(".cc-comments h3#comments");
      expect(out.files.at(-1)!.path).toBe(COMPAT_THEME_PATH);
      // and it is the last thing in the file, as the live page links it after every plugin file
      expect(out.content.lastIndexOf(".cc-comments")).toBeGreaterThan(
        out.content.lastIndexOf(".cc-nav"),
      );
    });

    test("it has the rules the live pages' structural classes need", () => {
      const out = buildCompatCss(source);
      const root = postcss.parse(out.content);
      const declarationsOf = (selector: string): Record<string, string> => {
        const found: Record<string, string> = {};
        root.walkRules((rule) => {
          if (rule.parent?.type !== "root" || rule.selector.replace(/\s+/g, "") !== selector)
            return;
          rule.walkDecls((decl) => {
            found[decl.prop] = decl.value;
          });
        });
        return found;
      };
      expect(declarationsOf(".cc-cntr,.cc-sct")).toEqual({ width: "100%" });
      expect(declarationsOf(".cc-cntr")).toMatchObject({
        "margin-left": "auto",
        "margin-right": "auto",
        "max-width": "1366px",
      });
      expect(declarationsOf("*,::after,::before")).toEqual({ "box-sizing": "border-box" });
      expect(declarationsOf("body")).toEqual({ margin: "0" });
      expect(declarationsOf("a")).toMatchObject({ "text-decoration": "none", color: "inherit" });
      // every rule of the navigation, the hamburger and the menu is there
      const sourceRules = postcss.parse(source.get("build/style-index.css")!);
      const countFor = (css: postcss.Root, pattern: RegExp): number => {
        let n = 0;
        css.walkRules((rule) => {
          if (pattern.test(rule.selector)) n += 1;
        });
        return n;
      };
      for (const pattern of [/\.cc-nav/, /\.cc-hamburger/, /\.cc-menu/]) {
        expect(countFor(root, pattern)).toBe(countFor(sourceRules, pattern));
        expect(countFor(root, pattern)).toBeGreaterThan(5);
      }
    });

    test("every cc- class the live pages carry that the plugin styles is styled in the file", () => {
      const out = buildCompatCss(source);
      const styled = classesNamedBy(out.content);
      const styledByPlugin = classesNamedBy(source.get("build/style-index.css")!);
      const used = new Set<string>();
      for (const page of pages)
        for (const name of page.classes) if (name.startsWith("cc-")) used.add(name);
      const needed = [...used].filter((name) => styledByPlugin.has(name));
      expect(needed.length).toBeGreaterThan(3);
      for (const name of needed) expect(styled.has(name)).toBe(true);
    });

    test("pruned to the classes the live pages carry, it keeps every rule those pages' classes can match", () => {
      const used = new Set<string>();
      for (const page of pages) for (const name of page.classes) used.add(name);
      const full = buildCompatCss(source);
      const pruned = buildCompatCss(source, { usedClasses: used });
      expect(pruned.content.length).toBeLessThan(full.content.length);
      expect(pruned.pruned.rules).toBeGreaterThan(20);
      // an independent reading of "can match": every class token a member names is in the set
      const classTokens = (selector: string): string[] =>
        [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
      const kept = new Set<string>();
      postcss.parse(pruned.content).walkRules((rule) => {
        for (const member of postcss.list.comma(rule.selector)) kept.add(member.trim());
      });
      let checked = 0;
      postcss.parse(full.content).walkRules((rule) => {
        // a keyframe stop (`0%`, `to`) is not a selector
        if (
          rule.parent?.type === "atrule" &&
          /keyframes$/i.test((rule.parent as postcss.AtRule).name)
        )
          return;
        for (const member of postcss.list.comma(rule.selector)) {
          // `:not(.x)` and friends are not requirements: only judge selectors without them
          if (/:(not|is|where|has|matches)\(/.test(member)) continue;
          const survives = classTokens(member).every((name) => used.has(name));
          if (survives) {
            checked += 1;
            expect(kept.has(member.trim())).toBe(true);
          } else {
            expect(kept.has(member.trim())).toBe(false);
          }
        }
      });
      expect(checked).toBeGreaterThan(50);
    });
  });
}

const repoReal = have(REPO) && have(CHECKOUTS.fineline);
(repoReal ? describe : describe.skip)("the Cwicly repository as a source", () => {
  test("its 1.6.0 files are the 1.4.7 files for everything the compat file uses, and the mismatch is reported", () => {
    const repo = dirPluginSource(REPO);
    const checkout = dirPluginSource(CHECKOUTS.fineline);
    const all = Object.fromEntries(
      Object.keys(COMPAT_FEATURE_FILES).map((k) => [k, true]),
    ) as Record<CompatFeature, boolean>;
    const report = createReport();
    const fromRepo = buildCompatCss(repo, { ...all, aos: false, version: "1.4.7", report });
    const fromCheckout = buildCompatCss(checkout, { ...all, aos: false });
    expect(fromRepo.files).toEqual(fromCheckout.files);
    const strip = (text: string): string =>
      text.replace(/^\/\* (.+?) \(Cwicly [\d.]+\) \*\//gm, "/* $1 */");
    expect(strip(fromRepo.content)).toBe(strip(fromCheckout.content));
    expect(fromRepo.pluginVersion).not.toBe("1.4.7");
    expect(report.entries().map((e) => e.code)).toEqual(["design.plugin-version"]);
  });
});
