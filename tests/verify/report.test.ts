/**
 * The report: aggregation by code and by property, the worst pages, the systematic differences
 * sorted for a fix loop, the Markdown, and the images of the worst pages (kept, moved, indexed).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReport,
  keepWorstImages,
  renderMarkdown,
  ShotKeeper,
  shotsDir,
  stats,
  writeReport,
} from "../../src/verify/report.ts";
import type { Finding, UrlResult, ViewportResult, VisualResult } from "../../src/verify/types.ts";
import { TMP_ROOT } from "../helpers/jx-build.ts";

const visual = (fidelity: number, aboveFold = fidelity): VisualResult => ({
  fidelity,
  aboveFold,
  width: 1366,
  height: 3000,
  liveHeight: 3000,
  localHeight: 3100,
  mismatchedPixels: 10,
  totalPixels: 100,
  tolerance: 0.1,
  bands: [],
});

const view = (
  width: number,
  fidelity: number | undefined,
  findings: Finding[] = [],
): ViewportResult => ({
  width,
  findings,
  ...(fidelity === undefined ? {} : { visual: visual(fidelity) }),
  liveStatus: 200,
  localStatus: 200,
  liveFinalUrl: "",
  localFinalUrl: "",
});

const systematic = (
  group: string,
  property: string,
  live: string,
  local: string,
  count: number,
  viewport = 1366,
): Finding => ({
  code: "style.systematic",
  severity: "warning",
  viewport,
  message: `${count} differ`,
  property,
  live,
  local,
  count,
  selector: `body > ${group.split(" > ")[1]}:nth-child(2)`,
  data: { group, elements: count + 1 },
});

const result = (
  path: string,
  slug: string,
  fidelities: (number | undefined)[],
  findings: Finding[] = [],
  viewportFindings: Finding[][] = [],
): UrlResult => {
  const widths = [1366, 390];
  const viewports = fidelities.map((f, i) =>
    view(widths[i] as number, f, viewportFindings[i] ?? []),
  );
  const scored = fidelities.filter((f): f is number => f !== undefined);
  return {
    url: `https://site.test${path}`,
    path,
    slug,
    viewports,
    fidelity: scored.length === 0 ? null : scored.reduce((a, b) => a + b, 0) / scored.length,
    findings,
  };
};

const results: UrlResult[] = [
  result("/", "index", [0.99, 0.97], [], [[], []]),
  result(
    "/about/",
    "about",
    [0.9, 0.8],
    [
      {
        code: "meta.title",
        severity: "warning",
        viewport: null,
        message: "titles differ",
        live: "A",
        local: "B",
      },
    ],
    [
      [
        systematic("nav > a", "fontFamily", "Arial", "Verdana", 5),
        {
          code: "image.missing",
          severity: "error",
          viewport: 1366,
          message: "1 image missing",
          count: 1,
        },
      ],
      [systematic("nav > a", "fontFamily", "Arial", "Verdana", 5, 390)],
    ],
  ),
  result(
    "/services/",
    "services",
    [0.6, 0.5],
    [],
    [
      [
        systematic("nav > a", "fontFamily", "Arial", "Verdana", 5),
        systematic("body > p".replace("body", "main"), "fontSize", "20px", "16px", 12),
      ],
      [
        {
          code: "style.mismatch",
          severity: "info",
          viewport: 390,
          message: "2 differ",
          property: "color",
          live: "rgb(0, 0, 0)",
          local: "rgb(10, 10, 10)",
          count: 2,
        },
      ],
    ],
  ),
  result(
    "/lost/",
    "lost",
    [undefined, undefined],
    [
      {
        code: "page.load-failed",
        severity: "error",
        viewport: null,
        message: "the migrated page could not be captured",
        data: { side: "local" },
      },
    ],
  ),
];

const report = () =>
  buildReport({
    live: "https://site.test",
    project: "/p",
    viewports: [1366, 390],
    tolerance: 0.1,
    results,
    skipped: [{ url: "https://site.test/archive/", reason: "not served" }],
    listed: 6,
    imageCount: 2,
    generatedAt: "2026-10-05T00:00:00.000Z",
  });

describe("stats", () => {
  test("mean, median (even and odd counts), min and max, rounded; nothing for nothing", () => {
    expect(stats([0.5, 1, 0.9])).toEqual({ mean: 0.8, median: 0.9, min: 0.5, max: 1 });
    expect(stats([0.2, 0.4])).toEqual({ mean: 0.3, median: 0.3, min: 0.2, max: 0.4 });
    expect(stats([])).toBeNull();
  });
});

describe("buildReport", () => {
  test("counts what was compared, skipped and not captured, and summarises fidelity per viewport", () => {
    const s = report().summary;
    expect(s).toMatchObject({ listed: 6, compared: 3, skipped: 1, failed: 1 });
    expect(s.fidelity?.min).toBeCloseTo(0.55, 3);
    expect(s.fidelity?.max).toBeCloseTo(0.98, 3);
    expect(s.byViewport["1366"]).toMatchObject({ min: 0.6, max: 0.99 });
    expect(s.byViewport["390"]).toMatchObject({ min: 0.5, max: 0.97 });
    expect(s.aboveFold?.mean).toBeCloseTo((0.99 + 0.97 + 0.9 + 0.8 + 0.6 + 0.5) / 6, 3);
  });

  test("the worst pages come first, with their viewports and their most serious finding", () => {
    const { worst } = report().summary;
    expect(worst.map((w) => w.path)).toEqual(["/services/", "/about/", "/"]);
    expect(worst[1]).toMatchObject({
      viewports: { "1366": 0.9, "390": 0.8 },
      topFinding: "image.missing: 1 image missing",
    });
    expect(worst[2]?.topFinding).toBeNull();
  });

  test("findings aggregate by code with severity, counts and the pages affected", () => {
    const { byCode } = report().summary;
    // Errors first, then by pages affected.
    expect(
      byCode
        .slice(0, 2)
        .map((c) => c.code)
        .sort(),
    ).toEqual(["image.missing", "page.load-failed"]);
    expect(byCode.slice(0, 2).every((c) => c.severity === "error")).toBe(true);
    const font = byCode.find((c) => c.code === "style.systematic");
    expect(font).toMatchObject({ severity: "warning", findings: 4, items: 27, urls: 2 });
    expect(font?.urlList).toEqual(["https://site.test/about/", "https://site.test/services/"]);
    expect(byCode.at(-1)?.severity).not.toBe("error");
  });

  test("style findings aggregate by property, with the commonest group and value pair", () => {
    const { byProperty } = report().summary;
    expect(byProperty.map((p) => p.property)).toEqual(["fontSize", "fontFamily", "color"]);
    // The same five paragraphs at both widths of /about/ are five elements, not ten.
    expect(byProperty[1]).toMatchObject({
      property: "fontFamily",
      elements: 10,
      urls: 2,
      group: "nav > a",
      live: "Arial",
      local: "Verdana",
    });
  });

  test("an element seen at both widths counts once; the widest viewport stands for the page", () => {
    const two = result(
      "/t/",
      "t",
      [0.9, 0.8],
      [],
      [
        [
          systematic("body > p", "color", "a", "b", 5),
          systematic("body > p", "margin", "1", "2", 2),
        ],
        [
          systematic("body > p", "color", "a", "b", 7, 390),
          systematic("body > p", "margin", "1", "2", 2, 390),
        ],
      ],
    );
    const r = buildReport({
      live: "https://site.test",
      project: "/p",
      viewports: [1366, 390],
      tolerance: 0.1,
      results: [two],
      skipped: [],
      listed: 1,
      imageCount: 0,
    });
    expect(r.summary.systematic.map((d) => [d.property, d.elements])).toEqual([
      ["color", 7],
      ["margin", 2],
    ]);
    expect(r.summary.byProperty.map((p) => [p.property, p.elements])).toEqual([
      ["color", 7],
      ["margin", 2],
    ]);
  });

  test("systematic differences are sorted by the elements they cover, so a fix loop takes the biggest first", () => {
    const { systematic: list } = report().summary;
    expect(list.map((d) => `${d.group}:${d.property}`)).toEqual([
      "main > p:fontSize",
      "nav > a:fontFamily",
    ]);
    expect(list[1]).toMatchObject({ elements: 10, urls: 2, live: "Arial", local: "Verdana" });
    expect(list[1]?.example.selector).toBe("body > a:nth-child(2)");
    expect(list[0]).toMatchObject({ elements: 12, urls: 1 });
  });

  test("a code's severity is the highest of its findings, whichever came first", () => {
    const mixed = result(
      "/m/",
      "m",
      [0.5],
      [],
      [
        [
          { code: "x.y", severity: "info", viewport: 1366, message: "a" },
          { code: "x.y", severity: "error", viewport: 1366, message: "b" },
          { code: "x.y", severity: "warning", viewport: 1366, message: "c" },
        ],
      ],
    );
    const r = buildReport({
      live: "https://site.test",
      project: "/p",
      viewports: [1366],
      tolerance: 0.1,
      results: [mixed],
      skipped: [],
      listed: 1,
      imageCount: 0,
    });
    expect(r.summary.byCode).toEqual([
      expect.objectContaining({ code: "x.y", severity: "error", findings: 3 }),
    ]);
  });

  test("severities are totalled", () => {
    expect(report().summary.severities).toEqual({ error: 2, warning: 5, info: 1 });
  });

  test("an empty run has no statistics and does not throw", () => {
    const empty = buildReport({
      live: "https://site.test",
      project: "/p",
      viewports: [1366],
      tolerance: 0.1,
      results: [],
      skipped: [],
      listed: 0,
      imageCount: 0,
    });
    expect(empty.summary).toMatchObject({
      compared: 0,
      fidelity: null,
      aboveFold: null,
      worst: [],
      byCode: [],
      systematic: [],
    });
  });

  test("long lists are cut in the JSON but their counts stay", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ path: `p${i}`, text: `t${i}` }));
    const v = view(1366, 0.9);
    v.dom = {
      text: {
        similarity: 0.5,
        liveWords: 100,
        regrouped: 0,
        localWords: 100,
        missing: many,
        extra: many,
        changed: [],
      },
      headings: { live: 1, local: 1, missing: [], extra: [], levelChanged: [] },
      links: { live: 90, local: 10, missing: [], extra: [], hrefChanged: [] },
      images: { live: 0, local: 0, matched: 0, missing: [], extra: [], broken: [], pairs: [] },
      elements: { live: 500, local: 500, matched: 400, deltas: [], groups: [] },
    };
    const r = buildReport({
      live: "https://site.test",
      project: "/p",
      viewports: [1366],
      tolerance: 0.1,
      results: [
        {
          url: "https://site.test/",
          path: "/",
          slug: "index",
          viewports: [v],
          fidelity: 0.9,
          findings: [],
        },
      ],
      skipped: [],
      listed: 1,
      imageCount: 0,
    });
    expect(r.urls[0]?.viewports[0]?.dom?.text.missing).toHaveLength(50);
    expect(r.urls[0]?.viewports[0]?.dom?.links.live).toBe(90);
  });
});

describe("renderMarkdown", () => {
  const md = renderMarkdown(report(), { about: "verify/about" });

  test("opens with the summary and the worst pages table", () => {
    expect(md).toContain("# wp2jx verify: https://site.test");
    expect(md).toContain("- Pages compared: 3 of 6 listed (1 skipped, 1 could not be captured)");
    expect(md).toContain("| /services/ | 55.0% | 60.0% | 50.0% |");
    expect(md).toContain("- At 390 px:");
  });

  test("lists the systematic differences with their values and an example selector", () => {
    expect(md).toContain("## Systematic differences, biggest first");
    expect(md).toContain(
      "| 10 | 2 | `nav > a` | fontFamily | Arial | Verdana | `body > a:nth-child(2)` on /about/ |",
    );
  });

  test("has the by-property and by-code tables, the page details and what was not compared", () => {
    expect(md).toContain("## Style findings by property");
    expect(md).toContain("| `style.systematic` | warning | 2 | 4 | 27 |");
    expect(md).toContain("### /about/");
    expect(md).toContain("images in `verify/about`");
    expect(md).toContain("- **error** `image.missing` @1366: 1 image missing");
    expect(md).toContain("## Not compared");
    expect(md).toContain("not served: 1 (/archive/)");
  });

  test("cells survive pipes and newlines", () => {
    const r = buildReport({
      live: "https://site.test",
      project: "/p",
      viewports: [1366],
      tolerance: 0.1,
      listed: 1,
      imageCount: 0,
      skipped: [],
      results: [
        result(
          "/x/",
          "x",
          [0.5],
          [],
          [[{ ...systematic("main > p", "fontFamily", "a|b", "c\nd", 4), count: 4 }]],
        ),
      ],
    });
    expect(renderMarkdown(r)).toContain("a\\|b");
    expect(renderMarkdown(r)).not.toContain("c\nd");
  });
});

describe("images of the worst pages", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const reportDir = (): string => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, "verify-report-"));
    dirs.push(dir);
    return dir;
  };
  const shots = (dir: string, slug: string): void => {
    mkdirSync(shotsDir(dir, slug), { recursive: true });
    for (const w of [1366, 390])
      for (const kind of ["live", "local", "diff"])
        writeFileSync(join(shotsDir(dir, slug), `${w}-${kind}.png`), "png");
  };
  const withImages = (r: UrlResult): UrlResult => ({
    ...r,
    viewports: r.viewports.map((v) => ({
      ...v,
      images: {
        live: `${v.width}-live.png`,
        local: `${v.width}-local.png`,
        diff: `${v.width}-diff.png`,
      },
    })),
  });

  test("the keeper holds the worst N pages on disk and deletes whatever falls out", () => {
    const dir = reportDir();
    const keeper = new ShotKeeper(dir, 2);
    for (const [slug, f] of [
      ["a", 0.9],
      ["b", 0.5],
      ["c", 0.95],
      ["d", 0.7],
    ] as const) {
      shots(dir, slug);
      keeper.offer(slug, f);
    }
    expect(["a", "b", "c", "d"].filter((s) => existsSync(shotsDir(dir, s)))).toEqual(["b", "d"]);
  });

  test("a page name that climbs out of .shots is refused before anything is deleted", () => {
    const dir = reportDir();
    writeFileSync(join(dir, "sentinel.txt"), "keep");
    for (const slug of ["..", ".", "", "../x", "a/../.."]) {
      expect(() => shotsDir(dir, slug)).toThrow("is not a folder inside");
    }
    expect(() => new ShotKeeper(dir, 0).offer("..", null)).toThrow();
    expect(existsSync(join(dir, "sentinel.txt"))).toBe(true);
  });

  test("a page that could not be compared, or a keeper of zero, keeps nothing", () => {
    const dir = reportDir();
    shots(dir, "x");
    new ShotKeeper(dir, 2).offer("x", null);
    expect(existsSync(shotsDir(dir, "x"))).toBe(false);
    shots(dir, "y");
    new ShotKeeper(dir, 0).offer("y", 0.1);
    expect(existsSync(shotsDir(dir, "y"))).toBe(false);
  });

  test("keepWorstImages moves the kept pages to verify/, repoints each viewport, writes the index and removes the rest", () => {
    const dir = reportDir();
    shots(dir, "services");
    shots(dir, "about");
    const list = [
      withImages(result("/about/", "about", [0.9, 0.8])),
      withImages(result("/services/", "services", [0.6, 0.5])),
      withImages(result("/", "index", [0.99, 0.97])),
    ];
    const kept = keepWorstImages(dir, list, 2);
    expect(kept).toEqual({ services: "verify/services", about: "verify/about" });
    expect(existsSync(join(dir, "verify/services/1366-diff.png"))).toBe(true);
    expect(existsSync(join(dir, ".shots"))).toBe(false);
    expect(list[1]?.viewports[0]?.images).toEqual({
      live: "verify/services/1366-live.png",
      local: "verify/services/1366-local.png",
      diff: "verify/services/1366-diff.png",
    });
    expect(list[2]?.viewports[0]?.images).toBeUndefined();
    const index = readFileSync(join(dir, "verify/index.html"), "utf8");
    expect(index).toContain('src="services/1366-live.png"');
    expect(index.indexOf("/services/")).toBeLessThan(index.indexOf("/about/"));
    expect(index).toContain("55.0%");
  });

  test("a page path is escaped in the image index: a path with markup is text, not a tag", () => {
    const dir = reportDir();
    shots(dir, "odd");
    const odd = withImages(result('/a<b>&"c"/', "odd", [0.5, 0.5]));
    keepWorstImages(dir, [odd], 1);
    const index = readFileSync(join(dir, "verify/index.html"), "utf8");
    expect(index).toContain("/a&lt;b&gt;&amp;&quot;c&quot;/");
    expect(index).not.toContain("<b>");
  });

  test("a second run replaces the first run's images; with no images there is no verify directory", () => {
    const dir = reportDir();
    shots(dir, "a");
    keepWorstImages(dir, [withImages(result("/a/", "a", [0.5, 0.5]))], 1);
    expect(existsSync(join(dir, "verify/a"))).toBe(true);
    keepWorstImages(dir, [result("/b/", "b", [0.5, 0.5])], 1);
    expect(existsSync(join(dir, "verify"))).toBe(false);
  });

  test("writeReport writes the JSON and the Markdown", () => {
    const dir = reportDir();
    const files = writeReport(dir, report());
    expect(JSON.parse(readFileSync(files.json, "utf8")).summary.compared).toBe(3);
    expect(readFileSync(files.md, "utf8")).toStartWith("# wp2jx verify");
  });
});
