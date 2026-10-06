/**
 * The oracle's report: `verify-report.json` (everything a program needs: per-URL fidelity, deltas
 * and findings, and a summary that aggregates by code and by property so a fix loop can take the
 * biggest systematic difference first), `verify-report.md` (the same for a person), and the side by
 * side images of the worst pages (live, local, diff) under `verify/`.
 *
 * Aggregation is a pure function of the per-URL results, so it is tested without a browser.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Finding, Severity, UrlResult } from "./types.ts";

export interface SkippedUrl {
  url: string;
  reason: string;
}

export interface ReportInput {
  live: string;
  project: string;
  viewports: number[];
  tolerance: number;
  results: UrlResult[];
  skipped: SkippedUrl[];
  /** How many URLs the sitemap or file named before filtering. */
  listed: number;
  /** How many worst pages keep their images. */
  imageCount: number;
  generatedAt?: string;
}

export interface Stats {
  mean: number;
  median: number;
  min: number;
  max: number;
}

export interface CodeSummary {
  code: string;
  /** The highest severity among its findings. */
  severity: Severity;
  /** Findings with this code (a page and viewport each count). */
  findings: number;
  /** The elements, blocks or items they cover. */
  items: number;
  /** Pages affected. */
  urls: number;
  urlList: string[];
}

export interface PropertySummary {
  property: string;
  /** Pages affected, and elements (the sum of the findings' counts). */
  urls: number;
  elements: number;
  /** The commonest group, and live and local values, among its findings. */
  group: string | null;
  live: string | null;
  local: string | null;
  urlList: string[];
}

export interface SystematicSummary {
  group: string;
  property: string;
  live: string;
  local: string;
  urls: number;
  elements: number;
  /** One path that shows it, on the migrated page. */
  example: { url: string; viewport: number | null; selector: string | undefined };
  urlList: string[];
}

export interface VerifyReport {
  generator: "wp2jx verify";
  generatedAt: string;
  live: string;
  project: string;
  viewports: number[];
  tolerance: number;
  summary: {
    listed: number;
    compared: number;
    skipped: number;
    /** URLs that could not be captured at all. */
    failed: number;
    fidelity: Stats | null;
    aboveFold: Stats | null;
    byViewport: Record<string, Stats>;
    severities: Record<Severity, number>;
    worst: {
      url: string;
      path: string;
      fidelity: number | null;
      viewports: Record<string, number>;
      topFinding: string | null;
    }[];
    byCode: CodeSummary[];
    byProperty: PropertySummary[];
    /** Style differences that hold across many elements, biggest first. */
    systematic: SystematicSummary[];
  };
  urls: UrlResult[];
  skipped: SkippedUrl[];
}

const round = (n: number, places = 4): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

export function stats(values: readonly number[]): Stats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    mean: round(sum / sorted.length),
    median: round(median),
    min: round(sorted[0] as number),
    max: round(sorted.at(-1) as number),
  };
}

const RANK: Record<Severity, number> = { error: 2, warning: 1, info: 0 };

/** All findings of a page: its own plus its viewports'. */
export function allFindings(result: UrlResult): Finding[] {
  return [...result.findings, ...result.viewports.flatMap((v) => v.findings)];
}

/**
 * What a difference covers, per page and viewport. The same elements are seen at every width, so
 * a page's figure is its widest viewport's (the viewports of one page are not more elements), and
 * the figure of a group of pages is the sum over its pages.
 */
type Seen = Map<string, Map<string, number>>;

function see(seen: Seen, url: string, f: Finding): void {
  const byViewport = seen.get(url) ?? new Map<string, number>();
  const width = String(f.viewport);
  byViewport.set(width, (byViewport.get(width) ?? 0) + (f.count ?? 1));
  seen.set(url, byViewport);
}

function elementsOf(seen: Seen): number {
  let total = 0;
  for (const byViewport of seen.values()) total += Math.max(0, ...byViewport.values());
  return total;
}

/** Aggregate the per-URL results into the report. */
export function buildReport(input: ReportInput): VerifyReport {
  const compared = input.results.filter((r) => r.fidelity !== null);
  const failed = input.results.filter((r) => r.fidelity === null);

  const byViewport: Record<string, Stats> = {};
  for (const width of input.viewports) {
    const values = input.results.flatMap((r) =>
      r.viewports
        .filter((v) => v.width === width && v.visual !== undefined)
        .map((v) => (v.visual as { fidelity: number }).fidelity),
    );
    const s = stats(values);
    if (s !== null) byViewport[String(width)] = s;
  }
  const folds = input.results.flatMap((r) =>
    r.viewports.flatMap((v) => (v.visual === undefined ? [] : [v.visual.aboveFold])),
  );

  const severities: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  const codes = new Map<
    string,
    { severity: Severity; findings: number; items: number; urls: Set<string> }
  >();
  const props = new Map<
    string,
    {
      urls: Set<string>;
      seen: Seen;
      groups: Map<string, number>;
      values: Map<string, number>;
    }
  >();
  const systematic = new Map<string, SystematicSummary & { urlSet: Set<string>; seen: Seen }>();

  for (const result of input.results) {
    for (const f of allFindings(result)) {
      severities[f.severity] += 1;
      const entry = codes.get(f.code) ?? {
        severity: f.severity,
        findings: 0,
        items: 0,
        urls: new Set<string>(),
      };
      if (RANK[f.severity] > RANK[entry.severity]) entry.severity = f.severity;
      entry.findings += 1;
      entry.items += f.count ?? 1;
      entry.urls.add(result.url);
      codes.set(f.code, entry);

      if (f.property !== undefined) {
        const p = props.get(f.property) ?? {
          urls: new Set<string>(),
          seen: new Map<string, Map<string, number>>(),
          groups: new Map<string, number>(),
          values: new Map<string, number>(),
        };
        p.urls.add(result.url);
        see(p.seen, result.url, f);
        const group = typeof f.data?.group === "string" ? f.data.group : undefined;
        if (group !== undefined) p.groups.set(group, (p.groups.get(group) ?? 0) + (f.count ?? 1));
        const pair = `${String(f.live ?? "")}\u0000${String(f.local ?? "")}`;
        p.values.set(pair, (p.values.get(pair) ?? 0) + (f.count ?? 1));
        props.set(f.property, p);
      }
      if (f.code === "style.systematic" && f.property !== undefined) {
        const group = typeof f.data?.group === "string" ? f.data.group : "";
        const key = `${group}|${f.property}|${String(f.live)}|${String(f.local)}`;
        const s = systematic.get(key) ?? {
          group,
          property: f.property,
          live: String(f.live ?? ""),
          local: String(f.local ?? ""),
          urls: 0,
          elements: 0,
          example: { url: result.url, viewport: f.viewport, selector: f.selector },
          urlList: [],
          urlSet: new Set<string>(),
          seen: new Map<string, Map<string, number>>(),
        };
        see(s.seen, result.url, f);
        s.urlSet.add(result.url);
        systematic.set(key, s);
      }
    }
  }

  const top = (map: Map<string, number>): string | null =>
    [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const worst = [...compared]
    .sort((a, b) => (a.fidelity as number) - (b.fidelity as number))
    .slice(0, 20)
    .map((r) => {
      const worstFinding = [...allFindings(r)].sort(
        (a, b) => RANK[b.severity] - RANK[a.severity],
      )[0];
      return {
        url: r.url,
        path: r.path,
        fidelity: r.fidelity,
        viewports: Object.fromEntries(
          r.viewports
            .filter((v) => v.visual !== undefined)
            .map((v) => [String(v.width), (v.visual as { fidelity: number }).fidelity]),
        ),
        topFinding:
          worstFinding === undefined ? null : `${worstFinding.code}: ${worstFinding.message}`,
      };
    });

  return {
    generator: "wp2jx verify",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    live: input.live,
    project: input.project,
    viewports: input.viewports,
    tolerance: input.tolerance,
    summary: {
      listed: input.listed,
      compared: compared.length,
      skipped: input.skipped.length,
      failed: failed.length,
      fidelity: stats(compared.map((r) => r.fidelity as number)),
      aboveFold: stats(folds),
      byViewport,
      severities,
      worst,
      byCode: [...codes.entries()]
        .map(([code, v]) => ({
          code,
          severity: v.severity,
          findings: v.findings,
          items: v.items,
          urls: v.urls.size,
          urlList: [...v.urls].slice(0, 50),
        }))
        .sort(
          (a, b) => RANK[b.severity] - RANK[a.severity] || b.urls - a.urls || b.items - a.items,
        ),
      byProperty: [...props.entries()]
        .map(([property, p]) => {
          const pair = top(p.values)?.split("\u0000") ?? [];
          return {
            property,
            urls: p.urls.size,
            elements: elementsOf(p.seen),
            group: top(p.groups),
            live: pair[0] ?? null,
            local: pair[1] ?? null,
            urlList: [...p.urls].slice(0, 50),
          };
        })
        .sort((a, b) => b.elements - a.elements),
      systematic: [...systematic.values()]
        .map(({ urlSet, seen, ...rest }) => ({
          ...rest,
          elements: elementsOf(seen),
          urls: urlSet.size,
          urlList: [...urlSet].slice(0, 50),
        }))
        .sort((a, b) => b.elements - a.elements || b.urls - a.urls),
    },
    urls: input.results.map(slimResult),
    skipped: input.skipped,
  };
}

/** A result with its long lists cut, so the report stays readable and a few MB: counts keep the totals. */
function slimResult(result: UrlResult): UrlResult {
  return {
    ...result,
    viewports: result.viewports.map((v) => {
      if (v.dom === undefined) return v;
      const { text, headings, links, images, elements } = v.dom;
      return {
        ...v,
        dom: {
          text: {
            ...text,
            missing: text.missing.slice(0, 50),
            extra: text.extra.slice(0, 50),
            changed: text.changed.slice(0, 50),
          },
          headings: {
            ...headings,
            missing: headings.missing.slice(0, 50),
            extra: headings.extra.slice(0, 50),
            levelChanged: headings.levelChanged.slice(0, 50),
          },
          links: {
            ...links,
            missing: links.missing.slice(0, 50),
            extra: links.extra.slice(0, 50),
            hrefChanged: links.hrefChanged.slice(0, 50),
          },
          images: {
            ...images,
            missing: images.missing.slice(0, 50),
            extra: images.extra.slice(0, 50),
            broken: images.broken.slice(0, 50),
            ...(images.brokenOnLive === undefined
              ? {}
              : { brokenOnLive: images.brokenOnLive.slice(0, 50) }),
            pairs: images.pairs.slice(0, 50),
          },
          elements: {
            ...elements,
            deltas: elements.deltas.slice(0, 100),
            groups: elements.groups.slice(0, 100),
          },
        },
      };
    }),
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────

const pct = (n: number | null | undefined, places = 1): string =>
  n === null || n === undefined ? "n/a" : `${(n * 100).toFixed(places)}%`;
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const clip = (text: string, n: number): string =>
  text.length > n ? `${text.slice(0, n - 1)}…` : text;

/** The report for a person: summary, worst pages, systematic differences, findings by code, per-page detail. */
export function renderMarkdown(
  report: VerifyReport,
  imageDirs: Record<string, string> = {},
): string {
  const s = report.summary;
  const out: string[] = [];
  out.push(`# wp2jx verify: ${report.live}`, "");
  out.push(
    `Project \`${report.project}\`, generated ${report.generatedAt}, viewports ${report.viewports.join(", ")} px, pixel tolerance ${report.tolerance}.`,
    "",
  );
  out.push("## Summary", "");
  out.push(
    `- Pages compared: ${s.compared} of ${s.listed} listed (${s.skipped} skipped, ${s.failed} could not be captured)`,
  );
  if (s.fidelity !== null) {
    out.push(
      `- Fidelity: mean ${pct(s.fidelity.mean)}, median ${pct(s.fidelity.median)}, min ${pct(s.fidelity.min)}, max ${pct(s.fidelity.max)}`,
    );
  }
  if (s.aboveFold !== null) out.push(`- Above the fold: mean ${pct(s.aboveFold.mean)}`);
  for (const [width, v] of Object.entries(s.byViewport)) {
    out.push(`- At ${width} px: mean ${pct(v.mean)}, median ${pct(v.median)}, min ${pct(v.min)}`);
  }
  out.push(
    `- Findings: ${s.severities.error} errors, ${s.severities.warning} warnings, ${s.severities.info} notes`,
    "",
  );

  if (s.worst.length > 0) {
    out.push("## Worst pages", "");
    out.push(
      `| Page | Fidelity | ${report.viewports.map((w) => `${w} px`).join(" | ")} | Most serious finding |`,
    );
    out.push(`| --- | ---: | ${report.viewports.map(() => "---:").join(" | ")} | --- |`);
    for (const w of s.worst) {
      out.push(
        `| ${cell(w.path)} | ${pct(w.fidelity)} | ${report.viewports.map((v) => pct(w.viewports[String(v)])).join(" | ")} | ${cell(clip(w.topFinding ?? "", 110))} |`,
      );
    }
    out.push("");
  }

  if (s.systematic.length > 0) {
    out.push("## Systematic differences, biggest first", "");
    out.push("| Elements | Pages | Group | Property | Live | Migrated | Example |");
    out.push("| ---: | ---: | --- | --- | --- | --- | --- |");
    for (const d of s.systematic.slice(0, 40)) {
      out.push(
        `| ${d.elements} | ${d.urls} | \`${cell(d.group)}\` | ${d.property} | ${cell(clip(d.live, 50))} | ${cell(clip(d.local, 50))} | \`${cell(clip(d.example.selector ?? "", 70))}\` on ${cell(new URL(d.example.url).pathname)} |`,
      );
    }
    out.push("");
  }

  if (s.byProperty.length > 0) {
    out.push("## Style findings by property", "");
    out.push("| Property | Elements | Pages | Commonest group | Live | Migrated |");
    out.push("| --- | ---: | ---: | --- | --- | --- |");
    for (const p of s.byProperty) {
      out.push(
        `| ${p.property} | ${p.elements} | ${p.urls} | ${cell(p.group ?? "")} | ${cell(clip(p.live ?? "", 50))} | ${cell(clip(p.local ?? "", 50))} |`,
      );
    }
    out.push("");
  }

  if (s.byCode.length > 0) {
    out.push("## Findings by code", "");
    out.push("| Code | Severity | Pages | Findings | Items |");
    out.push("| --- | --- | ---: | ---: | ---: |");
    for (const c of s.byCode)
      out.push(`| \`${c.code}\` | ${c.severity} | ${c.urls} | ${c.findings} | ${c.items} |`);
    out.push("");
  }

  const detailed = [...report.urls]
    .filter((u) => u.fidelity !== null || u.findings.length > 0)
    .sort((a, b) => (a.fidelity ?? -1) - (b.fidelity ?? -1))
    .slice(0, 20);
  if (detailed.length > 0) {
    out.push("## The worst pages in detail", "");
    for (const url of detailed) {
      out.push(`### ${url.path}`, "");
      out.push(
        `${url.url}, fidelity ${pct(url.fidelity)}${imageDirs[url.slug] === undefined ? "" : `, images in \`${imageDirs[url.slug]}\``}`,
        "",
      );
      for (const v of url.viewports) {
        if (v.visual !== undefined) {
          out.push(
            `- ${v.width} px: ${pct(v.visual.fidelity)} (above the fold ${pct(v.visual.aboveFold)}), height ${v.visual.liveHeight} live, ${v.visual.localHeight} migrated`,
          );
        } else out.push(`- ${v.width} px: not compared`);
      }
      out.push("");
      const rank = (f: Finding): number => RANK[f.severity];
      const findings = [...allFindings(url)].sort((a, b) => rank(b) - rank(a));
      for (const f of findings.slice(0, 25)) {
        out.push(
          `- **${f.severity}** \`${f.code}\`${f.viewport === null ? "" : ` @${f.viewport}`}: ${f.message}${f.selector === undefined ? "" : ` (\`${clip(f.selector, 100)}\`)`}`,
        );
      }
      if (findings.length > 25) out.push(`- … ${findings.length - 25} more in verify-report.json`);
      out.push("");
    }
  }

  if (report.skipped.length > 0) {
    out.push("## Not compared", "");
    const byReason = new Map<string, string[]>();
    for (const item of report.skipped) {
      const list = byReason.get(item.reason) ?? [];
      list.push(item.url);
      byReason.set(item.reason, list);
    }
    for (const [reason, urls] of byReason) {
      out.push(
        `- ${reason}: ${urls.length}${
          urls.length <= 8
            ? ` (${urls.map((u) => new URL(u).pathname).join(", ")})`
            : ` (e.g. ${urls
                .slice(0, 5)
                .map((u) => new URL(u).pathname)
                .join(", ")})`
        }`,
      );
    }
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

// ── Files ────────────────────────────────────────────────────────────────────────────────────────

/** Where one page's images are written while the run is going (kept only for the worst pages). */
export function shotsDir(reportDir: string, slug: string): string {
  const root = join(reportDir, ".shots");
  const dir = resolve(root, slug);
  // The folder is deleted and renamed wholesale: a slug that climbs out of `.shots` would take the
  // report (or anything above it) with it.
  if (!dir.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error(`page name ${JSON.stringify(slug)} is not a folder inside ${root}`);
  }
  return dir;
}

/**
 * Keeps the images of the worst pages and nobody else's: the run writes each page's three PNGs as it
 * goes and offers the page here; whichever page falls out of the worst `count` has its folder
 * removed at once, so a long run holds at most `count + 1` pages of images on disk.
 */
export class ShotKeeper {
  private readonly kept: { slug: string; fidelity: number }[] = [];

  constructor(
    private readonly reportDir: string,
    private readonly count: number,
  ) {}

  /** Register a page whose images are in `shotsDir`; the best-scoring page over the limit is deleted. */
  offer(slug: string, fidelity: number | null): void {
    if (fidelity === null || this.count <= 0) {
      rmSync(shotsDir(this.reportDir, slug), { recursive: true, force: true });
      return;
    }
    this.kept.push({ slug, fidelity });
    this.kept.sort((a, b) => a.fidelity - b.fidelity);
    while (this.kept.length > this.count) {
      const evicted = this.kept.pop();
      if (evicted !== undefined)
        rmSync(shotsDir(this.reportDir, evicted.slug), { recursive: true, force: true });
    }
  }
}

/**
 * Move the images the keeper held to `verify/<slug>/`, point each page's viewports at them, and
 * write `verify/index.html`, a page that shows each as live | migrated | diff side by side. Returns
 * the report-relative directory of each page that has images.
 */
export function keepWorstImages(
  reportDir: string,
  results: UrlResult[],
  count: number,
): Record<string, string> {
  const keep = results
    .filter((r) => r.fidelity !== null && existsSync(shotsDir(reportDir, r.slug)))
    .sort((a, b) => (a.fidelity as number) - (b.fidelity as number))
    .slice(0, Math.max(0, count));
  const target = join(reportDir, "verify");
  rmSync(target, { recursive: true, force: true });
  const kept: Record<string, string> = {};
  if (keep.length > 0) mkdirSync(target, { recursive: true });
  for (const result of keep) {
    renameSync(shotsDir(reportDir, result.slug), join(target, result.slug));
    kept[result.slug] = `verify/${result.slug}`;
  }
  // Point each kept page's images at their final place; the others have none.
  for (const result of results) {
    for (const v of result.viewports) {
      if (v.images === undefined) continue;
      if (kept[result.slug] === undefined) delete v.images;
      else {
        v.images = {
          live: `${kept[result.slug]}/${v.width}-live.png`,
          local: `${kept[result.slug]}/${v.width}-local.png`,
          diff: `${kept[result.slug]}/${v.width}-diff.png`,
        };
      }
    }
  }
  rmSync(join(reportDir, ".shots"), { recursive: true, force: true });
  if (keep.length > 0) {
    const sections = keep.map((result) => {
      const rows = result.viewports
        .filter((v) => v.images !== undefined)
        .map((v) => {
          const im = v.images as { live: string; local: string; diff: string };
          const rel = (p: string): string => p.replace(/^verify\//, "");
          return `<h3>${v.width} px: ${((v.visual?.fidelity ?? 0) * 100).toFixed(1)}%</h3><div class="row"><figure><figcaption>live</figcaption><img loading="lazy" src="${rel(im.live)}"></figure><figure><figcaption>migrated</figcaption><img loading="lazy" src="${rel(im.local)}"></figure><figure><figcaption>diff</figcaption><img loading="lazy" src="${rel(im.diff)}"></figure></div>`;
        })
        .join("\n");
      return `<section><h2>${escapeHtml(result.path)} <small>${((result.fidelity ?? 0) * 100).toFixed(1)}%</small></h2>${rows}</section>`;
    });
    writeFileSync(
      join(target, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>wp2jx verify</title><style>body{font:14px system-ui;margin:16px;background:#fff;color:#111}.row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;align-items:start}figure{margin:0}figcaption{font-weight:600;margin:4px 0}img{width:100%;border:1px solid #ccc}small{font-weight:400;color:#555}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style><h1>Worst pages</h1>${sections.join("\n")}`,
    );
  }
  return kept;
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

/** Write `verify-report.json` and `verify-report.md`; returns their paths. */
export function writeReport(
  reportDir: string,
  report: VerifyReport,
  imageDirs: Record<string, string> = {},
): { json: string; md: string } {
  mkdirSync(reportDir, { recursive: true });
  const json = join(reportDir, "verify-report.json");
  const md = join(reportDir, "verify-report.md");
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(md, renderMarkdown(report, imageDirs));
  return { json, md };
}
