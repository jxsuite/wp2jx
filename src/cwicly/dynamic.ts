/**
 * What a Cwicly block says it contains, from its attributes: its text, its image, its background and
 * its gallery.
 *
 * A block's saved markup already holds the answer as tokens (`<h2>{title}</h2>`), and `tokens.ts` resolves
 * those. This module is the other road to the same place, for a converter that builds an element from
 * the block's attributes instead of from its markup: it rebuilds the token the editor would have
 * written (a port of the editor's `build/index.js`: module 41074 for content, 308 for images, 96688
 * for backgrounds) and resolves it through the same table, so the two roads cannot disagree. The tests
 * hold them to that on every block of both sites.
 *
 * Every string returned is final-form (docs/bindings.md): a `${…}` binding where the value belongs to
 * the entry, text with its literal parts escaped for the place it is written otherwise.
 */
import { escapeTemplate, finishBindings, finishNodes } from "../jx-util.ts";
import { htmlToContent, type HtmlContent, type HtmlOptions } from "../html.ts";
import type { ConvertCtx, WpBlock } from "../types.ts";
import {
  acfRef,
  currentRef,
  escapeHtml,
  exprV,
  fieldByKey,
  fallbackImageSrc,
  fieldText,
  finalForm,
  isExprRef,
  jsString,
  literalFinal,
  literalTemplate,
  litV,
  optPath,
  orElse,
  parseLocation,
  refProp,
  report,
  resolveMarked,
  type Ref,
  type Val,
} from "./tokens.ts";

// ── Reading attributes ───────────────────────────────────────────────────────────────────────────

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined;

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * ACF's location argument the way the editor writes it into a token (`build/index.js`): a post by id,
 * the current user or author, a user by id, the options page, the term of the loop, the term of the
 * archive, or a term by id; nothing for the current post.
 */
export function acfLocationArg(
  attrs: Record<string, unknown>,
  keys: { location: string; id: string; object: string },
): string {
  const location = text(attrs[keys.location]);
  const id = text(attrs[keys.id]);
  const object = record(attrs[keys.object]);
  switch (location) {
    case "postid":
      return id ?? "";
    case "currentuser":
    case "currentauthor":
    case "option":
    case "termquery":
    case "userquery":
    case "currenttaxonomytermarchive":
      return location;
    case "userid":
      return id === undefined ? "" : `user_${id}`;
    case "termid":
      return "taxterm";
    case "taxonomyterm":
      return text(object?.value) === undefined ? "" : `term_${text(object?.value)}`;
    default:
      return "";
  }
}

/** The defaults of the dynamic content attributes in every text block's `block.json`: Gutenberg does not store them. */
const DEFAULTS = {
  dateType: "published",
  dateFormat: "default",
  currentDateTime: "default",
  currentDateDate: "default",
  commentsNone: "No Comments",
  commentsOne: "Comment",
  commentsMultiple: "Comments",
} as const;

const CONTENT_LOCATION = {
  location: "dynamicACFFieldLocation",
  id: "dynamicACFFieldLocationID",
  object: "dynamicACFFieldLocationIDObject",
} as const;

/**
 * The token the editor writes for a block's dynamic content (`dynamic` and its companions), or
 * undefined when the block's content is not dynamic. `{title}`, `{postexcerpt=75}`, `{postdate=published=default}`,
 * `{acffield=field_x=currenttaxonomytermarchive}`.
 */
export function contentToken(attrs: Record<string, unknown>): string | undefined {
  const dynamic = text(attrs.dynamic);
  if (dynamic === undefined) return undefined;
  const type = text(attrs.dynamicWordPressType);
  const arg = (v: unknown): string => (text(v) === undefined ? "" : `=${text(v)}`);
  if (dynamic === "wordpress" && type !== undefined) {
    let [n, i, a] = ["", "", ""];
    switch (type) {
      case "postexcerpt":
        n = arg(attrs.dynamicWordPressExcerptLimit);
        break;
      case "customcurrentdate":
        n = arg(attrs.dynamicWordPressCustomCurrentDate);
        break;
      // Gutenberg stores only what differs from the block's default, and the editor builds the token
      // from the attribute with its default applied: `{postdate=published=default}` for a block that says nothing.
      case "currentdate":
        n = arg(attrs.dynamicWordPressCurrentDateTime ?? DEFAULTS.currentDateTime);
        i = arg(attrs.dynamicWordPressCurrentDateDate ?? DEFAULTS.currentDateDate);
        break;
      case "postdate":
        n = arg(attrs.dynamicWordPressDateType ?? DEFAULTS.dateType);
        i = arg(attrs.dynamicWordPressDateFormat ?? DEFAULTS.dateFormat);
        a = arg(attrs.dynamicWordPressDateCustom);
        break;
      case "time":
        n = arg(attrs.dynamicWordPressTimeType ?? DEFAULTS.dateType);
        i = arg(attrs.dynamicWordPressTimeFormat ?? DEFAULTS.dateFormat);
        a = arg(attrs.dynamicWordPressTimeCustom);
        break;
      case "postcomments":
        n = arg(attrs.dynamicWordPressCommentsNone ?? DEFAULTS.commentsNone);
        i = arg(attrs.dynamicWordPressCommentsOne ?? DEFAULTS.commentsOne);
        a = arg(attrs.dynamicWordPressCommentsMultiple ?? DEFAULTS.commentsMultiple);
        break;
      case "siteoption":
      case "authorcustomfield":
      case "usercustomfield":
      case "customfield":
        n = arg(attrs.dynamicWordPressExtra);
        break;
    }
    return `{${type}${n}${i}${a}}`;
  }
  const taxonomyTerms = text(attrs.dynamicTaxTermsType);
  if (dynamic === "taxonomyterms" && taxonomyTerms !== undefined)
    return `{taxterms=${taxonomyTerms}}`;
  if (type !== undefined) {
    if (dynamic === "postquery") return `{postquery=${type}}`;
    if (dynamic === "userquery") return `{userquery=${type}}`;
    if (dynamic === "taxonomyquery") return `{termquery=${type}}`;
    if (dynamic === "filter") return `{filter=${type}}`;
    if (dynamic === "woocommerce") return `{${type}}`;
    if (dynamic === "commentquery") {
      const format = text(attrs.dynamicWordPressDateFormat);
      const time = text(attrs.dynamicWordPressTimeFormat);
      if (type === "comment_date") {
        return format === "custom"
          ? `{commentquery=${type}=custom=${text(attrs.dynamicWordPressDateCustom) ?? ""}}`
          : `{commentquery=${type}${arg(format)}}`;
      }
      if (type === "comment_time") {
        return time === "custom"
          ? `{commentquery=${type}=custom=${text(attrs.dynamicWordPressTimeCustom) ?? ""}}`
          : `{commentquery=${type}${arg(time)}}`;
      }
      return `{commentquery=${type}}`;
    }
  }
  const group = text(attrs.dynamicACFGroup);
  const field = text(attrs.dynamicACFField);
  const plus = text(attrs.dynamicACFFieldPlus);
  if (dynamic === "acf" && group !== undefined && field !== undefined) {
    const location = acfLocationArg(attrs, CONTENT_LOCATION);
    if (location !== "")
      return plus ? `{acffield=${field}=${location}=${plus}}` : `{acffield=${field}=${location}}`;
    return plus ? `{acffield=${field}=false=${plus}}` : `{acffield=${field}}`;
  }
  const repeater = text(attrs.dynamicRepeaterField);
  if (dynamic === "repeater" && repeater !== undefined) {
    return plus ? `{acfrepeater=${repeater}=false=${plus}}` : `{acfrepeater=${repeater}}`;
  }
  return undefined;
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────

export interface TextSpec {
  /** `text` is for a `textContent`, `html` for an `innerHTML`. */
  kind: "text" | "html";
  value: string;
}

/** The markup a block's text is, with its tokens still in it: the dynamic token between its static texts, or its saved `content`. */
function contentMarkup(block: WpBlock): { markup: string; dynamic: boolean } | undefined {
  const a = block.attrs;
  const connector = record(record(a.componentConnectors)?.content);
  const token =
    connector && text(connector.ref)
      ? `{component=content=${text(connector.ref)}}`
      : contentToken(a);
  if (token === undefined && text(a.dynamic) !== undefined) {
    // A dynamic source the editor writes no token for (a filter's selection): its `content` is the editor's preview.
    return { markup: "", dynamic: true };
  }
  if (token !== undefined) {
    const before = text(a.dynamicStaticBefore);
    const after = text(a.dynamicStaticAfter);
    return {
      markup: `${before === undefined ? "" : escapeHtml(before)}${token}${after === undefined ? "" : escapeHtml(after)}`,
      dynamic: true,
    };
  }
  const content = text(a.content);
  return content === undefined ? undefined : { markup: content, dynamic: false };
}

/**
 * A block's text: its dynamic content (with the static text the editor puts before and after it, and
 * its fallback), or else its saved `content`. Markup (`<a>`, `<strong>`, a character reference) makes
 * it `html`; a plain string is `text`. The before and after texts are plain text in the result, where
 * the editor's markup wraps them in `<span class="before">`: no stylesheet of either site targets
 * those spans, and a converter that wants them takes the saved markup through `tokenContent`.
 */
export function blockText(block: WpBlock, ctx: ConvertCtx): TextSpec | undefined {
  const found = contentMarkup(block);
  if (!found) return undefined;
  const trace = { html: false };
  // Resolved as markup whatever the result is: WordPress prints a block's static text through wptexturize,
  // which acts on markup, and a plain result is the same string with its escapes undone.
  const marked = resolveMarked(found.markup, ctx, block, true, trace);
  // A `<ccd>` token is not markup.
  const html =
    trace.html ||
    (!found.dynamic &&
      /<[a-z/!]|&[#a-z0-9]+;/i.test(found.markup.replaceAll(/<ccd>.*?<\/ccd>/gs, "")));
  if (html) return { kind: "html", value: finishBindings(marked, "html") };
  const plain = marked.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  return { kind: "text", value: finishBindings(plain, "text", () => literalTemplate(ctx)) };
}

/**
 * The same text as the content of one element, ready to spread into it: `textContent`, structured
 * `children` or an `innerHTML`, with every binding finished.
 */
export function blockContent(
  block: WpBlock,
  ctx: ConvertCtx,
  htmlOpts: HtmlOptions = {},
): HtmlContent | undefined {
  const found = contentMarkup(block);
  if (!found) return undefined;
  const marked = resolveMarked(found.markup, ctx, block, true);
  return finishNodes(htmlToContent(marked, htmlOpts), () => literalTemplate(ctx));
}

// ── Images ───────────────────────────────────────────────────────────────────────────────────────

export interface ImageSpec {
  /**
   * The file: a Jx path (`/media/2023/03/a.jpg`), or a binding that is `false` when the entry has no
   * image, so the attribute is left out.
   */
  src: string;
  alt: string;
  width?: number | string;
  height?: number | string;
  /**
   * `sizes`, for an image a component's property fills: the plugin prints `auto, (max-width: Wpx) 100vw,
   * Wpx` for such a lazy image, W being the width of the file the instance passed.
   */
  sizes?: string;
  /** `lazy` or `eager`, as the block asks; absent when it does not say. */
  loading?: string;
  /** The attachment, when it is a fixed one. */
  id?: number;
  /** Whether any of the above reads the entry or a component's state. */
  bound: boolean;
}

/** An attribute's value from a reference: omitted (`false`) when empty, so no empty `src` is written. */
function omitEmpty(v: Val): string | number | undefined {
  if ("lit" in v) {
    if (v.lit === "") return undefined;
    return /^\d+$/.test(v.lit) ? Number(v.lit) : v.lit;
  }
  return `\${(${v.expr}) || false}`;
}

/** The alt text a block states itself: its `imageAlt`, or a component parameter. */
function statedAlt(block: WpBlock, ctx: ConvertCtx): string | undefined {
  const alt = text(block.attrs.imageAlt);
  if (alt === undefined) return undefined;
  const ref = /^!ref=([\w-]+)!$/.exec(alt);
  if (ref)
    return finalForm(ctx, exprV(`state.${ctx.props?.get(ref[1] as string) ?? ref[1]} ?? ''`));
  return finalForm(ctx, litV(alt));
}

function loadingOf(block: WpBlock, ctx: ConvertCtx): string | undefined {
  const comp = text(block.attrs.lazyLoadComp);
  if (comp !== undefined) {
    const id = /!ref=([\w-]+)!/.exec(comp)?.[1];
    const key = id === undefined ? undefined : ctx.props?.get(id);
    return key === undefined ? undefined : `\${state.${key} ? 'lazy' : 'eager'}`;
  }
  const lazy = block.attrs.lazyLoad;
  if (lazy === true) return "lazy";
  if (lazy === false) return "eager";
  return undefined;
}

/** The parts of an image given by a reference to `{src, width, height, alt}`. */
function imageOfRef(ref: Ref): { src: Val; alt: Val; width: Val; height: Val } {
  const part = (key: string): Val => {
    const r = refProp(ref, key);
    return isExprRef(r)
      ? exprV(`${r.expr} ?? ''`)
      : litV(r.value === undefined || r.value === null ? "" : String(r.value));
  };
  return { src: part("src"), alt: part("alt"), width: part("width"), height: part("height") };
}

/**
 * The dimensions of the size a dynamic image block asks for (`imageThumbnailSize`) of the featured image
 * of the post the conversion is for, when that post is known now (a static conversion: a page, or the
 * item of a static query). `wp_get_attachment_image_src` answers with the size's own dimensions when the
 * attachment has that size and the original's when it has not, and prints them as `width` and `height`:
 * with a stylesheet that sets no width the image is as wide as that, not as wide as the original.
 */
function featuredSize(
  ctx: ConvertCtx,
  a: Record<string, unknown>,
): { width: number; height: number } | undefined {
  const name = text(a.imageThumbnailSize);
  const post = ctx.subject.post;
  if (name === undefined || post === undefined || ctx.mode !== "static") return undefined;
  const id = Number(ctx.model.postMeta.get(post.id)?._thumbnail_id?.[0]);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  const found = ctx.model.attachments.get(id)?.sizes.find((s) => s.name === name);
  return found ? { width: found.width, height: found.height } : undefined;
}

/** `src || fallback`, both as final-form text, `false` (no attribute) when there is neither. */
function withFallbackSrc(ctx: ConvertCtx, src: Val, fallback: string | undefined): string {
  if ("lit" in src) {
    const chosen = src.lit !== "" ? src.lit : fallback;
    return literalFinal(ctx, chosen ?? "");
  }
  return fallback === undefined
    ? `\${(${src.expr}) || false}`
    : `\${(${src.expr}) || ${jsString(fallback)}}`;
}

/**
 * The image a block shows: a fixed attachment (`imageID`, `imageURL`), the featured image of the post
 * or entry, an ACF image field, or the image a component passes in. `src` is the one original the
 * media plan keeps for the attachment's family; width and height are that original's.
 *
 * Avatars (`authorpicture`, `userpicture`) and comment authors have no file on the converted site: the
 * block's fallback image is used and the rest is reported (`dynamic.unsupported`).
 */
export function blockImage(block: WpBlock, ctx: ConvertCtx): ImageSpec | undefined {
  const a = block.attrs;
  const stated = statedAlt(block, ctx);
  const loading = loadingOf(block, ctx);
  const common = loading === undefined ? {} : { loading };

  const connector = text(record(record(a.componentConnectors)?.image)?.ref);
  if (connector !== undefined && a.imageType !== "static" && a.imageType !== "dynamic") {
    const key = ctx.props?.get(connector);
    if (key === undefined) {
      report(
        ctx,
        "dynamic.unsupported",
        "warn",
        `The image property ${connector} is not one of this component's properties.`,
        { token: `image:${connector}` },
      );
      return undefined;
    }
    const base = `state.${key}`;
    return {
      src: `\${${optPath(base, "src")} || false}`,
      alt: stated ?? `\${${optPath(base, "alt")} ?? ''}`,
      width: `\${${optPath(base, "width")} || false}`,
      height: `\${${optPath(base, "height")} || false}`,
      sizes: `\${${optPath(base, "width")} ? 'auto, (max-width: ' + ${optPath(base, "width")} + 'px) 100vw, ' + ${optPath(base, "width")} + 'px' : false}`,
      ...common,
      bound: true,
    };
  }

  const id = Number(a.imageID);
  const hasId = Number.isInteger(id) && id > 0;
  const byId = hasId ? ctx.mediaFor(id) : undefined;
  // What the editor leaves behind when a block's image is switched to a dynamic one: the id of the old
  // static image, whose alt text the saved markup still carries after the dynamic one.
  const idAlt = byId?.alt === undefined || byId.alt === "" ? undefined : byId.alt;

  if (a.imageType !== "dynamic") {
    const url = text(a.imageURL);
    const byUrl = url === undefined ? undefined : ctx.mediaForUrl(url);
    // Cwicly prints the stored address unless a size is chosen (or the image opens in a lightbox), in
    // which case it derives the file from the attachment id. The two name one file unless the block's
    // image was replaced and the id was left behind.
    const sized = text(a.imageThumbnailSize) !== undefined || a.lightbox === true;
    // An address no attachment accounts for is kept (and reported by the URL rewrite) rather than swapped
    // for the file of an id that may be stale.
    const shown = sized || url === undefined ? (byId ?? byUrl) : byUrl;
    if (byId && byUrl && byId.src !== byUrl.src) {
      report(
        ctx,
        "dynamic.stale-image",
        "info",
        `The image block names the attachment ${id} (${byId.src}) and the address ${url ?? ""} (${byUrl.src}): the ${sized ? "attachment" : "address"} is shown, as Cwicly shows it.`,
        { token: `image:${id}`, id },
      );
    }
    if (shown) {
      // The alt text is the attachment id's (`{imagealt=ID}`), and empty for an image with no id, however much
      // alt text the file's own attachment has: that is what the live page prints, and an image the site
      // left without a description stays decorative.
      const alt = stated ?? literalFinal(ctx, byId?.alt ?? "");
      return {
        src: literalFinal(ctx, shown.src),
        alt,
        ...(shown.width === undefined ? {} : { width: shown.width }),
        ...(shown.height === undefined ? {} : { height: shown.height }),
        ...common,
        ...(hasId ? { id } : {}),
        bound: false,
      };
    }
    if (hasId && url === undefined) {
      report(
        ctx,
        "dynamic.missing-image",
        "warn",
        `The image ${id} has no file in the media plan.`,
        { token: `imageID:${id}`, id },
      );
      return undefined;
    }
    if (url !== undefined) {
      return {
        src: literalFinal(ctx, ctx.rewriteUrl(url)),
        alt: stated ?? literalFinal(ctx, idAlt ?? ""),
        ...common,
        bound: false,
      };
    }
    return undefined;
  }

  const fallback = fallbackImageSrc(ctx, a, {
    id: "dynamicStaticFallbackID",
    url: "dynamicStaticFallbackURL",
  });
  const source = text(a.dynamic);
  let ref: Ref | undefined;
  let problem: string | undefined;
  if (source === "wordpress") {
    const type = text(a.dynamicWordpressType);
    if (type === "featuredimage") {
      ref = currentRef(ctx, "featuredImage");
      if (!ref) problem = "the featured image is the current post's, and this conversion has none";
    } else {
      problem = `the dynamic image "${type ?? ""}" (an avatar or an attachment page) has no file on the converted site`;
    }
  } else if (source === "acf") {
    const key = text(a.dynamicACFField);
    const info = key === undefined ? undefined : fieldByKey(ctx.acf, key);
    if (!info) {
      problem = `the ACF field ${key ?? ""} is not defined by any field group`;
      report(
        ctx,
        "dynamic.unknown-field",
        "warn",
        `The ACF field "${key ?? ""}" is not defined by any field group.`,
        { token: key ?? "", field: key ?? "" },
      );
    } else {
      const got = acfRef(ctx, info, parseLocation(acfLocationArg(a, CONTENT_LOCATION)));
      if ("problem" in got) problem = got.problem;
      else {
        const plus = text(a.dynamicACFFieldPlus);
        ref = plus ? refProp(got.ref, plus === "url" ? "src" : plus) : got.ref;
        if (info.field.type !== "image" && info.field.type !== "file" && !plus) {
          // A URL or a text field holds the address itself.
          const textual = fieldText(ctx, info.field, got.ref);
          if (textual) {
            return {
              src: withFallbackSrc(ctx, textual, fallback),
              alt: stated ?? "",
              ...common,
              bound: !("lit" in textual),
            };
          }
        }
      }
    }
  } else {
    problem = `the dynamic image source "${source ?? ""}" has no value on the converted site`;
  }
  if (!ref) {
    if (problem !== undefined) {
      report(ctx, "dynamic.unsupported", "warn", `The image cannot be bound here: ${problem}.`, {
        token: `image:${source ?? ""}`,
        detail: problem,
      });
    }
    return fallback === undefined
      ? undefined
      : { src: literalFinal(ctx, fallback), alt: stated ?? "", ...common, bound: false };
  }
  const parts = imageOfRef(ref);
  const bound = !("lit" in parts.src);
  // A post with no image and no fallback has no image to show: the converter leaves the element out.
  if (!bound && (parts.src as { lit: string }).lit === "" && fallback === undefined)
    return undefined;
  // A literal featured image is shown at the size the block asks for, as WordPress prints it; the
  // original's dimensions are the entry's data.
  const sized = bound ? undefined : featuredSize(ctx, a);
  const width = sized?.width ?? omitEmpty(parts.width);
  const height = sized?.height ?? omitEmpty(parts.height);
  return {
    src: withFallbackSrc(ctx, parts.src, fallback),
    // The image's own alt text, else the alt of the attachment the block used to show.
    alt:
      stated ??
      finalForm(
        ctx,
        idAlt === undefined ? parts.alt : (orElse(parts.alt, litV(idAlt)) ?? parts.alt),
      ),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...common,
    bound,
  };
}

// ── Backgrounds ──────────────────────────────────────────────────────────────────────────────────

export interface BackgroundSpec {
  /** The style key to set: Cwicly's stylesheet reads `background-image: var(--background-image)`. */
  property: "--background-image";
  /** The value: `url(/media/a.jpg)`, or a binding that is `none` when the entry has no image. */
  value: string;
  bound: boolean;
}

const BACKGROUND_LOCATION = {
  location: "backgroundDynamicACFFieldLocation",
  id: "backgroundDynamicACFFieldLocationID",
  object: "backgroundDynamicACFFieldLocationIDObject",
} as const;

/**
 * The dynamic background image of a block (`backgroundImageType: "dynamic"`): the featured image, an ACF
 * image field, or the block's fallback. Cwicly sets it as the custom property `--background-image` in
 * the element's inline style, and its stylesheet reads it: so does this.
 */
export function blockBackground(block: WpBlock, ctx: ConvertCtx): BackgroundSpec | undefined {
  const a = block.attrs;
  if (text(a.backgroundDynamic) === undefined) return undefined;
  // `backgroundImageType` is `static` unless it says otherwise, and the background has to be an image at the main breakpoint.
  if (text(a.backgroundImageType) !== "dynamic") return undefined;
  const main = ctx.cwicly.breakpoints.find((b) => b.isMain)?.key;
  const types = record(a.backgroundType);
  if (main === undefined || types?.[main] !== "image") return undefined;
  const fallback = fallbackImageSrc(ctx, a, {
    id: "backgroundDynamicStaticFallbackID",
    url: "backgroundDynamicStaticFallbackURL",
  });
  const source = text(a.backgroundDynamic);
  let ref: Ref | undefined;
  let problem: string | undefined;
  if (source === "wordpress") {
    const type = text(a.backgroundDynamicWordpressType);
    if (type === "featuredimage") {
      const image = currentRef(ctx, "featuredImage");
      if (image) ref = refProp(image, "src");
      else problem = "the featured image is the current post's, and this conversion has none";
    } else {
      problem = `the dynamic background "${type ?? ""}" (an avatar) has no file on the converted site`;
    }
  } else if (source === "acf") {
    const key = text(a.backgroundDynamicACFField);
    const info = key === undefined ? undefined : fieldByKey(ctx.acf, key);
    if (!info) {
      problem = `the ACF field ${key ?? ""} is not defined by any field group`;
    } else {
      const got = acfRef(ctx, info, parseLocation(acfLocationArg(a, BACKGROUND_LOCATION)));
      if ("problem" in got) problem = got.problem;
      else
        ref =
          info.field.type === "image" || info.field.type === "file"
            ? refProp(got.ref, "src")
            : got.ref;
    }
  } else {
    problem = `the dynamic background source "${source ?? ""}" has no value on the converted site`;
  }
  if (!ref) {
    if (problem !== undefined) {
      report(
        ctx,
        "dynamic.unsupported",
        "warn",
        `The background image cannot be bound here: ${problem}.`,
        { token: `background:${source ?? ""}`, detail: problem },
      );
    }
    return fallback === undefined
      ? undefined
      : {
          property: "--background-image",
          value: literalFinal(ctx, `url(${fallback})`),
          bound: false,
        };
  }
  if (!isExprRef(ref)) {
    const src =
      ref.value === undefined || ref.value === null || ref.value === ""
        ? fallback
        : String(ref.value);
    return {
      property: "--background-image",
      value: src === undefined ? "none" : literalFinal(ctx, `url(${src})`),
      bound: false,
    };
  }
  const pick = fallback === undefined ? `${ref.expr}` : `(${ref.expr}) || ${jsString(fallback)}`;
  return {
    property: "--background-image",
    value: `\${(${pick}) ? 'url(' + (${pick}) + ')' : 'none'}`,
    bound: true,
  };
}

// ── Galleries ────────────────────────────────────────────────────────────────────────────────────

export interface GalleryImage {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  /** The attachment id, for a fixed gallery. */
  id?: number;
}

export interface GallerySpec {
  /** The images of a gallery that is fixed (static, or an ACF field of the current post on a static page). */
  images: GalleryImage[];
  /**
   * For a gallery that belongs to the entry: the expression of the list of `{src, width, height, alt}`
   * (`state.entry.data.gallery`). Empty when `images` is the answer.
   */
  list?: string;
  /** Whether the images open in a lightbox (the block's link wrapper). */
  lightbox: boolean;
}

/** The ids of the images in a static gallery's saved markup, in order: `{image=815}` once per figure. */
export function galleryIds(block: WpBlock): number[] {
  const ids: number[] = [];
  for (const m of block.innerHTML.matchAll(/<img[^>]*\ssrc="\{image=(\d+)\}"/g))
    ids.push(Number(m[1]));
  return ids;
}

/**
 * The images of a `cwicly/gallery` block. A fixed gallery keeps its images only in its saved
 * markup (`<img src="{image=815}">` in a figure each; the block has no list attribute) and in the
 * `galleries` attribute when the editor kept one; an ACF gallery names a field. Each image is the one
 * original the media plan keeps for its family.
 */
export function blockGallery(block: WpBlock, ctx: ConvertCtx): GallerySpec | undefined {
  const a = block.attrs;
  const lightbox = a.linkWrapperActive === true && a.linkWrapperType === "lightbox";
  const dynamic = text(a.galleryDynamic) === "dynamic";
  if (dynamic) {
    if (text(a.galleryDynamicType) !== "acf") {
      report(
        ctx,
        "dynamic.unsupported",
        "warn",
        `The gallery source "${text(a.galleryDynamicType) ?? ""}" is not carried over.`,
        { token: `gallery:${text(a.galleryDynamicType) ?? ""}` },
      );
      return undefined;
    }
    const key = text(a.galleryDynamicACFField);
    const info = key === undefined ? undefined : fieldByKey(ctx.acf, key);
    if (!info) {
      report(
        ctx,
        "dynamic.unknown-field",
        "warn",
        `The ACF field "${key ?? ""}" of the gallery is not defined by any field group.`,
        { token: key ?? "", field: key ?? "" },
      );
      return undefined;
    }
    const got = acfRef(ctx, info, { kind: "current" });
    if ("problem" in got) {
      report(
        ctx,
        "dynamic.unsupported",
        "warn",
        `The gallery cannot be bound here: ${got.problem}.`,
        { token: `gallery:${key ?? ""}` },
      );
      return undefined;
    }
    if (isExprRef(got.ref)) return { images: [], list: `(${got.ref.expr} ?? [])`, lightbox };
    const value = got.ref.value;
    const images = (Array.isArray(value) ? value : []).map((i) => i as GalleryImage);
    return { images, lightbox };
  }
  const ids = galleryIds(block);
  const fromAttr = Array.isArray(a.galleries)
    ? (a.galleries as { images?: unknown[] }[]).flatMap((g) => (g.images ?? []).map(Number))
    : [];
  const images: GalleryImage[] = [];
  for (const id of ids.length > 0 ? ids : fromAttr) {
    const media = ctx.mediaFor(id);
    if (!media) {
      report(
        ctx,
        "dynamic.missing-image",
        "warn",
        `The gallery image ${id} has no file in the media plan.`,
        { token: `gallery:${id}`, id },
      );
      continue;
    }
    images.push({
      src: media.src,
      alt: media.alt,
      id,
      ...(media.width === undefined ? {} : { width: media.width }),
      ...(media.height === undefined ? {} : { height: media.height }),
    });
  }
  return { images, lightbox };
}

/**
 * The figures of a gallery as markup for an `innerHTML`: one `<figure>` per image, each image a link to
 * its file when the gallery opens in a lightbox. A gallery that belongs to the entry is one expression
 * that builds the markup, so an entry with no images prints an empty container and the page stays
 * static (docs/bindings.md, section 4).
 */
export function galleryMarkup(spec: GallerySpec): string {
  const attr = (v: string): string => escapeHtml(v).replaceAll('"', "&quot;");
  if (spec.list === undefined) {
    return escapeTemplate(
      spec.images
        .map((i) => {
          const size = `${i.width ? ` width="${i.width}"` : ""}${i.height ? ` height="${i.height}"` : ""}`;
          const img = `<img src="${attr(i.src)}" alt="${attr(i.alt)}"${size}>`;
          return `<figure class="cc-gallery-card">${spec.lightbox ? `<a href="${attr(i.src)}">${img}</a>` : img}</figure>`;
        })
        .join(""),
    );
  }
  // The same markup as one expression over the entry's list, each value escaped for an attribute.
  const esc =
    "(s => String(s ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c])))";
  const img = `'<img src="' + ${esc}(i.src) + '" alt="' + ${esc}(i.alt) + '"' + (i.width ? ' width="' + i.width + '"' : '') + (i.height ? ' height="' + i.height + '"' : '') + '>'`;
  const body = spec.lightbox ? `'<a href="' + ${esc}(i.src) + '">' + ${img} + '</a>'` : img;
  return `\${${spec.list}.map(i => '<figure class="cc-gallery-card">' + ${body} + '</figure>').join('')}`;
}
