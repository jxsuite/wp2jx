/**
 * The page-side half of the oracle: one function that Chrome runs inside the page and that returns
 * the document as the comparison sees it (`DomExtract`).
 *
 * It is serialised with `Function.prototype.toString` and evaluated in the page, so it must not
 * reach for anything outside itself: every helper is declared inside, and the only import is a type.
 * What it extracts is what a reader of the page sees. Hidden things (`display:none`, zero opacity,
 * `font-size:0`, off-screen, clipped to nothing) are not part of the text, the links or the
 * images, which is also what keeps fineline's injected spam block out of the numbers.
 *
 * Two blind spots, both reported rather than silent where they can be: the element and text-block
 * caps (`truncated`, `truncatedBlocks`, which become an `extract.truncated` finding), and the
 * content of shadow roots, which the walk does not enter (a component that renders into an open or
 * closed shadow root shows its host and nothing inside). Neither site migrated so far uses them.
 */
import type { DomExtract } from "./types.ts";

export interface ExtractOptions {
  /** The most elements the style probe records (text-bearing ones first). */
  maxElements: number;
  /** The most text blocks recorded. */
  maxBlocks: number;
}

export function extractDocument(options: ExtractOptions): DomExtract {
  const doc = document;
  const win = window;
  const body = doc.body;
  const root = doc.documentElement;

  const norm = (text: string): string => text.replace(/[\s ​]+/g, " ").trim();
  const px = (value: string): number => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };

  const styleOf = new Map<Element, CSSStyleDeclaration>();
  const cs = (el: Element): CSSStyleDeclaration => {
    let style = styleOf.get(el);
    if (style === undefined) {
      style = win.getComputedStyle(el);
      styleOf.set(el, style);
    }
    return style;
  };

  const docWidth = Math.max(
    root.scrollWidth,
    body === null ? 0 : body.scrollWidth,
    root.clientWidth,
  );
  const docHeight = Math.max(
    root.scrollHeight,
    body === null ? 0 : body.scrollHeight,
    root.offsetHeight,
  );

  // ── visibility ─────────────────────────────────────────────────────────────────────────────
  const visibleCache = new Map<Element, boolean>();
  const visible = (el: Element): boolean => {
    const cached = visibleCache.get(el);
    if (cached !== undefined) return cached;
    let result = true;
    const style = cs(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      result = false;
    } else if (px(style.opacity) === 0 && style.opacity !== "") {
      result = false;
    } else if (style.display === "contents") {
      // A box-less wrapper (every Jx component host is one) is as visible as its parent: `checkVisibility()`
      // calls it hidden because it has no box, which would hide the whole header it wraps.
      result = true;
    } else {
      const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
      // `content-visibility: auto` content that is merely off-screen still counts: the user scrolls to it.
      if (
        typeof check === "function" &&
        !check.call(el, { opacityProperty: true, visibilityProperty: true })
      ) {
        result = false;
      } else {
        const rect = el.getBoundingClientRect();
        const scrollX = win.scrollX;
        const scrollY = win.scrollY;
        const right = rect.right + scrollX;
        const bottom = rect.bottom + scrollY;
        if (el.getClientRects().length === 0) result = false;
        // Off the page to the left or above it: the classic way to hide a block of links.
        else if (right <= 0 || bottom <= 0) result = false;
        else if (rect.left + scrollX >= docWidth + 200) result = false;
        // A box clipped to a pixel or less hides its content (a 1px link, `clip-path: inset(50%)`).
        else if (
          (rect.width <= 1 || rect.height <= 1) &&
          (style.overflowX !== "visible" || style.overflowY !== "visible")
        ) {
          result = false;
        }
      }
    }
    if (result) {
      const parent = el.parentElement;
      if (parent !== null && parent !== root && !visible(parent)) result = false;
    }
    visibleCache.set(el, result);
    return result;
  };

  // A link is concealed when nothing of it can be seen: no box of its own (font size zero, text pushed
  // off the page with a negative indent, so the anchor has no width) and nothing inside it with one.
  const concealed = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1) return false;
    for (const child of Array.from(el.querySelectorAll("*"))) {
      const inner = child.getBoundingClientRect();
      if (inner.width > 1 && inner.height > 1 && visible(child)) return false;
    }
    return true;
  };
  // Text a negative `text-indent` has pushed off the page reads as nothing, whatever box holds it.
  const textOffPage = (node: Node): boolean => {
    const range = doc.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects());
    return (
      rects.length > 0 &&
      rects.every(
        (rect) =>
          rect.right + win.scrollX <= 0 ||
          rect.bottom + win.scrollY <= 0 ||
          rect.left + win.scrollX >= docWidth + 200,
      )
    );
  };

  // ── selector path ──────────────────────────────────────────────────────────────────────────
  const CLASS_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{7}$/;
  const escapeCss = (value: string): string =>
    typeof win.CSS !== "undefined" && typeof win.CSS.escape === "function"
      ? win.CSS.escape(value)
      : value.replace(/[^\w-]/g, "\\$&");
  const classesOf = (el: Element): string[] =>
    (el.getAttribute("class") ?? "").split(/\s+/).filter((c) => c !== "");
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let current: Element | null = el;
    while (current !== null && current !== root) {
      const tag = current.tagName.toLowerCase();
      if (current === body) {
        parts.unshift("body");
        break;
      }
      if (current.id !== "" && doc.querySelectorAll(`#${escapeCss(current.id)}`).length === 1) {
        parts.unshift(`${tag}#${escapeCss(current.id)}`);
        break;
      }
      const parent: Element | null = current.parentElement;
      const index =
        parent === null ? 1 : Array.prototype.indexOf.call(parent.children, current) + 1;
      const first = classesOf(current).find((c) => CLASS_ID.test(c));
      parts.unshift(
        `${tag}${first === undefined ? "" : `.${escapeCss(first)}`}:nth-child(${index})`,
      );
      current = parent;
    }
    return parts.join(" > ");
  };

  // ── text blocks ────────────────────────────────────────────────────────────────────────────
  const SKIP = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "HEAD",
    "TITLE",
    "META",
    "LINK",
  ]);
  const isInline = (el: Element): boolean => {
    const display = cs(el).display;
    return (
      display === "inline" ||
      display === "contents" ||
      display === "ruby" ||
      display === "inline-block" ||
      display === "inline-flex" ||
      display === "inline-grid" ||
      display === "inline-table"
    );
  };
  const blockOf = (node: Node): Element | null => {
    let el = node.parentElement;
    while (el !== null && el !== body && isInline(el)) el = el.parentElement;
    return el;
  };

  const blocks = new Map<Element, string>();
  const walker = doc.createTreeWalker(
    body ?? root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node: Node): number {
        if (node.nodeType === 1) {
          const el = node as Element;
          if (
            SKIP.has(el.tagName) ||
            (el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName.toLowerCase() !== "svg")
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          if (el.tagName === "BR") return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null) continue;
    if (node.nodeType === 1) {
      if (!visible(node as Element)) continue;
      const block = blockOf(node as Element);
      if (block !== null) blocks.set(block, `${blocks.get(block) ?? ""} `);
      continue;
    }
    const value = node.nodeValue ?? "";
    if (value.trim() === "" && !/\s/.test(value)) continue;
    if (!visible(parent)) continue;
    if (px(cs(parent).fontSize) === 0) continue;
    if (px(cs(parent).textIndent) < -100 && textOffPage(node)) continue;
    const block = blockOf(node);
    if (block === null) continue;
    blocks.set(block, (blocks.get(block) ?? "") + value);
  }
  const textBlocks: DomExtract["textBlocks"] = [];
  let truncatedBlocks = 0;
  for (const [el, text] of blocks) {
    const clean = norm(text);
    if (clean === "") continue;
    if (textBlocks.length >= options.maxBlocks) {
      truncatedBlocks += 1;
      continue;
    }
    textBlocks.push({ path: pathOf(el), text: clean });
  }

  // ── headings, links ────────────────────────────────────────────────────────────────────────
  const headings: DomExtract["headings"] = [];
  for (const el of Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    if (!visible(el)) continue;
    const text = norm(el.textContent ?? "");
    if (text === "") continue;
    headings.push({ level: Number(el.tagName.slice(1)), text, path: pathOf(el) });
  }

  const links: DomExtract["links"] = [];
  for (const el of Array.from(doc.querySelectorAll("a[href]"))) {
    if (!visible(el) || concealed(el)) continue;
    const raw = el.getAttribute("href") ?? "";
    const text =
      norm(el.textContent ?? "") ||
      norm(el.getAttribute("aria-label") ?? "") ||
      norm(el.querySelector("img")?.getAttribute("alt") ?? "");
    links.push({ href: (el as HTMLAnchorElement).href, raw, text, path: pathOf(el) });
  }

  // ── images ─────────────────────────────────────────────────────────────────────────────────
  const images: DomExtract["images"] = [];
  for (const el of Array.from(doc.images)) {
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    const src = el.currentSrc !== "" ? el.currentSrc : el.src;
    const isSvg = /\.svg(\?|#|$)/i.test(src) || src.startsWith("data:image/svg");
    images.push({
      kind: "img",
      src: el.src,
      currentSrc: el.currentSrc,
      alt: el.getAttribute("alt") ?? "",
      naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      loaded: el.complete && (el.naturalWidth > 0 || isSvg),
      path: pathOf(el),
    });
  }

  // ── element probe ──────────────────────────────────────────────────────────────────────────
  const LANDMARKS = new Set(["NAV", "HEADER", "FOOTER", "MAIN", "ASIDE", "FORM", "ARTICLE"]);
  const MEDIA_OR_CONTROL = new Set([
    "IMG",
    "A",
    "BUTTON",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "UL",
    "OL",
    "LI",
    "SECTION",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "P",
    "VIDEO",
    "PICTURE",
    "SVG",
  ]);
  const landmarkOf = (el: Element): string => {
    let parent = el.parentElement;
    while (parent !== null && parent !== body) {
      if (LANDMARKS.has(parent.tagName)) return parent.tagName.toLowerCase();
      parent = parent.parentElement;
    }
    return "body";
  };
  const ownText = (el: Element): string => {
    let text = "";
    for (const child of Array.from(el.childNodes))
      if (child.nodeType === 3) text += child.nodeValue ?? "";
    return norm(text);
  };

  const withText: Element[] = [];
  const structural: Element[] = [];
  const clipped = new Map<Element, boolean>();
  const overflowCandidates: { el: Element; right: number; width: number }[] = [];
  const viewportWidth = root.clientWidth;
  const sideways = docWidth > viewportWidth + 1;
  const all = Array.from((body ?? root).querySelectorAll("*"));
  const backgrounds: DomExtract["images"] = [];
  for (const el of all) {
    const tag = el.tagName;
    if (
      SKIP.has(tag) ||
      (el.namespaceURI === "http://www.w3.org/2000/svg" && tag.toLowerCase() !== "svg")
    )
      continue;
    if (!visible(el)) continue;
    const style = cs(el);
    const text = ownText(el);
    if (text !== "" && px(style.fontSize) > 0) withText.push(el);
    else if (
      LANDMARKS.has(tag) ||
      MEDIA_OR_CONTROL.has(tag.toUpperCase()) ||
      classesOf(el).some((c) => CLASS_ID.test(c))
    )
      structural.push(el);

    const bg = style.backgroundImage;
    if (bg !== "none" && bg.includes("url(")) {
      const match = /url\((["']?)(.*?)\1\)/.exec(bg);
      if (match !== null && match[2] !== undefined && !match[2].startsWith("data:")) {
        const rect = el.getBoundingClientRect();
        let absolute = match[2];
        try {
          absolute = new URL(match[2], doc.baseURI).href;
        } catch {
          // keep as written
        }
        backgrounds.push({
          kind: "background",
          src: absolute,
          currentSrc: absolute,
          alt: "",
          naturalWidth: 0,
          naturalHeight: 0,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
          loaded: true,
          path: pathOf(el),
        });
      }
    }

    if (sideways && style.position !== "fixed") {
      const rect = el.getBoundingClientRect();
      if (rect.right + win.scrollX > viewportWidth + 1 && rect.width > 0) {
        overflowCandidates.push({
          el,
          right: Math.round(rect.right + win.scrollX),
          width: Math.round(rect.width),
        });
      }
    }
  }
  images.push(...backgrounds);

  const isClipped = (el: Element): boolean => {
    const cached = clipped.get(el);
    if (cached !== undefined) return cached;
    let result = false;
    const parent = el.parentElement;
    if (parent !== null && parent !== root) {
      const style = cs(parent);
      const clips =
        style.overflowX === "hidden" ||
        style.overflowX === "clip" ||
        style.overflowX === "auto" ||
        style.overflowX === "scroll";
      if (clips && parent.getBoundingClientRect().right + win.scrollX <= viewportWidth + 1)
        result = true;
      else result = isClipped(parent);
    }
    clipped.set(el, result);
    return result;
  };
  const offenders = overflowCandidates
    .filter((c) => !isClipped(c.el))
    .sort((a, b) => b.right - a.right)
    .slice(0, 10)
    .map((c) => ({ path: pathOf(c.el), right: c.right, width: c.width }));

  const chosen = [...withText, ...structural].slice(0, options.maxElements);
  const truncated = withText.length + structural.length - chosen.length;
  const probed = new Set(chosen);
  const ordered = all.filter((el) => probed.has(el));
  const elements: DomExtract["elements"] = ordered.map((el) => {
    const style = cs(el);
    const rect = el.getBoundingClientRect();
    return {
      path: pathOf(el),
      tag: el.tagName.toLowerCase(),
      classes: classesOf(el),
      text: ownText(el).slice(0, 80),
      landmark: landmarkOf(el),
      rect: {
        x: Math.round((rect.left + win.scrollX) * 10) / 10,
        y: Math.round((rect.top + win.scrollY) * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      },
      style: {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        color: style.color,
        backgroundColor: style.backgroundColor,
        display: style.display,
        margin: style.margin,
        padding: style.padding,
      },
    };
  });

  const meta = (selector: string, attribute: string): string =>
    norm(doc.querySelector(selector)?.getAttribute(attribute) ?? "");

  return {
    title: norm(doc.title),
    description: meta('meta[name="description" i]', "content"),
    canonical: (doc.querySelector('link[rel="canonical" i]') as HTMLLinkElement | null)?.href ?? "",
    robots: meta('meta[name="robots" i]', "content"),
    lang: root.getAttribute("lang") ?? "",
    docWidth,
    docHeight,
    textBlocks,
    headings,
    links,
    images,
    elements,
    overflow: {
      scrollWidth: docWidth,
      clientWidth: viewportWidth,
      overflow: sideways,
      offenders,
    },
    truncated,
    truncatedBlocks,
  };
}
