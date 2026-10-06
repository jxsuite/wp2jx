/**
 * The vocabulary of `wp2jx verify`: what one page capture holds, what a comparison finds, and what
 * the report carries. Everything here is plain JSON so a capture can be cached, a report can be read
 * by a fix loop, and the comparison logic can be tested without a browser.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The computed properties a probe records for each element: what the oracle compares by value. */
export const STYLE_PROPS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "color",
  "backgroundColor",
  "display",
  "margin",
  "padding",
] as const;

export type StyleProp = (typeof STYLE_PROPS)[number];
export type StyleProbe = Record<StyleProp, string>;

export interface ElementProbe {
  /** A CSS selector that finds the element again (`body > main#x > section.s-1a2b3c4:nth-child(2) > h2:nth-child(1)`). */
  path: string;
  tag: string;
  classes: string[];
  /** The element's own text nodes, normalised and cut to 80 characters; empty for a structural element. */
  text: string;
  /** The closest landmark ancestor (`nav`, `header`, `footer`, `main`, `aside`, `form`, `article`) or `body`. */
  landmark: string;
  rect: Rect;
  style: StyleProbe;
}

export interface LinkInfo {
  /** The resolved absolute address (`a.href`). */
  href: string;
  /** The attribute as written. */
  raw: string;
  text: string;
  path: string;
}

export interface ImageInfo {
  kind: "img" | "background";
  /** The address the author wrote (`src`, or the CSS `url()`), resolved to an absolute one. */
  src: string;
  /** What the browser chose (`currentSrc`), which differs from `src` inside `<picture>` and with `srcset`. */
  currentSrc: string;
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Rendered size. */
  width: number;
  height: number;
  /** The browser finished with it and has pixels (`<img>` only; a background is assumed to have loaded). */
  loaded: boolean;
  /** The oracle refused the request (a blocked host): it never loaded because of the capture, not the page. */
  blocked?: boolean;
  path: string;
}

export interface HeadingInfo {
  level: number;
  text: string;
  path: string;
}

export interface TextBlock {
  path: string;
  text: string;
}

export interface OverflowInfo {
  scrollWidth: number;
  clientWidth: number;
  /** `scrollWidth` is wider than the viewport: the page scrolls sideways. */
  overflow: boolean;
  /** The widest elements that stick out of the viewport, when the page overflows. */
  offenders: { path: string; right: number; width: number }[];
}

export interface NetworkFailure {
  url: string;
  status?: number;
  failure?: string;
}

export interface ConsoleError {
  message: string;
  url?: string;
}

/** What the in-page extractor returns: the document as the comparison sees it. */
export interface DomExtract {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  lang: string;
  docWidth: number;
  docHeight: number;
  textBlocks: TextBlock[];
  headings: HeadingInfo[];
  links: LinkInfo[];
  images: ImageInfo[];
  elements: ElementProbe[];
  overflow: OverflowInfo;
  /** Elements the probe left out because of its cap. */
  truncated: number;
  /** Text blocks the extractor left out because of its cap. */
  truncatedBlocks?: number;
}

export interface PageSnapshot extends DomExtract {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  viewport: { width: number; height: number };
  consoleErrors: ConsoleError[];
  failedRequests: NetworkFailure[];
  /** Every address the page asked for (documents, scripts, styles, fonts, images), without repeats and capped. */
  requests?: string[];
  /** Set when the page could not be captured at all; the other fields are then empty. */
  error?: string;
  /** The page was still changing after several screenshots (an endless script animation): its pixels are approximate. */
  unstable?: boolean;
  /** The screenshot's height was cut at the capture cap, in pixels (0 when it was whole). */
  clippedAt?: number;
}

export type Severity = "error" | "warning" | "info";

export interface Finding {
  /** Stable, namespaced kebab-case: `style.systematic`, `image.broken`, `text.missing`. */
  code: string;
  severity: Severity;
  /** The viewport width it was found at, or null when it holds for the page as a whole. */
  viewport: number | null;
  message: string;
  /** A selector path that reproduces it, on the page that has the problem. */
  selector?: string | undefined;
  /** For style findings: the computed property. */
  property?: string | undefined;
  live?: unknown;
  local?: unknown;
  /** How many elements, blocks or items it covers. */
  count?: number | undefined;
  /** Everything else a developer needs: examples, paths, values. */
  data?: Record<string, unknown> | undefined;
}

export interface VisualResult {
  /** 1 minus the differing pixel ratio, 0..1. */
  fidelity: number;
  /** The same over the first screen only (the viewport height), so a long page's tail does not hide a good fold. */
  aboveFold: number;
  width: number;
  height: number;
  liveHeight: number;
  localHeight: number;
  mismatchedPixels: number;
  totalPixels: number;
  /** The pixelmatch colour threshold the score was taken at. */
  tolerance: number;
  /** The most different horizontal bands, worst first. */
  bands: { y: number; height: number; mismatch: number }[];
}

export interface ElementDelta {
  /** Where the element is on the live page and on the local one. */
  livePath: string;
  localPath: string;
  tag: string;
  text: string;
  landmark: string;
  /** local minus live, in pixels. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** The computed properties that differ, each with both values. */
  style: { property: StyleProp; live: string; local: string }[];
}

export interface StyleGroup {
  /** `<landmark> > <tag>`. */
  group: string;
  property: StyleProp;
  /** Matched elements in the group, and how many of them differ in this property. */
  elements: number;
  differing: number;
  /** The commonest live and local value pair among the differing ones. */
  live: string;
  local: string;
  /** How many differing elements carry exactly that pair. */
  pairCount: number;
  examples: string[];
}

export interface DomComparison {
  text: {
    similarity: number;
    liveWords: number;
    localWords: number;
    /** Blocks whose words are all there but grouped differently (not counted missing or extra). */
    regrouped: number;
    missing: { path: string; text: string }[];
    extra: { path: string; text: string }[];
    changed: {
      livePath: string;
      localPath: string;
      live: string;
      local: string;
      similarity: number;
    }[];
  };
  headings: {
    live: number;
    local: number;
    missing: HeadingInfo[];
    extra: HeadingInfo[];
    levelChanged: { live: HeadingInfo; local: HeadingInfo }[];
  };
  links: {
    live: number;
    local: number;
    missing: LinkInfo[];
    extra: LinkInfo[];
    hrefChanged: { live: LinkInfo; local: LinkInfo }[];
  };
  images: {
    live: number;
    local: number;
    matched: number;
    missing: ImageInfo[];
    extra: ImageInfo[];
    broken: ImageInfo[];
    /** Live images that did not load on the live page either (a 404 background, a dead `<img>`): not the migration's loss. */
    brokenOnLive?: ImageInfo[];
    /** Matched images with where each comes from and how big each is (the first 100). */
    pairs: {
      key: string;
      kind: "img" | "background";
      liveSrc: string;
      localSrc: string;
      liveNatural: string;
      localNatural: string;
      liveRendered: string;
      localRendered: string;
      loaded: boolean;
      path: string;
    }[];
  };
  elements: {
    live: number;
    local: number;
    matched: number;
    deltas: ElementDelta[];
    groups: StyleGroup[];
  };
}

export interface ViewportResult {
  width: number;
  /** Absent when either page could not be captured. */
  visual?: VisualResult;
  dom?: DomComparison;
  findings: Finding[];
  /** Image files written for this viewport, relative to the work directory. */
  images?: { live: string; local: string; diff: string };
  liveStatus: number | null;
  localStatus: number | null;
  liveFinalUrl: string;
  localFinalUrl: string;
}

export interface UrlResult {
  /** The live address. */
  url: string;
  path: string;
  /** Short file-system name for the page. */
  slug: string;
  viewports: ViewportResult[];
  /** Mean fidelity over the viewports that were compared, or null. */
  fidelity: number | null;
  findings: Finding[];
}
