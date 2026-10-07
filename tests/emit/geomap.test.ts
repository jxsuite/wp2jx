/**
 * `src/emit/geomap.ts` over the pilot's real map (the `igmap` post 3197, "Pennsylvania", and its
 * `map_info` meta): the markup is the plugin's own, and `tests/data/geomap-pennsylvania.txt` is what
 * the live page prints for it.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GEO_MAP_CSS_PATH,
  geoMapFor,
  geoMapMarkup,
  geoMapOf,
  geoMapStylesheet,
  usedGeoMaps,
  type GeoMap,
} from "../../src/emit/geomap.ts";
import type { SayForm } from "../../src/emit/fluentform.ts";
import { placeholderElement, readPlaceholder } from "../../src/placeholders.ts";
import { createReport } from "../../src/report.ts";
import { loadSite } from "../helpers/ctx.ts";

const site = await loadSite("fineline");
const live = await Bun.file(new URL("../data/geomap-pennsylvania.txt", import.meta.url)).text();
const flat = (html: string): string => html.replaceAll(/>\s+</g, "><").trim();

const say =
  (sink: ReturnType<typeof createReport>): SayForm =>
  (entry) =>
    sink.add({ ...entry, where: "test" });

const shortcode = (name: string, attrs: Record<string, string>) =>
  readPlaceholder(
    placeholderElement("shortcode", {
      "data-shortcode": name,
      "data-attributes": JSON.stringify(attrs),
      "data-source": `[${name} id='${attrs.id ?? ""}']`,
    }),
  )!;

describe("geoMapOf", () => {
  test("reads the stage's size from the map's own settings", () => {
    expect(geoMapOf(site.model, 3197)).toEqual({
      id: 3197,
      title: "Pennsylvania",
      height: "56",
      maxWidth: "2000",
      // stored as an empty string, which the plugin's floatval() prints as 0%
      heightMobile: "0%",
      mobileRatio: undefined,
    });
  });

  test("is undefined for anything that is not a published igmap", () => {
    // a page, and an id nothing has
    const page = [...site.model.posts.values()].find((p) => p.type === "page")!;
    expect(geoMapOf(site.model, page.id)).toBeUndefined();
    expect(geoMapOf(site.model, 999_999)).toBeUndefined();
    const draft = new Map(site.model.posts).set(3197, {
      ...site.model.posts.get(3197)!,
      status: "draft",
    });
    expect(geoMapOf({ posts: draft, postMeta: site.model.postMeta }, 3197)).toBeUndefined();
  });

  test("a post of another type is no map, whatever meta it holds", () => {
    const posts = new Map(site.model.posts).set(3197, {
      ...site.model.posts.get(3197)!,
      type: "page",
    });
    expect(geoMapOf({ posts, postMeta: site.model.postMeta }, 3197)).toBeUndefined();
  });

  test("falls back to the plugin's defaults when the meta says nothing", () => {
    const post = site.model.posts.get(3197)!;
    const bare = geoMapOf({ posts: site.model.posts, postMeta: new Map() }, post.id)!;
    expect(bare.height).toBe("56.25");
    expect(bare.maxWidth).toBe("2200");
    expect(bare.heightMobile).toBe("");
    const zero = new Map([[3197, { map_info: [{ visual: { paddingTop: "40", maxWidth: "0" } }] }]]);
    const own = geoMapOf({ posts: site.model.posts, postMeta: zero }, 3197)!;
    expect(own.height).toBe("40");
    expect(own.maxWidth).toBe("2200");
  });

  test("keeps a mobile ratio the map sets, as the script applies it", () => {
    const meta = new Map([
      [3197, { map_info: [{ visual: { paddingTop: "56", paddingTopMobile: "100" } }] }],
    ]);
    const own = geoMapOf({ posts: site.model.posts, postMeta: meta }, 3197)!;
    expect(own.heightMobile).toBe("100%");
    expect(own.mobileRatio).toBe("100");
  });
});

describe("geoMapMarkup", () => {
  test("is the markup the live page prints for the Pennsylvania map", () => {
    expect(flat(geoMapMarkup(geoMapOf(site.model, 3197)!))).toBe(flat(live));
  });
});

describe("geoMapFor", () => {
  test("draws the stage for the shortcode, in either of its names, and says the map is not drawn", () => {
    const own = { model: site.model };
    const report = createReport();
    const element = geoMapFor(own, shortcode("display-map", { id: "3197" }), say(report));
    expect(element).toMatchObject({
      tagName: "div",
      attributes: { "data-wp2jx": "geomap:3197" },
    });
    expect(flat(String((element as { innerHTML: string }).innerHTML))).toBe(flat(live));
    // the plugin lower-cases attribute names, and registers a second name
    expect(geoMapFor(own, shortcode("display-igmap", { ID: "3197" }), say(report))).not.toBeNull();
    expect(report.entries().map((e) => [e.severity, e.code])).toEqual([
      ["warn", "map.not-interactive"],
      ["warn", "map.not-interactive"],
    ]);
    // the assembler learns which maps were drawn, once each
    expect(usedGeoMaps(own).map((m) => m.id)).toEqual([3197]);
  });

  test("a map the database does not hold draws nothing, as the plugin prints nothing, and says so", () => {
    const report = createReport();
    expect(
      geoMapFor({ model: site.model }, shortcode("display-map", { id: "999999" }), say(report)),
    ).toBeNull();
    expect(report.entries().map((e) => e.code)).toEqual(["map.missing"]);
  });

  test("leaves any other placeholder to the caller", () => {
    const report = createReport();
    const own = { model: site.model };
    expect(geoMapFor(own, shortcode("gallery", { id: "3197" }), say(report))).toBeUndefined();
    expect(geoMapFor(own, shortcode("display-map", {}), say(report))).toBeUndefined();
    expect(geoMapFor(own, shortcode("display-map", { id: "x" }), say(report))).toBeUndefined();
    expect(
      geoMapFor(
        own,
        readPlaceholder(placeholderElement("shortcode", { "data-shortcode": "display-map" }))!,
        say(report),
      ),
    ).toBeUndefined();
    expect(
      geoMapFor(
        own,
        readPlaceholder(
          placeholderElement("shortcode", {
            "data-shortcode": "display-map",
            "data-attributes": "{broken",
          }),
        )!,
        say(report),
      ),
    ).toBeUndefined();
    expect(
      geoMapFor(
        own,
        readPlaceholder(placeholderElement("block", {}, { block: { name: "x/y", attrs: {} } }))!,
        say(report),
      ),
    ).toBeUndefined();
    expect(report.entries()).toEqual([]);
  });

  test("a site without a model cannot hold the map", () => {
    const report = createReport();
    expect(geoMapFor({}, shortcode("display-map", { id: "3197" }), say(report))).toBeNull();
    expect(report.entries().map((e) => e.code)).toEqual(["map.missing"]);
  });
});

describe("geoMapStylesheet", () => {
  const map = geoMapOf(site.model, 3197)!;
  const mobile: GeoMap = { ...map, id: 8, heightMobile: "100%", mobileRatio: "100" };
  const add = () => {
    const report = createReport();
    return {
      report,
      sink: {
        add: (entry: {
          severity: "warn";
          code: string;
          message: string;
          where: string;
          data?: Record<string, unknown>;
        }) => void report.add(entry),
      },
    };
  };

  test("is undefined when no page drew a map", async () => {
    expect(await geoMapStylesheet([], "/nowhere", add().sink)).toBeUndefined();
  });

  test("ships the plugin's own stylesheet, and a mobile rule for the map that sets a ratio", async () => {
    const root = mkdtempSync(join(import.meta.dir, "geomap-"));
    try {
      const dir = join(root, "wp-content/plugins/interactive-geo-maps/assets/public/css");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "styles.min.css"), ".map_wrapper{width:100%}\n");
      const { report, sink } = add();
      const sheet = await geoMapStylesheet([map, mobile], root, sink);
      expect(sheet?.path).toBe(GEO_MAP_CSS_PATH);
      expect(sheet?.content).toContain(".map_wrapper{width:100%}");
      expect(sheet?.content).toContain(
        "@media (max-width:780px){#map_wrapper_8 .map_aspect_ratio{padding-top:100% !important}}",
      );
      expect(sheet?.content).not.toContain("#map_wrapper_3197");
      expect(report.entries()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a stylesheet that cannot be read is reported, and the stage keeps its own size", async () => {
    const { report, sink } = add();
    const sheet = await geoMapStylesheet([map], undefined, sink);
    expect(report.entries().map((e) => e.code)).toEqual(["map.css-missing"]);
    expect(sheet?.content).toContain(".map_wrapper .map_aspect_ratio{");
    expect(sheet?.content).toContain("height:0");
    const other = add();
    await geoMapStylesheet([map], "/nowhere/at/all", other.sink);
    expect(other.report.entries()[0]?.message).toContain("at /nowhere/at/all");
  });
});
