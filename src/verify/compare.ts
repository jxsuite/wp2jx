/**
 * Comparing a live page with its migrated twin: pixels, then the document, then the page's own
 * health. Everything is a pure function of two captures (`PageSnapshot` and a PNG each), so the
 * logic is tested on small hand-made pairs without a browser.
 *
 * Findings carry stable codes so a fix loop can aggregate them:
 *
 *   page.load-failed  page.status  page.redirect  meta.title  meta.description  meta.canonical  meta.robots  meta.lang
 *   visual.low-fidelity  visual.unstable  visual.truncated  layout.height-delta  layout.overflow-x  layout.first-shift  layout.size-changed
 *   text.missing  text.extra  text.changed  text.regrouped
 *   heading.missing  heading.extra  heading.level
 *   link.missing  link.extra  link.href-changed
 *   image.missing  image.extra  image.broken  image.broken-on-live  image.rendered-size  image.low-resolution
 *   style.systematic  style.mismatch
 *   console.error  request.failed  resource.live-origin  extract.truncated
 */
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { align, normalizeText, wordCount, wordSimilarity } from "./diff.ts";
import type { Resolver } from "./urls.ts";
import {
  STYLE_PROPS,
  type DomComparison,
  type ElementDelta,
  type ElementProbe,
  type Finding,
  type ImageInfo,
  type LinkInfo,
  type PageSnapshot,
  type Severity,
  type StyleGroup,
  type StyleProp,
  type VisualResult,
} from "./types.ts";

const round = (n: number, places = 4): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const clip = (text: string, n = 140): string =>
  text.length > n ? `${text.slice(0, n - 1)}…` : text;

// ── Pixels ───────────────────────────────────────────────────────────────────────────────────────

export interface PixelOptions {
  /** Pixelmatch's colour tolerance, 0..1 (default 0.1): when two pixels count as the same colour. */
  tolerance?: number;
  /** The viewport height, for the above-the-fold score (default 900). */
  viewportHeight?: number;
  /** Height of one band of the band report (default 200). */
  bandHeight?: number;
}

/** Pad to a size with a colour no page uses, so a missing region counts as different whatever its colour. */
function padded(image: PNG, width: number, height: number): Uint8Array {
  if (image.width === width && image.height === height) return image.data;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 255;
    out[i + 1] = 0;
    out[i + 2] = 255;
    out[i + 3] = 255;
  }
  for (let y = 0; y < image.height; y++) {
    out.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * width * 4);
  }
  return out;
}

/**
 * Diff two full-page screenshots. Fidelity is 1 minus the share of pixels that differ beyond the
 * colour tolerance (anti-aliasing differences are not counted: text edges never match exactly).
 * When the pages differ in height the shorter one is padded, so the missing tail counts as wrong.
 */
export function comparePixels(
  livePng: Uint8Array,
  localPng: Uint8Array,
  options: PixelOptions = {},
): { visual: VisualResult; diffPng: Buffer } {
  const tolerance = options.tolerance ?? 0.1;
  const bandHeight = options.bandHeight ?? 200;
  const live = PNG.sync.read(Buffer.from(livePng));
  const local = PNG.sync.read(Buffer.from(localPng));
  const width = Math.max(live.width, local.width);
  const height = Math.max(live.height, local.height);
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(
    padded(live, width, height),
    padded(local, width, height),
    diff.data,
    width,
    height,
    { threshold: tolerance },
  );

  // pixelmatch draws a differing pixel (255, 0, 0); count them per band and over the first screen.
  const foldRows = Math.min(height, options.viewportHeight ?? 900);
  const bands: { y: number; height: number; mismatch: number }[] = [];
  let fold = 0;
  for (let y0 = 0; y0 < height; y0 += bandHeight) {
    const rows = Math.min(bandHeight, height - y0);
    let count = 0;
    for (let y = y0; y < y0 + rows; y++) {
      let rowCount = 0;
      for (let i = y * width * 4, end = i + width * 4; i < end; i += 4) {
        if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) rowCount += 1;
      }
      count += rowCount;
      if (y < foldRows) fold += rowCount;
    }
    bands.push({ y: y0, height: rows, mismatch: round(count / (rows * width)) });
  }
  const total = width * height;
  return {
    visual: {
      fidelity: round(1 - mismatched / total),
      aboveFold: round(1 - fold / (foldRows * width)),
      width,
      height,
      liveHeight: live.height,
      localHeight: local.height,
      mismatchedPixels: mismatched,
      totalPixels: total,
      tolerance,
      bands: bands
        .filter((band) => band.mismatch > 0)
        .sort((a, b) => b.mismatch - a.mismatch)
        .slice(0, 8),
    },
    diffPng: PNG.sync.write(diff),
  };
}

// ── Computed style equality ──────────────────────────────────────────────────────────────────────

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string): Rgba | undefined {
  const match =
    /^rgba?\(\s*([\d.]+)[ ,]+\s*([\d.]+)[ ,]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
      value.trim(),
    );
  if (match === null) return undefined;
  let alpha = 1;
  if (match[4] !== undefined) {
    alpha = match[4].endsWith("%")
      ? Number.parseFloat(match[4]) / 100
      : Number.parseFloat(match[4]);
  }
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
}

const firstFamily = (value: string): string =>
  (value.split(",")[0] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();

const weight = (value: string): number => {
  if (value === "normal") return 400;
  if (value === "bold") return 700;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

function sidesEqual(a: string, b: string, tolerance: number): boolean {
  const ta = a.trim().split(/\s+/);
  const tb = b.trim().split(/\s+/);
  if (ta.length !== tb.length) return a.trim() === b.trim();
  return ta.every((token, i) => {
    const other = tb[i] as string;
    const x = Number.parseFloat(token);
    const y = Number.parseFloat(other);
    if (Number.isFinite(x) && Number.isFinite(y) && token.endsWith("px") && other.endsWith("px")) {
      return Math.abs(x - y) <= tolerance;
    }
    return token === other;
  });
}

/** Whether two computed values of a property are the same for a reader (sub-pixel noise is not a difference). */
export function sameStyleValue(property: StyleProp, live: string, local: string): boolean {
  if (live === local) return true;
  switch (property) {
    case "fontFamily":
      return firstFamily(live) === firstFamily(local);
    case "fontSize":
      return Math.abs(Number.parseFloat(live) - Number.parseFloat(local)) < 0.51;
    case "fontWeight":
      return weight(live) === weight(local);
    case "color":
    case "backgroundColor": {
      const a = parseColor(live);
      const b = parseColor(local);
      if (a === undefined || b === undefined) return false;
      if (a.a === 0 && b.a === 0) return true;
      return (
        Math.abs(a.r - b.r) <= 2 &&
        Math.abs(a.g - b.g) <= 2 &&
        Math.abs(a.b - b.b) <= 2 &&
        Math.abs(a.a - b.a) <= 0.02
      );
    }
    case "margin":
    case "padding":
      return sidesEqual(live, local, 1.5);
    default:
      return false;
  }
}

// ── Matching elements ────────────────────────────────────────────────────────────────────────────

const CLASS_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{7}$/;
const LANDMARK_TAGS = new Set(["nav", "header", "footer", "main", "aside", "form", "article"]);

/** The classes that identify an element: its Cwicly block ids when it has them, else all of its classes. */
function classKey(element: ElementProbe): string {
  const ids = element.classes.filter((c) => CLASS_ID.test(c));
  return [...(ids.length > 0 ? ids : element.classes)].sort().join(".");
}

export interface ElementPair {
  live: ElementProbe;
  local: ElementProbe;
}

/**
 * Pair the elements of the two pages: first by tag and own text (a heading, a link, a button),
 * then by class (a block with no text of its own), then landmarks by tag. Repeats pair in document
 * order. Elements nothing pairs are left out.
 */
export function matchElements(
  live: readonly ElementProbe[],
  local: readonly ElementProbe[],
): ElementPair[] {
  const pairs: ElementPair[] = [];
  const usedLive = new Set<number>();
  const usedLocal = new Set<number>();
  const pass = (keyOf: (e: ElementProbe) => string | undefined): void => {
    const groups = new Map<string, { live: number[]; local: number[] }>();
    const group = (key: string): { live: number[]; local: number[] } => {
      let g = groups.get(key);
      if (g === undefined) {
        g = { live: [], local: [] };
        groups.set(key, g);
      }
      return g;
    };
    for (const [i, element] of live.entries()) {
      const key = usedLive.has(i) ? undefined : keyOf(element);
      if (key !== undefined) group(key).live.push(i);
    }
    for (const [j, element] of local.entries()) {
      const key = usedLocal.has(j) ? undefined : keyOf(element);
      if (key !== undefined) group(key).local.push(j);
    }
    for (const g of groups.values()) {
      if (g.live.length === 0 || g.local.length === 0) continue;
      for (const [i, j] of alignGroup(
        g.live.map((k) => live[k] as ElementProbe),
        g.local.map((k) => local[k] as ElementProbe),
      )) {
        const li = g.live[i] as number;
        const lj = g.local[j] as number;
        usedLive.add(li);
        usedLocal.add(lj);
        pairs.push({ live: live[li] as ElementProbe, local: local[lj] as ElementProbe });
      }
    }
  };
  pass((e) => (e.text === "" ? undefined : `${e.tag}|${normalizeText(e.text)}`));
  pass((e) => {
    const key = classKey(e);
    return key === "" ? undefined : `${key}|${e.tag}`;
  });
  pass((e) => (LANDMARK_TAGS.has(e.tag) ? `${e.tag}|${e.landmark}` : undefined));
  // Document order, by the live page.
  const order = new Map(live.map((element, i) => [element, i]));
  return pairs.sort((a, b) => (order.get(a.live) as number) - (order.get(b.live) as number));
}

const PATH_CLASS_ID = /\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{7})/g;

/** The Cwicly block ids along an element's selector path: where in the block tree it sits. */
function pathIds(path: string): Set<string> {
  return new Set([...path.matchAll(PATH_CLASS_ID)].map((m) => m[1] as string));
}

/**
 * Pair the elements that share one key. When both pages have the same number they pair in order. When
 * the counts differ (a phone number that is in the header and the footer on one page and only in the
 * footer on the other) the longest in-order assignment wins, scored by shared block ids on the path
 * (strong) and nearness on the page (weak), and a pair that has neither stays unpaired, so a copy
 * is never matched to the other page's different copy 8,000 pixels away.
 */
function alignGroup(a: readonly ElementProbe[], b: readonly ElementProbe[]): [number, number][] {
  if (a.length === b.length) return a.map((_, i) => [i, i]);
  if (a.length * b.length > 250_000) return a.slice(0, b.length).map((_, i) => [i, i]);
  const idsA = a.map((e) => pathIds(e.path));
  const idsB = b.map((e) => pathIds(e.path));
  const score = (i: number, j: number): number => {
    let shared = 0;
    for (const id of idsA[i] as Set<string>) if ((idsB[j] as Set<string>).has(id)) shared += 1;
    const near =
      1 -
      Math.min(1, Math.abs((a[i] as ElementProbe).rect.y - (b[j] as ElementProbe).rect.y) / 1500);
    return shared > 0 ? 2 + near : near > 0.3 ? near : 0;
  };
  const width = b.length + 1;
  const best = new Float64Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const take = score(i, j);
      best[i * width + j] = Math.max(
        best[(i + 1) * width + j] as number,
        best[i * width + j + 1] as number,
        take > 0 ? take + (best[(i + 1) * width + j + 1] as number) : 0,
      );
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const take = score(i, j);
    const here = best[i * width + j] as number;
    if (take > 0 && Math.abs(here - (take + (best[(i + 1) * width + j + 1] as number))) < 1e-9) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if (Math.abs(here - (best[(i + 1) * width + j] as number)) < 1e-9) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return out;
}

const RECT_TOLERANCE = 6;

function deltaOf(pair: ElementPair): ElementDelta {
  const { live, local } = pair;
  const style: ElementDelta["style"] = [];
  for (const property of STYLE_PROPS) {
    if (!sameStyleValue(property, live.style[property], local.style[property])) {
      style.push({ property, live: live.style[property], local: local.style[property] });
    }
  }
  return {
    livePath: live.path,
    localPath: local.path,
    tag: live.tag,
    text: live.text,
    landmark: live.landmark,
    dx: round(local.rect.x - live.rect.x, 1),
    dy: round(local.rect.y - live.rect.y, 1),
    dw: round(local.rect.width - live.rect.width, 1),
    dh: round(local.rect.height - live.rect.height, 1),
    style,
  };
}

const magnitude = (d: ElementDelta): number =>
  Math.max(Math.abs(d.dx), Math.abs(d.dy), Math.abs(d.dw), Math.abs(d.dh));

/** Group the style differences: by (landmark, tag) and property, with the commonest value pair. */
function styleGroups(pairs: readonly ElementPair[], deltas: readonly ElementDelta[]): StyleGroup[] {
  const sizes = new Map<string, number>();
  for (const pair of pairs) {
    const group = `${pair.live.landmark} > ${pair.live.tag}`;
    sizes.set(group, (sizes.get(group) ?? 0) + 1);
  }
  interface Acc {
    group: string;
    property: StyleProp;
    differing: number;
    values: Map<string, { live: string; local: string; count: number; examples: string[] }>;
  }
  const acc = new Map<string, Acc>();
  for (const delta of deltas) {
    const group = `${delta.landmark} > ${delta.tag}`;
    for (const item of delta.style) {
      const key = `${group}|${item.property}`;
      let entry = acc.get(key);
      if (entry === undefined) {
        entry = { group, property: item.property, differing: 0, values: new Map() };
        acc.set(key, entry);
      }
      entry.differing += 1;
      const pairKey = `${item.live}\u0000${item.local}`;
      const value = entry.values.get(pairKey);
      if (value === undefined) {
        entry.values.set(pairKey, {
          live: item.live,
          local: item.local,
          count: 1,
          examples: [delta.localPath],
        });
      } else {
        value.count += 1;
        if (value.examples.length < 5) value.examples.push(delta.localPath);
      }
    }
  }
  const groups: StyleGroup[] = [];
  for (const entry of acc.values()) {
    const top = [...entry.values.values()].sort((a, b) => b.count - a.count)[0];
    if (top === undefined) continue;
    groups.push({
      group: entry.group,
      property: entry.property,
      elements: sizes.get(entry.group) ?? entry.differing,
      differing: entry.differing,
      live: top.live,
      local: top.local,
      pairCount: top.count,
      examples: top.examples,
    });
  }
  return groups.sort((a, b) => b.differing - a.differing);
}

// ── The document comparison ──────────────────────────────────────────────────────────────────────

/**
 * A link's comparable target: the address the browser resolved (it knows `<base>`), unless the
 * author wrote nothing, an anchor or a script, which lead nowhere to compare.
 */
const linkKey = (resolver: Resolver, link: LinkInfo): string | undefined => {
  const raw = link.raw.trim();
  if (raw === "" || raw.startsWith("#") || /^javascript:/i.test(raw)) return undefined;
  return resolver.normalize(link.href);
};

const MIN_REGROUP = 4;
const SPACES = /\s+/g;

/**
 * Find the blocks of `containers` that the blocks of `parts` make up, and record both sides in the
 * two sets. Whitespace is ignored: adjacent inline elements concatenate with nothing between them.
 */
function regroup(
  containers: readonly number[],
  containerBlocks: readonly string[],
  parts: readonly number[],
  partBlocks: readonly string[],
  containerSet: Set<number>,
  partSet: Set<number>,
): void {
  const squashed = parts.map((i) => (partBlocks[i] as string).replace(SPACES, ""));
  for (const j of containers) {
    const whole = (containerBlocks[j] as string).replace(SPACES, "");
    if (whole.length < MIN_REGROUP) continue;
    const inside: number[] = [];
    squashed.forEach((part, k) => {
      if (part.length >= 2 && part !== whole && whole.includes(part)) inside.push(k);
    });
    if (inside.length < 2) continue;
    if (!inside.some((k) => (squashed[k] as string).length >= MIN_REGROUP)) continue;
    const covered = new Uint8Array(whole.length);
    for (const k of inside) {
      const part = squashed[k] as string;
      for (let at = whole.indexOf(part); at !== -1; at = whole.indexOf(part, at + 1)) {
        covered.fill(1, at, at + part.length);
      }
    }
    const share = covered.reduce((sum, bit) => sum + bit, 0) / whole.length;
    if (share < 0.9) continue;
    containerSet.add(j);
    for (const k of inside) partSet.add(parts[k] as number);
  }
}

/** What the findings need from a comparison and the report need not carry. */
export interface DomWork {
  /** Image pairs, live with local. */
  imagePairs: { live: ImageInfo; local: ImageInfo }[];
  /** Every matched element's delta, in the live page's document order. */
  allDeltas: ElementDelta[];
}

/** Compare what the two pages say, link to, show and style. */
export function compareDocuments(
  live: PageSnapshot,
  local: PageSnapshot,
  resolver: Resolver,
): { dom: DomComparison; work: DomWork } {
  // Text.
  const liveBlocks = live.textBlocks.map((b) => normalizeText(b.text)).filter((t) => t !== "");
  const localBlocks = local.textBlocks.map((b) => normalizeText(b.text)).filter((t) => t !== "");
  const liveTexts = live.textBlocks.filter((b) => normalizeText(b.text) !== "");
  const localTexts = local.textBlocks.filter((b) => normalizeText(b.text) !== "");
  const aligned = align(liveBlocks, localBlocks);

  // The same words grouped differently (`<a>A</a><a>B</a>` read as one block on one side and two on
  // the other, with nothing between the parts) are not missing text. A block is a regrouping when
  // two or more of what the other side has left over, one of them four characters or more, account
  // for nearly all of its characters: "Home" inside "Homeowner guide" accounts for a quarter of it.
  const leftLive = [...aligned.onlyA, ...aligned.changed.map((c) => c.a)];
  const leftLocal = [...aligned.onlyB, ...aligned.changed.map((c) => c.b)];
  const regroupedLive = new Set<number>();
  const regroupedLocal = new Set<number>();
  regroup(leftLocal, localBlocks, leftLive, liveBlocks, regroupedLocal, regroupedLive);
  regroup(leftLive, liveBlocks, leftLocal, localBlocks, regroupedLive, regroupedLocal);
  // A pair the aligner matched is dropped when both its blocks are accounted for by regroupings; when
  // only one is, the other has lost its partner and is missing or extra after all.
  const unpaired = aligned.changed.filter(
    (c) => !(regroupedLive.has(c.a) && regroupedLocal.has(c.b)),
  );
  const orphanLive = unpaired.filter((c) => regroupedLocal.has(c.b)).map((c) => c.a);
  const orphanLocal = unpaired.filter((c) => regroupedLive.has(c.a)).map((c) => c.b);
  const stillChanged = unpaired.filter((c) => !regroupedLive.has(c.a) && !regroupedLocal.has(c.b));
  const byIndex = (a: number, b: number): number => a - b;
  const missingIdx = [...aligned.onlyA, ...orphanLive]
    .filter((i) => !regroupedLive.has(i))
    .sort(byIndex);
  const extraIdx = [...aligned.onlyB, ...orphanLocal]
    .filter((j) => !regroupedLocal.has(j))
    .sort(byIndex);
  const text: DomComparison["text"] = {
    similarity: round(wordSimilarity(liveBlocks, localBlocks)),
    liveWords: wordCount(liveBlocks),
    localWords: wordCount(localBlocks),
    regrouped: regroupedLive.size + regroupedLocal.size,
    missing: missingIdx.map((i) => ({
      path: (liveTexts[i] as { path: string }).path,
      text: liveBlocks[i] as string,
    })),
    extra: extraIdx.map((j) => ({
      path: (localTexts[j] as { path: string }).path,
      text: localBlocks[j] as string,
    })),
    changed: stillChanged.map((c) => ({
      livePath: (liveTexts[c.a] as { path: string }).path,
      localPath: (localTexts[c.b] as { path: string }).path,
      live: liveBlocks[c.a] as string,
      local: localBlocks[c.b] as string,
      similarity: c.similarity,
    })),
  };

  // Headings.
  const headingKey = (h: { level: number; text: string }): string =>
    `${h.level}|${normalizeText(h.text)}`;
  const headingText = (h: { text: string }): string => normalizeText(h.text);
  const hAlign = align(live.headings.map(headingKey), local.headings.map(headingKey), 2);
  const levelChanged: DomComparison["headings"]["levelChanged"] = [];
  const hMissing = new Set(hAlign.onlyA);
  const hExtra = new Set(hAlign.onlyB);
  for (const i of hMissing) {
    const liveHeading = live.headings[i];
    if (liveHeading === undefined) continue;
    const j = [...hExtra].find((k) => {
      const candidate = local.headings[k];
      return candidate !== undefined && headingText(candidate) === headingText(liveHeading);
    });
    if (j === undefined) continue;
    levelChanged.push({
      live: liveHeading,
      local: local.headings[j] as DomComparison["headings"]["levelChanged"][number]["local"],
    });
    hMissing.delete(i);
    hExtra.delete(j);
  }
  const headings: DomComparison["headings"] = {
    live: live.headings.length,
    local: local.headings.length,
    missing: [...hMissing].map((i) => live.headings[i] as (typeof live.headings)[number]),
    extra: [...hExtra].map((j) => local.headings[j] as (typeof local.headings)[number]),
    levelChanged,
  };

  // Links: a link is the same when its target is the same place; the label breaks ties.
  const localByKey = new Map<string, LinkInfo[]>();
  for (const link of local.links) {
    const key = linkKey(resolver, link);
    if (key === undefined) continue;
    const list = localByKey.get(key);
    if (list === undefined) localByKey.set(key, [link]);
    else list.push(link);
  }
  const unmatchedLive: LinkInfo[] = [];
  for (const link of live.links) {
    const key = linkKey(resolver, link);
    if (key === undefined) continue;
    const list = localByKey.get(key);
    if (list === undefined || list.length === 0) {
      unmatchedLive.push(link);
      continue;
    }
    const same = list.findIndex(
      (candidate) => normalizeText(candidate.text) === normalizeText(link.text),
    );
    list.splice(same === -1 ? 0 : same, 1);
  }
  const leftoverLocal: LinkInfo[] = [...localByKey.values()].flat();
  const hrefChanged: DomComparison["links"]["hrefChanged"] = [];
  const missingLinks: LinkInfo[] = [];
  const takenLocal = new Set<LinkInfo>();
  for (const link of unmatchedLive) {
    const label = normalizeText(link.text);
    const twin =
      label === ""
        ? undefined
        : leftoverLocal.find(
            (candidate) => !takenLocal.has(candidate) && normalizeText(candidate.text) === label,
          );
    if (twin === undefined) missingLinks.push(link);
    else {
      takenLocal.add(twin);
      hrefChanged.push({ live: link, local: twin });
    }
  }
  const links: DomComparison["links"] = {
    live: live.links.length,
    local: local.links.length,
    missing: missingLinks,
    extra: leftoverLocal.filter((link) => !takenLocal.has(link)),
    hrefChanged,
  };

  // Images.
  const localImages = new Map<string, ImageInfo[]>();
  const addImage = (image: ImageInfo): void => {
    const key = `${image.kind}|${resolver.imageKey(image.currentSrc !== "" ? image.currentSrc : image.src)}`;
    const list = localImages.get(key);
    if (list === undefined) localImages.set(key, [image]);
    else list.push(image);
  };
  for (const image of local.images) addImage(image);
  let matched = 0;
  const missingImages: ImageInfo[] = [];
  const pairedSizes: { live: ImageInfo; local: ImageInfo }[] = [];
  const unmatchedImages: ImageInfo[] = [];
  for (const image of live.images) {
    const key = `${image.kind}|${resolver.imageKey(image.currentSrc !== "" ? image.currentSrc : image.src)}`;
    const found = localImages.get(key)?.shift();
    if (found === undefined) unmatchedImages.push(image);
    else {
      matched += 1;
      pairedSizes.push({ live: image, local: found });
    }
  }
  const remainingLocal = [...localImages.values()].flat();
  // A live image that was dead there (a 404 background, an <img> that never loaded) is nothing the
  // migration lost; one the oracle blocked never loaded either, but only because we refused it.
  const failedOnLive = new Set(live.failedRequests.map((r) => r.url));
  const deadOnLive = (image: ImageInfo): boolean =>
    failedOnLive.has(image.currentSrc !== "" ? image.currentSrc : image.src) ||
    failedOnLive.has(image.src) ||
    (image.kind === "img" && !image.loaded && image.blocked !== true);
  const brokenOnLive: ImageInfo[] = [];
  for (const image of unmatchedImages) {
    const alt = normalizeText(image.alt);
    const index =
      alt === ""
        ? -1
        : remainingLocal.findIndex((c) => c.kind === image.kind && normalizeText(c.alt) === alt);
    if (index === -1) (deadOnLive(image) ? brokenOnLive : missingImages).push(image);
    else {
      matched += 1;
      pairedSizes.push({ live: image, local: remainingLocal.splice(index, 1)[0] as ImageInfo });
    }
  }
  const images: DomComparison["images"] = {
    live: live.images.length,
    local: local.images.length,
    matched,
    missing: missingImages,
    extra: remainingLocal,
    // A load that failed. An `<img>` with no address at all is an empty slot (the live page has
    // `src=""` there too), and one whose live twin is dead as well is the site's own broken link: not
    // a regression of the migration.
    broken: local.images.filter(
      (image) =>
        image.kind === "img" &&
        !image.loaded &&
        image.blocked !== true &&
        (image.currentSrc !== "" || image.src !== "") &&
        !pairedSizes.some((pair) => pair.local === image && deadOnLive(pair.live)),
    ),
    brokenOnLive,
    pairs: pairedSizes.slice(0, 100).map(({ live: a, local: b }) => ({
      key: resolver.imageKey(a.currentSrc !== "" ? a.currentSrc : a.src),
      kind: a.kind,
      liveSrc: a.currentSrc !== "" ? a.currentSrc : a.src,
      localSrc: b.currentSrc !== "" ? b.currentSrc : b.src,
      liveNatural: `${a.naturalWidth}x${a.naturalHeight}`,
      localNatural: `${b.naturalWidth}x${b.naturalHeight}`,
      liveRendered: `${a.width}x${a.height}`,
      localRendered: `${b.width}x${b.height}`,
      loaded: b.loaded,
      path: b.path,
    })),
  };

  // Elements.
  const pairs = matchElements(live.elements, local.elements);
  const all = pairs.map(deltaOf);
  const deltas = all
    .filter((d) => d.style.length > 0 || magnitude(d) > RECT_TOLERANCE)
    .sort((a, b) => magnitude(b) + b.style.length * 10 - (magnitude(a) + a.style.length * 10))
    .slice(0, 300);
  const elements: DomComparison["elements"] = {
    live: live.elements.length,
    local: local.elements.length,
    matched: pairs.length,
    deltas,
    groups: styleGroups(pairs, all),
  };
  return {
    dom: { text, headings, links, images, elements },
    work: { imagePairs: pairedSizes, allDeltas: all },
  };
}

// ── Findings ─────────────────────────────────────────────────────────────────────────────────────

const finding = (
  code: string,
  severity: Severity,
  viewport: number | null,
  message: string,
  extra: Omit<Finding, "code" | "severity" | "viewport" | "message"> = {},
): Finding => ({ code, severity, viewport, message, ...extra });

const ratioSeverity = (ratio: number, error: number, warning: number): Severity =>
  ratio >= error ? "error" : ratio >= warning ? "warning" : "info";

/** The findings of the pixel comparison. */
export function visualFindings(
  visual: VisualResult,
  live: PageSnapshot,
  local: PageSnapshot,
  width: number,
): Finding[] {
  const out: Finding[] = [];
  const f = visual.fidelity;
  if (f < 0.97) {
    out.push(
      finding(
        "visual.low-fidelity",
        f < 0.7 ? "error" : f < 0.9 ? "warning" : "info",
        width,
        `${(f * 100).toFixed(1)}% of pixels match at ${width}px (${(visual.aboveFold * 100).toFixed(1)}% above the fold)`,
        {
          live: visual.liveHeight,
          local: visual.localHeight,
          data: { fidelity: f, aboveFold: visual.aboveFold, worstBands: visual.bands.slice(0, 5) },
        },
      ),
    );
  }
  const delta = local.docHeight - live.docHeight;
  const limit = Math.max(40, live.docHeight * 0.02);
  if (live.docHeight > 0 && local.docHeight > 0 && Math.abs(delta) > limit) {
    const ratio = Math.abs(delta) / live.docHeight;
    out.push(
      finding(
        "layout.height-delta",
        ratioSeverity(ratio, 0.1, 0.02),
        width,
        `the page is ${Math.abs(delta)}px ${delta > 0 ? "taller" : "shorter"} than live (${live.docHeight}px live, ${local.docHeight}px local, ${(ratio * 100).toFixed(1)}%)`,
        { live: live.docHeight, local: local.docHeight, data: { delta, ratio: round(ratio) } },
      ),
    );
  }
  if (live.unstable === true || local.unstable === true) {
    out.push(
      finding(
        "visual.unstable",
        "info",
        width,
        `${live.unstable === true && local.unstable === true ? "both pages were" : live.unstable === true ? "the live page was" : "the migrated page was"} still changing when captured (a script animating without end), so the fidelity is approximate`,
        { data: { live: live.unstable === true, local: local.unstable === true } },
      ),
    );
  }
  if (live.clippedAt !== undefined || local.clippedAt !== undefined) {
    out.push(
      finding(
        "visual.truncated",
        "info",
        width,
        "a screenshot was cut at the capture height cap, so the tail was not compared",
        {
          data: { liveClippedAt: live.clippedAt ?? null, localClippedAt: local.clippedAt ?? null },
        },
      ),
    );
  }
  return out;
}

const sample = <T>(list: readonly T[], n = 10): T[] => list.slice(0, n);

/** The findings of the document comparison, with everything needed to reproduce each. */
export function domFindings(
  dom: DomComparison,
  work: DomWork,
  live: PageSnapshot,
  local: PageSnapshot,
  resolver: Resolver,
  width: number,
): Finding[] {
  const out: Finding[] = [];

  // Text.
  const missingWords = wordCount(dom.text.missing.map((b) => b.text));
  const extraWords = wordCount(dom.text.extra.map((b) => b.text));
  if (dom.text.missing.length > 0) {
    out.push(
      finding(
        "text.missing",
        ratioSeverity(dom.text.liveWords === 0 ? 0 : missingWords / dom.text.liveWords, 0.2, 0.05),
        width,
        `${dom.text.missing.length} text block${dom.text.missing.length === 1 ? "" : "s"} (${missingWords} words) on the live page are not on the migrated page`,
        {
          count: dom.text.missing.length,
          selector: dom.text.missing[0]?.path,
          data: {
            words: missingWords,
            examples: sample(dom.text.missing).map((b) => ({ path: b.path, text: clip(b.text) })),
          },
        },
      ),
    );
  }
  if (dom.text.extra.length > 0) {
    out.push(
      finding(
        "text.extra",
        extraWords > 0 && dom.text.localWords > 0 && extraWords / dom.text.localWords >= 0.2
          ? "warning"
          : "info",
        width,
        `${dom.text.extra.length} text block${dom.text.extra.length === 1 ? "" : "s"} (${extraWords} words) on the migrated page are not on the live page`,
        {
          count: dom.text.extra.length,
          selector: dom.text.extra[0]?.path,
          data: {
            words: extraWords,
            examples: sample(dom.text.extra).map((b) => ({ path: b.path, text: clip(b.text) })),
          },
        },
      ),
    );
  }
  if (dom.text.regrouped > 0) {
    out.push(
      finding(
        "text.regrouped",
        "info",
        width,
        `${dom.text.regrouped} text block${dom.text.regrouped === 1 ? "" : "s"} hold the same words but are split differently from the live page (inline versus block elements)`,
        { count: dom.text.regrouped },
      ),
    );
  }
  if (dom.text.changed.length > 0) {
    const worst = dom.text.changed.filter((c) => c.similarity < 0.9);
    out.push(
      finding(
        "text.changed",
        worst.length > 0 ? "warning" : "info",
        width,
        `${dom.text.changed.length} text block${dom.text.changed.length === 1 ? "" : "s"} read differently (${worst.length} by more than a tenth of their words)`,
        {
          count: dom.text.changed.length,
          selector: dom.text.changed[0]?.localPath,
          data: {
            examples: sample([...dom.text.changed].sort((a, b) => a.similarity - b.similarity)).map(
              (c) => ({
                livePath: c.livePath,
                localPath: c.localPath,
                live: clip(c.live),
                local: clip(c.local),
                similarity: c.similarity,
              }),
            ),
          },
        },
      ),
    );
  }

  // Headings.
  const hs = dom.headings;
  if (hs.missing.length > 0) {
    out.push(
      finding(
        "heading.missing",
        hs.missing.some((h) => h.level === 1) ? "error" : "warning",
        width,
        `${hs.missing.length} heading${hs.missing.length === 1 ? "" : "s"} on the live page are missing`,
        {
          count: hs.missing.length,
          selector: hs.missing[0]?.path,
          data: {
            examples: sample(hs.missing).map((h) => ({
              level: h.level,
              text: clip(h.text),
              path: h.path,
            })),
          },
        },
      ),
    );
  }
  if (hs.extra.length > 0) {
    out.push(
      finding(
        "heading.extra",
        "info",
        width,
        `${hs.extra.length} heading${hs.extra.length === 1 ? "" : "s"} only on the migrated page`,
        {
          count: hs.extra.length,
          selector: hs.extra[0]?.path,
          data: {
            examples: sample(hs.extra).map((h) => ({
              level: h.level,
              text: clip(h.text),
              path: h.path,
            })),
          },
        },
      ),
    );
  }
  if (hs.levelChanged.length > 0) {
    out.push(
      finding(
        "heading.level",
        "warning",
        width,
        `${hs.levelChanged.length} heading${hs.levelChanged.length === 1 ? "" : "s"} changed level`,
        {
          count: hs.levelChanged.length,
          selector: hs.levelChanged[0]?.local.path,
          data: {
            examples: sample(hs.levelChanged).map((h) => ({
              text: clip(h.live.text),
              live: h.live.level,
              local: h.local.level,
              path: h.local.path,
            })),
          },
        },
      ),
    );
  }

  // Links.
  const ls = dom.links;
  const wpInternal = /^\/(?:wp-|feed|xmlrpc|comments|author\/|\?p=)/;
  const meaningfulMissing = ls.missing.filter((link) => {
    const key = linkKey(resolver, link);
    return key === undefined || !wpInternal.test(key);
  });
  if (ls.missing.length > 0) {
    out.push(
      finding(
        "link.missing",
        meaningfulMissing.length > 0 ? "warning" : "info",
        width,
        `${ls.missing.length} link${ls.missing.length === 1 ? "" : "s"} on the live page lead nowhere on the migrated page`,
        {
          count: ls.missing.length,
          selector: ls.missing[0]?.path,
          data: {
            examples: sample(ls.missing).map((l) => ({
              text: clip(l.text, 60),
              href: l.raw,
              path: l.path,
            })),
          },
        },
      ),
    );
  }
  if (ls.hrefChanged.length > 0) {
    out.push(
      finding(
        "link.href-changed",
        "warning",
        width,
        `${ls.hrefChanged.length} link${ls.hrefChanged.length === 1 ? "" : "s"} keep their label and lead somewhere else`,
        {
          count: ls.hrefChanged.length,
          selector: ls.hrefChanged[0]?.local.path,
          data: {
            examples: sample(ls.hrefChanged).map((l) => ({
              text: clip(l.live.text, 60),
              live: l.live.raw,
              local: l.local.raw,
              path: l.local.path,
            })),
          },
        },
      ),
    );
  }
  if (ls.extra.length > 0) {
    out.push(
      finding(
        "link.extra",
        "info",
        width,
        `${ls.extra.length} link${ls.extra.length === 1 ? "" : "s"} only on the migrated page`,
        {
          count: ls.extra.length,
          selector: ls.extra[0]?.path,
          data: {
            examples: sample(ls.extra).map((l) => ({
              text: clip(l.text, 60),
              href: l.raw,
              path: l.path,
            })),
          },
        },
      ),
    );
  }

  // Images.
  const im = dom.images;
  const deadLive = im.brokenOnLive ?? [];
  const liveWorking = im.live - deadLive.length;
  if (deadLive.length > 0) {
    out.push(
      finding(
        "image.broken-on-live",
        "info",
        width,
        `${deadLive.length} image${deadLive.length === 1 ? "" : "s"} did not load on the live page either, so ${deadLive.length === 1 ? "it is" : "they are"} not counted as missing`,
        {
          count: deadLive.length,
          selector: deadLive[0]?.path,
          data: {
            examples: sample(deadLive).map((i) => ({
              kind: i.kind,
              src: i.currentSrc || i.src,
              path: i.path,
            })),
          },
        },
      ),
    );
  }
  if (im.broken.length > 0) {
    out.push(
      finding(
        "image.broken",
        "error",
        width,
        `${im.broken.length} image${im.broken.length === 1 ? "" : "s"} did not load on the migrated page`,
        {
          count: im.broken.length,
          selector: im.broken[0]?.path,
          data: {
            examples: sample(im.broken).map((i) => ({
              src: i.currentSrc || i.src,
              alt: clip(i.alt, 60),
              path: i.path,
            })),
          },
        },
      ),
    );
  }
  if (im.missing.length > 0) {
    out.push(
      finding(
        "image.missing",
        ratioSeverity(liveWorking === 0 ? 0 : im.missing.length / liveWorking, 0.3, 0.05),
        width,
        `${im.missing.length} of ${liveWorking} images on the live page are not on the migrated page`,
        {
          count: im.missing.length,
          selector: im.missing[0]?.path,
          data: {
            examples: sample(im.missing).map((i) => ({
              kind: i.kind,
              src: i.currentSrc || i.src,
              alt: clip(i.alt, 60),
              path: i.path,
            })),
          },
        },
      ),
    );
  }
  if (im.extra.length > 0) {
    out.push(
      finding(
        "image.extra",
        "info",
        width,
        `${im.extra.length} image${im.extra.length === 1 ? "" : "s"} only on the migrated page`,
        {
          count: im.extra.length,
          selector: im.extra[0]?.path,
          data: {
            examples: sample(im.extra).map((i) => ({
              kind: i.kind,
              src: i.currentSrc || i.src,
              path: i.path,
            })),
          },
        },
      ),
    );
  }
  const pairedImages = work.imagePairs;
  const resized = pairedImages.filter(
    ({ live: a, local: b }) =>
      a.kind === "img" &&
      b.loaded &&
      (Math.abs(a.width - b.width) > Math.max(6, a.width * 0.08) ||
        Math.abs(a.height - b.height) > Math.max(6, a.height * 0.08)),
  );
  if (resized.length > 0) {
    out.push(
      finding(
        "image.rendered-size",
        "warning",
        width,
        `${resized.length} image${resized.length === 1 ? "" : "s"} render at another size than on the live page`,
        {
          count: resized.length,
          selector: resized[0]?.local.path,
          data: {
            examples: sample(resized).map(({ live: a, local: b }) => ({
              src: b.currentSrc || b.src,
              live: `${a.width}x${a.height}`,
              local: `${b.width}x${b.height}`,
              path: b.path,
            })),
          },
        },
      ),
    );
  }
  const soft = pairedImages.filter(
    ({ live: a, local: b }) =>
      a.kind === "img" &&
      b.loaded &&
      a.naturalWidth > 0 &&
      b.naturalWidth < a.naturalWidth * 0.75 &&
      b.naturalWidth < b.width * 1.5,
  );
  if (soft.length > 0) {
    out.push(
      finding(
        "image.low-resolution",
        "info",
        width,
        `${soft.length} image${soft.length === 1 ? "" : "s"} have fewer pixels than on the live page`,
        {
          count: soft.length,
          selector: soft[0]?.local.path,
          data: {
            examples: sample(soft).map(({ live: a, local: b }) => ({
              src: b.currentSrc || b.src,
              live: `${a.naturalWidth}x${a.naturalHeight}`,
              local: `${b.naturalWidth}x${b.naturalHeight}`,
              rendered: `${b.width}x${b.height}`,
              path: b.path,
            })),
          },
        },
      ),
    );
  }

  // Styles and boxes.
  const systematic = dom.elements.groups.filter(
    (g) => g.elements >= 3 && g.differing >= 3 && g.differing / g.elements >= 0.5,
  );
  for (const group of systematic) {
    const share = group.differing / group.elements;
    const loud =
      group.property === "fontFamily" ||
      group.property === "fontSize" ||
      group.property === "display";
    out.push(
      finding(
        "style.systematic",
        loud && share >= 0.9 && group.elements >= 5 ? "error" : "warning",
        width,
        `${group.differing} of ${group.elements} \`${group.group}\` elements differ in ${group.property}: live ${clip(group.live, 60)}, migrated ${clip(group.local, 60)}`,
        {
          property: group.property,
          live: group.live,
          local: group.local,
          count: group.differing,
          selector: group.examples[0],
          data: {
            group: group.group,
            elements: group.elements,
            withThatPair: group.pairCount,
            examples: group.examples,
          },
        },
      ),
    );
  }
  const systematicKeys = new Set(systematic.map((g) => `${g.group}|${g.property}`));
  const isolated = new Map<
    StyleProp,
    { count: number; examples: { path: string; live: string; local: string }[] }
  >();
  for (const delta of dom.elements.deltas) {
    for (const item of delta.style) {
      if (systematicKeys.has(`${delta.landmark} > ${delta.tag}|${item.property}`)) continue;
      const entry = isolated.get(item.property) ?? { count: 0, examples: [] };
      entry.count += 1;
      if (entry.examples.length < 8)
        entry.examples.push({ path: delta.localPath, live: item.live, local: item.local });
      isolated.set(item.property, entry);
    }
  }
  for (const [property, entry] of isolated) {
    out.push(
      finding(
        "style.mismatch",
        "info",
        width,
        `${entry.count} element${entry.count === 1 ? "" : "s"} differ in ${property}`,
        {
          property,
          count: entry.count,
          selector: entry.examples[0]?.path,
          live: entry.examples[0]?.live,
          local: entry.examples[0]?.local,
          data: { examples: entry.examples },
        },
      ),
    );
  }

  const deltas = work.allDeltas;
  const shifted = deltas.find((d) => Math.abs(d.dy) > RECT_TOLERANCE);
  if (shifted !== undefined) {
    const before = deltas.slice(0, deltas.indexOf(shifted));
    out.push(
      finding(
        "layout.first-shift",
        "warning",
        width,
        `layout first moves vertically at ${shifted.tag} "${clip(shifted.text, 40)}": ${shifted.dy > 0 ? "down" : "up"} ${Math.abs(shifted.dy)}px`,
        {
          selector: shifted.localPath,
          live: shifted.livePath,
          data: {
            dy: shifted.dy,
            dh: shifted.dh,
            matchedAbove: before.length,
            hint: "everything below this element is displaced by it; fix it first",
          },
        },
      ),
    );
  }
  const resizedBoxes = deltas.filter(
    (d) => Math.abs(d.dw) > RECT_TOLERANCE || Math.abs(d.dh) > RECT_TOLERANCE,
  );
  if (resizedBoxes.length > 0) {
    const top = [...resizedBoxes].sort((a, b) => magnitude(b) - magnitude(a));
    out.push(
      finding(
        "layout.size-changed",
        resizedBoxes.length > 20 ? "warning" : "info",
        width,
        `${resizedBoxes.length} matched element${resizedBoxes.length === 1 ? "" : "s"} have another width or height than on the live page`,
        {
          count: resizedBoxes.length,
          selector: top[0]?.localPath,
          data: {
            examples: sample(top).map((d) => ({
              path: d.localPath,
              tag: d.tag,
              text: clip(d.text, 40),
              dw: d.dw,
              dh: d.dh,
            })),
          },
        },
      ),
    );
  }

  // Overflow.
  const lo = live.overflow;
  const mo = local.overflow;
  if (mo.overflow && mo.scrollWidth > lo.scrollWidth + 4) {
    out.push(
      finding(
        "layout.overflow-x",
        lo.overflow ? "warning" : "error",
        width,
        `the migrated page scrolls sideways at ${width}px (${mo.scrollWidth}px wide in a ${mo.clientWidth}px viewport${lo.overflow ? `; live is ${lo.scrollWidth}px` : "; live does not"})`,
        {
          live: lo.scrollWidth,
          local: mo.scrollWidth,
          selector: mo.offenders[0]?.path,
          data: { offenders: mo.offenders },
        },
      ),
    );
  }

  // Resources still fetched from the live site: they work today and stop when the old site goes.
  const hot = new Set<string>();
  const isHotlink = (url: string): boolean => {
    if (!/^https?:/i.test(url) || !resolver.isInternal(url)) return false;
    return new URL(url).origin !== resolver.localOrigin;
  };
  for (const url of [
    ...local.images.flatMap((i) => [i.currentSrc, i.src]),
    ...(local.requests ?? []),
  ]) {
    if (url !== "" && isHotlink(url)) hot.add(url);
  }
  if (hot.size > 0) {
    out.push(
      finding(
        "resource.live-origin",
        "warning",
        width,
        `${hot.size} resource${hot.size === 1 ? "" : "s"} on the migrated page still load from the live site (${resolver.liveOrigin}) and will break when it goes`,
        { count: hot.size, data: { examples: [...hot].slice(0, 15) } },
      ),
    );
  }

  // What the extractor cut, so a long page is never silently half compared.
  const cut = (page: PageSnapshot): { elements: number; blocks: number } => ({
    elements: page.truncated,
    blocks: page.truncatedBlocks ?? 0,
  });
  if (
    live.truncated > 0 ||
    local.truncated > 0 ||
    (live.truncatedBlocks ?? 0) > 0 ||
    (local.truncatedBlocks ?? 0) > 0
  ) {
    const l = cut(live);
    const m = cut(local);
    out.push(
      finding(
        "extract.truncated",
        "info",
        width,
        `the page is longer than the comparison reads: ${l.elements + l.blocks} items cut on live, ${m.elements + m.blocks} on the migrated page (elements and text blocks past the caps are not compared)`,
        { data: { live: l, local: m } },
      ),
    );
  }

  // The page's own health.
  // A request is the same on both sides when it is for the same path or the same external address.
  const where = (url: string): string => {
    if (!resolver.isInternal(url)) return url;
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  };
  const liveFailed = new Set(live.failedRequests.map((r) => where(r.url)));
  const failed = local.failedRequests.filter((r) => !liveFailed.has(where(r.url)));
  if (failed.length > 0) {
    const internal = failed.filter((r) => resolver.isInternal(r.url));
    out.push(
      finding(
        "request.failed",
        internal.length > 0 ? "error" : "warning",
        width,
        `${failed.length} request${failed.length === 1 ? "" : "s"} failed on the migrated page (${internal.length} on the site itself)`,
        {
          count: failed.length,
          data: {
            examples: sample(failed, 15).map((r) => ({
              url: r.url,
              ...(r.status === undefined ? {} : { status: r.status }),
              ...(r.failure === undefined ? {} : { failure: r.failure }),
            })),
          },
        },
      ),
    );
  }
  const errorKey = (e: { message: string; url?: string | undefined }): string =>
    `${e.message}@${e.url === undefined ? "" : where(e.url)}`;
  const liveMessages = new Set(live.consoleErrors.map(errorKey));
  const errors = local.consoleErrors.filter((e) => !liveMessages.has(errorKey(e)));
  if (errors.length > 0) {
    out.push(
      finding(
        "console.error",
        "warning",
        width,
        `${errors.length} console error${errors.length === 1 ? "" : "s"} on the migrated page`,
        {
          count: errors.length,
          data: {
            examples: sample(errors, 10).map((e) => ({
              message: clip(e.message, 200),
              ...(e.url === undefined ? {} : { url: e.url }),
            })),
          },
        },
      ),
    );
  }
  return out;
}

/** What a robots meta tag asks of a crawler; the rest of Rank Math's directive list is not an instruction to compare. */
function robotsOf(content: string): { noindex: boolean; nofollow: boolean } {
  const directives = new Set(content.toLowerCase().split(/[\s,]+/));
  return {
    noindex: directives.has("noindex") || directives.has("none"),
    nofollow: directives.has("nofollow") || directives.has("none"),
  };
}

/** The findings that hold for the page as a whole: whether it loaded, its status, where it ended up, its head. */
export function pageFindings(
  live: PageSnapshot,
  local: PageSnapshot,
  resolver: Resolver,
): Finding[] {
  const out: Finding[] = [];
  if (live.error !== undefined) {
    out.push(
      finding(
        "page.load-failed",
        "error",
        null,
        `the live page could not be captured: ${live.error}`,
        { live: live.requestedUrl, data: { side: "live" } },
      ),
    );
  }
  if (local.error !== undefined) {
    out.push(
      finding(
        "page.load-failed",
        "error",
        null,
        `the migrated page could not be captured: ${local.error}`,
        { local: local.requestedUrl, data: { side: "local" } },
      ),
    );
  }
  if (live.error !== undefined || local.error !== undefined) return out;

  if (live.status !== local.status) {
    out.push(
      finding(
        "page.status",
        local.status !== null && local.status >= 400 ? "error" : "warning",
        null,
        `the live page answers ${live.status} and the migrated one ${local.status}`,
        {
          live: live.status,
          local: local.status,
        },
      ),
    );
  }
  const liveFinal = resolver.normalize(live.finalUrl, undefined, false);
  const localFinal = resolver.normalize(local.finalUrl, undefined, false);
  const liveAsked = resolver.normalize(live.requestedUrl, undefined, false);
  const localAsked = resolver.normalize(local.requestedUrl, undefined, false);
  if (liveFinal !== localFinal) {
    out.push(
      finding(
        "page.redirect",
        "error",
        null,
        `the live page ends at ${liveFinal} and the migrated one at ${localFinal}`,
        {
          live: live.finalUrl,
          local: local.finalUrl,
          data: { requestedLive: liveAsked, requestedLocal: localAsked },
        },
      ),
    );
  }
  if (normalizeText(live.title) !== normalizeText(local.title)) {
    out.push(
      finding("meta.title", "warning", null, "the page titles differ", {
        live: live.title,
        local: local.title,
      }),
    );
  }
  if (normalizeText(live.description) !== normalizeText(local.description)) {
    out.push(
      finding("meta.description", "info", null, "the meta descriptions differ", {
        live: live.description,
        local: local.description,
      }),
    );
  }
  const liveRobots = robotsOf(live.robots);
  const localRobots = robotsOf(local.robots);
  if (liveRobots.noindex !== localRobots.noindex || liveRobots.nofollow !== localRobots.nofollow) {
    out.push(
      finding(
        "meta.robots",
        localRobots.noindex && !liveRobots.noindex ? "error" : "warning",
        null,
        localRobots.noindex && !liveRobots.noindex
          ? "the migrated page asks search engines not to index it and the live page does not"
          : "the robots directives differ",
        { live: live.robots, local: local.robots },
      ),
    );
  }
  const liveLang = live.lang.trim().toLowerCase();
  const localLang = local.lang.trim().toLowerCase();
  if (liveLang !== localLang) {
    const primary = (lang: string): string => lang.split("-")[0] ?? "";
    out.push(
      finding(
        "meta.lang",
        liveLang !== "" && localLang !== "" && primary(liveLang) !== primary(localLang)
          ? "warning"
          : "info",
        null,
        "the document languages differ",
        { live: live.lang, local: local.lang },
      ),
    );
  }
  const liveCanonical =
    live.canonical === ""
      ? ""
      : (resolver.normalize(live.canonical, undefined, false) ?? live.canonical);
  const localCanonical =
    local.canonical === ""
      ? ""
      : (resolver.normalize(local.canonical, undefined, false) ?? local.canonical);
  if (liveCanonical !== localCanonical) {
    out.push(
      finding("meta.canonical", "info", null, "the canonical links differ", {
        live: live.canonical,
        local: local.canonical,
      }),
    );
  }
  return out;
}
