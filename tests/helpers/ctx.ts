/**
 * A real `ConvertCtx` assembled from the committed fixtures, for every test that converts blocks.
 *
 *   const ctx = await makeCtx("fineline", { kind: "post", id: 5246 });
 *   const blocks = subjectBlocks(await loadSite("fineline"), { kind: "post", id: 5246 });
 *
 * A thin wrapper over `src/site.ts`: the fixture site is loaded through `loadSiteContext` (its
 * database is the committed rows, its stylesheets the committed CSS), a subject's context comes from
 * `subjectCtx`, and `ctx.convert` is the real driver. Pass `overrides` to replace any field. For
 * compatibility with the tests written before the driver existed, a template or part is converted as
 * `static` here unless `overrides.mode` says otherwise (the driver's own default for a single
 * template is `entry`), and the context carries no explicit `target` unless one is given.
 */
import {
  allSubjects as siteSubjects,
  componentInfos,
  cssIndexFor as siteCssIndexFor,
  cssNamesFor as siteCssNamesFor,
  loadSiteContext,
  subjectBlocks as siteSubjectBlocks,
  subjectCtx,
  subjectPost as siteSubjectPost,
  type SiteContext,
  type Subject,
} from "../../src/site.ts";
import { openDb } from "../../src/wp/db.ts";
import { DEFAULT_EXCLUDED_POST_TYPES } from "../../src/wp/model.ts";
import type {
  ComponentInfo,
  ConvertCtx,
  CssIndex,
  WpBlock,
  WpModel,
  WpPost,
} from "../../src/types.ts";
import { fixtureCssDir } from "./fixture-css.ts";
import { fixtureDb } from "./fixture-db.ts";

export type { Subject };
export type SiteName = "fineline" | "ap";

export interface LoadedSite extends SiteContext {
  site: SiteName;
}

const sites = new Map<SiteName, Promise<LoadedSite>>();

/** Load a fixture site once per process (`bun test --isolate` gives each file its own). */
export function loadSite(site: SiteName): Promise<LoadedSite> {
  let loaded = sites.get(site);
  if (!loaded) {
    loaded = (async () => {
      const { url, prefix } = await fixtureDb(site);
      // Every type the fixture holds except the bookkeeping ones: the fixtures cap each type at 100
      // rows, so the model is the same one the tests were written against.
      const db = await openDb(url, { prefix });
      let postTypes: string[];
      try {
        const rows = await db.query<{ post_type: string }>(
          `select distinct post_type from ${db.table("posts")} order by post_type`,
        );
        postTypes = rows
          .map((r) => String(r.post_type))
          .filter((t) => !DEFAULT_EXCLUDED_POST_TYPES.includes(t));
      } finally {
        await db.close();
      }
      const context = await loadSiteContext({
        db: url,
        prefix,
        cssFrom: { dir: fixtureCssDir(site) },
        componentPrefix: "wp",
        postTypes,
      });
      return { ...context, site };
    })();
    sites.set(site, loaded);
  }
  return loaded;
}

// ── Subjects ─────────────────────────────────────────────────────────────────────────────────────

/** The post a subject stands for. */
export const subjectPost = (site: LoadedSite, subject: Subject): WpPost | undefined =>
  siteSubjectPost(site, subject);

export const subjectBlocks = (site: LoadedSite, subject: Subject): WpBlock[] =>
  siteSubjectBlocks(site, subject);

/** The stylesheet names a subject's rendered page loads (see `cssNamesFor` in src/site.ts). */
export const cssNamesFor = (site: LoadedSite, subject: Subject): string[] =>
  siteCssNamesFor(site, subject);

export const cssIndexFor = (site: LoadedSite, subject: Subject): Promise<CssIndex> =>
  siteCssIndexFor(site, subject);

/** Every published `cc_block`, keyed by its `reference` meta. The tag is `<prefix>-<slug>`. */
export const componentsOf = (model: WpModel, prefix = "wp"): Map<string, ComponentInfo> =>
  componentInfos(model, prefix);

// ── Stand-ins from before the routes module existed (kept for the tests that use them) ──────────

/** Permalink-ish paths, enough for tests: pages at `/<slug>/`, other posts at `/<type>/<slug>/`. */
export function stubUrlFor(model: WpModel): ConvertCtx["urlFor"] {
  return (kind, id) => {
    if (kind === "post") {
      const post = model.posts.get(id);
      if (!post) return undefined;
      return post.type === "page" ? `/${post.slug}/` : `/${post.type}/${post.slug}/`;
    }
    const term = model.terms.get(id);
    return term ? `/${term.taxonomy}/${term.slug}/` : undefined;
  };
}

/**
 * Uploads become `/media/…` through the real media plan; same-site URLs lose their origin; the rest
 * is untouched. The real routes module replaces this with permalink-aware rewriting.
 */
export function stubRewriteUrl(site: LoadedSite): ConvertCtx["rewriteUrl"] {
  const origins = new Set(
    [site.model.site.url, site.model.site.home].map((u) => u.replace(/\/$/, "")),
  );
  return (url) => {
    const media = site.media.mediaForUrl(url);
    if (media) return media.src;
    for (const origin of origins) {
      if (url === origin) return "/";
      if (
        url.startsWith(`${origin}/`) ||
        url.startsWith(`${origin}?`) ||
        url.startsWith(`${origin}#`)
      ) {
        return url.slice(origin.length) || "/";
      }
    }
    return url;
  };
}

// ── The context ──────────────────────────────────────────────────────────────────────────────────

export async function makeCtx(
  site: SiteName,
  subject: Subject,
  overrides: Partial<ConvertCtx> = {},
): Promise<ConvertCtx> {
  const loaded = await loadSite(site);
  const ctx: ConvertCtx = await subjectCtx(loaded, subject, {
    ...(subject.kind === "component" ? {} : { mode: "static" as const }),
    ...overrides,
  });
  // The driver says where the nodes go (`ctx.target`); the tests written before it asked `targetOf`,
  // which derives it from the subject, and that is what they hold the context to.
  if (overrides.target === undefined) delete ctx.target;
  return ctx;
}

/** Every post worth converting in a site, for corpus sweeps: published content, templates, parts, components, reusable blocks. */
export const allSubjects = (site: LoadedSite): Subject[] => siteSubjects(site);
