/**
 * The Cwicly blocks that lay out a page, set its text and show its media: section, div, container,
 * styler, columns, column, heading, paragraph, list, button, icon, svg, image, video, gallery, code,
 * hook, fragment, content and maps. (Component instances, queries and repeaters are the data
 * module's; accordions, tabs, modals, popovers, sliders, menus and inputs the interactive one's.)
 *
 * Every block here is "static save plus server post-processing" (core/includes/blocks/*.php: each
 * render callback checks the conditions and hands the saved markup to `cc_render`), so the saved
 * markup is what the page printed, and the block's attributes are what it was made from. A converter
 * says what is INSIDE its block and `buildBlock` (common.ts) makes the root, so the class list (the
 * classID first), the style, the visibility, the link and the author's attributes are the same for
 * all of them. What differs, block by block:
 *
 * - **Boxes** (`section`, `div`, `container`, `columns`, `column`): the saved tag (a `div` may be an
 *   `a`, an `article`, a `form`) around the converted inner blocks. A section that still has the
 *   old layout keeps its `<div class="<classID>-wrapper cc-wrapper">` around them, with the
 *   wrapper's own rule. Columns and column are plain boxes: `columnsTemplateColumns` and the item
 *   grids are in the stylesheet, as `display: grid` rules of the block's class.
 * - **Text** (`heading`, `paragraph`, `list`, `button`): the block's text through the dynamic module
 *   (a token, a fallback, or the saved `content`), converted as one piece of markup so inline
 *   content keeps its spacing. A button's icon goes in the same string, before or after the label
 *   as `buttonPosition` says.
 * - **Media** (`icon`, `svg`, `image`, `video`, `gallery`, `maps`): the SVG the editor saved, the
 *   image `blockImage` resolves (one original per family, `srcset` and `sizes` left to the Jx
 *   build), the iframe or `<video>` the block printed, the figure grid with its lightbox links, and
 *   an embedded Google map in place of the plugin's script.
 * - **The entry body** (`content`): `${entry.$children}` in an entry template, the page's own blocks
 *   in the subject that has them, the layout's `<slot>` in a template.
 *
 * What a static site cannot carry is reported, never dropped quietly: `block.unsupported` (a PHP
 * hook, PHP in a code block, the WooCommerce cart context), `block.code-js`, `block.code-css`,
 * `block.code-css-statement`, `block.styler-dropped`, `block.video-overlay`, `block.video-unresolved`, `block.gallery-filter`,
 * `block.gallery-captions`, `block.gallery-masonry`, `block.maps-approximated`, `block.svg-image`, `block.image-empty`, `block.fragment-conditional`,
 * `block.fragment-empty`, `block.fragment-missing`, `block.icon-connector`, `block.content-recursion`, and what the style,
 * link, dynamic and condition modules report on the way.
 */
import { escapeHtml, jsString, resolveTokens } from "../tokens.ts";
import { htmlToNodes } from "../../html.ts";
import { isEmptyStyle } from "../../jx-util.ts";
import { blockGallery, blockImage, type GallerySpec } from "../dynamic.ts";
import { parseCwiclyCss } from "../css.ts";
import { parseBlocks } from "../../wp/blocks.ts";
import type { BlockConverter, ConvertCtx, JxElement, JxNode, WpBlock } from "../../types.ts";
import {
  assemble,
  buildBlock,
  contentMarkup,
  hoistRule,
  iconSvg,
  inlineContent,
  markupContent,
  markupNodes,
  placeholder,
  prepare,
  record,
  rewriteAddress,
  savedSvg,
  say,
  shapeElement,
  targetOf,
  text,
  type AttrValue,
} from "./common.ts";

// ── Boxes ────────────────────────────────────────────────────────────────────────────────────────

/** A block that is its tag around its inner blocks. */
const box =
  (tag: string): BlockConverter =>
  (block, ctx) =>
    buildBlock(block, ctx, () => ({ tag, children: ctx.convert(block.innerBlocks) }));

/**
 * The old section layout: `<section class="<classID> cc-sct"><div class="<classID>-wrapper cc-wrapper">`.
 * The wrapper's layout is its own rule (`.<classID>-wrapper`), which the style module hands back on
 * the inner shape; the section's inner blocks go inside it.
 */
const section: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, (env) => {
    const children = ctx.convert(block.innerBlocks);
    const wrapper = env.styling.inner.find((shape) =>
      shape.className.split(/\s+/).includes("cc-wrapper"),
    );
    return {
      tag: "section",
      children: wrapper ? [shapeElement(ctx, wrapper, { children, block })] : children,
    };
  });

/** A div with the WooCommerce cart context is rendered by a script of the plugin's; its children are kept. */
const div: BlockConverter = (block, ctx) => {
  if (block.attrs.dynamicContext === "woocart") {
    say(
      ctx,
      block,
      "block.unsupported",
      "warn",
      "The block is a WooCommerce cart context, which a script of the plugin renders; its inner blocks are kept without the cart.",
      { detail: "woocart", feature: "woocart" },
    );
  }
  return box("div")(block, ctx);
};

/** The styler's render callback returns null: it prints nothing on the live site, inner blocks included. */
const styler: BlockConverter = (block, ctx) => {
  say(
    ctx,
    block,
    "block.styler-dropped",
    "info",
    "A styler block prints nothing on the live site (its render callback returns null), so it and the blocks inside it are left out.",
    { detail: "styler" },
  );
  return [];
};

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────

const heading: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, () => {
    const content = inlineContent(block, ctx);
    return { tag: text(block.attrs.headingTag) ?? "h1", ...(content ? { content } : {}) };
  });

const paragraph: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, () => {
    const content = inlineContent(block, ctx);
    return { tag: "p", ...(content ? { content } : {}) };
  });

/**
 * A list is a `div` around the `<ul>`/`<ol>` its `content` holds. The editor keeps the list element
 * in `content` only when it came from a pasted or converted list: a block typed in the editor keeps
 * just the `<li>` items, and the block's save puts them in `listTag` (`ul` when the block has none)
 * with the `start` and `reversed` of an ordered list (`RichText.Content tagName=…`). Taking `content`
 * as it is turned four of ap's six lists into items with no list around them: the numbers became
 * bullets and the markers left the box. A content that starts with its own list is the saved markup as
 * it is, and so is a dynamic one (its tag is the source's). The marker icons (`listIcons`, `listIcon*`)
 * are CSS masks in the stylesheet, not elements.
 */
const list: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, () => {
    const a = block.attrs;
    const found = contentMarkup(block);
    const bare =
      found !== undefined &&
      !found.dynamic &&
      found.markup.trim() !== "" &&
      !/^\s*<(?:ul|ol)[\s>]/i.test(found.markup);
    const tag = /^(?:ul|ol)$/.test(text(a.listTag) ?? "") ? (text(a.listTag) as string) : "ul";
    const start = text(a.listStart);
    const around = bare
      ? {
          before: `<${tag}${tag === "ol" && start !== undefined ? ` start="${attr(start)}"` : ""}${tag === "ol" && a.listReversed === true ? " reversed" : ""}>`,
          after: `</${tag}>`,
        }
      : {};
    const content = inlineContent(block, ctx, around);
    return { tag: "div", ...(content ? { content } : {}) };
  });

/**
 * A button: the tag the saved markup gives it (`a`, `button` or a `div` that links nowhere), its
 * label and, when the block shows one, its icon: the SVG the page printed, before the label or after
 * it as `buttonPosition` says (before when the block says nothing).
 */
const button: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, (env) => {
    const a = block.attrs;
    const svg =
      savedSvg(block) ?? (a.buttonIconActive === true ? iconSvg(a.buttonIcon) : undefined);
    const around =
      svg === undefined ? {} : a.buttonPosition === "after" ? { after: svg } : { before: svg };
    const content = inlineContent(block, ctx, around);
    return { tag: env.link ? "a" : "div", ...(content ? { content } : {}) };
  });

// ── Icons and SVG ────────────────────────────────────────────────────────────────────────────────

/**
 * An icon is a box around an inline SVG, which the editor saves with the block (`iconIcon` is its
 * source, `iconUnicode` the same SVG with `fill="unset"` the editor's own preview needs). A connected
 * icon (`{component=icon=<prop>}`) is an SVG the component's instance passes in: markup in `state`.
 */
const icon: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, () => {
    const a = block.attrs;
    const connected = text(record(record(a.componentConnectors)?.icon)?.ref);
    if (connected !== undefined) {
      const key = ctx.props?.get(connected);
      if (key !== undefined)
        return { tag: "div", content: { innerHTML: `\${state.${key} ?? ''}` } };
      say(
        ctx,
        block,
        "block.icon-connector",
        "warn",
        `The icon property ${connected} is not one of this component's properties; the icon is empty.`,
        { detail: connected },
      );
      return { tag: "div" };
    }
    const svg = savedSvg(block) ?? iconSvg(a.iconIcon) ?? text(a.iconUnicode);
    return {
      tag: "div",
      ...(svg === undefined ? {} : { content: markupContent(svg, ctx, block) }),
    };
  });

/**
 * The svg block: an inline SVG written into the block (`inlineSvg`), an icon, or an SVG file of the
 * media library. Whatever the saved markup roots on (the block's `<svg>` itself or a box around
 * it), the result is the same element with the SVG's content, the viewBox the token gave it
 * and the block's classes. A file of the library cannot be inlined (the converter has no file to read):
 * it becomes an `<img>`, which keeps the shape and loses `currentColor` and CSS targeting its paths.
 */
const svg: BlockConverter = (block, ctx) => {
  const a = block.attrs;
  const env = prepare(block, ctx);
  if (!env) return [];
  const rooted = env.styling.tag === "svg";
  if (
    text(a.svgType) === "image" ||
    (a.imageType === "static" &&
      text(a.inlineSvg) === undefined &&
      text(a.imageURL) &&
      text(a.svgType) !== "icon")
  ) {
    const image = blockImage(block, ctx);
    if (!image) return [];
    say(
      ctx,
      block,
      "block.svg-image",
      "info",
      "An SVG file of the media library is shown as an image: the converter has no file to inline, so the shape stays and currentColor and CSS that targets its paths are lost.",
      { detail: "svg-image" },
    );
    return assemble(env, {
      tag: "img",
      forceTag: "img",
      attributes: {
        src: image.src,
        alt: image.alt,
        width: image.width as AttrValue | undefined,
        height: image.height as AttrValue | undefined,
      },
    }).nodes;
  }
  const inline = text(a.inlineSvg);
  const markup = inline ?? savedSvg(block) ?? iconSvg(a.iconIcon) ?? text(a.iconUnicode);
  if (rooted && markup !== undefined) {
    // The element IS the svg: its content is what sits between the saved tags.
    const saved = /<svg\b[^>]*>([\s\S]*)<\/svg>/i.exec(block.innerHTML);
    const inner = saved?.[1] ?? /<svg\b[^>]*>([\s\S]*)<\/svg>/i.exec(markup)?.[1] ?? "";
    return assemble(env, {
      tag: "svg",
      content: { innerHTML: resolveTokens(inner, ctx, block, { where: "html" }) },
    }).nodes;
  }
  return assemble(env, {
    tag: "div",
    ...(markup === undefined ? {} : { content: markupContent(markup, ctx, block) }),
  }).nodes;
};

// ── Images ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The width and height of the image size a block's saved tag asks for: `{imagewidth=ID=<size>}` is
 * `wp_get_attachment_image_src(ID, size)`, the size's own dimensions when the attachment has that size
 * and the original's when it has not (or the size is `full`). A block with no saved tag follows its
 * `imageThumbnailSize`. `undefined` is the original's size: a bound or unknown image, or no size at all.
 */
function sizedDimensions(
  block: WpBlock,
  ctx: ConvertCtx,
  spec: { id?: number; bound: boolean },
): { width: number; height: number } | undefined {
  if (spec.id === undefined || spec.bound) return undefined;
  const token = /\{imagewidth=(\d+)(?:=([^}=]*))?\}/.exec(block.innerHTML);
  const name = token ? token[2] : text(block.attrs.imageThumbnailSize);
  if (token && Number(token[1]) !== spec.id) return undefined;
  if (name === undefined) return undefined;
  const found = ctx.model.attachments.get(spec.id)?.sizes.find((s) => s.name === name);
  return found ? { width: found.width, height: found.height } : undefined;
}

/**
 * An image: the file `blockImage` resolves for the block (the one original the media plan keeps for
 * its family, the featured image of the entry, an ACF field), with the size and alt text it knows.
 * `srcset` and `sizes` are the Jx build's. A lightbox is the link the saved markup wraps around it. An image the
 * plan has no file for is left out and reported by `blockImage`.
 */
const image: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  const spec = blockImage(block, ctx);
  if (!spec) {
    // `blockImage` says why a file it was asked for is missing. A block that names no file at all is
    // printed by the plugin as an `<img>` with no `src`, and it still takes its place in the layout: a
    // column of a flex container puts its row gap around it (the icon card's image, which its
    // instances never fill, is 16px of space above every heading).
    if (
      text(block.attrs.imageID) === undefined &&
      text(block.attrs.imageURL) === undefined &&
      block.attrs.imageType !== "dynamic"
    ) {
      say(
        ctx,
        block,
        "block.image-empty",
        "info",
        "The image block names no file: it prints an image with no source, as the plugin does, which shows nothing and keeps its place in the layout.",
        {
          detail: "image-empty",
        },
      );
      return assemble(env, { tag: "img", forceTag: "img", attributes: { alt: "" } }).nodes;
    }
    return [];
  }
  // The saved tag has a width and a height only when the block knows its file's size (an image with no
  // attachment id has neither, nor does an SVG): adding the size of the file the address names would
  // stretch an image whose stylesheet sets one side only, as `<img width height>` is a presentational hint.
  // The size is the one the tag names (`{imagewidth=ID=medium_large}`), not the original's: an image whose
  // stylesheet sets no width is as wide as its attribute, and the original is far wider than its column.
  const saved = env.styling.element?.attributes;
  const named = sizedDimensions(block, ctx, spec);
  // A dynamic image's tag is saved without them and printed with them: the plugin adds the size of the
  // file it picks when it renders (a literal one, which this conversion knows).
  // The image a component's property fills is printed with the instance's own size, too.
  const printed = (block.attrs.imageType === "dynamic" && !spec.bound) || spec.sizes !== undefined;
  const size = (key: "width" | "height"): AttrValue | undefined =>
    printed || saved === undefined || (saved[key] ?? "") !== ""
      ? (named?.[key] ?? spec[key])
      : undefined;
  const width = size("width");
  return assemble(env, {
    tag: "img",
    forceTag: "img",
    attributes: {
      src: spec.src,
      alt: spec.alt,
      width,
      height: size("height"),
      sizes: spec.sizes ?? naturalSizes(width, block.attrs.imageType === "dynamic"),
      loading: spec.loading,
    },
  }).nodes;
};

/**
 * The `sizes` that give a rebuilt `srcset` the natural width the live tag has. The plugin prints a
 * static image as a plain `src` of the size it names, so its natural width is that file's width,
 * wherever it sits; a `srcset` with the build's default `sizes` (`50vw`) has the width of that slot
 * instead, and an image whose stylesheet leaves its width to the content (a grid column holding an
 * `120%` wide image, a flex item with no width) lays out narrower than on the live page. A dynamic
 * image is printed with a `srcset` and `auto, (max-width: Wpx) 100vw, Wpx`, which is what WordPress
 * itself prints for it.
 */
function naturalSizes(width: AttrValue | undefined, dynamic: boolean): string | undefined {
  if (typeof width !== "number" || !(width > 0)) return undefined;
  return dynamic ? `auto, (max-width: ${width}px) 100vw, ${width}px` : `${width}px`;
}

// ── Video ────────────────────────────────────────────────────────────────────────────────────────

const VIDEO_FILE = /\.(?:mp4|m4v|webm|ogv|ogg|mov)(?:[?#]|$)/i;

/** The id of a YouTube address, or of a Vimeo one: the two the plugin knows. */
function videoSource(url: string): { kind: "youtube" | "vimeo"; id: string } | undefined {
  const yt =
    /^(?:https?:\/\/)?(?:www\.)?(?:m\.)?(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:(?:watch)?\?(?:.*&)?v(?:i)?=|(?:embed|v|vi|user)\/))([^?&"'>]+)/.exec(
      url,
    );
  if (yt?.[1]) return { kind: "youtube", id: yt[1] };
  const vm =
    /^https?:\/\/(?:www\.|player\.)?vimeo\.com\/(?:channels\/(?:\w+\/)?|groups\/[^/]*\/videos\/|album\/\d+\/video\/|video\/|)(\d+)(?:$|\/|\?)/i.exec(
      url,
    );
  if (vm?.[1]) return { kind: "vimeo", id: vm[1] };
  return undefined;
}

/**
 * The embed address the plugin builds (`cc_video_url`), from the block's player options. A video of a
 * dynamic field (`cc_video_final_maker`) is the plugin's other path: it works out the privacy host and
 * never uses it, so its YouTube address is always `www.youtube.com`.
 */
function embedUrl(
  a: Record<string, unknown>,
  source: { kind: "youtube" | "vimeo"; id: string },
  dynamic = false,
): string {
  if (source.kind === "vimeo") {
    let url = `https://player.vimeo.com/video/${source.id}?transparent=1`;
    if (a.videoStart) url += `&#t=${String(a.videoStart)}`;
    if (a.videoAutoplay) url += "&autoplay=true";
    if (a.videoMute) url += "&muted=1";
    if (a.videoLoop) url += "&loop=1";
    if (a.videoPrivacy) url += "&dnt=1";
    return url;
  }
  const host = a.videoPrivacy && !dynamic ? "www.youtube-nocookie.com" : "www.youtube.com";
  let url = `https://${host}/embed/${source.id}?modestbranding=${a.videoBranding ? 1 : 0}`;
  if (a.videoStart) url += `&start=${String(a.videoStart)}`;
  if (a.videoEnd) url += `&end=${String(a.videoEnd)}`;
  if (a.videoAutoplay) url += "&autoplay=1";
  if (a.videoMute) url += "&mute=1";
  if (a.videoLoop) url += "&loop=1";
  if (a.videoControls === false) url += "&controls=0";
  if (a.videoRelated === true) url += "&rel=1";
  else if (a.videoRelated === false) url += "&rel=0";
  return url;
}

const attr = (value: string): string => escapeHtml(value).replaceAll('"', "&quot;");

const IFRAME_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";

/**
 * The player flags of a video element. A static video shows its controls unless the block says no; the
 * plugin's dynamic branch shows them only when the block says yes.
 */
function videoFlags(a: Record<string, unknown>, dynamic: boolean): string[] {
  return [
    a.videoAutoplay ? "autoplay" : "",
    a.videoLoop ? "loop" : "",
    a.videoMute ? "muted" : "",
    (dynamic ? a.videoControls : a.videoControls !== false) ? "controls" : "",
  ].filter(Boolean);
}

const VIDEO_FALLBACK = "Sorry, your browser doesn't support embedded videos.";

/** The markup of a video the block's attributes describe (what `cc_video_final_maker` prints). */
function videoMarkup(a: Record<string, unknown>, url: string, dynamic = false): string {
  const source = videoSource(url);
  if (source) {
    return `<div class="cc-iframe-container"><iframe title="Video" width="560" height="315" src="${attr(embedUrl(a, source, dynamic))}" frameborder="0" allow="${IFRAME_ALLOW}" allowfullscreen></iframe></div>`;
  }
  const flags = videoFlags(a, dynamic).join(" ");
  return `<video src="${attr(url)}" ${flags} controlslist="nodownload" playsinline>${VIDEO_FALLBACK}</video>`;
}

/**
 * The embed address of a dynamic video as an expression over the entry's field, for a value that is
 * known only when the page is built: the same YouTube and Vimeo rules, written in JavaScript. The
 * expression is empty for anything else (a file is the `<video>` element's, not an iframe's).
 */
function embedExpression(a: Record<string, unknown>, value: string): string {
  const yt = embedUrl(a, { kind: "youtube", id: "\u0000" }, true);
  const vm = embedUrl(a, { kind: "vimeo", id: "\u0000" }, true);
  const [ytHead = "", ytTail = ""] = yt.split("\u0000");
  const [vmHead = "", vmTail = ""] = vm.split("\u0000");
  return (
    `((u) => { u = String(u ?? ''); ` +
    `const y = /(?:youtu\\.be\\/|youtube(?:-nocookie)?\\.com\\/(?:(?:watch)?\\?(?:.*&)?vi?=|(?:embed|v|vi|user)\\/))([^?&"'>]+)/.exec(u); ` +
    `if (y) return ${jsString(ytHead)} + y[1] + ${jsString(ytTail)}; ` +
    `const v = /vimeo\\.com\\/(?:video\\/)?(\\d+)/.exec(u); ` +
    `if (v) return ${jsString(vmHead)} + v[1] + ${jsString(vmTail)}; ` +
    `return ''; })(${value})`
  );
}

/**
 * The two players of a dynamic video in an entry template, of which the field's value picks one when
 * the page is built (`cc_video_final_maker` prints an iframe for a YouTube or Vimeo address and a
 * `<video>` for anything else): both elements are written, and the one the value does not call for has
 * `hidden`, which the build resolves into the page. A value the entry does not have shows neither.
 */
function entryPlayers(a: Record<string, unknown>, expr: string): JxNode[] {
  const embed = embedExpression(a, expr);
  const field = `String((${expr}) ?? '')`;
  const flags = Object.fromEntries(videoFlags(a, true).map((flag) => [flag, true] as const));
  return [
    {
      tagName: "div",
      className: "cc-iframe-container",
      // No address (a field with no value) leaves the attribute out rather than an iframe with an empty `src`.
      attributes: { hidden: `\${!(${embed}) || false}` },
      children: [
        {
          tagName: "iframe",
          attributes: {
            title: "Video",
            width: 560,
            height: 315,
            src: `\${(${embed}) || false}`,
            frameborder: "0",
            allow: IFRAME_ALLOW,
            allowfullscreen: true,
          },
        },
      ],
    },
    {
      tagName: "video",
      attributes: {
        src: `\${((u, e) => (u && !e ? u : ''))(${field}, ${embed}) || false}`,
        hidden: `\${((u, e) => !u || !!e)(${field}, ${embed}) || false}`,
        ...flags,
        controlslist: "nodownload",
        playsinline: true,
      },
      textContent: VIDEO_FALLBACK,
    },
  ];
}

/**
 * A video: the iframe or `<video>` the page printed inside the block's `cc-vid` box. The saved markup
 * is the page's own (its iframe address already carries the player options), so it is used when it
 * is there; the plugin's script (`cc-video.js`) and its `<ccdyn>` poster placeholder are left out. A
 * video of an ACF field is built from the field's value.
 */
const video: BlockConverter = (block, ctx) => {
  const a = block.attrs;
  const env = prepare(block, ctx);
  if (!env) return [];
  if (a.videoImageOverlay) {
    say(
      ctx,
      block,
      "block.video-overlay",
      "info",
      "The video's cover image (a script shows the player when it is clicked) is not carried over: the player is shown directly.",
      { detail: "video-overlay" },
    );
  }
  const saved = /<div\b[^>]*>([\s\S]*)<\/div>\s*$/i.exec(block.innerHTML.trim())?.[1];
  const cleaned = saved?.replace(/<ccdyn>[\s\S]*?<\/ccdyn>/gi, "").trim();
  if (cleaned && /<(?:iframe|video)\b/i.test(cleaned)) {
    return assemble(env, { tag: "div", content: markupContent(cleaned, ctx, block) }).nodes;
  }
  // No saved player: the block's own address, or the ACF field it reads.
  if (text(a.videoType) === "dynamic") {
    const field = text(a.videoDynamicAcfField);
    if (field === undefined) {
      say(
        ctx,
        block,
        "block.video-unresolved",
        "warn",
        "A dynamic video names no field; the box is empty.",
        {
          detail: "dynamic",
        },
      );
      return assemble(env, { tag: "div" }).nodes;
    }
    const tokenized = resolveTokens(`{acffield=${field}}`, ctx, block, { where: "attribute" });
    if (tokenized.includes("${")) {
      const expr = /^\$\{([\s\S]*)\}$/.exec(tokenized)?.[1];
      if (expr === undefined) {
        say(
          ctx,
          block,
          "block.video-unresolved",
          "warn",
          `The video field ${field} is a composite value; the box is empty.`,
          {
            detail: field,
          },
        );
        return assemble(env, { tag: "div" }).nodes;
      }
      return assemble(env, { tag: "div", children: entryPlayers(a, expr) }).nodes;
    }
    if (tokenized === "") {
      say(
        ctx,
        block,
        "block.video-unresolved",
        "info",
        `The video field ${field} is empty here; the box is empty.`,
        {
          detail: field,
        },
      );
      return assemble(env, { tag: "div" }).nodes;
    }
    return assemble(env, {
      tag: "div",
      content: markupContent(videoMarkup(a, tokenized, true), ctx, block),
    }).nodes;
  }
  const url = text(a.videoStaticURL);
  if (url === undefined) {
    say(
      ctx,
      block,
      "block.video-unresolved",
      "warn",
      "The video names no address; the box is empty.",
      {
        detail: "static",
      },
    );
    return assemble(env, { tag: "div" }).nodes;
  }
  const address = VIDEO_FILE.test(url) ? rewriteAddress(ctx, url) : url;
  return assemble(env, { tag: "div", content: markupContent(videoMarkup(a, address), ctx, block) })
    .nodes;
};

// ── Gallery ──────────────────────────────────────────────────────────────────────────────────────

/** The inline style of a gallery's images: the saved markup's own (a masonry gallery does not crop), else the grid's. */
const IMAGE_STYLE = "width:100%;height:100%;object-fit:cover";

interface FigureOptions {
  lightbox: boolean;
  gallery: string;
  imageStyle: string;
}

/** The figures of one image, as the saved markup has them: a card, its clip box, the lightbox link or a plain box, the image, a caption slot. */
function figureMarkup(
  image: { src: string; alt: string; width?: number; height?: number },
  options: FigureOptions,
): string {
  const size = `${image.width ? ` width="${image.width}"` : ""}${image.height ? ` height="${image.height}"` : ""}`;
  const img = `<img style="${attr(options.imageStyle)}" src="${attr(image.src)}" alt="${attr(image.alt)}"${size}/>`;
  const inner = options.lightbox
    ? `<a class="cc-lightbox cc-gallery-lightbox" href="${attr(image.src)}" data-gallery="${attr(options.gallery)}">${img}<figcaption></figcaption></a>`
    : `<div class="cc-gallery-lightbox">${img}<figcaption></figcaption></div>`;
  return `<figure style="position:relative" class="cc-gallery-card gallery-1" data-ccgalleryname="gallery-1"><div style="overflow:hidden;height:100%;width:100%;position:relative">${inner}</div></figure>`;
}

/** The same figures for a gallery that belongs to the entry: one expression, so an entry with no images prints an empty grid and the page stays static. */
function figureExpression(spec: GallerySpec, gallery: string, imageStyle: string): string {
  const esc =
    "(s => String(s ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c])))";
  const img = `'<img style="${imageStyle}" src="' + ${esc}(i.src) + '" alt="' + ${esc}(i.alt) + '"' + (i.width ? ' width="' + i.width + '"' : '') + (i.height ? ' height="' + i.height + '"' : '') + '/>'`;
  const inner = spec.lightbox
    ? `'<a class="cc-lightbox cc-gallery-lightbox" href="' + ${esc}(i.src) + '" data-gallery="${gallery}">' + ${img} + '<figcaption></figcaption></a>'`
    : `'<div class="cc-gallery-lightbox">' + ${img} + '<figcaption></figcaption></div>'`;
  return `\${${spec.list}.map(i => '<figure style="position:relative" class="cc-gallery-card gallery-1" data-ccgalleryname="gallery-1"><div style="overflow:hidden;height:100%;width:100%;position:relative">' + ${inner} + '</div></figure>').join('')}`;
}

/**
 * A gallery keeps the structure the plugin's stylesheets target (`.gallery-<id> .cc-gallery`, the
 * `figure.cc-gallery-card` cards): a grid box around a `cc-gallery` box around one figure per image,
 * each image a link to its file when the gallery opens in a lightbox. The filter buttons and the
 * captions are scripts' and are reported.
 */
const gallery: BlockConverter = (block, ctx) => {
  const a = block.attrs;
  const env = prepare(block, ctx);
  if (!env) return [];
  const spec = blockGallery(block, ctx);
  if (a.galleryFilter === true) {
    say(
      ctx,
      block,
      "block.gallery-filter",
      "info",
      "The gallery's category filter buttons are a script's and are not carried over.",
      {
        detail: "filter",
      },
    );
  }
  const galleries = Array.isArray(a.galleries) ? (a.galleries as Record<string, unknown>[]) : [];
  if (
    galleries.some(
      (g) =>
        (Array.isArray(g.titles) && g.titles.length > 0) ||
        (Array.isArray(g.descriptions) && g.descriptions.length > 0),
    )
  ) {
    say(
      ctx,
      block,
      "block.gallery-captions",
      "warn",
      "The gallery's titles and descriptions are not carried over.",
      {
        detail: "captions",
      },
    );
  }
  const id = text(a.id) ?? text(a.classID) ?? "gallery";
  // A masonry gallery is `cc-masonry` and does not crop its images; the saved markup says which, and a block with no markup follows its type.
  const masonry = text(a.galleryType) === "masonry";
  if (masonry || /\sdata-ccgallerymason=/i.test(block.innerHTML)) {
    say(
      ctx,
      block,
      "block.gallery-masonry",
      "info",
      "A masonry gallery's layout is a script's (cc-gallery.js moves each card with a negative top margin): the cards are in the grid the stylesheet gives them, without the masonry packing.",
      { detail: "masonry" },
    );
  }
  const imageStyle =
    /<img\b[^>]*\sstyle="([^"]*)"/.exec(block.innerHTML)?.[1] ??
    (masonry ? "width:100%;height:100%" : IMAGE_STYLE);
  const root = {
    tag: "div",
    link: "none" as const,
    classes: [masonry ? "cc-masonry" : "cc-grid"],
    attributes: { "data-ccgallery": "" },
  };
  if (!spec)
    return assemble(env, { ...root, children: [{ tagName: "div", className: "cc-gallery" }] })
      .nodes;
  const inner: JxElement =
    spec.list === undefined
      ? {
          tagName: "div",
          className: "cc-gallery",
          children: htmlToNodes(
            spec.images
              .map((image) =>
                figureMarkup(image, { lightbox: spec.lightbox, gallery: id, imageStyle }),
              )
              .join(""),
            {
              target: targetOf(ctx),
              report: ctx.report,
              where: `${ctx.subject.kind}:${ctx.subject.id}`,
            },
          ),
        }
      : {
          tagName: "div",
          className: "cc-gallery",
          innerHTML: figureExpression(spec, id, imageStyle),
        };
  return assemble(env, { ...root, children: [inner] }).nodes;
};

// ── Code, hooks and fragments ────────────────────────────────────────────────────────────────────

/**
 * A code block: its rendered HTML (`codeRender`, the output the editor saw, or the code itself when it
 * holds no PHP). The PHP is not run, the JavaScript is not carried (reported with the start of it),
 * and the stylesheet the block prints in the page's head is hoisted rule by rule.
 */
const code: BlockConverter = (block, ctx) => {
  const a = block.attrs;
  const env = prepare(block, ctx);
  if (!env) return [];
  const source = typeof a.code === "string" ? a.code : "";
  const php = /<\?(?:php|=)?/i.test(source);
  const rendered =
    typeof a.codeRender === "string" && a.codeRender !== "" ? a.codeRender : php ? "" : source;
  if (php) {
    say(
      ctx,
      block,
      "block.unsupported",
      "warn",
      rendered === ""
        ? "The code block runs PHP on every request and has no rendered output saved: it is left empty."
        : "The code block runs PHP on every request: the output the editor saved is kept as it is, and what the PHP computes is frozen at that.",
      { detail: "code-php", feature: "php", excerpt: source.slice(0, 120) },
    );
  }
  const js = typeof a.codeJS === "string" ? a.codeJS.trim() : "";
  if (js !== "") {
    say(ctx, block, "block.code-js", "warn", "The code block's JavaScript is not carried over.", {
      detail: "code-js",
      excerpt: js.slice(0, 120),
    });
  }
  const css = typeof a.codeCSS === "string" ? a.codeCSS.replaceAll(/[\r\n]+/g, " ").trim() : "";
  if (css !== "") {
    const index = parseCwiclyCss(css, ctx.cwicly.breakpoints, {
      file: `codeCSS of ${text(a.classID) ?? text(a.uniqueID) ?? "a code block"}`,
      palette: [...ctx.cwicly.globalStyles.colorRefs.values()],
    });
    for (const [name, entry] of index.classes)
      hoistRule(ctx, block, { selector: `.${name}`, style: entry.style });
    for (const [selector, style] of index.other) hoistRule(ctx, block, { selector, style });
    for (const rule of index.atRules) {
      if (!isEmptyStyle(rule.style)) {
        hoistRule(ctx, block, { selector: rule.key, style: rule.style });
        continue;
      }
      // A statement (`@import url(…)`) has no body, and a style object cannot carry one: hoisted, it would vanish from the build while the report claims the sheet was kept.
      say(
        ctx,
        block,
        "block.code-css-statement",
        "warn",
        `The code block's \`${rule.key}\` cannot be a style rule: link the file from the project's $head instead; it is not carried over.`,
        { detail: `code-css-statement|${rule.key}`, rule: rule.key },
      );
    }
    for (const artifact of index.artifacts) {
      // A media query the author wrote is not an artifact of Cwicly's generator: it is kept as an `@(…)` query.
      if (artifact.code === "css.media-unmapped") continue;
      say(ctx, block, "css.artifact", "warn", artifact.detail, {
        detail: `code-css|${artifact.detail}`,
      });
    }
    say(
      ctx,
      block,
      "block.code-css",
      "info",
      "The code block's stylesheet, which the page printed in its head, is hoisted into the page's styles.",
      {
        detail: "code-css",
      },
    );
  }
  if (rendered === "") return [];
  const nodes = markupNodes(rendered, ctx, block);
  // The block has no element of its own (`cc_code_render_callback` returns the code's output as it is).
  return env.visibility.hidden === undefined && env.visibility.deviceHide === undefined
    ? nodes
    : assemble(env, { tag: "div", children: nodes }).nodes;
};

/** `do_action(<hook>)` prints whatever the site's plugins hang on it: PHP, per request. */
const hook: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  say(
    ctx,
    block,
    "block.unsupported",
    "warn",
    `The hook "${text(block.attrs.hook) ?? ""}" prints what PHP code hung on it, on every request; nothing is carried over.`,
    { detail: `hook|${text(block.attrs.hook) ?? ""}`, hook: text(block.attrs.hook) ?? null },
  );
  return [];
};

const CONDITION_KEYS = ["singular", "archive", "author", "acf", "custom"];

/**
 * The template slugs a fragment's include conditions say apply to every page, and the ones that depend
 * on the page, as `cc_condition_checker` (core/includes/dynamic/cc-helpers.php) decides them. A part is
 * included only when its `includeCondition` is `and` (every result true) or `or` (any result true), so
 * a rule with no `includeCondition` prints nothing; `all` is a result only when it is the STRING
 * `"true"` (`'true' === $value->all`), the other results being the page's own conditions. So `or` with
 * `all` is every page, `and` with `all` and nothing else is every page, and whatever else holds a
 * condition of the page is the page's to decide. An exclusion that is `all` removes the part (unless it
 * is an `and` over conditions of the page too), and one that holds conditions of the page makes the
 * part depend on the page.
 */
function fragmentTemplates(
  parts: unknown,
  name: string,
): { always: string[]; conditional: string[]; known: boolean } {
  const fragment = record(record(record(parts)?.fragments)?.[name]);
  const conditions = record(fragment?.conditions);
  const include = record(conditions?.include) ?? {};
  const exclude = record(conditions?.exclude) ?? {};
  const isAll = (rule: unknown): boolean => record(rule)?.all === "true";
  const keyedOf = (rule: unknown): boolean =>
    CONDITION_KEYS.some((k) => {
      const list = record(rule)?.[k];
      return Array.isArray(list) && list.length > 0;
    });
  const always: string[] = [];
  const conditional: string[] = [];
  for (const [slug, rule] of Object.entries(include)) {
    const r = record(rule) ?? {};
    const mode = r.includeCondition;
    if (mode !== "and" && mode !== "or") continue;
    const out = exclude[slug];
    const excludedByPage = keyedOf(out);
    if (isAll(out) && !(record(out)?.excludeCondition === "and" && excludedByPage)) continue;
    const keyed = keyedOf(r);
    let shown: "always" | "page" | undefined;
    if (mode === "or") shown = isAll(r) ? "always" : keyed ? "page" : undefined;
    else shown = keyed ? "page" : isAll(r) ? "always" : undefined;
    if (shown === "always" && excludedByPage) shown = "page";
    if (shown === "always") always.push(slug);
    else if (shown === "page") conditional.push(slug);
  }
  return { always, conditional, known: fragment !== undefined };
}

/**
 * A fragment prints the template parts of the global fragment it names (`cwicly_global_parts`),
 * chosen by display conditions. The parts that apply to every page become template-part placeholders,
 * which the template emitter replaces with the part's component (the spelling core's own
 * `core/template-part` has); a part that depends on the page is reported and left out.
 */
const fragment: BlockConverter = (block, ctx) => {
  const env = prepare(block, ctx);
  if (!env) return [];
  const name = text(block.attrs.fragment);
  if (name === undefined) return [];
  const found = fragmentTemplates(ctx.cwicly.globalParts, name);
  if (!found.known) {
    say(
      ctx,
      block,
      "block.fragment-missing",
      "warn",
      `The fragment "${name}" is not one of the site's global fragments; nothing is printed.`,
      {
        detail: name,
      },
    );
    return [];
  }
  if (found.always.length === 0 && found.conditional.length === 0) {
    say(
      ctx,
      block,
      "block.fragment-empty",
      "info",
      `The fragment "${name}" has no template part that its display conditions show on any page, so nothing is printed.`,
      { detail: name },
    );
  }
  for (const slug of found.conditional) {
    say(
      ctx,
      block,
      "block.fragment-conditional",
      "warn",
      `The fragment "${name}" prints the part "${slug}" only where its display conditions say so, which a static page cannot decide: the part is left out.`,
      { detail: `${name}|${slug}`, part: slug },
    );
  }
  return found.always.map((slug) =>
    placeholder(block, "template-part", "wp-block-template-part", {
      slug,
      theme: ctx.model.site.theme,
      "data-fragment": name,
    }),
  );
};

// ── The entry body ───────────────────────────────────────────────────────────────────────────────

/** The posts whose body is being expanded, so a body that holds its own `content` block again does not recurse. */
const expanding = new Set<number>();

/**
 * The slot of a template that holds the page's own content (`{postcontent}`): the same box as the
 * block's saved tag, with the body inside. In an entry template the body is the entry's
 * (`${state.entry.$children}`, one string: docs/bindings.md, section 1); a subject that has its own
 * blocks prints them; a template leaves the layout's `<slot>`.
 */
const content: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, () => {
    if (ctx.mode === "entry") {
      return {
        tag: "div",
        children: `\${${ctx.entryExpr}.$children ?? []}` as unknown as JxNode[],
      };
    }
    const post = ctx.subject.kind === "post" ? ctx.subject.post : undefined;
    if (post) {
      if (expanding.has(post.id)) {
        say(
          ctx,
          block,
          "block.content-recursion",
          "warn",
          "The page's own body holds a content block again; it is not expanded twice.",
          {
            detail: String(post.id),
          },
        );
        return { tag: "div" };
      }
      expanding.add(post.id);
      try {
        return { tag: "div", children: ctx.convert(parseBlocks(post.content)) };
      } finally {
        expanding.delete(post.id);
      }
    }
    return { tag: "div", children: [{ tagName: "slot" }] };
  });

// ── Maps ─────────────────────────────────────────────────────────────────────────────────────────

/** The zoom a map block has when it names none (`gmapZoom` in the block's block.json; the plugin's script alone would fall back to 10). */
const MAP_ZOOM = 14;

/**
 * A map block loads Google's JavaScript API with the site's key. A static page has neither: the block
 * becomes Google's keyless embed (`maps?q=…&output=embed`) of its place at its zoom, which shows a map
 * and a marker but not the block's custom style, controls or street view. The plugin's script centres
 * the map and puts its marker on the COORDINATES (`data-lat`, `data-lng`) and prints the address and name
 * only in the marker's window, so the coordinates are the place when the block has both, and the address
 * is the place of a block with no coordinates. (block.json also defaults the coordinates to a point in the
 * Indian Ocean: a block that sets neither is a placeholder, not a place, and the box is left empty.)
 */
const maps: BlockConverter = (block, ctx) =>
  buildBlock(block, ctx, () => {
    const a = block.attrs;
    const lat = text(a.gmapLatitude);
    const lng = text(a.gmapLongitude);
    const place = lat !== undefined && lng !== undefined ? `${lat},${lng}` : text(a.gmapAddress);
    say(
      ctx,
      block,
      "block.maps-approximated",
      "warn",
      place === undefined
        ? "The map names no address or coordinates; the box is empty."
        : "The map is Google's embedded map of its address: the plugin's script, the custom style and the controls are not carried over.",
      { detail: "maps", style: text(a.gmapStyle) ?? null },
    );
    if (place === undefined) return { tag: "div" };
    const zoom = typeof a.gmapZoom === "number" ? a.gmapZoom : Number(text(a.gmapZoom) ?? MAP_ZOOM);
    const src = `https://maps.google.com/maps?q=${encodeURIComponent(place)}&z=${Number.isFinite(zoom) ? zoom : MAP_ZOOM}&output=embed`;
    return {
      tag: "div",
      children: [
        {
          tagName: "iframe",
          attributes: {
            src,
            title: text(a.gmapName) ?? text(a.gmapAddress) ?? place,
            width: "100%",
            height: "100%",
            style: "border:0",
            loading: "lazy",
            referrerpolicy: "no-referrer-when-downgrade",
            allowfullscreen: true,
          },
        },
      ],
    };
  });

// ── The table ────────────────────────────────────────────────────────────────────────────────────

export const layoutConverters: Record<string, BlockConverter> = {
  "cwicly/section": section,
  "cwicly/div": div,
  "cwicly/container": box("div"),
  "cwicly/styler": styler,
  "cwicly/columns": box("div"),
  "cwicly/column": box("div"),
  "cwicly/heading": heading,
  "cwicly/paragraph": paragraph,
  "cwicly/list": list,
  "cwicly/button": button,
  "cwicly/icon": icon,
  "cwicly/svg": svg,
  "cwicly/image": image,
  "cwicly/video": video,
  "cwicly/gallery": gallery,
  "cwicly/code": code,
  "cwicly/hook": hook,
  "cwicly/fragment": fragment,
  "cwicly/content": content,
  "cwicly/maps": maps,
};
