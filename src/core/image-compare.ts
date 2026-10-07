/**
 * `icb/image-compare`: the Image Compare Block plugin's before and after slider.
 *
 * The block saves no markup (`<!-- wp:icb/image-compare {…} /-->`): the plugin's PHP prints a
 * container and its script builds the slider in the browser, sizing the stage to its taller image. A
 * static page cannot run the script, but the slider's resting state (both images, the second clipped
 * to the right half, a handle in the middle) is plain markup and the plugin's own `view.css` styles it,
 * so that is what the converter writes. What a visitor loses is the dragging: the images stay split
 * at the middle (`block.image-compare-static`, info).
 *
 * The stage is as tall as the taller of the two images is at the stage's width; the script writes that height in
 * pixels, and an `aspect-ratio` says the same without it. A stage height the block states for a device
 * (`styles.container.height`) is a script setting too and is not carried.
 *
 * Report codes: `block.image-compare-static` (info), `block.image-compare-unresolved` (warn: an image
 * of the block is not in the media plan, so the block is left out).
 */
import { escapeHtml } from "../cwicly/tokens.ts";
import type { BlockConverter, ConvertCtx, WpBlock } from "../types.ts";
import { note, staticBlock } from "./static.ts";
import { readPluginFile } from "../emit/fluentform.ts";

/** The sites whose pages drew a slider: the assembler ships the plugin's stylesheet for them. */
const usedBySite = new WeakSet<object>();

/** Whether any page, template or entry of the site drew an image compare slider. */
export const usedImageCompare = (model: object): boolean => usedBySite.has(model);

/** Where the plugin's stylesheet lives, relative to the site root. */
export const IMAGE_COMPARE_PLUGIN_CSS =
  "wp-content/plugins/before-after-image-compare/build/view.css";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const attr = (v: string): string => escapeHtml(v).replaceAll('"', "&quot;");

/** The address a picked image has: the media library's own record of it, else the address the block saved. */
function pickedImage(
  ctx: ConvertCtx,
  value: unknown,
): { url: string; alt: string; width?: number; height?: number } | undefined {
  if (!isRecord(value)) return undefined;
  const id = Number(value.id);
  const saved = typeof value.url === "string" ? value.url : "";
  const planned = Number.isInteger(id) && id > 0 ? ctx.mediaFor(id) : undefined;
  const found = planned ?? (saved === "" ? undefined : ctx.mediaForUrl(saved));
  if (found === undefined) return undefined;
  const alt = typeof value.alt === "string" ? value.alt : found.alt;
  return {
    url: saved === "" ? found.src : saved,
    alt: alt ?? "",
    ...(found.width === undefined ? {} : { width: found.width }),
    ...(found.height === undefined ? {} : { height: found.height }),
  };
}

/**
 * The image that sets the stage's height: the script gives the stage, and both images, the tallest of
 * the heights the images have at the stage's width (`Math.max` over their rendered heights), so it is
 * the one with the larger height for its width, not the before image. When only one image knows its
 * size that one stands in for both, as the stage then follows the only ratio there is.
 */
function tallestOf(
  ...images: { width?: number; height?: number }[]
): { width: number; height: number } | undefined {
  let best: { width: number; height: number } | undefined;
  for (const image of images) {
    const { width, height } = image;
    if (width === undefined || height === undefined || !(width > 0) || !(height > 0)) continue;
    if (best === undefined || height / width > best.height / best.width) best = { width, height };
  }
  return best;
}

export const imageCompareBlock: BlockConverter = (block: WpBlock, ctx) => {
  const a = block.attrs;
  const before = pickedImage(ctx, a.beforeImg);
  const after = pickedImage(ctx, a.afterImg);
  if (before === undefined || after === undefined) {
    note(
      ctx,
      "warn",
      "block.image-compare-unresolved",
      "An image of the before and after slider is not in the media plan, so the slider is left out.",
      { block: block.name },
    );
    return [];
  }
  const vertical = a.orientation === "vertical";
  const width = typeof a.width === "string" && a.width !== "" ? a.width : "80%";
  const tallest = tallestOf(before, after);
  const ratio = tallest === undefined ? "" : `aspect-ratio:${tallest.width} / ${tallest.height};`;
  const clip = vertical ? "inset(50% 0px 0px 0px)" : "inset(0px 0px 0px 50%)";
  const handle = vertical
    ? `<div class="icb-comparison-slider-handle icb-slider-vertical default" style="top:50%"><div class="icb-default-icon"></div></div>`
    : `<div class="icb-comparison-slider-handle icb-slider-horizontal default" style="left:50%"><div class="icb-default-icon"></div></div>`;
  const img = (picked: { url: string; alt: string }): string =>
    `<img src="${attr(picked.url)}" alt="${attr(picked.alt)}" style="height:100%">`;
  const html =
    `<div class="align wp-block-icb-image-compare" style="text-align:center">` +
    `<div class="icbImageCompare" style="width:${attr(width)}">` +
    `<div class="icb-comparison-wrapper" style="${ratio}">` +
    `<div class="icb-image-wrapper">${img(before)}</div>` +
    `<div class="icb-image-wrapper" style="clip-path:${clip}">${img(after)}</div>` +
    `${handle}</div></div></div>`;
  usedBySite.add(ctx.model);
  note(
    ctx,
    "info",
    "block.image-compare-static",
    "The before and after slider is drawn at rest, split at the middle: its script does the dragging and is not carried over.",
    { block: block.name },
  );
  return staticBlock(block, ctx, { html });
};

export const IMAGE_COMPARE_CSS_PATH = "public/css/image-compare.css";

/**
 * The plugin's own stylesheet for the slider, read from the site checkout or the live site `from`:
 * undefined when no page drew a slider, and a report entry (`block.image-compare-css-missing`) when
 * the file cannot be read, since the stage is then an unstyled stack of two images.
 */
export async function imageCompareStylesheet(
  model: object,
  from: string | undefined,
  report: {
    add(entry: { severity: "warn"; code: string; message: string; where: string }): void;
  },
): Promise<{ path: string; content: string } | undefined> {
  if (!usedImageCompare(model)) return undefined;
  const css = from === undefined ? null : await readPluginFile(from, IMAGE_COMPARE_PLUGIN_CSS);
  if (css === null) {
    report.add({
      severity: "warn",
      code: "block.image-compare-css-missing",
      message: `The plugin stylesheet ${IMAGE_COMPARE_PLUGIN_CSS} was not found${from === undefined ? " (no plugin source was given)" : ` at ${from}`}, so the before and after sliders have none of the plugin's styles.`,
      where: "plugin:before-after-image-compare",
    });
    return undefined;
  }
  return {
    path: IMAGE_COMPARE_CSS_PATH,
    content:
      `/* ${IMAGE_COMPARE_PLUGIN_CSS} */\n${css.trim()}\n\n` +
      // The plugin gives the stage a height of 400px and its script replaces it with the before image's
      // height at the stage's width. A page that cannot run the script says the same with the stage's
      // aspect-ratio (a class rule of the page, which the plugin's more specific selector would
      // beat), so the plugin's fixed height has to give way.
      `/* wp2jx: the stage is as tall as its aspect-ratio says */\n.wp-block-icb-image-compare .icbImageCompare .icb-comparison-wrapper{height:auto}\n`,
  };
}
