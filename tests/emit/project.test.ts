/**
 * Project assembly against the two real fixture sites: `migrateSite` writes a Jx project that
 * `jx schema`, `jx validate` and `jx build` accept, a second run is byte-identical and touches
 * nothing, a run that no longer produces a file removes it only when it is this tool's and unedited,
 * a dry run fetches nothing, and nothing a database URL held reaches a file.
 *
 * The units (paths, sinks, secrets, the merged report, the style order, the owner's decisions) are
 * checked on their own first, with hand-made inputs where a fixture has no case for them.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  checkProjectPath,
  checkReferences,
  composeStyle,
  entryHeadingRules,
  EVERY_WIDTH,
  layerAfterMedia,
  themeSupportsResponsiveEmbeds,
  withoutSupersededPages,
  supersededFiles,
  liftMediaBlocks,
  CORE_CSS_PATH,
  CURRENT_PAGE_JS_PATH,
  dbSecrets,
  diskSink,
  fontFile,
  GITIGNORE,
  HEAVY_IMAGE_COUNT,
  imageSettings,
  MANIFEST_PATH,
  memorySink,
  mergeReports,
  migrateSite,
  projectPackageJson,
  naturalCompare,
  ownerDecisions,
  redactDbUrl,
  readSiteUrl,
  redactEntry,
  redactText,
  redirectDestination,
  renderDecisions,
  renderProjectReport,
  REPORT_JSON_PATH,
  REPORT_MD_PATH,
  settleUnresolved,
  STRUCTURAL_POST_TYPES,
  type MigrateOptions,
  type MigrationResult,
  type ProjectSink,
} from "../../src/emit/project.ts";
import { pilotForms } from "../helpers/fluentform-db.ts";
import { CURRENT_PAGE_SCRIPT } from "../../src/emit/menus.ts";
import {
  BUILD_MS_PER_MEDIA_FILE,
  buildTimeoutFor,
  MIN_BUILD_TIMEOUT_MS,
  type JxOptions,
} from "../../src/jx.ts";
import { createReport } from "../../src/report.ts";
import { loadSiteContext } from "../../src/site.ts";
import type { ReportEntry } from "../../src/types.ts";
import { openDb } from "../../src/wp/db.ts";
import { DEFAULT_EXCLUDED_POST_TYPES } from "../../src/wp/model.ts";
import { fixtureCssDir } from "../helpers/fixture-css.ts";
import { fixtureDb } from "../helpers/fixture-db.ts";
import { TMP_ROOT } from "../helpers/jx-build.ts";

setDefaultTimeout(280_000);

const DEV = join(import.meta.dir, "../../..");
const CWICLY = process.env.WP2JX_CWICLY ?? join(DEV, "cwicly");
const WP_TREE = process.env.WP2JX_WP_TREE ?? join(DEV, "site-finelinepainting");
const HAVE_PLUGIN = existsSync(join(CWICLY, "build/style-index.css"));
const HAVE_WP = existsSync(join(WP_TREE, "wp-includes/blocks"));
const NOW = new Date("2026-10-05T12:00:00Z");

const scratch: string[] = [];
function tmp(name: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, `${name}-`));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const sha = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Every file under `dir` (relative, forward slashes), `dist/` left out. */
function listFiles(root: string, dir = root, skipDist = true): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDist && dir === root && entry.name === "dist") continue;
      out.push(...listFiles(root, path, skipDist));
    } else out.push(relative(root, path).split("\\").join("/"));
  }
  return out.sort();
}

// ── Paths ────────────────────────────────────────────────────────────────────────────────────────

describe("checkProjectPath", () => {
  test("accepts a project-relative path with forward slashes", () => {
    expect(checkProjectPath("pages/about-us.json")).toBe("pages/about-us.json");
    expect(checkProjectPath("content/post/2024/03/hello.md")).toBe("content/post/2024/03/hello.md");
    expect(checkProjectPath(".gitignore")).toBe(".gitignore");
  });

  test.each([
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["C:/x", "absolute"],
    ["../x", "leaves"],
    ["a/../../x", "leaves"],
    ["a/./b", "normalised"],
    ["a//b", "normalised"],
    ["a/", "normalised"],
    ["a\\b", "backslash"],
    ["a\0b", "NUL"],
  ])("refuses %p", (path) => {
    expect(() => checkProjectPath(path)).toThrow("refusing to write");
  });
});

// ── Sinks ────────────────────────────────────────────────────────────────────────────────────────

describe("diskSink", () => {
  test("writes bytes exactly, creates the directories, and leaves no temporary file behind", async () => {
    const root = tmp("sink");
    const sink = diskSink(join(root, "out"));
    const bytes = new Uint8Array([0, 255, 1, 128, 10, 13]);
    await sink.write("a/b/c.bin", bytes);
    await sink.write("a/text.txt", "héllo\n");
    expect([...readFileSync(join(root, "out/a/b/c.bin"))]).toEqual([...bytes]);
    expect(readFileSync(join(root, "out/a/text.txt"), "utf8")).toBe("héllo\n");
    expect(listFiles(join(root, "out")).filter((f) => f.includes("wp2jx-tmp"))).toEqual([]);
    expect(listFiles(join(root, "out"))).toEqual(["a/b/c.bin", "a/text.txt"]);
  });

  test("a write replaces the file whole: a reader never sees half of one (temp file, then rename)", async () => {
    const root = tmp("sink");
    const sink = diskSink(root);
    await sink.write("f.txt", "old");
    const before = lstatSync(join(root, "f.txt")).ino;
    await sink.write("f.txt", "new content");
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("new content");
    // A rename puts a new inode in place; an in-place write would keep the old one.
    expect(lstatSync(join(root, "f.txt")).ino).not.toBe(before);
  });

  test("a failed write removes its temporary file and keeps the old one", async () => {
    const root = tmp("sink");
    const sink = diskSink(root);
    await sink.write("f.txt", "old");
    // A directory where the file should go makes the rename fail.
    mkdirSync(join(root, "d"));
    await expect(sink.write("d", "x")).rejects.toThrow();
    expect(listFiles(root).filter((f) => f.includes("wp2jx-tmp"))).toEqual([]);
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("old");
  });

  test("refuses a path that would leave the directory, however it is written", async () => {
    const root = tmp("sink");
    const sink = diskSink(join(root, "out"));
    for (const path of ["../escape.txt", "/tmp/escape.txt", "a/../../escape.txt", "a\\..\\x"]) {
      await expect(sink.write(path, "x")).rejects.toThrow("refusing to write");
    }
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
  });

  test("refuses a write through a symlink that leads out of the directory", async () => {
    const root = tmp("sink");
    const outside = join(root, "outside");
    mkdirSync(outside);
    const out = join(root, "out");
    mkdirSync(out);
    symlinkSync(outside, join(out, "link"));
    const sink = diskSink(out);
    await expect(sink.write("link/stolen.txt", "x")).rejects.toThrow("outside");
    expect(existsSync(join(outside, "stolen.txt"))).toBe(false);
    // A symlink that stays inside is fine.
    mkdirSync(join(out, "real"));
    symlinkSync(join(out, "real"), join(out, "inside"));
    await sink.write("inside/ok.txt", "x");
    expect(readFileSync(join(out, "real/ok.txt"), "utf8")).toBe("x");
  });

  test("read, exists and remove: absent is undefined/false, remove prunes the empty directories up to the root", async () => {
    const root = tmp("sink");
    const sink = diskSink(root);
    expect(await sink.read!("nope.txt")).toBeUndefined();
    expect(await sink.exists!("nope.txt")).toBe(false);
    await sink.write("a/b/c.txt", "hi");
    expect(new TextDecoder().decode((await sink.read!("a/b/c.txt"))!)).toBe("hi");
    expect(await sink.exists!("a/b/c.txt")).toBe(true);
    expect(await sink.exists!("a/b")).toBe(false);
    await sink.write("a/keep.txt", "k");
    await sink.remove!("a/b/c.txt");
    expect(existsSync(join(root, "a/b"))).toBe(false);
    expect(existsSync(join(root, "a/keep.txt"))).toBe(true);
    await sink.remove!("a/keep.txt");
    expect(existsSync(join(root, "a"))).toBe(false);
    expect(existsSync(root)).toBe(true);
    await sink.remove!("never/was.txt");
  });

  test("the sink refuses to read or remove outside the directory too", async () => {
    const root = tmp("sink");
    const sink = diskSink(join(root, "out"));
    writeFileSync(join(root, "secret.txt"), "s");
    await expect(sink.read!("../secret.txt")).rejects.toThrow("refusing");
    await expect(sink.remove!("../secret.txt")).rejects.toThrow("refusing");
    expect(existsSync(join(root, "secret.txt"))).toBe(true);
  });
});

describe("memorySink", () => {
  test("holds what is written, checks the path, and answers read, exists and remove", async () => {
    const sink = memorySink();
    await sink.write("a/b.txt", "x");
    expect(sink.files.get("a/b.txt")).toBe("x");
    await expect(sink.write("../x", "y")).rejects.toThrow("refusing");
    expect(new TextDecoder().decode((await sink.read!("a/b.txt"))!)).toBe("x");
    expect(await sink.exists!("a/b.txt")).toBe(true);
    await sink.remove!("a/b.txt");
    expect(await sink.exists!("a/b.txt")).toBe(false);
    expect(await sink.read!("a/b.txt")).toBeUndefined();
  });
});

// ── Order and secrets ────────────────────────────────────────────────────────────────────────────

describe("naturalCompare", () => {
  test("numbers compare as numbers, text as text, with no locale in it", () => {
    const sorted = ["post:10", "post:9", "post:100", "page:1", "post:2", "template:cwicly//a"].sort(
      naturalCompare,
    );
    expect(sorted).toEqual([
      "page:1",
      "post:2",
      "post:9",
      "post:10",
      "post:100",
      "template:cwicly//a",
    ]);
    expect(naturalCompare("a", "a")).toBe(0);
    expect(naturalCompare("a1", "a01")).toBe(0);
    expect(naturalCompare("a", "a1")).toBeLessThan(0);
    expect(naturalCompare("Z", "a")).toBeLessThan(0);
  });
});

describe("secrets", () => {
  test("the password of a database URL, however it is written, is found and masked", () => {
    expect(dbSecrets("mysql://root:s3cr3t@127.0.0.1:3399/wp")).toEqual(["s3cr3t"]);
    expect(dbSecrets("mysql://root:p%40ss%2Fw@host/wp")).toEqual(["p%40ss%2Fw", "p@ss/w"]);
    expect(dbSecrets("mysql://root@127.0.0.1:3399/wp")).toEqual([]);
    expect(dbSecrets("sqlite:/tmp/x.sqlite")).toEqual([]);
    expect(dbSecrets("mysql://u@h/wp?password=hunter22&x=1")).toEqual(["hunter22"]);
    expect(redactDbUrl("mysql://root:s3cr3t@127.0.0.1:3399/wp")).toBe(
      "mysql://root:***@127.0.0.1:3399/wp",
    );
    expect(redactDbUrl("mysql://u@h/wp?password=hunter22&x=1")).toBe(
      "mysql://u@h/wp?password=***&x=1",
    );
    expect(redactDbUrl("sqlite:/tmp/x.sqlite")).toBe("sqlite:/tmp/x.sqlite");
  });

  test("redactText replaces every occurrence, and leaves a too-short secret alone (it would mask ordinary text)", () => {
    expect(redactText("a s3cr3t b s3cr3t", ["s3cr3t"])).toBe("a *** b ***");
    expect(redactText("ab", ["ab"])).toBe("ab");
  });
});

// ── The merged report ────────────────────────────────────────────────────────────────────────────

const e = (over: Partial<ReportEntry> & { code: string }): ReportEntry => ({
  severity: "warn",
  message: "m",
  ...over,
});

describe("mergeReports", () => {
  test("severity first, then code, then location in natural order, then address, message and data", () => {
    const merged = mergeReports([
      [
        e({ code: "b.code", where: "post:10" }),
        e({ code: "b.code", where: "post:9" }),
        e({ code: "a.code", severity: "info", where: "post:1" }),
        e({ code: "z.code", severity: "error" }),
        e({ code: "b.code", where: "post:9", url: "https://x/2" }),
        e({ code: "b.code", where: "post:9", url: "https://x/1" }),
        e({ code: "b.code", where: "post:9", message: "a" }),
      ],
    ]);
    expect(
      merged.map((x) => `${x.severity}|${x.code}|${x.where ?? "-"}|${x.url ?? ""}|${x.message}`),
    ).toEqual([
      "error|z.code|-||m",
      "warn|b.code|post:9||a",
      "warn|b.code|post:9||m",
      "warn|b.code|post:9|https://x/1|m",
      "warn|b.code|post:9|https://x/2|m",
      "warn|b.code|post:10||m",
      "info|a.code|post:1||m",
    ]);
  });

  test("within a severity the codes go alphabetically, whatever the locations say", () => {
    const merged = mergeReports([
      [
        e({ code: "b.code", where: "post:1" }),
        e({ code: "a.code", where: "post:2" }),
        e({ code: "a.code", where: "post:1" }),
      ],
    ]);
    expect(merged.map((x) => `${x.code} ${x.where}`)).toEqual([
      "a.code post:1",
      "a.code post:2",
      "b.code post:1",
    ]);
  });

  test("the same finding reached through two modules is one entry; the same code at two places is two", () => {
    const one = e({ code: "x.y", where: "post:1", data: { a: 1, nested: { b: [1, 2] } } });
    const report = createReport();
    report.add(one);
    const merged = mergeReports([report, [{ ...one }, e({ code: "x.y", where: "post:2" })]]);
    expect(merged).toHaveLength(2);
    // Different data is a different finding.
    expect(mergeReports([[one, { ...one, data: { a: 2 } }]])).toHaveLength(2);
  });

  test("the order does not depend on which module reported first", () => {
    const entries = [
      e({ code: "a", where: "post:3" }),
      e({ code: "a", where: "post:1" }),
      e({ code: "b", severity: "error", where: "post:2" }),
      e({ code: "c", severity: "info" }),
    ];
    expect(mergeReports([entries])).toEqual(mergeReports([[...entries].reverse()]));
    expect(mergeReports([entries.slice(0, 2), entries.slice(2)])).toEqual(
      mergeReports([entries.slice(2), entries.slice(0, 2)]),
    );
  });

  test("a secret is masked in the message, the location, the address and the data, at any depth", () => {
    const merged = mergeReports(
      [
        [
          e({
            code: "site.db",
            message: "cannot open mysql://root:s3cr3t@h/db",
            where: "db:s3cr3t",
            url: "https://x/?k=s3cr3t",
            data: { list: ["s3cr3t", { deep: "x s3cr3t y" }], n: 3 },
          }),
        ],
      ],
      ["s3cr3t"],
    );
    expect(JSON.stringify(merged)).not.toContain("s3cr3t");
    expect(merged[0]!.data).toEqual({ list: ["***", { deep: "x *** y" }], n: 3 });
  });

  test("data a JSON dump cannot hold (a bigint, a Map, a cycle) does not break the merge", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const merged = mergeReports([
      [e({ code: "a", data: { big: 10n ** 20n, map: new Map([["k", 1]]), cyc } })],
    ]);
    expect(merged).toHaveLength(1);
  });
});

// ── The style ────────────────────────────────────────────────────────────────────────────────────

describe("composeStyle", () => {
  test("layers go after the base, in order, and a selector the base has gets the later declarations", () => {
    const base = {
      "--a": "1",
      body: { color: "red" },
      ".x": { color: "red", margin: "0" },
    } as never;
    const { style, merged } = composeStyle(base, [
      {
        custom: { "--a": "2", "--b": "3" },
        style: { ".x": { color: "blue", padding: "1px" }, ".y": { top: 0 } } as never,
      },
      {
        rules: [
          { selector: ".y", style: { top: "1px" } as never },
          { selector: " .z ", style: { left: 0 } as never },
        ],
      },
    ]);
    expect(Object.keys(style)).toEqual(["--a", "body", ".x", "--b", ".y", ".z"]);
    // A custom property the base has is not replaced; a new one is added.
    expect(style["--a"]).toBe("1");
    expect(style["--b"]).toBe("3");
    // Later declarations win in place, earlier ones that are not touched stay.
    expect(style[".x"]).toEqual({ margin: "0", color: "blue", padding: "1px" });
    expect(style[".y"]).toEqual({ top: "1px" });
    expect(merged).toEqual([".x", ".y"]);
  });

  test("identical content is not a merge, the base is not modified, a nested block merges, a replacing at-rule is replaced", () => {
    const base = {
      ".a": { color: "red", ":hover": { color: "blue" } },
      "@keyframes spin": { from: { opacity: 0 } },
    } as never;
    const copy = JSON.stringify(base);
    const { style, merged } = composeStyle(base, [
      { style: { ".a": { color: "red", ":hover": { color: "blue" } } } as never },
      {
        rules: [
          { selector: ".a", style: { ":hover": { top: 0 } } as never },
          { selector: "@keyframes spin", style: { from: { opacity: 1 } } as never },
        ],
      },
    ]);
    expect(JSON.stringify(base)).toBe(copy);
    expect(style[".a"]).toEqual({ color: "red", ":hover": { color: "blue", top: 0 } });
    expect(style["@keyframes spin"]).toEqual({ from: { opacity: 1 } });
    expect(merged).toEqual([".a", "@keyframes spin"]);
  });

  test("a later declaration moves to the end of its rule, because a shorthand after a longhand overrides it", () => {
    const { style } = composeStyle({ ".a": { marginTop: "1px", color: "red" } } as never, [
      {
        rules: [
          { selector: ".a", style: { margin: "0" } as never },
          { selector: ".a", style: { marginTop: "2px" } as never },
        ],
      },
    ]);
    expect(Object.keys(style[".a"] as object)).toEqual(["color", "margin", "marginTop"]);
  });
});

describe("supersededFiles", () => {
  const pages = [
    { route: "/about/", file: "pages/about.json" },
    { route: "/", file: "pages/index.json" },
  ];
  const entries = [
    { route: "/hardwood", file: "content/post/hardwood.md" },
    { route: "/project/barn/", file: "content/project/barn.md" },
  ];

  test("names the file of every page and entry at an address a rule answers, however the address is written", () => {
    expect(
      [...supersededFiles(["/about", "/hardwood/", "/nowhere"], pages, entries)].sort(),
    ).toEqual(["content/post/hardwood.md", "pages/about.json"]);
    expect(supersededFiles([], pages, entries).size).toBe(0);
    expect([...supersededFiles(["/project/barn"], pages, entries)]).toEqual([
      "content/project/barn.md",
    ]);
  });
});

describe("withoutSupersededPages", () => {
  test("a page at the address of a redirect is not written; the others, and an entry's address, are", () => {
    const pages = {
      files: [{ path: "pages/about.json" }, { path: "pages/index.json" }],
      pages: [
        { route: "/about/", file: "pages/about.json" },
        { route: "/", file: "pages/index.json" },
      ],
    };
    withoutSupersededPages(["/about", "/hardwood-floor-refinishing"], pages);
    expect(pages.files).toEqual([{ path: "pages/index.json" }]);
    expect(pages.pages).toEqual([{ route: "/", file: "pages/index.json" }]);
    withoutSupersededPages([], pages);
    expect(pages.pages).toHaveLength(1);
  });
});

describe("entryHeadingRules", () => {
  // The keys and values the pilot's core CSS gave (`.has-background:is(h1):where(.wp-block-heading)` and the five after it).
  const heading = [1, 2, 3, 4, 5, 6]
    .map((n) => `.has-background:is(h${n}):where(.wp-block-heading)`)
    .join(", ");
  const core = {
    ":where(.wp-block-columns.has-background)": { padding: "1.25em 2.375em" },
    [heading]: { padding: "1.25em 2.375em" },
    ".wp-block-embed iframe": { maxWidth: "100%" },
  };
  const entry = (content: string) => ({ content });

  test("an entry that holds a heading with a background gets the library's padding once more, one class stronger", () => {
    const rules = entryHeadingRules(core, [
      entry(
        '::::h2{className="wp-block-heading has-cc-color-1-background-color has-background"}\nTitle\n:::',
      ),
    ]);
    expect(rules).toEqual([
      {
        selector: [1, 2, 3, 4, 5, 6]
          .map((n) => `:root .has-background:is(h${n}):where(.wp-block-heading)`)
          .join(", "),
        style: { padding: "1.25em 2.375em" },
      },
    ]);
  });

  test("nothing without such a heading (a list or a plain heading with the class is not one), without core CSS, or for a rule with only a media block", () => {
    expect(
      entryHeadingRules(core, [
        entry(':::h3{className="wp-block-heading"}\nPlain\n:::'),
        // a class that only contains the word is not the class
        entry(':::h2{className="wp-block-heading nothas-background has-background-dim"}\nX\n:::'),
        entry(':::p{className="has-background"}\nA paragraph\n:::'),
        entry('a `:::h2{className="has-background"}` in a sentence'),
      ]),
    ).toEqual([]);
    expect(entryHeadingRules(undefined, [entry(':::h2{className="has-background"}')])).toEqual([]);
    expect(
      entryHeadingRules({ [heading]: { "@--sm": { padding: "1em" } } }, [
        entry(':::h2{className="has-background"}'),
      ]),
    ).toEqual([]);
  });
});

describe("themeSupportsResponsiveEmbeds", () => {
  test("the pilot's theme asks for responsive embeds, which is why its pages' body carries wp-embed-responsive", () => {
    if (!HAVE_WP) return;
    expect(themeSupportsResponsiveEmbeds(WP_TREE, "cwicly")).toBe(true);
  });

  test("a theme without the call, one that is not there, a live address and no root say no", () => {
    const root = tmp("theme-support");
    mkdirSync(join(root, "wp-content/themes/plain"), { recursive: true });
    writeFileSync(
      join(root, "wp-content/themes/plain/functions.php"),
      "<?php add_theme_support('post-thumbnails'); // 'responsive-embeds' in a comment\n",
    );
    mkdirSync(join(root, "wp-content/themes/spaced"), { recursive: true });
    writeFileSync(
      join(root, "wp-content/themes/spaced/functions.php"),
      '<?php add_theme_support( "responsive-embeds" );\n',
    );
    expect(themeSupportsResponsiveEmbeds(root, "plain")).toBe(false);
    expect(themeSupportsResponsiveEmbeds(root, "spaced")).toBe(true);
    expect(themeSupportsResponsiveEmbeds(root, "missing")).toBe(false);
    expect(themeSupportsResponsiveEmbeds(root, "")).toBe(false);
    expect(themeSupportsResponsiveEmbeds(root, undefined)).toBe(false);
    expect(themeSupportsResponsiveEmbeds("https://finelinepainting.pro", "cwicly")).toBe(false);
    expect(themeSupportsResponsiveEmbeds(undefined, "cwicly")).toBe(false);
  });
});

describe("layerAfterMedia", () => {
  const MEDIA = { "--": "1366px", "--md": "(max-width: 992px)", "--sm": "(max-width: 576px)" };
  // The pilot's gallery: the global class says two columns below 992px, the post says three at every width.
  const design = {
    ".gallery-default .cc-gallery": { gridTemplateColumns: "repeat(3, 1fr)" },
    "@--md": { ".gallery-default .cc-gallery": { gridTemplateColumns: "repeat(2, 1fr)" } },
    "@--sm": { ".gallery-default figure": { height: "8rem" } },
  } as never;

  test("a post's rule comes after every conditional block of the design system, and its media blocks after it", () => {
    const out = layerAfterMedia(
      design,
      {
        ".gallery-c1 .cc-gallery": {
          gridTemplateColumns: "repeat(3, 1fr)",
          "@--sm": { gridTemplateColumns: "repeat(1, 1fr)" },
        },
        ".other": { color: "red", "@--md": { color: "blue" } },
      } as never,
      MEDIA,
    ) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual([
      ".gallery-default .cc-gallery",
      "@--md",
      "@--sm",
      "@(min-width: 0px)",
      "@(max-width: 992px)",
      "@(max-width: 576px)",
    ]);
    expect(out["@(min-width: 0px)"]).toEqual({
      ".gallery-c1 .cc-gallery": { gridTemplateColumns: "repeat(3, 1fr)" },
      ".other": { color: "red" },
    });
    expect(out["@(max-width: 992px)"]).toEqual({ ".other": { color: "blue" } });
    expect(out["@(max-width: 576px)"]).toEqual({
      ".gallery-c1 .cc-gallery": { gridTemplateColumns: "repeat(1, 1fr)" },
    });
    // the design system's own blocks are untouched
    expect(out["@--md"]).toEqual({
      ".gallery-default .cc-gallery": { gridTemplateColumns: "repeat(2, 1fr)" },
    });
  });

  test("a rule that has nothing but a media block has no base, and a style with no rules is the same style", () => {
    const out = layerAfterMedia(
      design,
      { ".a": { "@--md": { color: "red" } } } as never,
      MEDIA,
    ) as Record<string, unknown>;
    expect(out["@(min-width: 0px)"]).toBeUndefined();
    expect(out["@(max-width: 992px)"]).toEqual({ ".a": { color: "red" } });
    expect(layerAfterMedia(design, {} as never, MEDIA)).toEqual(design);
  });

  test("an at-rule among the rules, and a media name with no parenthesised query, stay where they were", () => {
    const out = layerAfterMedia(
      design,
      {
        "@font-face": { fontFamily: "x" },
        ".a": { color: "red", "@--": { color: "blue" } },
      } as never,
      MEDIA,
    ) as Record<string, unknown>;
    expect(out["@font-face"]).toEqual({ fontFamily: "x" });
    expect(out["@(min-width: 0px)"]).toEqual({ ".a": { color: "red", "@--": { color: "blue" } } });
  });
});

describe("liftMediaBlocks", () => {
  const MEDIA = ["--", "--md", "--sm"];

  test("a selector's media block moves to the project's block of that name, which follows the wider one", () => {
    const style = {
      ".gallery-default .cc-gallery": { display: "grid" },
      ".gallery-c1": {
        gap: "10px",
        "@--sm": { gridTemplateColumns: "repeat(3, 1fr)" },
        "@--md": { gap: "5px" },
      },
      "@--md": { ".gallery-default .cc-gallery": { gridTemplateColumns: "repeat(2, 1fr)" } },
      "@--sm": { ".other": { color: "red" } },
      "@supports (height: 100dvh)": { body: { minHeight: "100dvh" } },
    } as never;
    const copy = JSON.stringify(style);
    const lifted = liftMediaBlocks(style, MEDIA) as Record<string, unknown>;
    expect(JSON.stringify(style)).toBe(copy);
    expect(lifted[".gallery-c1"]).toEqual({ gap: "10px" });
    expect(lifted["@--md"]).toEqual({
      ".gallery-default .cc-gallery": { gridTemplateColumns: "repeat(2, 1fr)" },
      ".gallery-c1": { gap: "5px" },
    });
    expect(lifted["@--sm"]).toEqual({
      ".other": { color: "red" },
      ".gallery-c1": { gridTemplateColumns: "repeat(3, 1fr)" },
    });
    // Narrow after wide, wherever each was written, and the other at-rules where they were.
    const keys = Object.keys(lifted);
    expect(keys.indexOf("@--md")).toBeLessThan(keys.indexOf("@--sm"));
    expect(keys).toContain("@supports (height: 100dvh)");
  });

  test("a selector that held nothing but media blocks has no rule of its own left, and one block merges with another", () => {
    const lifted = liftMediaBlocks(
      {
        ".a": { "@--sm": { color: "red" } },
        ".b": { color: "blue", "@--sm": { color: "green" } },
        "@--sm": { ".a": { margin: "0" } },
      } as never,
      MEDIA,
    ) as Record<string, unknown>;
    expect(lifted[".a"]).toBeUndefined();
    expect(lifted[".b"]).toEqual({ color: "blue" });
    expect(lifted["@--sm"]).toEqual({
      ".a": { margin: "0", color: "red" },
      ".b": { color: "green" },
    });
  });

  test("a style with no media blocks is the same style", () => {
    const style = { ".a": { color: "red" }, "--x": "1", body: { margin: 0 } } as never;
    expect(liftMediaBlocks(style, MEDIA)).toEqual(style);
    expect(Object.keys(liftMediaBlocks(style, MEDIA))).toEqual(Object.keys(style));
  });
});

// ── What the site owner decides ──────────────────────────────────────────────────────────────────

describe("ownerDecisions", () => {
  const entries: ReportEntry[] = [
    e({
      code: "collection.unrouted",
      where: "collection:grw_feed",
      data: { type: "grw_feed", count: 6 },
    }),
    e({
      code: "route.unregistered",
      where: "post-type:grw_feed",
      data: { type: "grw_feed", count: 6 },
    }),
    e({ code: "route.unregistered", where: "post-type:igmap", data: { type: "igmap", count: 1 } }),
    e({
      code: "collection.excluded",
      severity: "info",
      where: "collection:project",
      data: { type: "project", status: "draft", count: 7 },
    }),
    e({
      code: "page.unpublished",
      severity: "info",
      where: "site",
      data: { status: "draft", ids: [1, 2, 3] },
    }),
    e({ code: "collection.protected", where: "post:5", data: { type: "service" } }),
    e({
      code: "condition.dropped",
      where: "template:a//t",
      data: { token: "functionreturn === pa" },
    }),
    e({
      code: "page.placeholder-neutral",
      where: "post:195",
      data: { kind: "shortcode", shortcode: "trustindex" },
    }),
    e({
      code: "block.shortcode",
      where: "post:195",
      data: { block: "core/shortcode", shortcode: "trustindex" },
    }),
    e({ code: "block.unsupported", where: "post:1013", data: { block: "fluentfom/guten-block" } }),
    e({
      code: "page.placeholder-neutral",
      where: "post:1013",
      data: { kind: "block", block: "fluentfom/guten-block" },
    }),
    e({
      code: "entry.placeholder-dropped",
      where: "post:4084",
      data: { tag: "wp2jx-block", blocks: ["icb/image-compare", "x/y"] },
    }),
    e({
      code: "url.unresolved",
      where: "post:1",
      url: "https://s/a/",
      data: { url: "https://s/a/" },
    }),
    e({
      code: "url.unresolved",
      where: "post:2",
      url: "https://s/a/",
      data: { url: "https://s/a/" },
    }),
    e({ code: "link.unresolved", where: "post:2", data: { token: "pageobject=482" } }),
    e({ code: "md.lossy", where: "post:9" }),
    e({
      code: "redirect.dangling",
      where: "redirect:a/",
      url: "https://s/a",
      data: { source: "/a" },
    }),
    e({ code: "redirect.loop", where: "redirect:b/", data: { source: "/b" } }),
    e({ code: "media.download-failed", where: "post:7", data: { file: "2024/a.jpg" } }),
    e({ code: "dynamic.missing-image", where: "post:3", data: { id: 4009 } }),
    e({ code: "interaction.approximated", where: "template:a//h", data: { feature: "nav-modal" } }),
    e({ code: "link.unsupported", where: "template:a//p", data: { action: "infiniteButtonLoad" } }),
    e({
      code: "media.undecodable",
      where: "post:1470",
      data: { file: "2021/04/iOS.heic.jpg", publicPath: "/media/2021/04/iOS.heic.jpg" },
    }),
    e({
      code: "template.shortcode-dropped",
      severity: "info",
      where: "template:a//p",
      data: { shortcode: "dkpdf-button" },
    }),
    e({ code: "style.fallback", severity: "info" }),
  ];
  const decisions = ownerDecisions(entries);
  const byId = (id: string) => decisions.find((d) => d.id === id)!;

  test("a question nothing raised is left out, and so is an entry no question draws on", () => {
    expect(decisions.map((d) => d.id)).toEqual([
      "post-types",
      "not-public",
      "conditions",
      "placeholders",
      "behaviours",
      "urls",
      "markdown",
      "redirects",
      "undecodable",
      "media",
    ]);
    expect(ownerDecisions([e({ code: "style.fallback" })])).toEqual([]);
    expect(ownerDecisions([])).toEqual([]);
  });

  test("a form that is drawn but cannot be submitted is a placeholder question, named by its title", () => {
    const forms = ownerDecisions([
      e({
        code: "form.not-submittable",
        where: "post:1013",
        data: { form: 3, title: "Quote Form" },
      }),
      e({ code: "form.not-submittable", where: "post:5", data: { form: 3, title: "Quote Form" } }),
      e({ code: "form.missing", where: "post:9", data: { form: 8 } }),
    ]).find((d) => d.id === "placeholders")!;
    expect(forms.examples).toEqual([
      "Fluent Forms form Quote Form (drawn, not submittable): 2 places",
      "Fluent Forms form 8 (not in the database): 1 place",
    ]);
  });

  test("a post type that two modules report is one example, with the larger count, not the sum", () => {
    expect(byId("post-types").examples).toEqual(["grw_feed: 6 posts", "igmap: 1 post"]);
    expect(byId("post-types").count).toBe(3);
    expect(byId("post-types").codes).toEqual(["collection.unrouted", "route.unregistered"]);
  });

  test("unpublished content is counted by type and status, adding up", () => {
    expect(byId("not-public").examples).toEqual([
      "7 × project, draft",
      "3 × page, draft",
      "1 × service, password protected",
    ]);
  });

  test("a placeholder is named for what it stands for, and one block reported by two codes is one place", () => {
    const ex = byId("placeholders").examples;
    expect(ex).toContain("shortcode [trustindex]: 1 place");
    expect(ex).toContain("block fluentfom/guten-block: 1 place");
    expect(ex).toContain("block icb/image-compare: 1 place");
    expect(ex).toContain("block x/y: 1 place");
    expect(ex).not.toContain("block core/shortcode: 1 place");
    expect(ex).toHaveLength(4);
  });

  test("addresses are counted by the places that hold them, redirects carry their reason, media their attachment", () => {
    expect(byId("urls").examples).toEqual(["https://s/a/: 2 places", "pageobject=482: 1 place"]);
    expect(byId("redirects").examples).toEqual(["/a (dangling)", "/b (loop)"]);
    expect(byId("media").examples).toEqual(["2024/a.jpg: 1 place", "attachment 4009: 1 place"]);
    expect(byId("behaviours").examples).toEqual([
      "dkpdf-button: 1 place",
      "infiniteButtonLoad: 1 place",
      "nav-modal: 1 place",
    ]);
    expect(byId("undecodable").examples).toEqual(["2021/04/iOS.heic.jpg: 1 place"]);
    expect(byId("conditions").examples).toEqual(["template:a//t: functionreturn === pa"]);
  });

  test("at most ten examples, the most frequent first", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      e({ code: "url.unresolved", where: `post:${i}`, data: { url: `https://s/${i}` } }),
    ).concat(
      Array.from({ length: 3 }, (_, i) =>
        e({ code: "url.unresolved", where: `post:${100 + i}`, data: { url: "https://s/popular" } }),
      ),
    );
    const d = ownerDecisions(many)[0]!;
    expect(d.examples).toHaveLength(10);
    expect(d.examples[0]).toBe("https://s/popular: 3 places");
    expect(d.count).toBe(17);
  });
});

describe("the owner's section of the Markdown report", () => {
  const entries = [
    e({ code: "block.unsupported", where: "post:1", data: { block: "a/b`c" } }),
    e({ code: "style.fallback", severity: "info", where: "post:2" }),
  ];
  const decisions = ownerDecisions(entries);

  test("sits after the summary and before the first group of entries", () => {
    const md = renderProjectReport(entries, decisions, "https://x.test");
    const at = md.indexOf("## Decisions for the site owner");
    expect(at).toBeGreaterThan(md.indexOf("## Summary"));
    expect(at).toBeLessThan(md.indexOf("## warn ("));
    expect(md.startsWith("# Migration report: https://x.test")).toBe(true);
    // One section, and the report is otherwise what the report module writes.
    expect(md.match(/## Decisions for the site owner/g)).toHaveLength(1);
  });

  test("an example with a backtick still reads as one code span", () => {
    const text = renderDecisions(decisions);
    expect(text).toContain("- ``block a/b`c: 1 place``");
  });

  test("no decisions, no section; no entries, the report says so and has no section", () => {
    expect(renderDecisions([])).toBe("");
    expect(renderProjectReport([], [], "https://x.test")).not.toContain("Decisions");
    const only = [e({ code: "md.lossy", where: "post:1" })];
    const md = renderProjectReport(only, ownerDecisions(only), "s");
    expect(md).toContain("### Entries the Markdown could not carry faithfully (1)");
  });
});

// ── References ───────────────────────────────────────────────────────────────────────────────────

describe("checkReferences", () => {
  const files = (o: Record<string, string>): Map<string, string> => new Map(Object.entries(o));

  test("a $ref and a $layout that name no file are errors at the file that holds them", () => {
    const report = createReport();
    checkReferences(
      files({
        "pages/a.json": JSON.stringify({
          $layout: "./layouts/missing.json",
          $elements: [{ $ref: "../components/gone.json" }, { $ref: "../components/here.json" }],
          state: { x: { $ref: "#/state/y" } },
          children: [],
        }),
        "components/here.json": "{}",
        "layouts/base.json": "{}",
        // A layout path is relative to the project, wherever the page is: this one is fine.
        "pages/deep/nested/ok.json": JSON.stringify({ $layout: "./layouts/base.json" }),
        "project.json": JSON.stringify({
          defaults: { layout: "./layouts/base.json" },
          content: {
            c: {
              $elements: [
                { $ref: "./components/here.json" },
                "@jxsuite/parser",
                { $ref: "./components/no.json" },
              ],
            },
          },
        }),
      }),
      report,
    );
    const found = report.entries().map((x) => [x.code, x.where, x.data?.reference]);
    expect(found).toEqual([
      ["project.ref-missing", "pages/a.json", "$layout ./layouts/missing.json"],
      ["project.ref-missing", "pages/a.json", "$ref ../components/gone.json"],
      ["project.ref-missing", "project.json", "$ref ./components/no.json"],
    ]);
    expect(report.entries().every((x) => x.severity === "error")).toBe(true);
  });

  test("a file that is not JSON is `project.json-invalid`; packages, URLs and non-JSON refs are not files to check", () => {
    const report = createReport();
    checkReferences(
      files({
        "pages/bad.json": "{ nope",
        "pages/ok.json": JSON.stringify({
          a: { $ref: "https://x/y.json" },
          b: { $ref: "@jxsuite/x/y.json" },
          c: { $ref: "./data/x.csv" },
          d: { $ref: "#/state/x" },
        }),
        "public/js/a.js": "x",
      }),
      report,
    );
    expect(report.entries().map((x) => [x.code, x.where])).toEqual([
      ["project.json-invalid", "pages/bad.json"],
    ]);
  });
});

/** A response the media downloader accepts for any file the plan names. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const fakeFetch =
  (seen: string[]) =>
  async (url: string): Promise<Response> => {
    seen.push(url);
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".pdf")) return new Response("%PDF-1.4\nfake");
    if (path.endsWith(".svg"))
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    if (/\.(woff2?|ttf|otf)$/.test(path)) return new Response(new Uint8Array([0, 1, 0, 0, 0, 12]));
    return new Response(PNG);
  };

// ── The pipeline, over both fixture sites ────────────────────────────────────────────────────────

type SiteName = "fineline" | "ap";
const SITES: SiteName[] = ["fineline", "ap"];

async function optionsFor(
  name: SiteName,
  extra: Partial<MigrateOptions> = {},
): Promise<MigrateOptions> {
  const { url, prefix } = await fixtureDb(name);
  return {
    db: url,
    prefix,
    cssFrom: { dir: fixtureCssDir(name) },
    // Nothing named is the live site's, and a unit test never asks it.
    pluginFrom: HAVE_PLUGIN ? CWICLY : false,
    wpFrom: HAVE_WP ? WP_TREE : false,
    componentPrefix: name === "ap" ? "ap" : "fp",
    media: false,
    now: NOW,
    ...extra,
  };
}

interface Migrated {
  dir: string;
  result: MigrationResult;
}

const full = new Map<SiteName, Migrated>();
const running = new Map<SiteName, Promise<Migrated>>();

/** One full migration of a site, with `jx validate` and `jx build`, made when the first test needs it. */
function ensure(name: SiteName): Promise<Migrated> {
  let promise = running.get(name);
  if (promise === undefined) {
    promise = (async () => {
      const dir = tmp(`project-${name}`);
      const result = await migrateSite({
        ...(await optionsFor(name)),
        out: dir,
        verify: { validate: true, build: true },
      });
      const migrated = { dir, result };
      full.set(name, migrated);
      return migrated;
    })();
    running.set(name, promise);
  }
  return promise;
}

const read = (name: SiteName, path: string): string =>
  readFileSync(join(full.get(name)!.dir, path), "utf8");
const projectOf = (name: SiteName): Record<string, any> => JSON.parse(read(name, "project.json"));

describe.each(SITES)("%s: the project it writes", (name) => {
  test("`jx validate` and `jx build` pass on it, and the build has every page", async () => {
    await ensure(name);
    const { result } = full.get(name)!;
    expect(result.verify!.validate!.ok).toBe(true);
    expect(result.verify!.build!.ok).toBe(true);
    expect(result.verify!.build!.routes).toBeGreaterThanOrEqual(result.counts.pages);
    expect(result.report.filter((x) => x.code.startsWith("jx.") && x.severity === "error")).toEqual(
      [],
    );
    expect(existsSync(join(full.get(name)!.dir, "dist/index.html"))).toBe(true);
    // The validation leaves the project as it was: no schema files.
    expect(existsSync(join(full.get(name)!.dir, "project.schema.json"))).toBe(false);
  });

  test("no built page holds a binding the build did not evaluate", async () => {
    await ensure(name);
    const dist = join(full.get(name)!.dir, "dist");
    const stack = [dist];
    const bad: string[] = [];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.name.endsWith(".html") && readFileSync(path, "utf8").includes("${")) {
          bad.push(relative(dist, path));
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("project.json carries the site's name, address, language, breakpoints and layout", async () => {
    await ensure(name);
    const project = projectOf(name);
    const { result } = full.get(name)!;
    expect(Object.keys(project)).toEqual(
      expect.arrayContaining([
        "name",
        "url",
        "defaults",
        "$media",
        "extensions",
        "style",
        "$head",
        "content",
        "redirects",
        "build",
      ]),
    );
    expect(project.url).toBe(
      name === "fineline" ? "https://finelinepainting.pro" : "https://anabaptistperspectives.org",
    );
    expect(project.name).toBe(result.project.name as string);
    expect(project.name).not.toContain("&amp;");
    expect(project.defaults.lang).toBe("en-US");
    expect(project.$media).toEqual({
      "--": "1366px",
      "--md": "(max-width: 992px)",
      "--sm": "(max-width: 576px)",
    });
    expect(project.extensions).toEqual(["@jxsuite/parser"]);
    expect(project.build).toEqual({ adapter: "static" });
    expect(
      existsSync(join(full.get(name)!.dir, project.defaults.layout.replace(/^\.\//, ""))),
    ).toBe(true);
  });

  test("the project's style carries every media block at the top, the wider before the narrower, and none inside a selector", async () => {
    await ensure(name);
    const project = projectOf(name);
    const aliases = Object.keys(project.$media as Record<string, string>).map((k) => `@${k}`);
    const style = project.style as Record<string, Record<string, unknown>>;
    const nested = Object.entries(style)
      .filter(([key, value]) => !key.startsWith("@") && typeof value === "object" && value !== null)
      .flatMap(([key, value]) =>
        Object.keys(value)
          .filter((k) => aliases.includes(k))
          .map((k) => `${key} ${k}`),
      );
    expect(nested).toEqual([]);
    const at = Object.keys(style).filter((key) => aliases.includes(key));
    expect(at).toEqual(aliases.filter((alias) => at.includes(alias)));
  });

  test("the plugin's compatibility stylesheet is the first thing in `$head`, ahead of fonts and scripts", async () => {
    await ensure(name);
    const head = projectOf(name).$head as {
      tagName: string;
      attributes?: Record<string, string>;
    }[];
    if (!HAVE_PLUGIN) return;
    expect(head[0]).toEqual({
      tagName: "link",
      attributes: { rel: "stylesheet", href: "/css/cwicly-base.css" },
    });
    const stylesheets = head
      .map((h, i) => [h, i] as const)
      .filter(([h]) => h.attributes?.rel === "stylesheet");
    expect(stylesheets[0]![1]).toBe(0);
    // Every local sheet it links is in the project.
    for (const h of head) {
      const href = h.attributes?.href ?? h.attributes?.src;
      if (href?.startsWith("/") && !href.startsWith("//")) {
        expect(existsSync(join(full.get(name)!.dir, "public", href))).toBe(true);
      }
    }
  });

  test("a Google font a template's stylesheet imports is linked from the head once, not left in a page's style", async () => {
    await ensure(name);
    const head = projectOf(name).$head as {
      tagName: string;
      attributes?: Record<string, string>;
    }[];
    const reem = head.filter((h) => h.attributes?.href?.includes("family=Reem Kufi"));
    expect(reem).toHaveLength(name === "fineline" ? 1 : 0);
    if (name !== "fineline") return;
    expect(reem[0]).toEqual({
      tagName: "link",
      attributes: {
        rel: "stylesheet",
        href: expect.stringMatching(/^https:\/\/fonts\.googleapis\.com\/css\?family=Reem Kufi:/),
      },
    });
    // the statement is in no document: a style object cannot hold it
    const dir = full.get(name)!.dir;
    const documents = ["pages", "components", "layouts"].flatMap((folder) =>
      (readdirSync(join(dir, folder), { recursive: true }) as string[])
        .filter((file) => file.endsWith(".json"))
        .map((file) => join(folder, file)),
    );
    expect(documents.length).toBeGreaterThan(0);
    for (const path of documents) {
      expect([path, read(name, path).includes("@import")]).toEqual([path, false]);
    }
  });

  test("the menus' current-page script is linked deferred, last in the head, and is the script menus.ts defines", async () => {
    await ensure(name);
    const head = projectOf(name).$head as {
      tagName: string;
      attributes?: Record<string, string>;
    }[];
    const last = head.at(-1)!;
    expect(last).toEqual({
      tagName: "script",
      attributes: { src: "/js/wp2jx-current-page.js", defer: "" },
    });
    expect(read(name, "public/js/wp2jx-current-page.js")).toContain(
      'querySelectorAll("ul.cc-menu a[href]")',
    );
  });

  test("every collection of `content` has entries on disk, and every entry file belongs to a collection", async () => {
    await ensure(name);
    const { dir } = full.get(name)!;
    const content = projectOf(name).content as Record<string, { source: string; format: string }>;
    const entryFiles = listFiles(dir).filter((f) => f.startsWith("content/"));
    for (const [collection, def] of Object.entries(content)) {
      expect(def.source).toBe(`content/${collection}`);
      expect(entryFiles.some((f) => f.startsWith(`${def.source}/`))).toBe(true);
    }
    for (const file of entryFiles) {
      expect(Object.keys(content).some((c) => file.startsWith(`content/${c}/`))).toBe(true);
    }
  });

  test("every reference between the files resolves, and the report says no `project.ref-missing` or `project.stage-failed`", async () => {
    await ensure(name);
    const { result } = full.get(name)!;
    expect(
      result.report.filter((x) => x.code.startsWith("project.") && x.severity === "error"),
    ).toEqual([]);
  });

  test("the manifest lists every file the tool wrote, with its hash, and nothing else", async () => {
    await ensure(name);
    const { dir } = full.get(name)!;
    const manifest = JSON.parse(read(name, MANIFEST_PATH)) as {
      generator: string;
      manifest: number;
      files: Record<string, string>;
    };
    expect(manifest.generator).toBe("wp2jx");
    expect(manifest.manifest).toBe(1);
    // The package.json and the .gitignore are the person's after the first run: the manifest does not claim them.
    const seeds = new Set([MANIFEST_PATH, "package.json", ".gitignore"]);
    const onDisk = listFiles(dir).filter((f) => !seeds.has(f));
    expect(Object.keys(manifest.files)).toEqual(onDisk);
    for (const path of onDisk)
      expect(manifest.files[path]).toBe(sha(readFileSync(join(dir, path))));
    // Keys are sorted, so the manifest itself is stable.
    expect(Object.keys(manifest.files)).toEqual(Object.keys(manifest.files).toSorted());
  });

  test("migration-report.json holds every entry once with its summary, and the Markdown puts the owner's decisions first", async () => {
    await ensure(name);
    const { result } = full.get(name)!;
    const json = JSON.parse(read(name, REPORT_JSON_PATH)) as {
      summary: { total: number; bySeverity: Record<string, number> };
      entries: ReportEntry[];
    };
    expect(json.entries).toHaveLength(result.report.length);
    expect(json.summary.total).toBe(result.report.length);
    expect(json.summary.bySeverity).toEqual(result.summary.bySeverity);
    const keys = json.entries.map((x) =>
      JSON.stringify([x.severity, x.code, x.message, x.where, x.url, x.data]),
    );
    expect(new Set(keys).size).toBe(keys.length);
    const md = read(name, REPORT_MD_PATH);
    expect(md).toContain("## Decisions for the site owner");
    expect(md.indexOf("## Decisions for the site owner")).toBeLessThan(md.indexOf("## warn ("));
    expect(result.decisions.length).toBeGreaterThan(0);
    // The jx findings are in it.
    expect(json.entries.some((x) => x.code === "jx.validate-lint")).toBe(true);
  });

  test("the report is in order: errors, then warnings, then information, and codes alphabetical within each", async () => {
    await ensure(name);
    const { result } = full.get(name)!;
    const rank = { error: 0, warn: 1, info: 2 } as const;
    for (let i = 1; i < result.report.length; i++) {
      const a = result.report[i - 1]!;
      const b = result.report[i]!;
      expect(rank[a.severity] <= rank[b.severity]).toBe(true);
      if (a.severity === b.severity) expect(a.code <= b.code).toBe(true);
    }
  });

  test("nothing in the written files is a password or a database address", async () => {
    await ensure(name);
    const { dir } = full.get(name)!;
    for (const path of listFiles(dir)) {
      if (!/\.(json|md|css|js)$/.test(path)) continue;
      const text = readFileSync(join(dir, path), "utf8");
      expect(text).not.toContain("mysql://");
    }
  });
});

describe("fineline: what only that site shows", () => {
  test("the pilot's counts: pages, entries and collections of the live site", async () => {
    await ensure("fineline");
    await ensure("ap");
    const { result } = full.get("fineline")!;
    expect(result.counts.collections).toBe(10);
    expect(result.counts.entries).toBeGreaterThan(100);
    expect(result.counts.pages).toBeGreaterThan(20);
    expect(result.counts.components).toBe(6);
    expect(Object.keys(projectOf("fineline").content)).toEqual(
      expect.arrayContaining(["post", "project", "service", "project_tag", "location"]),
    );
  });

  test("fineline: the post Rank Math sends away stays in its collection, and the build writes the redirect's refresh page over its own", async () => {
    await ensure("fineline");
    const redirects = projectOf("fineline").redirects as Record<string, unknown>;
    expect(redirects["/hardwood-floor-refinishing"]).toBe("/service/hardwood-floor-refinishing/");
    const dir = full.get("fineline")!.dir;
    // The blog index on the source site lists this post, so the entry is written; only its page gives way.
    expect(existsSync(join(dir, "content/post/hardwood-floor-refinishing.md"))).toBe(true);
    expect(existsSync(join(dir, "content/post/the-benefits-of-premium-paint.md"))).toBe(true);
    // The refresh page Jx writes at the address (not the page): it leads to the destination.
    expect(readFileSync(join(dir, "dist/hardwood-floor-refinishing/index.html"), "utf8")).toContain(
      'http-equiv="refresh" content="0;url=/service/hardwood-floor-refinishing/"',
    );
    const { result } = full.get("fineline")!;
    expect(
      result.report.filter((x) => x.code === "redirect.supersedes-page").map((x) => x.where),
    ).toEqual(["redirect:hardwood-floor-refinishing/"]);
    // The redirect is not dropped as shadowed by the entry it supersedes.
    expect(
      result.report.some(
        (x) =>
          x.code === "project.redirect-shadowed" &&
          x.data?.source === "/hardwood-floor-refinishing",
      ),
    ).toBe(false);
    // The blog index's cards include it.
    expect(readFileSync(join(dir, "dist/blog/index.html"), "utf8")).toContain(
      "How to Refinish a Hardwood Floor",
    );
  });

  test("fineline: the library's padding for a heading with a background is written once more for the posts that hold one, and the base layout carries the embed class", async () => {
    if (!HAVE_WP) return;
    await ensure("fineline");
    const style = projectOf("fineline").style as Record<string, Record<string, string>>;
    // The hoisted rules follow the design system's conditional blocks, in a block of their own.
    const hoisted = style[EVERY_WIDTH] as unknown as Record<string, Record<string, string>>;
    const twin = Object.keys(hoisted).find((k) => k.startsWith(":root .has-background:is(h1)"));
    expect(twin).toBeDefined();
    expect(hoisted[twin!]).toEqual({ padding: "1.25em 2.375em" });
    expect(readFileSync(join(full.get("fineline")!.dir, "layouts/base.json"), "utf8")).toContain(
      "wp-site-blocks wp-embed-responsive",
    );
  });

  test("a redirect whose source is a page this run wrote is dropped and said, and `/search` (the templates' own page) is no redirect", async () => {
    await ensure("fineline");
    await ensure("ap");
    const redirects = projectOf("ap").redirects as Record<string, unknown>;
    expect(redirects["/search"]).toBeUndefined();
    const { result } = full.get("ap")!;
    expect(
      result.report.some(
        (x) => x.code === "project.redirect-shadowed" && x.data?.source === "/search",
      ),
    ).toBe(true);
    // The build says nothing about a collision.
    expect(
      result.report.some((x) => x.code === "jx.build-warning" && x.message.includes("collides")),
    ).toBe(false);
  });
});

// Narrow runs: a few posts of one type, so each costs about a second.
const NARROW = ["service"];

describe("running again", () => {
  test("a second run over the same site is byte-identical, in another directory", async () => {
    const a = memorySink();
    const b = memorySink();
    const opts = await optionsFor("fineline", { postTypes: NARROW });
    await migrateSite({ ...opts, sink: a });
    await migrateSite({ ...opts, sink: b });
    expect([...a.files.keys()]).toEqual([...b.files.keys()]);
    for (const [path, content] of a.files) expect(b.files.get(path)).toEqual(content);
    expect(a.files.size).toBeGreaterThan(50);
  });

  test("into the same directory, nothing is rewritten: every file unchanged, none written, none removed", async () => {
    const dir = tmp("again");
    const opts = await optionsFor("fineline", { postTypes: NARROW, out: dir });
    const first = await migrateSite(opts);
    expect(first.files.written.length).toBeGreaterThan(50);
    expect(first.files.unchanged).toEqual([]);
    const marker = new Date("2020-01-01T00:00:00Z");
    for (const path of ["project.json", "pages/index.json", MANIFEST_PATH, REPORT_MD_PATH]) {
      utimesSync(join(dir, path), marker, marker);
    }
    const second = await migrateSite(opts);
    expect(second.files.written).toEqual([]);
    expect(second.files.removed).toEqual([]);
    expect(second.files.unchanged).toEqual(first.files.written);
    for (const path of ["project.json", "pages/index.json", MANIFEST_PATH, REPORT_MD_PATH]) {
      expect(statSync(join(dir, path)).mtime.getTime()).toBe(marker.getTime());
    }
  });

  test("a changed file is rewritten and only that one", async () => {
    const dir = tmp("again");
    const opts = await optionsFor("fineline", { postTypes: NARROW, out: dir });
    const first = await migrateSite(opts);
    writeFileSync(join(dir, "pages/index.json"), "{}\n");
    const second = await migrateSite(opts);
    // The edit is overwritten and the report says so, which is why the report and the manifest that
    // vouches for it change with it; no other file of the project does.
    expect(second.files.written).toEqual([
      MANIFEST_PATH,
      REPORT_JSON_PATH,
      REPORT_MD_PATH,
      "pages/index.json",
    ]);
    expect(second.files.unchanged).toHaveLength(first.files.written.length - 4);
    expect(second.report.find((x) => x.code === "project.edited-overwritten")).toMatchObject({
      severity: "warn",
      where: "pages/index.json",
    });
  });

  test("a file the tool wrote and no longer produces is removed; a file it did not write is not; one that was edited is kept and said", async () => {
    const dir = tmp("stale");
    await migrateSite(await optionsFor("fineline", { postTypes: ["service", "post"], out: dir }));
    const before = listFiles(dir);
    const services = before.filter((f) => f.startsWith("content/service/"));
    const posts = before.filter((f) => f.startsWith("content/post/"));
    expect(services.length).toBeGreaterThan(5);
    expect(posts.length).toBeGreaterThan(5);
    // Somebody's own files, in a directory the tool uses and in a new one.
    writeFileSync(join(dir, "content/service/notes.txt"), "mine");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/README.md"), "mine");
    // An entry that was edited since.
    const edited = services[0]!;
    writeFileSync(join(dir, edited), "edited by a person\n");

    const second = await migrateSite(
      await optionsFor("fineline", { postTypes: ["post"], out: dir }),
    );
    const after = new Set(listFiles(dir));
    const mine = new Set(["content/service/notes.txt", "docs/README.md"]);
    // What went: everything the first run wrote that the second no longer does, but the edited file.
    const gone = before.filter((f) => !after.has(f));
    expect(second.files.removed).toEqual(gone);
    expect(gone.filter((f) => f.startsWith("content/service/"))).toEqual(
      services.filter((f) => f !== edited).sort(),
    );
    // The routes of the service entries went with them.
    expect(gone).toContain("pages/service/[slug].json");
    expect(gone.some((f) => mine.has(f) || f === edited)).toBe(false);
    expect(second.files.kept).toEqual([edited]);
    expect(second.report.find((x) => x.code === "project.stale-kept")).toMatchObject({
      severity: "warn",
      where: edited,
    });
    for (const f of services.filter((f) => f !== edited))
      expect(existsSync(join(dir, f))).toBe(false);
    expect(readFileSync(join(dir, edited), "utf8")).toBe("edited by a person\n");
    expect(readFileSync(join(dir, "content/service/notes.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(dir, "docs/README.md"), "utf8")).toBe("mine");
    for (const f of posts) expect(existsSync(join(dir, f))).toBe(true);
    // The kept file stays in the manifest, so a later run still knows it is the tool's.
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_PATH), "utf8")) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files)).toContain(edited);
    expect(Object.keys(manifest.files)).not.toContain("content/service/notes.txt");
  });

  test("an unreadable manifest removes nothing and is said", async () => {
    const dir = tmp("badmanifest");
    const opts = await optionsFor("fineline", { postTypes: ["service", "post"], out: dir });
    await migrateSite(opts);
    writeFileSync(join(dir, MANIFEST_PATH), "{ not json");
    const second = await migrateSite({ ...opts, postTypes: ["post"] });
    expect(second.files.removed).toEqual([]);
    expect(second.report.find((x) => x.code === "project.manifest-unreadable")).toMatchObject({
      severity: "warn",
    });
    expect(listFiles(dir).some((f) => f.startsWith("content/service/"))).toBe(true);
    // And the next run writes a good manifest again.
    expect(JSON.parse(readFileSync(join(dir, MANIFEST_PATH), "utf8")).generator).toBe("wp2jx");
  });

  test("a manifest that lists a path outside the project removes nothing there", async () => {
    const root = tmp("evil");
    const dir = join(root, "out");
    const opts = await optionsFor("fineline", { postTypes: ["post"], out: dir });
    await migrateSite(opts);
    writeFileSync(join(root, "victim.txt"), "keep me");
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_PATH), "utf8")) as {
      files: Record<string, string>;
    };
    manifest.files["../victim.txt"] = sha("keep me");
    manifest.files["/etc/hostname"] = "0".repeat(64);
    writeFileSync(join(dir, MANIFEST_PATH), JSON.stringify(manifest));
    await migrateSite(opts);
    expect(readFileSync(join(root, "victim.txt"), "utf8")).toBe("keep me");
  });
});

describe("dry run, media and options", () => {
  test("a dry run with no output writes nothing anywhere, converts everything and counts the media it would fetch", async () => {
    let fetches = 0;
    const result = await migrateSite({
      ...(await optionsFor("fineline", { postTypes: NARROW })),
      media: true,
      dryRun: true,
      fetch: async () => {
        fetches++;
        return new Response("x");
      },
    });
    expect(fetches).toBe(0);
    expect(result.files.written.length).toBeGreaterThan(50);
    expect(result.media.downloaded).toBe(0);
    expect(result.media.planned).toBeGreaterThan(0);
    const note = result.report.find((x) => x.code === "media.not-downloaded")!;
    expect(note.severity).toBe("info");
    expect(note.data?.files).toBe(result.media.planned);
  });

  test("a dry run with an output writes the project and no media, and a later real run fetches only then", async () => {
    const dir = tmp("dry");
    const opts = await optionsFor("fineline", { postTypes: NARROW, out: dir, media: true });
    const dry = await migrateSite({ ...opts, dryRun: true });
    expect(existsSync(join(dir, "project.json"))).toBe(true);
    expect(existsSync(join(dir, "public/media"))).toBe(false);
    expect(dry.media.downloaded).toBe(0);
  });

  test("`media: false` leaves the media out and says how many files that is; nothing is fetched", async () => {
    let fetches = 0;
    const result = await migrateSite({
      ...(await optionsFor("fineline", { postTypes: NARROW })),
      media: false,
      sink: memorySink(),
      fetch: async () => {
        fetches++;
        return new Response("x");
      },
    });
    expect(fetches).toBe(0);
    expect(result.report.find((x) => x.code === "media.skipped")).toMatchObject({
      severity: "info",
    });
  });

  test("the media the pages asked for is fetched into public/media, once, and a re-run skips what is there", async () => {
    const sink = memorySink();
    const seen: string[] = [];
    const opts = await optionsFor("fineline", {
      postTypes: NARROW,
      media: true,
      sink,
      fetch: fakeFetch(seen),
    });
    const first = await migrateSite(opts);
    const media = [...sink.files.keys()].filter((p) => p.startsWith("public/media/"));
    expect(media.length).toBeGreaterThan(5);
    expect(first.media.downloaded).toBe(media.length);
    expect(first.media.failed).toBe(0);
    expect(first.media.bytes).toBeGreaterThan(0);
    // Only the files the converted content refers to: far fewer than the library.
    expect(first.media.planned).toBeLessThan(1233);
    // Every address a page uses has its file.
    for (const f of first.files.written) {
      if (!f.endsWith(".json") || !f.startsWith("pages/")) continue;
      for (const m of (sink.files.get(f) as string).matchAll(/"\/media\/([^"]+)"/g)) {
        expect(sink.files.has(`public/media/${decodeURIComponent(m[1]!)}`)).toBe(true);
      }
    }
    const manifest = JSON.parse(sink.files.get(MANIFEST_PATH) as string) as {
      files: Record<string, string>;
    };
    for (const p of media) expect(manifest.files[p]).toBe(sha(sink.files.get(p)!));

    seen.length = 0;
    const second = await migrateSite(opts);
    expect(seen).toEqual([]);
    expect(second.media.downloaded).toBe(0);
    expect(second.media.skipped).toBe(first.media.planned);
    expect(second.files.written).toEqual([]);
  });

  test("a picture the image optimiser cannot decode (a HEIC under a .jpg name) is said, and its references opt out of the optimiser so the build goes on", async () => {
    const heic = Uint8Array.from([
      0,
      0,
      0,
      24,
      ...[..."ftypheic"].map((c) => c.charCodeAt(0)),
      0,
      0,
      0,
      0,
    ]);
    const sink = memorySink();
    const opts = await optionsFor("fineline", {
      postTypes: NARROW,
      media: true,
      sink,
      fetch: async (url: string) =>
        new Response(new URL(url).pathname.toLowerCase().endsWith(".jpg") ? heic : PNG),
    });
    const result = await migrateSite(opts);
    const bad = result.report.filter((e) => e.code === "media.undecodable");
    expect(bad.length).toBeGreaterThan(0);
    for (const e of bad) {
      expect(e.severity).toBe("warn");
      expect(e.message).toContain("HEIC");
      expect(e.message).toContain("data-no-optimize");
      expect(e.data?.publicPath).toMatch(/^\/media\/.*\.jpg$/i);
    }
    const unreadable = new Set(bad.map((e) => String(e.data?.publicPath)));
    // Every image of a page that names one of them opts out; every other image does not.
    let marked = 0;
    for (const [path, data] of sink.files) {
      if (!path.startsWith("pages/") || !path.endsWith(".json")) continue;
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node === null || typeof node !== "object") return;
        const n = node as { tagName?: string; attributes?: Record<string, unknown> };
        const src = n.attributes?.src;
        if (n.tagName === "img" && typeof src === "string" && src.startsWith("/media/")) {
          const out = n.attributes?.["data-no-optimize"] !== undefined;
          expect([src, out]).toEqual([src, unreadable.has(src)]);
          if (out) marked++;
        }
        Object.values(node).forEach(walk);
      };
      walk(JSON.parse(data as string));
    }
    expect(marked).toBeGreaterThan(0);
    // A second run with the files in place says the same and changes nothing.
    const again = await migrateSite(opts);
    expect(again.report.filter((e) => e.code === "media.undecodable")).toHaveLength(bad.length);
    expect(again.files.written).toEqual([]);
  });

  test("a dry run keeps the media an earlier run fetched in the manifest, and removes none of it", async () => {
    const sink = memorySink();
    const opts = await optionsFor("fineline", {
      postTypes: NARROW,
      media: true,
      sink,
      fetch: fakeFetch([]),
    });
    await migrateSite(opts);
    const media = [...sink.files.keys()].filter((p) => p.startsWith("public/media/"));
    const dry = await migrateSite({ ...opts, dryRun: true });
    expect(dry.files.removed).toEqual([]);
    expect([...sink.files.keys()].filter((p) => p.startsWith("public/media/"))).toEqual(media);
    const manifest = JSON.parse(sink.files.get(MANIFEST_PATH) as string) as {
      files: Record<string, string>;
    };
    for (const p of media) expect(manifest.files[p]).toBeDefined();
  });

  test("a media file the content no longer asks for is removed, unless it was changed", async () => {
    const sink = memorySink();
    const base = { media: true, sink, fetch: fakeFetch([]) } as const;
    await migrateSite(await optionsFor("fineline", { postTypes: ["service", "post"], ...base }));
    const all = [...sink.files.keys()].filter((p) => p.startsWith("public/media/"));
    const narrow = await migrateSite(
      await optionsFor("fineline", { postTypes: ["post"], ...base }),
    );
    const left = [...sink.files.keys()].filter((p) => p.startsWith("public/media/"));
    expect(left.length).toBeLessThan(all.length);
    expect(narrow.files.removed.filter((p) => p.startsWith("public/media/")).sort()).toEqual(
      all.filter((p) => !left.includes(p)).sort(),
    );
  });

  test("`uploads` as a folder copies from it and never touches the network; a file it lacks is an error naming it", async () => {
    // Which files the pages ask for: a first run through a fake server.
    const first = memorySink();
    const warm = await migrateSite(
      await optionsFor("fineline", {
        postTypes: NARROW,
        media: true,
        sink: first,
        fetch: fakeFetch([]),
      }),
    );
    const wanted = [...first.files.keys()].filter((p) => p.startsWith("public/media/"));
    expect(warm.media.failed).toBe(0);
    const uploads = tmp("uploads");
    const have = wanted.slice(0, 4);
    for (const p of have) {
      const dest = join(uploads, p.replace(/^public\/media\//, ""));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, `local:${p}`);
    }
    const sink = memorySink();
    const result = await migrateSite(
      await optionsFor("fineline", {
        postTypes: NARROW,
        media: true,
        uploads,
        sink,
        fetch: async () => {
          throw new Error("the network was used");
        },
      }),
    );
    for (const p of have) expect(sink.files.get(p)).toEqual(new TextEncoder().encode(`local:${p}`));
    expect(result.media.downloaded).toBe(have.length);
    const missing = result.report.filter((x) => x.code === "media.local-missing");
    expect(missing).toHaveLength(
      wanted.length - have.length + (result.media.planned - wanted.length),
    );
    expect(missing.every((x) => x.severity === "error")).toBe(true);
    expect(result.media.failed).toBe(missing.length);
    // A file already in the project is not copied again.
    const again = await migrateSite(
      await optionsFor("fineline", {
        postTypes: NARROW,
        media: true,
        uploads,
        sink,
        fetch: async () => {
          throw new Error("the network was used");
        },
      }),
    );
    expect(again.media.downloaded).toBe(0);
    expect(again.media.skipped).toBe(have.length);
    expect(again.media.failed).toBe(missing.length);
  });

  test("`uploads` as an address is asked first, and the original address is the fallback", async () => {
    const seen: string[] = [];
    const sink = memorySink();
    const result = await migrateSite(
      await optionsFor("fineline", {
        postTypes: NARROW,
        media: true,
        uploads: "https://mirror.example.test/up",
        sink,
        fetch: fakeFetch(seen),
      }),
    );
    expect(result.media.failed).toBe(0);
    expect(seen.length).toBeGreaterThan(5);
    const images = seen.filter((u) => !/\.(woff2?|ttf|otf)$/.test(u));
    expect(images.every((u) => u.startsWith("https://mirror.example.test/up/"))).toBe(true);
  });

  test("a failed download is an error entry naming the file, and the rest are still fetched", async () => {
    const sink = memorySink();
    const seen: string[] = [];
    const inner = fakeFetch(seen);
    let failed = 0;
    const result = await migrateSite(
      await optionsFor("fineline", {
        postTypes: NARROW,
        media: true,
        sink,
        fetch: async (url: string) => {
          if (seen.length === 1) {
            failed++;
            seen.push(url);
            return new Response("gone", { status: 404 });
          }
          return inner(url);
        },
      }),
    );
    expect(failed).toBe(1);
    expect(result.media.failed).toBeGreaterThanOrEqual(1);
    expect(result.media.downloaded).toBeGreaterThan(5);
    expect(
      result.report.some((x) => x.code === "media.download-failed" && x.severity === "error"),
    ).toBe(true);
    expect(result.decisions.find((d) => d.id === "media")).toBeDefined();
  });
});

describe("what migrateSite refuses, and survives", () => {
  test("it needs somewhere to write, or a dry run", async () => {
    await expect(migrateSite(await optionsFor("fineline"))).rejects.toThrow(
      "needs `out` or `sink`",
    );
  });

  test("verify needs the files on disk", async () => {
    await expect(
      migrateSite({
        ...(await optionsFor("fineline")),
        sink: memorySink(),
        verify: { validate: true },
      }),
    ).rejects.toThrow("needs an output directory");
  });

  test("without a site, `db` is required", async () => {
    await expect(migrateSite({ sink: memorySink() })).rejects.toThrow("needs `db`");
  });

  test("a run with no plugin source and no WordPress root says what is missing instead of shipping a broken style", async () => {
    const opts = await optionsFor("fineline", { postTypes: ["post"], sink: memorySink() });
    opts.pluginFrom = false;
    opts.wpFrom = false;
    const result = await migrateSite(opts);
    const codes = result.report.map((x) => x.code);
    expect(codes).toContain("project.compat-missing");
    expect(codes).toContain("project.core-css-skipped");
    const head = (result.project.$head as { attributes?: { href?: string } }[]) ?? [];
    expect(head.some((h) => h.attributes?.href === "/css/cwicly-base.css")).toBe(false);
  });

  test("a stage that throws costs its own output only: the others are written and the failure is an error", async () => {
    const opts = await optionsFor("fineline", { postTypes: ["post"] });
    const site = await loadSiteContext({
      db: opts.db!,
      prefix: opts.prefix!,
      cssFrom: opts.cssFrom!,
      ...(typeof opts.pluginFrom === "string" ? { pluginFrom: opts.pluginFrom } : {}),
      componentPrefix: "fp",
      postTypes: [
        "page",
        "post",
        "wp_template",
        "wp_template_part",
        "wp_block",
        "cc_block",
        "acf-post-type",
        "acf-taxonomy",
        "acf-field-group",
        "acf-field",
        "wp_navigation",
        "wp_global_styles",
        "custom_css",
      ],
    });
    // The URL tools are bound once for the design system and once for the redirects, and once per subject.
    const broken = {
      ...site,
      urls: {
        ...site.urls,
        bind: (report: never, where?: string) => {
          if (where === "design:global-css" || where === "redirects") throw new Error("boom");
          return site.urls.bind(report, where);
        },
      },
    } as typeof site;
    const sink = memorySink();
    const result = await migrateSite({ site: broken, sink, now: NOW, media: false });
    const failures = result.report.filter((x) => x.code === "project.stage-failed");
    expect(failures.map((x) => x.data?.stage).sort()).toEqual(["design", "redirects"]);
    expect(failures.every((x) => x.severity === "error" && x.message.includes("boom"))).toBe(true);
    expect([...sink.files.keys()].some((p) => p.startsWith("pages/"))).toBe(true);
    expect(sink.files.has("project.json")).toBe(true);
    // The breakpoints still come from the options, with no design system.
    expect(result.project.$media).toEqual(site.options.media);
    expect(result.project.redirects).toBeUndefined();
  });

  test("a password in a database URL is in no file, however a module put it in its message", async () => {
    const opts = await optionsFor("fineline", { postTypes: ["post"] });
    const site = await loadSiteContext({
      db: opts.db!,
      prefix: opts.prefix!,
      cssFrom: opts.cssFrom!,
      componentPrefix: "fp",
      postTypes: [
        "page",
        "post",
        "wp_template",
        "wp_template_part",
        "cc_block",
        "acf-post-type",
        "acf-taxonomy",
        "acf-field-group",
        "acf-field",
      ],
    });
    site.report.add({
      severity: "error",
      code: "site.db",
      message: "cannot open mysql://root:Tr0ub4dor@db.internal/wp: refused",
      where: "db:Tr0ub4dor",
      data: { url: "mysql://root:Tr0ub4dor@db.internal/wp" },
    });
    const sink = memorySink();
    const result = await migrateSite({
      site,
      db: "mysql://root:Tr0ub4dor@db.internal/wp",
      sink,
      now: NOW,
      media: false,
    });
    expect(JSON.stringify(result)).not.toContain("Tr0ub4dor");
    for (const [path, content] of sink.files) {
      expect(typeof content === "string" ? content : "").not.toContain("Tr0ub4dor");
      expect(path).not.toContain("Tr0ub4dor");
    }
    const json = JSON.parse(sink.files.get(REPORT_JSON_PATH) as string) as {
      entries: ReportEntry[];
    };
    expect(json.entries.find((x) => x.code === "site.db")).toMatchObject({
      message: "cannot open mysql://root:***@db.internal/wp: refused",
      where: "db:***",
      data: { url: "mysql://root:***@db.internal/wp" },
    });
  });

  test("the progress callback hears every phase, in order, and one that throws does not stop the run", async () => {
    const phases: string[] = [];
    const sink = memorySink();
    await migrateSite({
      ...(await optionsFor("fineline", { postTypes: ["post"] })),
      sink,
      progress: (event) => {
        phases.push(event.phase);
        throw new Error("observer failed");
      },
    });
    const order = [...new Set(phases)];
    expect(order).toEqual([
      "load",
      "components",
      "templates",
      "pages",
      "collections",
      "design",
      "core-css",
      "redirects",
      "write",
    ]);
    expect(sink.files.has("project.json")).toBe(true);
  });

  test("a core rule no style object can carry (an @import) is a stylesheet of its own, linked right after the compatibility sheet", async () => {
    const wp = tmp("fakewp");
    mkdirSync(join(wp, "wp-includes/blocks/paragraph"), { recursive: true });
    mkdirSync(join(wp, "wp-includes/css/dist/block-library"), { recursive: true });
    writeFileSync(
      join(wp, "wp-includes/blocks/paragraph/style.min.css"),
      '@import url("https://fonts.test/x.css");\n.wp-block-paragraph{overflow-wrap:break-word}',
    );
    writeFileSync(
      join(wp, "wp-includes/css/dist/block-library/common.min.css"),
      ".screen-reader-text{clip:rect(1px,1px,1px,1px)}",
    );
    const sink = memorySink();
    const result = await migrateSite({
      ...(await optionsFor("fineline", { postTypes: ["post"] })),
      wpFrom: wp,
      sink,
    });
    const css = sink.files.get(CORE_CSS_PATH) as string;
    expect(css).toContain('@import url("https://fonts.test/x.css");');
    expect(css.startsWith("/* ")).toBe(true);
    const head = result.project.$head as { attributes?: { href?: string } }[];
    const at = head.findIndex((h) => h.attributes?.href === "/css/wp-core-blocks.css");
    expect(at).toBe(HAVE_PLUGIN ? 1 : 0);
    if (HAVE_PLUGIN) expect(head[0]!.attributes!.href).toBe("/css/cwicly-base.css");
    // What a style can carry went there instead.
    expect(Object.keys(result.project.style as object)).toContain(".screen-reader-text");
    expect(result.report.find((x) => x.code === "corecss.verbatim")).toBeDefined();
  });

  test("the core block rules are in the project style, and the ones a style cannot hold are a linked stylesheet", async () => {
    if (!HAVE_WP) return;
    const sink = memorySink();
    const result = await migrateSite({
      ...(await optionsFor("fineline", { postTypes: NARROW })),
      sink,
    });
    const style = result.project.style as Record<string, unknown>;
    expect(Object.keys(style).some((k) => k.includes("wp-block-"))).toBe(true);
    // Presets are the editor's, not the live site's: none unless asked for.
    expect(Object.keys(style).some((k) => k.startsWith("--wp--preset--"))).toBe(false);
    if (sink.files.has(CORE_CSS_PATH)) {
      const head = result.project.$head as { attributes?: { href?: string } }[];
      expect(head.some((h) => h.attributes?.href === "/css/wp-core-blocks.css")).toBe(true);
    }
  });
});

// ── Local fonts ──────────────────────────────────────────────────────────────────────────────────

describe("fontFile", () => {
  const uploads = "https://s.test/wp-content/uploads";

  test("an address is resolved the way a browser would from the stylesheet that names it", () => {
    const at = (url: string) =>
      fontFile({ url, dest: "public/fonts/a/b.woff2" }, "https://s.test", uploads)!;
    expect(at("https://cdn.test/x/b.woff2").sourceUrl).toBe("https://cdn.test/x/b.woff2");
    expect(at("//cdn.test/x/b.woff2").sourceUrl).toBe("https://cdn.test/x/b.woff2");
    expect(at("/wp-content/uploads/cwicly/local-fonts/a/b.woff2").sourceUrl).toBe(
      "https://s.test/wp-content/uploads/cwicly/local-fonts/a/b.woff2",
    );
    expect(at("a/b.woff2").sourceUrl).toBe(
      "https://s.test/wp-content/uploads/cwicly/local-fonts/a/b.woff2",
    );
  });

  test("it is a file of the project at the destination the CSS already names, typed by its extension", () => {
    const f = fontFile(
      { url: "https://x.test/a.woff2", dest: "public/fonts/a.woff2" },
      "https://s.test",
      uploads,
    )!;
    expect(f).toEqual({
      attachmentIds: [],
      sourceUrl: "https://x.test/a.woff2",
      file: "fonts/a.woff2",
      destPath: "public/fonts/a.woff2",
      publicPath: "/fonts/a.woff2",
      mime: "font/woff2",
    });
    expect(
      fontFile(
        { url: "https://x.test/a.ttf", dest: "public/fonts/a.ttf" },
        "https://s.test",
        uploads,
      )!.mime,
    ).toBe("font/ttf");
    expect(
      fontFile(
        { url: "https://x.test/a.bin", dest: "public/fonts/a.bin" },
        "https://s.test",
        uploads,
      )!.mime,
    ).toBe("");
  });

  test("an address that cannot be resolved is no file (the caller reports it)", () => {
    expect(
      fontFile({ url: "/a.woff2", dest: "public/fonts/a.woff2" }, "", uploads),
    ).toBeUndefined();
  });
});

describe("local fonts, end to end", () => {
  const family = (css: string) => ({
    family: "Local One",
    source: "local" as const,
    key: "k1",
    css,
  });
  const CSS =
    "@font-face{font-family:'Local One';font-weight:400;src:url(https://s.test/wp-content/uploads/cwicly/local-fonts/local-one/regular.woff2) format('woff2'),url(local-one/regular.woff) format('woff')}";

  async function withFont(extra: Partial<MigrateOptions>): Promise<MigrationResult> {
    const opts = await optionsFor("fineline", { postTypes: ["post"] });
    const site = await loadSiteContext({
      db: opts.db!,
      prefix: opts.prefix!,
      cssFrom: opts.cssFrom!,
      componentPrefix: "fp",
      postTypes: [
        "page",
        "post",
        "wp_template",
        "wp_template_part",
        "wp_block",
        "cc_block",
        "acf-post-type",
        "acf-taxonomy",
        "acf-field-group",
        "acf-field",
        "wp_navigation",
        "wp_global_styles",
        "custom_css",
      ],
    });
    const withLocal = {
      ...site,
      options: {
        ...site.options,
        globalStyles: {
          ...site.options.globalStyles,
          fonts: [...site.options.globalStyles.fonts, family(CSS)],
        },
      },
    } as typeof site;
    return migrateSite({ site: withLocal, now: NOW, ...extra });
  }

  test("the font files are fetched into public/fonts, and the project's own CSS points at them", async () => {
    const sink = memorySink();
    const seen: string[] = [];
    const result = await withFont({
      sink,
      media: true,
      fetch: fakeFetch(seen),
    });
    expect([...sink.files.keys()].filter((p) => p.startsWith("public/fonts/")).sort()).toEqual([
      "public/fonts/local-one/regular.woff2",
      "public/fonts/regular.woff",
    ]);
    expect(seen).toContain(
      "https://s.test/wp-content/uploads/cwicly/local-fonts/local-one/regular.woff2",
    );
    expect(seen).toContain(
      "https://finelinepainting.pro/wp-content/uploads/cwicly/local-fonts/local-one/regular.woff",
    );
    const css = sink.files.get("public/css/cwicly-global.css") as string;
    expect(css).toContain("url(/fonts/local-one/regular.woff2)");
    expect(css).not.toContain("s.test");
    expect(result.media.failed).toBe(0);
    const manifest = JSON.parse(sink.files.get(MANIFEST_PATH) as string) as {
      files: Record<string, string>;
    };
    expect(manifest.files["public/fonts/local-one/regular.woff2"]).toBeDefined();
  });

  test("with `uploads` as a folder the fonts are still fetched from the site: the folder is the library's, not the theme's", async () => {
    const uploads = tmp("uploads-empty");
    const seen: string[] = [];
    const sink = memorySink();
    const result = await withFont({ sink, media: true, uploads, fetch: fakeFetch(seen) });
    expect(seen).toHaveLength(2);
    expect(seen.every((u) => /\.woff2?$/.test(u))).toBe(true);
    expect(sink.files.has("public/fonts/local-one/regular.woff2")).toBe(true);
    expect(sink.files.has("public/fonts/regular.woff")).toBe(true);
    // The library files the folder does not have are errors; the fonts are not among them.
    const missing = result.report.filter((x) => x.code === "media.local-missing");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((x) => x.message.includes("fonts/"))).toBe(false);
  });

  test("with `uploads` as an address the library is asked there first and the fonts are not: they were never in it", async () => {
    const seen: string[] = [];
    const sink = memorySink();
    const result = await withFont({
      sink,
      media: true,
      uploads: "https://mirror.example.test/up",
      fetch: fakeFetch(seen),
    });
    const fonts = seen.filter((u) => /\.woff2?$/.test(u));
    expect(fonts.sort()).toEqual([
      "https://finelinepainting.pro/wp-content/uploads/cwicly/local-fonts/local-one/regular.woff",
      "https://s.test/wp-content/uploads/cwicly/local-fonts/local-one/regular.woff2",
    ]);
    expect(
      seen
        .filter((u) => !/\.woff2?$/.test(u))
        .every((u) => u.startsWith("https://mirror.example.test/up/")),
    ).toBe(true);
    expect(result.media.failed).toBe(0);
  });

  test("a dry run does not fetch them, and counts them among the files it would", async () => {
    const wet = await withFont({ sink: memorySink(), media: true, fetch: fakeFetch([]) });
    const dry = await withFont({ sink: memorySink(), media: true, dryRun: true });
    expect(dry.media.downloaded).toBe(0);
    expect(dry.media.planned).toBe(wet.media.planned);
  });

  test("a dry run, or one with the media left out, keeps the fonts an earlier run fetched, in the manifest and on disk", async () => {
    const sink = memorySink();
    await withFont({ sink, media: true, fetch: fakeFetch([]) });
    const fonts = [...sink.files.keys()].filter((p) => p.startsWith("public/fonts/")).sort();
    expect(fonts).toHaveLength(2);
    for (const later of [{ dryRun: true }, { media: false }] as const) {
      const again = await withFont({ sink, media: true, ...later });
      expect(again.files.removed).toEqual([]);
      expect([...sink.files.keys()].filter((p) => p.startsWith("public/fonts/")).sort()).toEqual(
        fonts,
      );
      const manifest = JSON.parse(sink.files.get(MANIFEST_PATH) as string) as {
        files: Record<string, string>;
      };
      for (const font of fonts) expect(manifest.files[font]).toBeDefined();
    }
  });
});

// ── Fluent Forms ─────────────────────────────────────────────────────────────────────────────────

describe("the forms a page draws", () => {
  async function siteWithForms() {
    const opts = await optionsFor("fineline");
    const site = await loadSiteContext({
      db: opts.db!,
      prefix: opts.prefix!,
      cssFrom: opts.cssFrom!,
      ...(typeof opts.pluginFrom === "string" ? { pluginFrom: opts.pluginFrom } : {}),
      componentPrefix: "fp",
      postTypes: ["page", "wp_template", "wp_template_part", "wp_block", "cc_block", "service"],
    });
    return { ...site, forms: await pilotForms() };
  }

  test("their stylesheet is written, linked right after the compatibility sheet, and holds the plugin's rules and the form's own", async () => {
    const plugin = tmp("fluentform-plugin");
    const css = join(plugin, "wp-content", "plugins", "fluentform", "assets", "css");
    mkdirSync(css, { recursive: true });
    writeFileSync(
      join(css, "fluent-forms-public.css"),
      ".fluentform .has-conditions{display:none}",
    );
    writeFileSync(join(css, "fluentform-public-default.css"), ".ff-default .ff-btn{x:y}");
    const sink = memorySink();
    const result = await migrateSite({
      site: await siteWithForms(),
      pluginFrom: plugin,
      wpFrom: false,
      sink,
      now: NOW,
      media: false,
    });
    const sheet = String(sink.files.get("public/css/fluentform.css"));
    expect(sheet).toContain(".fluentform .has-conditions{display:none}");
    expect(sheet).toContain(".ff-default .ff-btn{x:y}");
    expect(sheet).toContain(".fluentform_wrapper_3.ffs_custom_wrap");
    expect(sheet).toContain(".fluentform_wrapper_1.ffs_classic_wrap");
    const head = result.project.$head as { attributes?: { href?: string } }[];
    const hrefs = head.map((h) => h.attributes?.href);
    const at = hrefs.indexOf("/css/fluentform.css");
    expect(at).toBeGreaterThan(-1);
    expect(hrefs.filter((h) => h === "/css/fluentform.css")).toHaveLength(1);
    const first = head.findIndex((h) => h.attributes?.href?.endsWith(".css"));
    expect(at).toBe(first + 1);
    expect(result.report.some((e) => e.code === "form.not-submittable")).toBe(true);
    // the quote page carries the form, the project lists the file it needs
    expect(String(sink.files.get("pages/quote.json"))).toContain("fluentform_wrapper_3");
  });

  test("a site with the bot check on gets Cloudflare's script in the head, once; one without it does not", async () => {
    const plain = await siteWithForms();
    const guarded = {
      ...plain,
      model: {
        ...plain.model,
        options: new Map([
          ...plain.model.options,
          ["cfturnstile_fluent", "on"],
          ["cfturnstile_key", "0xKEY"],
        ]),
      },
    };
    const scripts = (head: unknown): string[] =>
      (head as { tagName: string; attributes?: { src?: string } }[])
        .filter((h) => h.tagName === "script")
        .map((h) => h.attributes?.src ?? "")
        .filter((src) => src.includes("turnstile"));
    const withIt = await migrateSite({
      site: guarded,
      pluginFrom: false,
      wpFrom: false,
      sink: memorySink(),
      now: NOW,
      media: false,
    });
    expect(scripts(withIt.project.$head)).toEqual([
      "https://challenges.cloudflare.com/turnstile/v0/api.js",
    ]);
    const without = await migrateSite({
      site: plain,
      pluginFrom: false,
      wpFrom: false,
      sink: memorySink(),
      now: NOW,
      media: false,
    });
    expect(scripts(without.project.$head)).toEqual([]);
  });

  test("a site that draws no form ships no form stylesheet", async () => {
    const opts = await optionsFor("fineline");
    const site = await loadSiteContext({
      db: opts.db!,
      prefix: opts.prefix!,
      cssFrom: opts.cssFrom!,
      componentPrefix: "fp",
      postTypes: ["page", "wp_template", "wp_template_part"],
    });
    const sink = memorySink();
    const result = await migrateSite({
      site,
      wpFrom: false,
      pluginFrom: false,
      sink,
      now: NOW,
      media: false,
    });
    expect(sink.files.has("public/css/fluentform.css")).toBe(false);
    expect(JSON.stringify(result.project.$head)).not.toContain("fluentform");
  });
});

// ── Interactive Geo Maps ─────────────────────────────────────────────────────────────────────────

describe("the maps a page draws", () => {
  /** The fixture site with every post type it holds (the location template needs its terms), without the maps when asked. */
  async function siteWithMaps(withMaps: boolean) {
    const opts = await optionsFor("fineline");
    const db = await openDb(opts.db!, { prefix: opts.prefix! });
    let types: string[];
    try {
      const rows = await db.query<{ post_type: string }>(
        `select distinct post_type from ${db.table("posts")} order by post_type`,
      );
      types = rows.map((r) => String(r.post_type)).filter((t) => withMaps || t !== "igmap");
    } finally {
      await db.close();
    }
    return loadSiteContext({
      db: opts.db!,
      prefix: opts.prefix!,
      cssFrom: opts.cssFrom!,
      componentPrefix: "fp",
      postTypes: types.filter((t) => !DEFAULT_EXCLUDED_POST_TYPES.includes(t)),
    });
  }

  test("the plugin's stylesheet is written once and linked, and the template prints the map's stage", async () => {
    const plugin = tmp("geomap-plugin");
    const css = join(
      plugin,
      "wp-content",
      "plugins",
      "interactive-geo-maps",
      "assets",
      "public",
      "css",
    );
    mkdirSync(css, { recursive: true });
    writeFileSync(join(css, "styles.min.css"), ".map_wrapper .map_aspect_ratio{height:0}");
    const sink = memorySink();
    const result = await migrateSite({
      site: await siteWithMaps(true),
      pluginFrom: plugin,
      wpFrom: false,
      sink,
      now: NOW,
      media: false,
    });
    expect(String(sink.files.get("public/css/geo-map.css"))).toContain(
      ".map_wrapper .map_aspect_ratio{height:0}",
    );
    const hrefs = (result.project.$head as { attributes?: { href?: string } }[]).map(
      (h) => h.attributes?.href,
    );
    expect(hrefs.filter((h) => h === "/css/geo-map.css")).toHaveLength(1);
    expect(String(sink.files.get("pages/service_area/[slug].json"))).toContain("map_wrapper_3197");
    expect(result.report.some((e) => e.code === "map.not-interactive")).toBe(true);
    expect(result.report.some((e) => e.code === "map.css-missing")).toBe(false);
  });

  test("a map's stylesheet that cannot be read is reported, and the stage keeps its own size", async () => {
    const sink = memorySink();
    const result = await migrateSite({
      site: await siteWithMaps(true),
      pluginFrom: false,
      wpFrom: false,
      sink,
      now: NOW,
      media: false,
    });
    expect(result.report.some((e) => e.code === "map.css-missing")).toBe(true);
    expect(String(sink.files.get("public/css/geo-map.css"))).toContain("height:0");
  });

  test("a site whose database has no map prints nothing for the shortcode and ships no map stylesheet", async () => {
    const sink = memorySink();
    const result = await migrateSite({
      site: await siteWithMaps(false),
      pluginFrom: false,
      wpFrom: false,
      sink,
      now: NOW,
      media: false,
    });
    expect(sink.files.has("public/css/geo-map.css")).toBe(false);
    expect(result.report.some((e) => e.code === "map.missing")).toBe(true);
    expect(JSON.stringify(result.project.$head)).not.toContain("geo-map");
  });
});

// ── The site icon ────────────────────────────────────────────────────────────────────────────────

describe("the site icon", () => {
  async function siteFor(name: SiteName) {
    const opts = await optionsFor(name);
    return loadSiteContext({
      db: opts.db!,
      prefix: opts.prefix!,
      cssFrom: opts.cssFrom!,
      ...(typeof opts.pluginFrom === "string" ? { pluginFrom: opts.pluginFrom } : {}),
      componentPrefix: name === "ap" ? "ap" : "fp",
      postTypes: [
        "page",
        "post",
        "wp_template",
        "wp_template_part",
        "wp_block",
        "cc_block",
        "acf-post-type",
        "acf-taxonomy",
        "acf-field-group",
        "acf-field",
        "wp_navigation",
        "wp_global_styles",
        "custom_css",
      ],
    });
  }
  const withIcon = <T extends Awaited<ReturnType<typeof siteFor>>>(site: T, id: string): T =>
    ({
      ...site,
      model: { ...site.model, options: new Map([...site.model.options, ["site_icon", id]]) },
    }) as T;
  type Head = { tagName: string; attributes?: Record<string, string> }[];
  const icons = (head: Head) =>
    head.filter((h) => h.tagName === "link" && /icon/.test(h.attributes?.rel ?? ""));

  test("the site icon attachment is the icon and the touch icon of every page, and its file is fetched", async () => {
    const site = await siteFor("fineline");
    const attachment = [...site.model.attachments.values()].find(
      (a) => a.mime === "image/jpeg" && site.media.mediaFor(a.id) !== undefined,
    )!;
    const media = site.media.mediaFor(attachment.id)!;
    const sink = memorySink();
    const result = await migrateSite({
      site: withIcon(site, String(attachment.id)),
      sink,
      now: NOW,
      media: true,
      fetch: fakeFetch([]),
    });
    expect(icons(result.project.$head as Head)).toEqual([
      { tagName: "link", attributes: { rel: "icon", href: media.src } },
      { tagName: "link", attributes: { rel: "apple-touch-icon", href: media.src } },
    ]);
    expect(sink.files.has(`public${media.src}`)).toBe(true);
    expect(result.report.some((x) => x.code === "project.site-icon-missing")).toBe(false);
  });

  test("an SVG icon says so, because a browser would otherwise sniff it", async () => {
    const site = await siteFor("ap");
    const svg = [...site.model.attachments.values()].find(
      (a) => a.mime === "image/svg+xml" && site.media.mediaFor(a.id) !== undefined,
    )!;
    const result = await migrateSite({
      site: withIcon(site, String(svg.id)),
      sink: memorySink(),
      now: NOW,
      media: false,
    });
    const found = icons(result.project.$head as Head);
    expect(found[0]!.attributes).toEqual({
      rel: "icon",
      href: site.media.mediaFor(svg.id)!.src,
      type: "image/svg+xml",
    });
    expect(found).toHaveLength(2);
  });

  test("a site with no icon has no icon links, and one whose attachment is not in the media plan says so", async () => {
    const site = await siteFor("fineline");
    const none = await migrateSite({ site, sink: memorySink(), now: NOW, media: false });
    expect(icons(none.project.$head as Head)).toEqual([]);
    expect(none.report.some((x) => x.code === "project.site-icon-missing")).toBe(false);
    const gone = await migrateSite({
      site: withIcon(site, "999999999"),
      sink: memorySink(),
      now: NOW,
      media: false,
    });
    expect(icons(gone.project.$head as Head)).toEqual([]);
    expect(gone.report.find((x) => x.code === "project.site-icon-missing")).toMatchObject({
      severity: "warn",
      where: "option:site_icon",
      data: { id: 999999999 },
    });
    // An option that is not an id is no icon and no finding.
    const junk = await migrateSite({
      site: withIcon(site, "banana"),
      sink: memorySink(),
      now: NOW,
      media: false,
    });
    expect(icons(junk.project.$head as Head)).toEqual([]);
    expect(junk.report.some((x) => x.code === "project.site-icon-missing")).toBe(false);
  });
});

// ── Menus in components ──────────────────────────────────────────────────────────────────────────

describe("a menu inside a component", () => {
  test("is the menu itself, like one in a page or a part, and not a placeholder nobody replaced", async () => {
    const opts = await optionsFor("fineline", { postTypes: ["post"] });
    const site = await loadSiteContext({
      db: opts.db!,
      prefix: opts.prefix!,
      cssFrom: opts.cssFrom!,
      componentPrefix: "fp",
      postTypes: [
        "page",
        "post",
        "wp_template",
        "wp_template_part",
        "wp_block",
        "cc_block",
        "acf-post-type",
        "acf-taxonomy",
        "acf-field-group",
        "acf-field",
        "wp_navigation",
        "wp_global_styles",
        "custom_css",
      ],
    });
    const menu = [...site.model.terms.values()].find((t) => t.taxonomy === "nav_menu")!;
    const component = [...site.model.posts.values()].find((p) => p.type === "cc_block")!;
    const edited = {
      ...site,
      model: {
        ...site.model,
        posts: new Map(site.model.posts).set(component.id, {
          ...component,
          content: `<!-- wp:cwicly/menu {"menuSelected":"${menu.termId}"} /-->`,
        }),
      },
    } as typeof site;
    const sink = memorySink();
    const result = await migrateSite({ site: edited, sink, now: NOW, media: false });
    const tag = [...site.components.values()].find((c) => c.postId === component.id)!.tagName;
    const file = sink.files.get(`components/${tag}.json`) as string;
    expect(file).toContain('"className": "cc-menu hor"');
    expect(file).not.toContain("wp2jx-menu");
    expect(result.report.some((x) => x.code === "placeholder.unresolved")).toBe(false);
  });
});

// ── What nobody named is the live site's ─────────────────────────────────────────────────────────

describe("the live site as the default source", () => {
  /** A `fetch` that records every address and finds nothing, for as long as `run` takes. */
  async function withNoNetwork(run: () => Promise<void>): Promise<string[]> {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = real;
    }
    return urls;
  }

  test("the stylesheets, the plugin's files and the core block CSS are asked of the address the database holds", async () => {
    const { url, prefix } = await fixtureDb("fineline");
    const sink = memorySink();
    const urls = await withNoNetwork(async () => {
      await migrateSite({ db: url, prefix, postTypes: ["post"], sink, media: false, now: NOW });
    });
    const base = "https://finelinepainting.pro";
    expect(urls).toContain(`${base}/wp-content/uploads/cwicly/cc-global-classes.css`);
    expect(urls).toContain(`${base}/wp-content/plugins/cwicly/build/style-index.css`);
    expect(urls).toContain(`${base}/wp-content/themes/cwicly/style.css`);
    expect(urls.some((u) => u.startsWith(`${base}/wp-includes/`))).toBe(true);
    expect(urls.every((u) => u.startsWith(`${base}/`))).toBe(true);
  });

  test("`siteUrl` is where the live site is when it is not where the database says", async () => {
    const { url, prefix } = await fixtureDb("fineline");
    const urls = await withNoNetwork(async () => {
      await migrateSite({
        db: url,
        prefix,
        siteUrl: "https://staging.example.test/",
        postTypes: ["post"],
        sink: memorySink(),
        media: false,
        now: NOW,
      });
    });
    expect(urls.length).toBeGreaterThan(5);
    expect(urls.every((u) => u.startsWith("https://staging.example.test/"))).toBe(true);
    expect(urls.some((u) => u.startsWith("https://finelinepainting.pro"))).toBe(false);
  });

  test("a folder named for the stylesheets is the whole source: the live site is not asked for them", async () => {
    const opts = await optionsFor("fineline", { postTypes: ["post"], sink: memorySink() });
    const urls = await withNoNetwork(async () => {
      await migrateSite(opts);
    });
    expect(urls).toEqual([]);
  });

  test("`false` leaves the plugin's files and the core CSS out, and the report says what is missing", async () => {
    const opts = await optionsFor("fineline", { postTypes: ["post"], sink: memorySink() });
    const urls = await withNoNetwork(async () => {
      const result = await migrateSite({ ...opts, pluginFrom: false, wpFrom: false });
      const codes = result.report.map((x) => x.code);
      expect(codes).toContain("project.compat-missing");
      expect(codes).toContain("project.core-css-skipped");
    });
    expect(urls).toEqual([]);
  });

  test("readSiteUrl reads the siteurl option, trimmed of its slash, and refuses a database without one", async () => {
    const { url, prefix } = await fixtureDb("fineline");
    expect(await readSiteUrl(url, prefix)).toBe("https://finelinepainting.pro");
    const ap = await fixtureDb("ap");
    expect(await readSiteUrl(ap.url)).toBe("https://anabaptistperspectives.org");
  });

  /** A WordPress-shaped SQLite file with the given `siteurl` row (or none). */
  function tinyDb(siteurl: string | undefined): string {
    const path = join(tmp("tinydb"), "wp.sqlite");
    const db = new Database(path, { create: true });
    db.run("create table wp_options (option_id integer, option_name text, option_value text)");
    db.run("create table wp_posts (id integer)");
    db.run("create table wp_postmeta (meta_id integer)");
    db.run("insert into wp_options values (1, 'blogname', 'x')");
    if (siteurl !== undefined) db.run("insert into wp_options values (2, 'siteurl', ?)", [siteurl]);
    db.close();
    return `sqlite:${path}`;
  }

  test("trailing slashes and spaces are trimmed away, and a database with no siteurl is refused with the way out", async () => {
    expect(await readSiteUrl(tinyDb("  https://x.test///  "))).toBe("https://x.test");
    await expect(readSiteUrl(tinyDb(undefined))).rejects.toThrow("pass siteUrl (--site-url)");
    await expect(readSiteUrl(tinyDb("  "))).rejects.toThrow("no siteurl option");
  });
});

// ── package.json ─────────────────────────────────────────────────────────────────────────────────

describe("the project's package.json", () => {
  const installed = (pkg: string): string =>
    `^${(JSON.parse(readFileSync(join(import.meta.dir, "../../node_modules", pkg, "package.json"), "utf8")) as { version: string }).version}`;

  test("the jx scripts, the compiler and runtime to build with, and the parser when there are collections", () => {
    const pkg = JSON.parse(projectPackageJson("Anabaptist Perspectives", true));
    expect(pkg).toEqual({
      name: "anabaptist-perspectives",
      private: true,
      description: "Anabaptist Perspectives, migrated from WordPress by wp2jx",
      type: "module",
      scripts: { build: "jx build", dev: "jx dev", validate: "jx validate" },
      dependencies: { "@jxsuite/parser": installed("@jxsuite/parser") },
      devDependencies: {
        "@jxsuite/compiler": installed("@jxsuite/compiler"),
        "@jxsuite/runtime": installed("@jxsuite/runtime"),
      },
    });
    expect(projectPackageJson("x", false)).not.toContain('dependencies": {\n    "@jxsuite/parser');
    expect(JSON.parse(projectPackageJson("x", false)).dependencies).toBeUndefined();
    expect(projectPackageJson("x", true).endsWith("}\n")).toBe(true);
  });

  test("the name is one npm accepts, whatever the site is called", () => {
    const name = (site: string): string => JSON.parse(projectPackageJson(site, false)).name;
    expect(name("finelinepainting.pro")).toBe("finelinepainting-pro");
    expect(name("  Missions & Evangelism!  ")).toBe("missions-evangelism");
    expect(name("!!!")).toBe("jx-site");
    expect(name("")).toBe("jx-site");
  });

  test("it is written once; a person's edits to it survive every later run, and it is not the manifest's", async () => {
    const dir = tmp("pkg");
    const opts = await optionsFor("fineline", { postTypes: NARROW, out: dir });
    const first = await migrateSite(opts);
    expect(first.files.written).toContain("package.json");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@jxsuite/parser"]).toBe(installed("@jxsuite/parser"));
    pkg.dependencies.lodash = "^4.0.0";
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const second = await migrateSite(opts);
    expect(second.files.written).toEqual([]);
    expect(second.files.unchanged).toContain("package.json");
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies.lodash).toBe(
      "^4.0.0",
    );
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_PATH), "utf8")) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files)).not.toContain("package.json");
    // Even a run that no longer has collections leaves it alone.
    const third = await migrateSite({ ...opts, postTypes: [] });
    expect(third.files.removed).not.toContain("package.json");
    expect(existsSync(join(dir, "package.json"))).toBe(true);
  });
});

describe("the install step", () => {
  test("`install` runs before jx validate, in the output; its failure is in the report and in the result", async () => {
    const dir = tmp("install");
    const script = join(tmp("fakeinstall"), "install.js");
    writeFileSync(
      script,
      'require("node:fs").writeFileSync("installed-here.txt", `${require("node:fs").existsSync("project.json")}`); console.error("error: no network"); process.exit(1);',
    );
    const result = await migrateSite({
      ...(await optionsFor("fineline", { postTypes: ["post"], out: dir })),
      verify: { install: true, installCmd: [process.execPath, script], validate: true },
    });
    // It ran in the output, after the project was written.
    expect(readFileSync(join(dir, "installed-here.txt"), "utf8")).toBe("true");
    expect(result.verify!.install!.ok).toBe(false);
    expect(result.verify!.validate!.ok).toBe(true);
    expect(result.report.find((x) => x.code === "jx.install-failed")).toMatchObject({
      severity: "error",
      message: expect.stringContaining("no network"),
    });
  });

  test("with `install` unset nothing is installed", async () => {
    const dir = tmp("noinstall");
    const result = await migrateSite({
      ...(await optionsFor("fineline", { postTypes: ["post"], out: dir })),
      verify: { validate: true },
    });
    expect(result.verify!.install).toBeUndefined();
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });
});

// ── What the review of the assembly found ────────────────────────────────────────────────────────

/** A loaded site, for the tests that change what the database says (its addresses) or hand `migrateSite` a site. */
async function siteOf(name: SiteName, types: string[] = ["post"]) {
  const opts = await optionsFor(name);
  return loadSiteContext({
    db: opts.db!,
    prefix: opts.prefix!,
    cssFrom: opts.cssFrom!,
    ...(typeof opts.pluginFrom === "string" ? { pluginFrom: opts.pluginFrom } : {}),
    componentPrefix: name === "ap" ? "ap" : "fp",
    postTypes: [...new Set([...STRUCTURAL_POST_TYPES, ...types])],
  });
}

describe("jx build as part of a run", () => {
  /** A jx that encodes `images` images, one line each, and builds. */
  function fakeBuild(images: number): string {
    const bin = join(tmp("fake-jx"), "jx.js");
    writeFileSync(
      bin,
      [
        'if (process.argv[2] === "build") {',
        `  for (let i = 1; i <= ${images}; i++) console.log("    Optimizing photo-" + i + ".jpg...");`,
        '  console.log("Done: 1 routes → 1 files");',
        "}",
      ].join("\n"),
    );
    return bin;
  }

  test("the lines of the build are progress of the verify phase, and the images are counted, not echoed", async () => {
    const bin = fakeBuild(60);
    const events: { phase: string; message: string }[] = [];
    const result = await migrateSite({
      ...(await optionsFor("fineline", { postTypes: ["post"] })),
      out: tmp("build-progress"),
      verify: { build: true, jx: { bin } },
      progress: (event) => void events.push(event),
    });
    expect(result.verify!.build!.ok).toBe(true);
    const said = events.filter((e) => e.message.startsWith("jx build: ")).map((e) => e.message);
    expect(said).toEqual([
      "jx build: optimising images: 1 so far (now photo-1.jpg)",
      "jx build: optimising images: 25 so far (now photo-25.jpg)",
      "jx build: optimising images: 50 so far (now photo-50.jpg)",
      "jx build: Done: 1 routes → 1 files",
    ]);
    expect(
      events.filter((e) => e.message.startsWith("jx build: ")).every((e) => e.phase === "verify"),
    ).toBe(true);
  });

  test("the limit is half an hour at least and grows with the media the pages use; a limit the caller sets is kept", async () => {
    const bin = fakeBuild(0);
    const run = async (extra: Partial<MigrateOptions>, jx: JxOptions = {}) =>
      migrateSite({
        ...(await optionsFor("fineline", extra)),
        out: tmp("build-limit"),
        verify: { build: true, jx: { bin, ...jx } },
      });
    // A few posts use a hundred and some files, which fit in the least a build is given.
    const few = await run({ postTypes: ["post"] });
    expect(few.media.planned).toBeLessThan(MIN_BUILD_TIMEOUT_MS / BUILD_MS_PER_MEDIA_FILE);
    expect(few.verify!.build!.timeoutMs).toBe(MIN_BUILD_TIMEOUT_MS);
    // The whole site uses more than they would, and the limit follows what the pages plan, not what was downloaded.
    const all = await run({});
    expect(all.media.planned).toBeGreaterThan(MIN_BUILD_TIMEOUT_MS / BUILD_MS_PER_MEDIA_FILE);
    expect(all.verify!.build!.timeoutMs).toBe(buildTimeoutFor({ files: all.media.planned }));
    expect(all.verify!.build!.timeoutMs).toBeGreaterThan(MIN_BUILD_TIMEOUT_MS);
    // One the caller sets is kept, shorter or longer.
    expect(
      (await run({ postTypes: ["post"] }, { timeoutMs: 123_000 })).verify!.build!.timeoutMs,
    ).toBe(123_000);
    expect((await run({}, { timeoutMs: 99 * 3_600_000 })).verify!.build!.timeoutMs).toBe(
      99 * 3_600_000,
    );
  });
});

describe("verification judges the tree the run leaves behind", () => {
  test("jx runs after the stale files are removed, never before", async () => {
    const dir = tmp("verify-order");
    const log = join(tmp("verify-log"), "calls.log");
    const bin = join(tmp("fake-jx"), "jx.js");
    writeFileSync(
      bin,
      [
        'const fs = require("node:fs");',
        'const stale = fs.existsSync("content/service") ? "present" : "absent";',
        "fs.appendFileSync(process.env.WP2JX_TEST_LOG, `${process.argv[2]} service=${stale}\\n`);",
        'if (process.argv[2] === "build") console.log("Done: 1 routes → 1 files");',
        'if (process.argv[2] === "validate") console.log("Project is valid (1 files checked in .)");',
      ].join("\n"),
    );
    await migrateSite(await optionsFor("fineline", { postTypes: ["service", "post"], out: dir }));
    expect(existsSync(join(dir, "content/service"))).toBe(true);
    const second = await migrateSite({
      ...(await optionsFor("fineline", { postTypes: ["post"], out: dir })),
      verify: { validate: true, build: true, jx: { bin, env: { WP2JX_TEST_LOG: log } } },
    });
    expect(second.files.removed.some((f) => f.startsWith("content/service/"))).toBe(true);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toEqual([
      "schema service=absent",
      "validate service=absent",
      "build service=absent",
    ]);
  });

  test("a real jx build after a narrower run reports what a clean run reports, and ships no page of a removed type", async () => {
    const dir = tmp("verify-real");
    const clean = tmp("verify-clean");
    await migrateSite(await optionsFor("fineline", { postTypes: ["service", "post"], out: dir }));
    const verify = { validate: true, build: true } as const;
    const second = await migrateSite({
      ...(await optionsFor("fineline", { postTypes: ["post"], out: dir })),
      verify,
    });
    const fresh = await migrateSite({
      ...(await optionsFor("fineline", { postTypes: ["post"], out: clean })),
      verify,
    });
    expect(second.verify!.build!.routes).toBe(fresh.verify!.build!.routes);
    expect(second.verify!.build!.issues).toBe(fresh.verify!.build!.issues);
    expect(second.report.some((x) => /content type "service"/.test(x.message))).toBe(false);
    expect(existsSync(join(dir, "dist/service"))).toBe(false);
  });
});

describe("the image settings of project.json", () => {
  test("Jx's own settings up to the threshold, WebP alone above it, and the caller's word over either", () => {
    expect(imageSettings(0)).toBeUndefined();
    expect(imageSettings(HEAVY_IMAGE_COUNT)).toBeUndefined();
    expect(imageSettings(HEAVY_IMAGE_COUNT + 1)).toEqual({ formats: ["webp"] });
    expect(imageSettings(5000)).toEqual({ formats: ["webp"] });
    const given = { formats: ["webp", "avif"], widths: [640] };
    expect(imageSettings(5000, given)).toBe(given);
    expect(imageSettings(0, given)).toBe(given);
    // `{}` is "Jx's own", whatever the size.
    expect(imageSettings(5000, {})).toBeUndefined();
  });

  const migrated = (extra: Partial<MigrateOptions> = {}): Promise<MigrationResult> =>
    optionsFor("fineline", { postTypes: ["post"], sink: memorySink(), ...extra }).then(migrateSite);

  test("a media-heavy site asks for WebP only, says so as information with the numbers, and puts the question to the owner", async () => {
    const result = await migrated();
    expect(result.project.images).toEqual({ formats: ["webp"] });
    const said = result.report.filter((e) => e.code === "project.images-formats");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ severity: "info", where: "project.json" });
    expect(said[0]!.data!.images as number).toBeGreaterThan(HEAVY_IMAGE_COUNT);
    expect(said[0]!.data).toMatchObject({ threshold: HEAVY_IMAGE_COUNT, formats: ["webp"] });
    expect(said[0]!.message).toContain("AVIF");
    expect(said[0]!.message).toContain("images.formats");
    // The way to change it lasts across runs; an edit to the regenerated project.json does not.
    expect(said[0]!.message).toContain("--image-formats webp,avif");
    const decision = result.decisions.find((d) => d.id === "images")!;
    expect(decision.codes).toEqual(["project.images-formats"]);
    expect(decision.question).toContain("--image-formats webp,avif");
    expect(decision.examples).toEqual([
      `project.json: ${said[0]!.data!.images as number} images, WebP only`,
    ]);
    // It is in the report file the owner reads, with the decision on top.
    const sink = memorySink();
    await migrated({ sink });
    expect(String(sink.files.get(REPORT_MD_PATH))).toContain("Image formats of the build");
    // And in `project.json`, before `build`.
    const keys = Object.keys(JSON.parse(String(sink.files.get("project.json"))));
    expect(keys.indexOf("images")).toBeGreaterThan(-1);
    expect(keys.indexOf("images")).toBeLessThan(keys.indexOf("build"));
  });

  test("`images: {}` leaves Jx's defaults alone and says nothing; settings the caller gives are written as given, and said nothing about", async () => {
    const own = await migrated({ images: {} });
    expect(own.project).not.toHaveProperty("images");
    expect(own.report.some((e) => e.code === "project.images-formats")).toBe(false);
    expect(own.decisions.some((d) => d.id === "images")).toBe(false);
    const given = { formats: ["webp", "avif"], widths: [640, 1280], quality: { avif: 50 } };
    const set = await migrated({ images: given });
    expect(set.project.images).toEqual(given);
    expect(set.report.some((e) => e.code === "project.images-formats")).toBe(false);
  });
});

describe("a database password that is an ordinary word", () => {
  test("whole tokens only: `post` masks the password, not `posts` or `pages`", () => {
    expect(redactText("11 pages, post 5, posts", ["post"])).toBe("11 pages, *** 5, posts");
    expect(redactText("page.password-protected", ["password"])).toBe("page.***-protected");
    // A secret that ends in a symbol has no word to mistake it for: matched anywhere.
    expect(redactText("x p4ss&!y", ["p4ss&!"])).toBe("x ***y");
    expect(redactText("a.b+c a.b+c", ["a.b+c"])).toBe("*** ***");
  });

  test("an entry's code and severity are never rewritten, and a location keeps its kind", () => {
    const entry: ReportEntry = {
      severity: "warn",
      code: "page.password-protected",
      message: "the page is password protected",
      where: "page:post:12",
      url: "https://x.test/page/",
      data: { type: "page", kind: "post" },
    };
    expect(redactEntry(entry, ["password"])).toEqual({
      ...entry,
      message: "the page is *** protected",
    });
    expect(redactEntry(entry, ["page", "post"])).toEqual({
      ...entry,
      message: "the *** is password protected",
      where: "page:***:12",
      url: "https://x.test/***/",
      data: { type: "***", kind: "***" },
    });
    expect(redactEntry(entry, [])).toBe(entry);
  });

  test.each(["page", "post", "password"])(
    "with %p as the password the run keeps its codes, locations and decisions, and the files hold no password",
    async (word) => {
      const site = await siteOf("fineline", ["post", "service"]);
      const common = { site, now: NOW, media: false } as const;
      const plain = await migrateSite({ ...common, sink: memorySink() });
      const sink = memorySink();
      const masked = await migrateSite({
        ...common,
        db: `mysql://wp:${word}@db.example.com/wp`,
        sink,
      });
      expect(masked.report.map((x) => x.code)).toEqual(plain.report.map((x) => x.code));
      expect(masked.report.map((x) => x.severity)).toEqual(plain.report.map((x) => x.severity));
      expect(masked.report.map((x) => x.where?.split(":")[0])).toEqual(
        plain.report.map((x) => x.where?.split(":")[0]),
      );
      expect(masked.decisions.map((d) => [d.id, d.count, d.codes])).toEqual(
        plain.decisions.map((d) => [d.id, d.count, d.codes]),
      );
      expect(plain.decisions.length).toBeGreaterThan(0);
      const json = JSON.parse(sink.files.get(REPORT_JSON_PATH) as string) as {
        entries: ReportEntry[];
      };
      expect(json.entries.every((x) => !x.code.includes("***"))).toBe(true);
    },
  );
});

describe("what a person edited, and what is not the tool's to overwrite", () => {
  test("the .gitignore is a seed: written once with the image cache in it, never rewritten, not in the manifest", async () => {
    expect(GITIGNORE).toBe("dist/\nnode_modules/\n.cache/\n");
    const sink = memorySink();
    const opts = await optionsFor("fineline", { postTypes: NARROW, sink });
    const first = await migrateSite(opts);
    expect(sink.files.get(".gitignore")).toBe(GITIGNORE);
    expect(first.files.written).toContain(".gitignore");
    sink.files.set(".gitignore", `${GITIGNORE}.env\n.wrangler/\n`);
    const second = await migrateSite(opts);
    expect(sink.files.get(".gitignore")).toBe(`${GITIGNORE}.env\n.wrangler/\n`);
    expect(second.files.unchanged).toContain(".gitignore");
    expect(second.files.written).toEqual([]);
    const manifest = JSON.parse(sink.files.get(MANIFEST_PATH) as string) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files)).not.toContain(".gitignore");
  });

  test("a project an earlier version wrote, with .gitignore in its manifest, keeps it when it becomes a seed", async () => {
    const sink = memorySink();
    const opts = await optionsFor("fineline", { postTypes: NARROW, sink });
    await migrateSite(opts);
    const manifest = JSON.parse(sink.files.get(MANIFEST_PATH) as string) as {
      files: Record<string, string>;
    };
    manifest.files[".gitignore"] = sha(GITIGNORE);
    sink.files.set(MANIFEST_PATH, JSON.stringify(manifest));
    const again = await migrateSite(opts);
    expect(again.files.removed).toEqual([]);
    expect(sink.files.get(".gitignore")).toBe(GITIGNORE);
  });

  test("a file the run produces again that was edited is overwritten, and said; a clean re-run says nothing", async () => {
    const sink = memorySink();
    const opts = await optionsFor("fineline", { postTypes: NARROW, sink });
    await migrateSite(opts);
    const path = [...sink.files.keys()].find((p) => p.startsWith("content/service/"))!;
    const original = sink.files.get(path) as string;
    sink.files.set(path, `${original}\nedited by a person\n`);
    const second = await migrateSite(opts);
    expect(sink.files.get(path)).toBe(original);
    expect(second.files.written).toContain(path);
    const note = second.report.filter((x) => x.code === "project.edited-overwritten");
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({ severity: "warn", where: path });
    const third = await migrateSite(opts);
    expect(third.report.some((x) => x.code === "project.edited-overwritten")).toBe(false);
  });

  test("a file with no manifest entry is not claimed to have been edited", async () => {
    const sink = memorySink();
    const opts = await optionsFor("fineline", { postTypes: NARROW, sink });
    await migrateSite(opts);
    const path = [...sink.files.keys()].find((p) => p.startsWith("content/service/"))!;
    const manifest = JSON.parse(sink.files.get(MANIFEST_PATH) as string) as {
      files: Record<string, string>;
    };
    delete manifest.files[path];
    sink.files.set(MANIFEST_PATH, JSON.stringify(manifest));
    sink.files.set(path, "somebody's");
    const second = await migrateSite(opts);
    expect(second.report.some((x) => x.code === "project.edited-overwritten")).toBe(false);
  });
});

describe("a write that fails halfway", () => {
  /** A sink whose write of one path fails the way a file named like a directory does. */
  function failingAt(base: ReturnType<typeof memorySink>, at: string): ProjectSink {
    return {
      ...base,
      async write(path, data) {
        if (path === at) throw new Error(`ENOTDIR: not a directory, mkdir '${path}'`);
        return base.write(path, data);
      },
    };
  }

  test("names the file and the operation, records what was written in a manifest, and the next run goes on from there", async () => {
    const base = memorySink();
    const opts = await optionsFor("fineline", { postTypes: NARROW });
    await expect(
      migrateSite({ ...opts, sink: failingAt(base, "pages/index.json") }),
    ).rejects.toThrow("could not write pages/index.json: ENOTDIR");
    const manifest = JSON.parse(base.files.get(MANIFEST_PATH) as string) as {
      generator: string;
      files: Record<string, string>;
    };
    expect(manifest.generator).toBe("wp2jx");
    const claimed = Object.keys(manifest.files);
    expect(claimed.length).toBeGreaterThan(5);
    expect(claimed).not.toContain("pages/index.json");
    expect(claimed).not.toContain("project.json");
    for (const path of claimed) expect(manifest.files[path]).toBe(sha(base.files.get(path)!));
    const second = await migrateSite({ ...opts, sink: base });
    expect(second.files.written).toContain("pages/index.json");
    expect(second.files.unchanged.length).toBeGreaterThanOrEqual(claimed.length);
    expect(base.files.has("project.json")).toBe(true);
  });

  test("a failure while the reports are written leaves a manifest too", async () => {
    const base = memorySink();
    const opts = await optionsFor("fineline", { postTypes: NARROW });
    await expect(migrateSite({ ...opts, sink: failingAt(base, REPORT_MD_PATH) })).rejects.toThrow(
      `could not write ${REPORT_MD_PATH}`,
    );
    const manifest = JSON.parse(base.files.get(MANIFEST_PATH) as string) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files)).toContain("project.json");
  });
});

describe("a file somebody else put in the project", () => {
  test("media that was already there with no manifest entry is used as found, said, and never removed by a later run", async () => {
    const fetchFor = () => ({ media: true, fetch: fakeFetch([]) }) as const;
    const only = async (types: string[]): Promise<string[]> => {
      const sink = memorySink();
      await migrateSite(await optionsFor("fineline", { postTypes: types, sink, ...fetchFor() }));
      return [...sink.files.keys()].filter((p) => p.startsWith("public/media/"));
    };
    const withService = await only(["service"]);
    const withPost = new Set(await only(["post"]));
    const serviceOnly = withService.find((p) => !withPost.has(p))!;
    expect(serviceOnly).toBeDefined();

    const sink = memorySink();
    sink.files.set(serviceOnly, "somebody's own copy");
    const first = await migrateSite(
      await optionsFor("fineline", { postTypes: ["service"], sink, ...fetchFor() }),
    );
    expect(sink.files.get(serviceOnly)).toBe("somebody's own copy");
    const manifest = JSON.parse(sink.files.get(MANIFEST_PATH) as string) as {
      files: Record<string, string>;
    };
    expect(Object.keys(manifest.files)).not.toContain(serviceOnly);
    expect(first.report.find((x) => x.code === "project.media-not-adopted")).toMatchObject({
      severity: "info",
      data: { files: 1, examples: [serviceOnly] },
    });
    const second = await migrateSite(
      await optionsFor("fineline", { postTypes: ["post"], sink, ...fetchFor() }),
    );
    expect(second.files.removed).not.toContain(serviceOnly);
    expect(sink.files.get(serviceOnly)).toBe("somebody's own copy");
    // The media this tool did write for the service entries is its own, and went.
    expect(second.files.removed.some((p) => p.startsWith("public/media/"))).toBe(true);
  });
});

describe("the address of the migrated site", () => {
  // The report's addresses are the source site's, by design: only the project's own files are judged.
  const strangers = (sink: ReturnType<typeof memorySink>, host: string): string[] =>
    [...sink.files]
      .filter(([p, c]) => !p.startsWith("migration-report.") && typeof c === "string")
      .filter(([, c]) => (c as string).includes(host))
      .map(([p]) => p);

  test("`siteUrl` is the public address of project.json and of every canonical, though the database says another", async () => {
    const site = await siteOf("fineline", ["post"]);
    const staged = {
      ...site,
      model: {
        ...site.model,
        site: {
          ...site.model.site,
          url: "https://staging.example.com",
          home: "https://staging.example.com",
        },
      },
    } as typeof site;
    const sink = memorySink();
    const result = await migrateSite({
      site: staged,
      siteUrl: "https://finelinepainting.pro",
      sink,
      now: NOW,
      media: false,
    });
    expect(result.project.url).toBe("https://finelinepainting.pro");
    expect(strangers(sink, "staging.example.com")).toEqual([]);
    const about = sink.files.get("pages/about-us.json") as string;
    expect(about).toContain("https://finelinepainting.pro/about-us/");
  });

  test("a WordPress in a subdirectory is served at its home, not at the address WordPress lives at", async () => {
    const site = await siteOf("fineline", ["post"]);
    const sub = {
      ...site,
      model: {
        ...site.model,
        site: {
          ...site.model.site,
          url: "https://finelinepainting.pro/wp",
          home: "https://finelinepainting.pro",
        },
      },
    } as typeof site;
    const sink = memorySink();
    const result = await migrateSite({ site: sub, sink, now: NOW, media: false });
    expect(result.project.url).toBe("https://finelinepainting.pro");
    expect(strangers(sink, "finelinepainting.pro/wp")).toEqual([]);
  });

  test("with neither, the address is `home`, as the pages' canonicals already were", async () => {
    const site = await siteOf("fineline", ["post"]);
    const result = await migrateSite({ site, sink: memorySink(), now: NOW, media: false });
    expect(result.project.url).toBe(site.model.site.home.replace(/\/+$/, ""));
  });
});

describe("the site an output directory belongs to", () => {
  test("another site's project is refused before anything is written, and replaced only with force", async () => {
    const sink = memorySink();
    await migrateSite(await optionsFor("fineline", { postTypes: NARROW, sink }));
    const manifest = JSON.parse(sink.files.get(MANIFEST_PATH) as string) as {
      site: string;
      files: Record<string, string>;
    };
    expect(manifest.site).toBe("https://finelinepainting.pro");
    const before = new Map(sink.files);

    const ap = await optionsFor("ap", { postTypes: ["post"], sink });
    await expect(migrateSite(ap)).rejects.toThrow(
      "holds the project of https://finelinepainting.pro",
    );
    expect(sink.files).toEqual(before);

    const forced = await migrateSite({ ...ap, force: true });
    expect(forced.files.removed.length).toBeGreaterThan(50);
    expect(forced.report.find((x) => x.code === "project.site-changed")).toMatchObject({
      severity: "warn",
      data: { before: "https://finelinepainting.pro", after: "https://anabaptistperspectives.org" },
    });
    expect(sink.files.has("content/service/notes.txt")).toBe(false);
    expect(JSON.parse(sink.files.get(MANIFEST_PATH) as string).site).toBe(
      "https://anabaptistperspectives.org",
    );
  });

  test("a manifest from before it named the site is no reason to refuse", async () => {
    const sink = memorySink();
    await migrateSite(await optionsFor("fineline", { postTypes: NARROW, sink }));
    const manifest = JSON.parse(sink.files.get(MANIFEST_PATH) as string) as {
      site?: string;
      files: Record<string, string>;
    };
    delete manifest.site;
    sink.files.set(MANIFEST_PATH, JSON.stringify(manifest));
    const again = await migrateSite(await optionsFor("ap", { postTypes: ["post"], sink }));
    expect(again.files.written.length).toBeGreaterThan(0);
  });

  test("the same site again is no other site", async () => {
    const sink = memorySink();
    const opts = await optionsFor("fineline", { postTypes: NARROW, sink });
    await migrateSite(opts);
    const again = await migrateSite(opts);
    expect(again.report.some((x) => x.code === "project.site-changed")).toBe(false);
  });
});

describe("a package.json that was already there", () => {
  const withPackage = async (text: string, types = NARROW) => {
    const sink = memorySink();
    sink.files.set("package.json", text);
    const result = await migrateSite(await optionsFor("fineline", { postTypes: types, sink }));
    return { sink, result };
  };

  test("one that lacks the parser a collection needs is a warning naming it, and is not rewritten", async () => {
    const { sink, result } = await withPackage('{"name":"mine"}');
    expect(sink.files.get("package.json")).toBe('{"name":"mine"}');
    const parser = result.report.find((x) => x.code === "project.package-missing-parser");
    expect(parser).toMatchObject({ severity: "warn", where: "package.json" });
    expect(parser!.message).toContain("prototype-resolver");
    expect(result.report.find((x) => x.code === "project.package-missing-jx")).toMatchObject({
      data: { packages: ["@jxsuite/compiler", "@jxsuite/runtime"] },
    });
  });

  test("one that names what the project needs, in either kind of dependency, is not mentioned", async () => {
    const { result } = await withPackage(
      JSON.stringify({
        dependencies: { "@jxsuite/parser": "^1.0.0" },
        devDependencies: { "@jxsuite/compiler": "^4.0.0", "@jxsuite/runtime": "^4.0.0" },
      }),
    );
    expect(result.report.some((x) => x.code.startsWith("project.package-"))).toBe(false);
  });

  test("one that is not JSON is said, not guessed at", async () => {
    const { result } = await withPackage("{ nope");
    expect(result.report.find((x) => x.code === "project.package-unreadable")).toMatchObject({
      severity: "warn",
    });
    expect(result.report.some((x) => x.code === "project.package-missing-parser")).toBe(false);
  });

  test("the one this tool writes is complete, so a first run says nothing", async () => {
    const sink = memorySink();
    const result = await migrateSite(await optionsFor("fineline", { postTypes: NARROW, sink }));
    expect(result.report.some((x) => x.code.startsWith("project.package-"))).toBe(false);
  });
});

describe("addresses the migrated site does serve", () => {
  const unresolved = (url: string, reason = "no-route"): ReportEntry => ({
    severity: "warn",
    code: "url.unresolved",
    message: "A link to this site that no page accounts for.",
    where: "post:1",
    url,
    data: { url, reason },
  });

  test("a redirect source is found as an exact address, a pattern or a parameter, never through a query string", () => {
    const redirects = {
      "/agricultural": "/service/barn-painting/",
      "/docs/*": { destination: "/documentation/:splat", status: 301 },
      "/user/:id": "/people/:id",
      "/q?x=1": "/nope/",
    };
    expect(redirectDestination(redirects, "https://x.test/agricultural/")).toBe(
      "/service/barn-painting/",
    );
    expect(redirectDestination(redirects, "/AGRICULTURAL")).toBe("/service/barn-painting/");
    expect(redirectDestination(redirects, "https://x.test/docs/a/b/")).toBe(
      "/documentation/:splat",
    );
    expect(redirectDestination(redirects, "/user/7/")).toBe("/people/:id");
    expect(redirectDestination(redirects, "/user/7/posts/")).toBeUndefined();
    expect(redirectDestination(redirects, "/agricultural/?x=1")).toBeUndefined();
    expect(redirectDestination(redirects, "/q/")).toBeUndefined();
    expect(redirectDestination(redirects, "/else/")).toBeUndefined();
  });

  test("a page this run wrote is no finding, a redirect source is information, anything else stays", () => {
    const entries = [
      unresolved("https://x.test/search/", "search"),
      unresolved("https://x.test/agricultural/"),
      unresolved("https://x.test/old/deep/page/"),
      unresolved("https://x.test/nope/"),
      unresolved("https://x.test/search/?s=paint", "search"),
      { ...unresolved("https://x.test/about/#team"), code: "link.unresolved" },
    ];
    const out = settleUnresolved(entries, new Set(["/search/", "/about/"]), {
      "/agricultural": "/service/barn-painting/",
      "/old/*": "/new/:splat",
    });
    expect(out.map((e) => [e.code, e.severity, e.url])).toEqual([
      ["url.redirected", "info", "https://x.test/agricultural/"],
      ["url.redirected", "info", "https://x.test/old/deep/page/"],
      ["url.unresolved", "warn", "https://x.test/nope/"],
      ["url.unresolved", "warn", "https://x.test/search/?s=paint"],
      ["link.unresolved", "warn", "https://x.test/about/#team"],
    ]);
    expect(out[0]).toMatchObject({
      where: "post:1",
      data: { url: "https://x.test/agricultural/", destination: "/service/barn-painting/" },
    });
    expect(out[0]!.message).toContain("/service/barn-painting/");
  });

  test.each(SITES)("%s: no unresolved address is one the built site serves", async (name) => {
    await ensure(name);
    const { result } = full.get(name)!;
    const redirects = (result.project.redirects ?? {}) as Record<string, string>;
    const left = result.report.filter((x) => x.code === "url.unresolved");
    for (const entry of left) {
      expect(redirectDestination(redirects, entry.url!)).toBeUndefined();
      expect(new URL(entry.url!, "https://x.test").pathname).not.toBe("/search/");
    }
    const settled = result.report.filter((x) => x.code === "url.redirected");
    expect(settled.length).toBeGreaterThan(0);
    for (const entry of settled) {
      expect(entry.severity).toBe("info");
      expect(redirectDestination(redirects, entry.url!)).toBe(entry.data!.destination as string);
    }
    // The owner's question counts only what is left.
    const urls = result.decisions.find((d) => d.id === "urls");
    expect(urls?.count ?? 0).toBe(
      left.length + result.report.filter((x) => x.code === "link.unresolved").length,
    );
  });
});

describe("constants the assembly shares with the rest", () => {
  test("the current-page script is written where the head links it, and holds the menus' own script", async () => {
    expect(CURRENT_PAGE_JS_PATH).toBe("public/js/wp2jx-current-page.js");
    await ensure("fineline");
    expect(read("fineline", CURRENT_PAGE_JS_PATH)).toBe(`${CURRENT_PAGE_SCRIPT}\n`);
  });

  test("pages and posts, the block templates and parts, components and the ACF definitions are always converted", async () => {
    for (const type of [
      "page",
      "post",
      "wp_template",
      "wp_template_part",
      "wp_block",
      "cc_block",
      "acf-post-type",
      "acf-taxonomy",
      "acf-field-group",
      "acf-field",
    ]) {
      expect(STRUCTURAL_POST_TYPES).toContain(type);
    }
    // Asked for the services alone, the run still writes the posts: `postTypes` adds content types.
    const sink = memorySink();
    await migrateSite(await optionsFor("fineline", { postTypes: ["service"], sink }));
    const kinds = new Set(
      [...sink.files.keys()].filter((p) => p.startsWith("content/")).map((p) => p.split("/")[1]),
    );
    expect(kinds.has("service")).toBe(true);
    expect(kinds.has("post")).toBe(true);
    expect(kinds.has("project")).toBe(false);
  });
});
