/**
 * Cwicly's link wrapper: any block with `linkWrapperActive` is a link, and about eighty attributes say
 * where it goes (`linkWrapperUrl`, `linkWrapperStaticObject`, `linkWrapperSourceDynamic`,
 * `linkWrapperAction`…). This is a port of the editor's builder for the link's attributes (module
 * 13993 of the plugin's `build/index.js`, the one that writes `href="{pageurl}"` into the saved tag),
 * with each destination resolved by the token table of tokens.ts, so a link built here and the same
 * link read back from the saved markup are the same link. The tests hold them to that on every
 * link-wrapped block of both sites.
 *
 * ## Which element is the anchor
 *
 * Measured over the saved markup of both sites (`anchor` in the result):
 *
 * - `self`: the block's own element becomes the `<a>` (button, div, section, container, column, icon,
 *   paragraph: a link-wrapped paragraph is an `<a class="paragraph-…">`, not a `<p>`);
 * - `inner`: the block's element stays and an `<a>` wraps its content: `<h3 class="heading-…"><a href=…>`
 *   for a heading and `<li class="cc-nav-link"><a class="cc-nav-item">` for a nav link;
 * - `outer`: the `<a>` wraps the element: a linked image is `<a class="cc-lightbox"><img></a>`;
 * - `button`: the block is a `<button>` (`containerLayoutTag: "button"`), which has no `href`;
 * - `images`: a gallery, whose link wrapper is its lightbox: every image of it is its own link, and the
 *   block itself has none.
 *
 * ## Actions
 *
 * A link wrapper can also be an action (`linkWrapperType: "action"`). What a static site can keep:
 * a modal opener becomes a popover trigger (`link.approximated`), a lightbox becomes a plain link to
 * its image or video (`link.approximated`), "scroll to top" becomes `#`. A query's next, previous and
 * load-more buttons, sliders, filters, dark-mode toggles and WooCommerce actions have no static
 * equivalent: `link.unsupported`, and the link has no destination.
 */
import { finishBindings } from "../jx-util.ts";
import type { ConvertCtx, WpBlock } from "../types.ts";
import { maybeUnserialize } from "../wp/phpser.ts";
import { acfLocationArg } from "./dynamic.ts";
import {
  acfRef,
  fieldByKey,
  fieldText,
  finalForm,
  isExprRef,
  literalFinal,
  literalTemplate,
  objectUrl,
  optPath,
  parseLocation,
  report,
  resolveMarked,
} from "./tokens.ts";

export type LinkAction =
  | { kind: "modal"; mode: "open" | "close" | "toggle"; target: string }
  | { kind: "popover"; mode: "show" | "hide" | "toggle" | "showHide"; target: string }
  | { kind: "nav"; mode: "show" | "hide" | "toggle"; target: string }
  | { kind: "lightbox"; media: "image" | "video"; gallery?: string; caption?: string }
  | { kind: "scroll"; to: "top" }
  | { kind: "slider"; mode: string; target: string; index?: number }
  | { kind: "query"; mode: "next" | "previous" | "load-more" }
  | { kind: "share"; network: string }
  | { kind: "contact"; type: string }
  | { kind: "darkmode" }
  | { kind: "filter" }
  | { kind: "shop"; action: string };

export interface LinkSpec {
  /** Final-form: a Jx path, an external URL, `mailto:…`, or a binding that is `false` when there is none. */
  href?: string;
  /** `_blank` when the link opens in a new tab. */
  target?: string;
  /** `noopener` is added for a new tab, as the editor does. */
  rel?: string;
  title?: string;
  ariaLabel?: string;
  action?: LinkAction;
  anchor: "self" | "inner" | "outer" | "button" | "images";
  /** Why the link asked for has no destination, when it has none. */
  unresolved?: string;
  /** Whether `href` (or anything else) reads the entry or a component's state. */
  bound: boolean;
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined;

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** The host of an address, without a leading `www.`, or undefined for anything that is not http(s). */
function hostOf(url: string): string | undefined {
  if (!/^(?:https?:)?\/\//i.test(url.trim())) return undefined;
  try {
    return new URL(url.trim(), "https://placeholder.invalid").hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

const rankMathNewWindow = new WeakMap<object, boolean>();

/**
 * Whether Rank Math opens the external links of a post's content in a new window
 * (`new_window_external_links` in `rank-math-options-general`, read while the plugin is active). It does
 * so when it filters `the_content` (priority 11), so a post's own content, and the reusable blocks it
 * holds, are affected and a template or a template part is not.
 */
function opensExternalLinksInNewWindow(ctx: ConvertCtx): boolean {
  if (ctx.subject.kind !== "post") return false;
  const known = rankMathNewWindow.get(ctx.model.options);
  if (known !== undefined) return known;
  const raw = ctx.model.options.get("rank-math-options-general");
  const general = raw === undefined ? undefined : maybeUnserialize(raw);
  const on =
    ctx.model.site.activePlugins.some((p) => p.startsWith("seo-by-rank-math")) &&
    typeof general === "object" &&
    general !== null &&
    (general as Record<string, unknown>).new_window_external_links === "on";
  rankMathNewWindow.set(ctx.model.options, on);
  return on;
}

/** Whether an address leads to another site than the one being converted. */
function isExternal(ctx: ConvertCtx, href: string): boolean {
  const host = hostOf(href);
  if (host === undefined) return false;
  const own = [ctx.model.site.url, ctx.model.site.home].map((u) => hostOf(u));
  return !own.includes(host);
}

/** Which element carries the anchor, by block. */
function anchorOf(block: WpBlock): LinkSpec["anchor"] {
  if (block.name === "cwicly/gallery") return "images";
  const tag = text(block.attrs.containerLayoutTag);
  if (block.name === "cwicly/heading") return "inner";
  if (block.name === "cwicly/navlink" || block.name === "cwicly/navdropdown") return "inner";
  if (block.name === "cwicly/image") return "outer";
  if (tag === "button") return "button";
  return "self";
}

/** A token resolved to the final-form string a link attribute holds. */
function tokenHref(token: string, ctx: ConvertCtx, block: WpBlock): string | undefined {
  const marked = resolveMarked(token, ctx, block, false);
  const out = finishBindings(marked, "attribute", () => literalTemplate(ctx));
  return out === "" ? undefined : out;
}

/** The ACF location of a link wrapper's field, in the editor's own spelling. */
function linkLocation(attrs: Record<string, unknown>): string {
  return acfLocationArg(attrs, {
    location: "linkWrapperAcfLocation",
    id: "linkWrapperAcfLocationID",
    object: "linkWrapperAcfLocationIDObject",
  });
}

/** An ACF field's URL for a link: a link field's `url`, an image's file, a URL or text field's text. */
function acfHref(
  block: WpBlock,
  ctx: ConvertCtx,
  fieldKey: string,
  locationArg: string,
): string | undefined {
  const info = fieldByKey(ctx.acf, fieldKey);
  if (!info) {
    report(
      ctx,
      "dynamic.unknown-field",
      "warn",
      `The ACF field "${fieldKey}" of a link is not defined by any field group.`,
      { token: fieldKey, field: fieldKey },
    );
    return undefined;
  }
  const got = acfRef(ctx, info, parseLocation(locationArg));
  if ("problem" in got) {
    report(
      ctx,
      "dynamic.unsupported",
      "warn",
      `A link to the field "${info.field.name}" cannot be bound here: ${got.problem}.`,
      { token: `link:${fieldKey}`, field: info.field.name },
    );
    return undefined;
  }
  const v = fieldText(ctx, info.field, got.ref);
  if (!v) return undefined;
  if (isExprRef(got.ref)) return `\${(${(v as { expr: string }).expr}) || false}`;
  return "lit" in v && v.lit !== "" ? finalForm(ctx, v) : undefined;
}

const SHARE: Readonly<Record<string, (description: string) => string>> = {
  twitter: (d) =>
    `https://twitter.com/intent/tweet?url={pageurl=false=encoded}&text=${encodeURIComponent(d)}`,
  facebook: () => "https://www.facebook.com/sharer.php?u={pageurl=false=encoded}",
  linkedin: (d) =>
    `https://www.linkedin.com/shareArticle?url={pageurl=false=encoded}&title=${encodeURIComponent(d)}`,
  pinterest: (d) =>
    `https://www.pinterest.com/pin/create/button?url={pageurl=false=encoded}&media=&description=${encodeURIComponent(d)}`,
  reddit: (d) =>
    `https://reddit.com/submit?url={pageurl=false=encoded}&title=${encodeURIComponent(d)}`,
  whatsapp: () => "https://wa.me/?text={pageurl=false=encoded}",
  sms: () => "sms:%7Bphone_number%7D?body={pageurl=false=encoded}",
  stumbleupon: (d) =>
    `https://www.stumbleupon.com/submit?url={pageurl=false=encoded}&title=${encodeURIComponent(d)}`,
};

/** The `href` of a contact action: mail, phone, messaging apps. */
function contactHref(a: Record<string, unknown>): string | undefined {
  const type = text(a.linkWrapperActionContactType);
  const line = text(a.linkWrapperActionContactOneLine);
  switch (type) {
    case "email":
      return `mailto:${text(a.linkWrapperActionContactEmailAddress) ?? ""}?subject=${encodeURIComponent(text(a.linkWrapperActionContactEmailSubject) ?? "")}&body=${encodeURIComponent(text(a.linkWrapperActionContactEmailMessage) ?? "")}`;
    case "tel":
      return line === undefined ? undefined : `tel:${line}`;
    case "sms":
      return line === undefined ? undefined : `sms:${line}`;
    case "whatsapp":
      return line === undefined ? undefined : `https://api.whatsapp.com/send?phone=${line}`;
    case "messenger":
      return line === undefined ? undefined : `https://m.me/${line}`;
    case "viber": {
      const viber = text(a.linkWrapperActionContactViber);
      return line === undefined || viber === undefined
        ? undefined
        : `viber://${viber}?number=${line}`;
    }
    case "skype": {
      const skype = text(a.linkWrapperActionContactSkype);
      return line === undefined || skype === undefined ? undefined : `skype:${line}?${skype}`;
    }
    case "waze":
      return line === undefined ? undefined : `https://www.waze.com/ul?ll=${line}`;
    default:
      return undefined;
  }
}

/** The id the editor gives a modal block: lower case, no `[post_id]`-style placeholders. */
const modalId = (id: string): string => id;

interface Built {
  href?: string;
  action?: LinkAction;
  unresolved?: string;
  /** A report entry already says why `unresolved` is. */
  reported?: boolean;
}

/** The destination and action of a link whose type is `action`. */
function actionLink(block: WpBlock, ctx: ConvertCtx): Built {
  const a = block.attrs;
  const action = text(a.linkWrapperAction) ?? "";
  const unsupported = (why: string, built: Partial<Built> = {}): Built => {
    report(
      ctx,
      "link.unsupported",
      "warn",
      `The link action "${action}" has no static equivalent: ${why}.`,
      { token: `action:${action}`, action },
    );
    return { unresolved: `the action "${action}" ${why}`, reported: true, ...built };
  };
  const popover = text(a.linkWrapperActionPopoverID);
  if (
    popover !== undefined &&
    ["showPopover", "hidePopover", "togglePopover", "showHidePopover"].includes(action)
  ) {
    const mode = (
      {
        showPopover: "show",
        hidePopover: "hide",
        togglePopover: "toggle",
        showHidePopover: "showHide",
      } as const
    )[action as "showPopover"];
    report(ctx, "link.approximated", "info", "A popover link becomes a popover trigger button.", {
      token: `action:${action}`,
      action,
    });
    return { action: { kind: "popover", mode, target: popover } };
  }
  const nav = text(a.linkWrapperActionNavID);
  if (nav !== undefined && ["showNav", "hideNav", "toggleNav"].includes(action)) {
    return unsupported("is a menu toggle, which the menu converter owns", {
      action: {
        kind: "nav",
        mode: ({ showNav: "show", hideNav: "hide", toggleNav: "toggle" } as const)[
          action as "showNav"
        ],
        target: nav,
      },
    });
  }
  switch (action) {
    case "scrolltotop":
      report(
        ctx,
        "link.approximated",
        "info",
        "A scroll-to-top button links to the top of the page.",
        { token: "action:scrolltotop", action },
      );
      return { href: "#", action: { kind: "scroll", to: "top" } };
    case "toggleDarkMode":
      return unsupported("is a dark mode switch", { action: { kind: "darkmode" } });
    case "share": {
      const network = text(a.linkWrapperShare) ?? "";
      const make = SHARE[network];
      const description = text(a.linkWrapperShareDescription) ?? "";
      let href: string | undefined;
      if (network === "email") {
        href = `mailto:${text(a.linkWrapperActionContactEmailAddress) ?? ""}?subject=${encodeURIComponent(description)}&body={pageurl=false=encoded}`;
      } else if (make) href = make(description);
      const resolved = href === undefined ? undefined : tokenHref(href, ctx, block);
      return {
        ...(resolved === undefined ? {} : { href: resolved }),
        action: { kind: "share", network },
      };
    }
    case "contact": {
      const contact = contactHref(a);
      const href = contact === undefined ? undefined : literalFinal(ctx, contact);
      return {
        ...(href === undefined ? {} : { href }),
        action: { kind: "contact", type: text(a.linkWrapperActionContactType) ?? "" },
      };
    }
    case "modal": {
      const id = text(a.linkWrapperActionModalBlockId);
      const mode = text(a.linkWrapperActionModalType);
      if (id === undefined || (mode !== "open" && mode !== "close" && mode !== "toggle")) {
        return unsupported("names no modal");
      }
      report(ctx, "link.approximated", "info", "A modal opener becomes a popover trigger.", {
        token: `modal:${id}`,
        modal: id,
      });
      return { action: { kind: "modal", mode, target: modalId(id) } };
    }
    case "lightbox": {
      const type = text(a.linkWrapperActionLighboxType) === "video" ? "video" : "image";
      const source = text(a.linkWrapperActionLighboxSourceType);
      let href: string | undefined;
      if (source === "static" || source === undefined) {
        href =
          type === "video"
            ? text(a.linkWrapperActionLighboxVideoURL)
            : text(a.linkWrapperActionLighboxURL);
        if (href !== undefined && type === "image")
          href = ctx.mediaForUrl(href)?.src ?? ctx.rewriteUrl(href);
        if (href !== undefined) href = literalFinal(ctx, href);
      } else {
        const dynamic = text(a.linkWrapperActionLighboxSourceDynamic);
        if (dynamic === "acffield") {
          const field = text(a.linkWrapperActionLighboxAcfFields);
          href = field === undefined ? undefined : tokenHref(`{acffield=${field}}`, ctx, block);
        } else if (dynamic === "featuredimage") {
          href = tokenHref("{featuredimage}", ctx, block);
        } else {
          report(
            ctx,
            "link.unsupported",
            "warn",
            `The lightbox source "${dynamic ?? ""}" has no static equivalent.`,
            { token: `lightbox:${dynamic ?? ""}` },
          );
        }
      }
      report(
        ctx,
        "link.approximated",
        "info",
        "A lightbox link becomes a plain link to the image or video.",
        { token: "action:lightbox", action },
      );
      const gallery = text(a.linkWrapperActionLighboxRef);
      const caption = text(a.linkWrapperActionLighboxCaption);
      return {
        ...(href === undefined ? {} : { href }),
        action: {
          kind: "lightbox",
          media: type,
          ...(gallery === undefined ? {} : { gallery }),
          ...(caption === undefined ? {} : { caption }),
        },
      };
    }
    case "prevQuery":
      return unsupported("is a query's pagination link (Jx has no pagination yet)", {
        action: { kind: "query", mode: "previous" },
      });
    case "nextQuery":
      return unsupported("is a query's pagination link (Jx has no pagination yet)", {
        action: { kind: "query", mode: "next" },
      });
    case "infiniteButtonLoad":
      return unsupported("loads more of a query's results (Jx has no pagination yet)", {
        action: { kind: "query", mode: "load-more" },
      });
    case "slider": {
      const type = text(a.linkWrapperActionSliderType) ?? "";
      const id = text(a.linkWrapperActionSliderID) ?? "";
      const goto = a.linkWrapperActionSliderGoTo;
      return unsupported("controls a slider, which is not carried over", {
        action: {
          kind: "slider",
          mode: type,
          target: id,
          ...(typeof goto === "number" ? { index: goto } : {}),
        },
      });
    }
    case "filter":
      return unsupported("controls a filter", { action: { kind: "filter" } });
    default:
      if (/^woo|cart/i.test(action))
        return unsupported("is a shop action", { action: { kind: "shop", action } });
      return unsupported("is not one Cwicly documents");
  }
}

/** The destination of a link whose type is `url`. */
function urlLink(block: WpBlock, ctx: ConvertCtx): Built {
  const a = block.attrs;
  const source = text(a.linkWrapperSourceType) ?? "static";
  if (source === "static") {
    const object = record(a.linkWrapperStaticObject);
    const given = text(a.linkWrapperUrl);
    if (object !== undefined && text(object.id) !== undefined) {
      const found = objectUrl(
        ctx,
        Number(object.id),
        text(object.type) ?? "",
        text(object.kind) ?? "",
      );
      if (!("problem" in found)) return { href: literalFinal(ctx, found.url) };
      report(
        ctx,
        "link.unresolved",
        "warn",
        `A link to ${text(object.type) ?? text(object.kind) ?? "an object"} ${String(object.id)}: ${found.problem}.`,
        {
          token: `pageobject=${String(object.id)}=${text(object.type) ?? ""}=${text(object.kind) ?? ""}`,
        },
      );
      if (given === undefined) return { unresolved: found.problem, reported: true };
    }
    if (given === undefined) return { unresolved: "the link names no address" };
    return { href: literalFinal(ctx, ctx.rewriteUrl(given)) };
  }
  if (source !== "dynamic")
    return { unresolved: `the link source "${source}" is not one Cwicly has` };
  const dynamic = text(a.linkWrapperSourceDynamic);
  if (dynamic === undefined) return { unresolved: "the dynamic link names no source" };
  if (dynamic === "acffield") {
    const field = text(a.linkWrapperAcfFields);
    if (field === undefined) return { unresolved: "the ACF link names no field" };
    const href = acfHref(block, ctx, field, linkLocation(a));
    return href === undefined
      ? { unresolved: `the ACF field ${field} has no address here` }
      : { href };
  }
  if (dynamic === "acfrepeater") {
    const field = text(a.linkWrapperAcfRepeater);
    const href = field === undefined ? undefined : tokenHref(`{acfrepeater=${field}}`, ctx, block);
    return href === undefined
      ? { unresolved: "an ACF repeater link needs the row of its loop" }
      : { href };
  }
  const extra = text(a.linkWrapperSourceExtra);
  const tokens: Record<string, string> = {
    posturl: "{pageurl}",
    attachmenturl: "{attachment_url}",
    homeurl: "{homeurl}",
    siteurl: "{siteurl}",
    authorurl: "{authorurl}",
    featuredimage: "{featuredimage}",
    taxonomytermsurl: "{taxonomytermsurl}",
    taxonomyqueryurl: "{taxonomyqueryurl}",
    userqueryurl: "{userqueryurl}",
    archiveurl: "{archiveurl}",
    postarchiveurl: "{archiveurl}",
    loginurl: extra ? `{loginurl=${extra}}` : "{loginurl}",
    directlogout: extra ? `{directlogout=${extra}}` : "{directlogout}",
    commentsurl: "{commentsurl}",
    commenturl: "{commenturl}",
    commentreplyurl: "{commentreplyurl}",
    editcommenturl: "{editcommenturl}",
  };
  if (dynamic === "previouspost" || dynamic === "nextpost") {
    return { unresolved: "an adjacent post is a query", reported: false };
  }
  if (dynamic === "shortcode") return { unresolved: "a shortcode is PHP" };
  const token = tokens[dynamic];
  if (token === undefined) {
    return {
      unresolved: dynamic.startsWith("comment")
        ? "comments are not carried over"
        : `the dynamic link source "${dynamic}" is not one this tool knows`,
    };
  }
  const href = tokenHref(token, ctx, block);
  // The token's own report says why it printed nothing.
  return href === undefined
    ? { unresolved: `${dynamic} has no value on the converted site`, reported: true }
    : { href };
}

/**
 * The link a block carries, or undefined when it is not a link. `href` is the destination as the
 * link wrapper's source gives it (a URL, a post or term, an ACF field, a dynamic source), made a
 * path of the converted site when it is internal; `action` is what the link does besides leading
 * somewhere. A destination nothing on the converted site can answer is `unresolved`, with the reason,
 * and reported.
 */
export function blockLink(block: WpBlock, ctx: ConvertCtx): LinkSpec | undefined {
  const a = block.attrs;
  const connector = text(record(record(a.componentConnectors)?.link)?.ref);
  if (a.linkWrapperActive !== true && a.linkWrapperActive !== "true") {
    if (connector === undefined) return undefined;
    const key = ctx.props?.get(connector);
    if (key === undefined) {
      report(
        ctx,
        "dynamic.unsupported",
        "warn",
        `The link property ${connector} is not one of this component's properties.`,
        { token: `link:${connector}` },
      );
      return undefined;
    }
    const base = `state.${key}`;
    return {
      href: `\${${optPath(base, "href")} || false}`,
      target: `\${${optPath(base, "target")} || false}`,
      rel: `\${${optPath(base, "rel")} || false}`,
      title: `\${${optPath(base, "title")} || false}`,
      anchor: anchorOf(block),
      bound: true,
    };
  }
  if (block.name === "cwicly/gallery") {
    // A gallery's link wrapper is its lightbox, which opens each image; the images are `blockGallery`'s.
    if (text(a.linkWrapperType) !== "lightbox") return undefined;
    report(
      ctx,
      "link.approximated",
      "info",
      "A gallery's lightbox becomes a plain link to each image's file.",
      { token: "gallery-lightbox", detail: "gallery-lightbox" },
    );
    return { action: { kind: "lightbox", media: "image" }, anchor: "images", bound: false };
  }
  let rel = text(a.linkWrapperRel);
  const title = text(a.linkWrapperTitle);
  const ariaLabel = text(a.linkWrapperAriaLabel);
  const type = text(a.linkWrapperType) ?? "url";
  const built = type === "action" ? actionLink(block, ctx) : urlLink(block, ctx);
  // Rank Math puts `target="_blank"` on an external link of a post's content that has no target of its own.
  const newTab =
    a.linkWrapperNewTab === true ||
    (built.href !== undefined && opensExternalLinksInNewWindow(ctx) && isExternal(ctx, built.href));
  if (newTab)
    rel = rel === undefined ? "noopener" : rel.includes("noopener") ? rel : `${rel} noopener`;
  if (built.unresolved !== undefined && built.reported !== true) {
    report(
      ctx,
      "link.unresolved",
      "warn",
      `A link has no destination on the converted site: ${built.unresolved}.`,
      {
        token: `link:${text(a.linkWrapperSourceDynamic) ?? text(a.linkWrapperSourceType) ?? type}`,
        detail: built.unresolved,
      },
    );
  }
  const anchor = anchorOf(block);
  const bound = built.href?.includes("${") === true;
  return {
    ...(built.href === undefined ? {} : { href: built.href }),
    ...(newTab ? { target: "_blank" } : {}),
    ...(rel === undefined ? {} : { rel: literalFinal(ctx, rel) }),
    ...(title === undefined ? {} : { title: literalFinal(ctx, title) }),
    ...(ariaLabel === undefined ? {} : { ariaLabel: literalFinal(ctx, ariaLabel) }),
    ...(built.action === undefined ? {} : { action: built.action }),
    ...(built.unresolved === undefined ? {} : { unresolved: built.unresolved }),
    anchor,
    bound,
  };
}
