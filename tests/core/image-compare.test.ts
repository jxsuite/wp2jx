/**
 * `icb/image-compare` over the pilot's real blocks: the slider drawn at rest, as the plugin's own
 * stylesheet expects it, and nothing else (the script that drags it is not carried).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertBlocks } from "../../src/convert.ts";
import {
  IMAGE_COMPARE_CSS_PATH,
  IMAGE_COMPARE_PLUGIN_CSS,
  imageCompareBlock,
  imageCompareStylesheet,
  usedImageCompare,
} from "../../src/core/image-compare.ts";
import { createReport } from "../../src/report.ts";
import type { JxElement, JxNode, WpBlock } from "../../src/types.ts";
import { walkBlocks } from "../../src/wp/blocks.ts";
import { allSubjects, loadSite, makeCtx, subjectBlocks } from "../helpers/ctx.ts";

const sliders = async (): Promise<
  { block: WpBlock; subject: ReturnType<typeof allSubjects>[number] }[]
> => {
  const site = await loadSite("fineline");
  const found: { block: WpBlock; subject: ReturnType<typeof allSubjects>[number] }[] = [];
  for (const subject of allSubjects(site)) {
    walkBlocks(subjectBlocks(site, subject), (block) => {
      if (block.name === "icb/image-compare") found.push({ block, subject });
    });
  }
  return found;
};

const find = (nodes: readonly JxNode[], test: (e: JxElement) => boolean): JxElement[] => {
  const out: JxElement[] = [];
  const visit = (node: JxNode): void => {
    if (typeof node === "string") return;
    if (test(node)) out.push(node);
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
};

describe("icb/image-compare", () => {
  test("the pilot has them, in projects and services", async () => {
    const all = await sliders();
    expect(all.length).toBeGreaterThanOrEqual(8);
  });

  test("a slider is the plugin's stage: both images, the second clipped to the right half, a handle in the middle", async () => {
    const [first] = await sliders();
    const ctx = await makeCtx("fineline", first!.subject);
    const nodes = convertBlocks([first!.block], ctx);
    const root = nodes[0] as JxElement;
    expect(String(root.className)).toContain("wp-block-icb-image-compare");
    const stage = find(nodes, (e) => String(e.className ?? "").includes("icb-comparison-wrapper"));
    expect(stage).toHaveLength(1);
    const wrappers = find(nodes, (e) => String(e.className ?? "").includes("icb-image-wrapper"));
    expect(wrappers).toHaveLength(2);
    const images = find(nodes, (e) => e.tagName === "img");
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(String((image.attributes as Record<string, unknown>).src)).toStartWith("/media/");
    }
    const handle = find(nodes, (e) =>
      String(e.className ?? "").includes("icb-comparison-slider-handle"),
    );
    expect(handle).toHaveLength(1);
    expect(String(handle[0]!.className)).toContain("icb-slider-horizontal");
    // the clip and the stage's proportions are the block's own, written as style objects
    const json = JSON.stringify(nodes);
    expect(json).toContain("inset(0px 0px 0px 50%)");
    expect(json).toMatch(/"aspectRatio":"\d+ \/ \d+"/);
    expect(json).toContain('"width":"80%"');
    expect(usedImageCompare(ctx.model)).toBe(true);
    expect(ctx.report.entries().map((e) => e.code)).toContain("block.image-compare-static");
  });

  test("the stage has the proportions of the taller image at its width, as the script sets it (the Manheim barn: a 2048x1536 before and a 1554x1180 after)", async () => {
    const all = await sliders();
    const manheim = all.find(
      ({ block }) => (block.attrs.beforeImg as { id?: number } | undefined)?.id === 4586,
    )!;
    const ctx = await makeCtx("fineline", manheim.subject);
    const before = ctx.mediaFor(4586)!;
    const after = ctx.mediaFor(4585)!;
    expect([before.width, before.height, after.width, after.height]).toEqual([
      2048, 1536, 1554, 1180,
    ]);
    // 1180/1554 is taller than 1536/2048, and the live stage is 781px high at 1028.8px wide
    expect(JSON.stringify(convertBlocks([manheim.block], ctx))).toContain(
      '"aspectRatio":"1554 / 1180"',
    );
    // swapped, the same stage: it follows the image, not the side it is on
    const swapped: WpBlock = {
      ...manheim.block,
      attrs: {
        ...manheim.block.attrs,
        beforeImg: manheim.block.attrs.afterImg,
        afterImg: manheim.block.attrs.beforeImg,
      },
    };
    expect(JSON.stringify(convertBlocks([swapped], ctx))).toContain('"aspectRatio":"1554 / 1180"');
    // an image that does not know its size leaves the other one to say it
    const bare = await makeCtx("fineline", manheim.subject);
    const sized = bare.mediaFor.bind(bare);
    bare.mediaFor = (id: number) => {
      const found = sized(id);
      return id === 4585 || found === undefined
        ? found
        : (({ width: _w, height: _h, ...rest }) => rest)(found);
    };
    expect(JSON.stringify(convertBlocks([manheim.block], bare))).toContain(
      '"aspectRatio":"1554 / 1180"',
    );
    // and one that says it is zero pixels wide says nothing
    const zero = await makeCtx("fineline", manheim.subject);
    const real = zero.mediaFor.bind(zero);
    zero.mediaFor = (id: number) => {
      const found = real(id);
      return id === 4586 && found !== undefined ? { ...found, width: 0, height: 0 } : found;
    };
    expect(JSON.stringify(convertBlocks([manheim.block], zero))).toContain(
      '"aspectRatio":"1554 / 1180"',
    );
  });

  test("a vertical slider is clipped from the middle down, with its handle across", async () => {
    const [first] = await sliders();
    const ctx = await makeCtx("fineline", first!.subject);
    const nodes = convertBlocks(
      [
        {
          ...first!.block,
          attrs: { ...first!.block.attrs, orientation: "vertical", width: "50%" },
        },
      ],
      ctx,
    );
    const json = JSON.stringify(nodes);
    expect(json).toContain("inset(50% 0px 0px 0px)");
    expect(json).toContain("icb-slider-vertical");
    expect(json).toContain('"width":"50%"');
  });

  test("an image the media plan does not have leaves the slider out and says so", async () => {
    const [first] = await sliders();
    const ctx = await makeCtx("fineline", first!.subject);
    const broken: WpBlock = {
      ...first!.block,
      attrs: {
        ...first!.block.attrs,
        afterImg: { id: 99999999, url: "https://elsewhere.test/x.jpg" },
      },
    };
    expect(imageCompareBlock(broken, ctx)).toEqual([]);
    expect(ctx.report.entries().map((e) => e.code)).toContain("block.image-compare-unresolved");
  });
});

describe("imageCompareStylesheet", () => {
  const root = resolve(import.meta.dir, "../..");

  test("is the plugin's view.css when a slider was drawn, and nothing when none was", async () => {
    const [first] = await sliders();
    const ctx = await makeCtx("fineline", first!.subject);
    convertBlocks([first!.block], ctx);
    mkdirSync(join(root, ".dev/tmp"), { recursive: true });
    const dir = mkdtempSync(join(root, ".dev/tmp/icb-"));
    try {
      mkdirSync(join(dir, IMAGE_COMPARE_PLUGIN_CSS, ".."), { recursive: true });
      writeFileSync(join(dir, IMAGE_COMPARE_PLUGIN_CSS), ".icb-comparison-wrapper{height:400px}");
      const report = createReport();
      const sheet = await imageCompareStylesheet(ctx.model, dir, report);
      expect(sheet?.path).toBe(IMAGE_COMPARE_CSS_PATH);
      expect(sheet?.content).toContain(".icb-comparison-wrapper{height:400px}");
      // the plugin's fixed stage height gives way to the aspect-ratio, after the plugin's own rule
      const content = sheet!.content;
      expect(content.indexOf("{height:auto}")).toBeGreaterThan(content.indexOf("{height:400px}"));
      expect(report.entries()).toEqual([]);
      // a model nobody drew a slider for
      expect(await imageCompareStylesheet({}, dir, createReport())).toBeUndefined();
      const missing = createReport();
      expect(await imageCompareStylesheet(ctx.model, undefined, missing)).toBeUndefined();
      expect(missing.entries().map((e) => e.code)).toEqual(["block.image-compare-css-missing"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
