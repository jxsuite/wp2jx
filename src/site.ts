/**
 * The site and its subjects: everything a conversion needs that is not one block.
 *
 * {@link loadSiteContext} is the production version of what the tests' ctx helper does: open the
 * database, read the model, the Cwicly options, ACF, the media plan and the routes once, and hold
 * them with the stylesheet and plugin sources. A {@link Subject} (a post, a template, a template part,
 * a component or a reusable block) is what one conversion is about, and {@link subjectCtx} makes the
 * `ConvertCtx` for it: the subject's own CSS index (its stylesheet and those of every part, component
 * and reusable block its blocks reference), URL tools that report into the subject's own report, and
 * the defaults the subject's kind implies (static for a page, an entry for a single template, a
 * component body for a component).
 *
 * The tag names of the Jx components the emitters write (`<prefix>-<slug>` for a Cwicly component, a
 * template part and a reusable block) are decided here, once, so `components/<tag>.json` and the
 * `<tag>` that uses it can never disagree: {@link componentInfos}, {@link partTag}, {@link reusableTag}.
 *
 * Report codes: `site.theme-css-missing`, `site.plugin-missing`, `site.registry-incomplete` (from
 * convert.ts's registry), and, per subject, the reader's `css.*` artifacts of the subject's own
 * stylesheets (`css.missing-file` is `info` for a post, whose stylesheet exists only when a block of
 * it has styles).
 */
import {
  dirThemeCss,
  dirPluginSource,
  fetchPluginSource,
  fetchThemeCss,
} from "./emit/compat-css.ts";
import type { PluginAssetSource } from "./emit/compat-css.ts";
import { dirCssSource, urlCssSource, type RememberedAbsence } from "./cwicly/css-source.ts";
import {
  emptyCssIndex,
  mergeCssIndexes,
  parseCwiclyCss,
  CSS_ARTIFACT,
  type OrderedCssIndex,
} from "./cwicly/css.ts";
import { readCwiclyOptions, type CwiclyOptionsFull } from "./cwicly/options.ts";
import {
  findUnregisteredNamespaces,
  setUnregisteredBlockNamespaces,
  usedBlockNamespaces,
} from "./wp/block-registry.ts";
import { convertBlocks, ensureConverters, withOverrides } from "./convert.ts";
import { planMedia, type MediaPlan } from "./media.ts";
import { createReport } from "./report.ts";
import {
  buildRoutes,
  createUrlTools,
  type RouteOptions,
  type RouteTable,
  type UrlTools,
} from "./routes.ts";
import type {
  ComponentInfo,
  ConvertCtx,
  CssSource,
  JxStyle,
  Report,
  WpBlock,
  WpDb,
  WpModel,
  WpPost,
} from "./types.ts";
import { loadAcf, userFieldNames, type AcfModel } from "./wp/acf.ts";
import { addReferencedUsers, referencedUsers } from "./wp/profiles.ts";
import { loadFluentForms, type FluentForm } from "./wp/fluentform.ts";
import { parseBlocks, walkBlocks } from "./wp/blocks.ts";
import { openDb } from "./wp/db.ts";
import { DEFAULT_EXCLUDED_POST_TYPES, decodeEntities, loadModel, publicUrl } from "./wp/model.ts";

// ── Subjects ─────────────────────────────────────────────────────────────────────────────────────

/** What a conversion is about: a post, a template or template part (by slug), a component (by `reference`), a reusable block. */
export type Subject =
  | { kind: "post"; id: number }
  | { kind: "template"; slug: string }
  | { kind: "part"; slug: string }
  | { kind: "component"; ref: string }
  | { kind: "reusable"; id: number };

/** The site, loaded once. Everything in it is read-only for the conversion. */
export interface SiteContext {
  model: WpModel;
  options: CwiclyOptionsFull;
  acf: AcfModel;
  /** The real media plan (no downloads): families collapsed, every attachment and uploads URL resolvable. */
  media: MediaPlan;
  /** The route table and the URL tools over it (permalinks, Jx routes, `rewriteUrl`); bind them to a report per subject. */
  routes: RouteTable;
  urls: UrlTools;
  /** Where Cwicly's generated stylesheets come from. */
  cssSource: CssSource;
  /** The plugin's own files (`build/style-index.css`…), when the caller said where they are. */
  pluginSource?: PluginAssetSource;
  /** The site's published Fluent Forms forms by id (empty without the plugin); a page that embeds one draws it. */
  forms?: ReadonlyMap<number, FluentForm>;
  /** What the load itself found (options, ACF, routes). A subject's own findings are in its `Converted.report`. */
  report: Report;
  /** The prefix of every tag the emitters write: `fp` gives `fp-icon-card`. */
  componentPrefix: string;
  /** Every Cwicly component by its `reference` meta. */
  components: Map<string, ComponentInfo>;
  /**
   * The active theme's `style.css` (what `buildCompatCss({theme})` ships last), or null when the
   * checkout or the live site did not have it. The theme's name is `model.site.theme`.
   */
  theme: string | null;
}

const firstMeta = (model: WpModel, id: number, key: string): unknown =>
  model.postMeta.get(id)?.[key]?.[0];

/** Statuses a template, part or component can be converted from: WordPress keeps both in the editor, and the corpus sweep lists both. */
const LIVE_STATUSES = new Set(["publish", "private"]);

/**
 * How well a template's `wp_theme` term fits the active theme: 0 is the active theme's own, 1 is a post
 * with no theme term (a hand-made one), 2 is another theme's. WordPress keeps the templates of an
 * inactive theme in the database, so a slug alone can name two posts.
 */
function themeRank(model: WpModel, post: WpPost): 0 | 1 | 2 {
  let rank: 1 | 2 = 1;
  for (const termId of model.termsByPost.get(post.id) ?? []) {
    const term = model.terms.get(termId);
    if (term?.taxonomy !== "wp_theme") continue;
    if (term.slug === model.site.theme) return 0;
    rank = 2;
  }
  return rank;
}

/**
 * The post a template or a part slug names: of the posts with that type and slug that are published
 * or private, the active theme's before another's and a published one before a private one, then the
 * first. One rule, so what {@link allSubjects} lists, what {@link subjectPost} converts and what the
 * tag table names agree.
 */
function templatePost(
  model: WpModel,
  type: "wp_template" | "wp_template_part",
  slug: string,
): WpPost | undefined {
  let best: WpPost | undefined;
  let bestRank = Infinity;
  for (const post of model.posts.values()) {
    if (post.type !== type || post.slug !== slug || !LIVE_STATUSES.has(post.status)) continue;
    const rank = themeRank(model, post) * 2 + (post.status === "publish" ? 0 : 1);
    if (rank < bestRank) {
      best = post;
      bestRank = rank;
    }
  }
  return best;
}

/** The post a subject stands for. */
export function subjectPost(
  site: Pick<SiteContext, "model">,
  subject: Subject,
): WpPost | undefined {
  const { model } = site;
  switch (subject.kind) {
    case "post":
    case "reusable":
      return model.posts.get(subject.id);
    case "template":
      return templatePost(model, "wp_template", subject.slug);
    case "part":
      return templatePost(model, "wp_template_part", subject.slug);
    case "component": {
      // The first live post of the reference, the one `componentInfos` names.
      for (const post of model.posts.values()) {
        if (
          post.type === "cc_block" &&
          LIVE_STATUSES.has(post.status) &&
          firstMeta(model, post.id, "reference") === subject.ref
        )
          return post;
      }
      return undefined;
    }
  }
}

export function subjectBlocks(site: Pick<SiteContext, "model">, subject: Subject): WpBlock[] {
  return parseBlocks(subjectPost(site, subject)?.content ?? "");
}

/**
 * The id the report and the URL tools locate a subject by: the post id, `<theme>//<slug>` for a
 * template or a part (WordPress's own template id), the `reference` for a component.
 */
export function subjectId(site: Pick<SiteContext, "model">, subject: Subject): string {
  switch (subject.kind) {
    case "post":
    case "reusable":
      return String(subject.id);
    case "component":
      return subject.ref;
    case "template":
    case "part":
      return `${site.model.site.theme}//${subject.slug}`;
  }
}

/** The `ctx.subject.kind` a subject is converted as: a reusable block is a post, a part is a template. */
export function ctxKind(subject: Subject): ConvertCtx["subject"]["kind"] {
  switch (subject.kind) {
    case "post":
    case "reusable":
      return "post";
    case "component":
      return "component";
    case "template":
    case "part":
      return "template";
  }
}

/** `post:5246`, `template:cwicly//header`: the report location of a subject (the same text `whereOf` writes). */
export const subjectWhere = (site: Pick<SiteContext, "model">, subject: Subject): string =>
  `${ctxKind(subject)}:${subjectId(site, subject)}`;

export interface AllSubjectsOptions {
  /**
   * Keep a post of a type other than `page` only when the route table gives it an address: the
   * configuration posts of plugins (a podcast host's, a form builder's, an admin-UI's) are loaded
   * with the model but are not content, and `route.unregistered` has already said so. Without `site.routes` there is nothing to ask and the option does nothing.
   */
  routedOnly?: boolean;
}

/**
 * Every subject worth converting in a site, for corpus sweeps: published and private content,
 * templates, parts, components, reusable blocks. A template or a part is listed once per slug (the
 * post {@link subjectPost} converts), a component once per `reference`.
 */
export function allSubjects(
  site: Pick<SiteContext, "model"> & Partial<Pick<SiteContext, "routes">>,
  opts: AllSubjectsOptions = {},
): Subject[] {
  const out: Subject[] = [];
  const components = new Set<string>();
  for (const post of site.model.posts.values()) {
    if (!LIVE_STATUSES.has(post.status)) continue;
    switch (post.type) {
      case "wp_template":
        if (templatePost(site.model, "wp_template", post.slug)?.id === post.id)
          out.push({ kind: "template", slug: post.slug });
        break;
      case "wp_template_part":
        if (templatePost(site.model, "wp_template_part", post.slug)?.id === post.id)
          out.push({ kind: "part", slug: post.slug });
        break;
      case "cc_block": {
        // A component with no reference, or a second post under a taken one, is reported by `componentInfos`.
        const ref = firstMeta(site.model, post.id, "reference");
        if (typeof ref === "string" && ref !== "" && !components.has(ref)) {
          components.add(ref);
          out.push({ kind: "component", ref });
        }
        break;
      }
      case "wp_block":
        out.push({ kind: "reusable", id: post.id });
        break;
      case "attachment":
      case "nav_menu_item":
      case "wp_navigation":
      case "acf-field":
      case "acf-field-group":
      case "acf-post-type":
      case "acf-taxonomy":
      case "wp_global_styles":
      case "custom_css":
        break;
      case "page":
        out.push({ kind: "post", id: post.id });
        break;
      default:
        if (opts.routedOnly !== true || site.routes === undefined || site.routes.forPost(post.id))
          out.push({ kind: "post", id: post.id });
    }
  }
  return out;
}

// ── Stylesheets of a subject ─────────────────────────────────────────────────────────────────────

/** The live head's order: the global stylesheets, then the global classes (docs/design.md, live CSS order). */
const GLOBAL_CSS = ["cc-global-stylesheets.css", "cc-global-classes.css"] as const;

/**
 * Whether a stylesheet name can be asked of a {@link CssSource}: a plain file name. The parts of a
 * name come from block attributes (`slug`, `theme`, `ref`), so a malformed one (a slash, a NUL, a
 * query) must never reach a source that would refuse it, or fetch something else.
 */
export const isCssFileName = (name: string): boolean =>
  name !== "" &&
  name !== "." &&
  name !== ".." &&
  !/[\\/?#]/.test(name) &&
  ![...name].some((char) => char.charCodeAt(0) < 32);

/** The stylesheets a subject loads: the names a source can be asked, and the ones a block attribute made unusable. */
export interface CssPlan {
  names: string[];
  /** Names built from an attribute that is not a file-name fragment (`cc-tp-cwicly_../../x.css`); never asked of a source. */
  invalid: string[];
}

/**
 * The stylesheets a subject's rendered page loads, in the order the live head prints them: the global
 * files; for a template, part, component or reusable block its own file and then those of every
 * template part, component and reusable block its blocks (transitively) reference; for a post those
 * first and its own file LAST (`cc-post-<id>` ends every live head). A missing file is reported by the
 * CSS reader (`css.missing-file`).
 */
export function cssPlanFor(site: Pick<SiteContext, "model">, subject: Subject): CssPlan {
  const theme = site.model.site.theme;
  const names = new Set<string>(GLOBAL_CSS);
  const seen = new Set<string>();

  const visit = (blocks: readonly WpBlock[]): void => {
    walkBlocks(blocks, (block) => {
      const attrs = block.attrs;
      if (block.name === "core/template-part" && typeof attrs.slug === "string") {
        const part = attrs.slug;
        const partTheme = typeof attrs.theme === "string" ? attrs.theme : theme;
        names.add(`cc-tp-${partTheme}_${part}.css`);
        if (!seen.has(`part:${part}`)) {
          seen.add(`part:${part}`);
          visit(subjectBlocks(site, { kind: "part", slug: part }));
        }
      } else if (block.name === "cwicly/component" && typeof attrs.ref === "string") {
        names.add(`cc-cm-${attrs.ref}.css`);
        if (!seen.has(`cm:${attrs.ref}`)) {
          seen.add(`cm:${attrs.ref}`);
          visit(subjectBlocks(site, { kind: "component", ref: attrs.ref }));
        }
      } else if (block.name === "core/block" && typeof attrs.ref === "number") {
        names.add(`cc-rb-${attrs.ref}.css`);
        if (!seen.has(`rb:${attrs.ref}`)) {
          seen.add(`rb:${attrs.ref}`);
          visit(subjectBlocks(site, { kind: "reusable", id: attrs.ref }));
        }
      }
    });
  };

  const own = ownCssName(site, subject);
  // A template's file is enqueued before the parts it renders; a post's after everything it embeds.
  if (own !== undefined && subject.kind !== "post") names.add(own);
  const post = subjectPost(site, subject);
  let styled = false;
  if (post) {
    const blocks = parseBlocks(post.content);
    visit(blocks);
    walkBlocks(blocks, (block) => {
      if (block.name?.startsWith("cwicly/") && block.attrs.isStyling === true) styled = true;
    });
  }
  // Cwicly writes a post's file when the post has a styled block of its own and not otherwise: a post of
  // core blocks has none, and asking the site for one (a request each, hundreds on a site of essays) only
  // learns that.
  if (own !== undefined && (subject.kind !== "post" || styled)) names.add(own);
  const all = [...names];
  return { names: all.filter(isCssFileName), invalid: all.filter((name) => !isCssFileName(name)) };
}

/** The stylesheet names a subject's rendered page loads, in cascade order ({@link cssPlanFor}), less any that is not a file name. */
export const cssNamesFor = (site: Pick<SiteContext, "model">, subject: Subject): string[] =>
  cssPlanFor(site, subject).names;

/** The stylesheet that belongs to the subject itself (the others it loads belong to the parts and components it embeds). */
export function ownCssName(site: Pick<SiteContext, "model">, subject: Subject): string | undefined {
  switch (subject.kind) {
    case "post":
      return `cc-post-${subject.id}.css`;
    case "template":
    case "part":
      return `cc-tp-${site.model.site.theme}_${subject.slug}.css`;
    case "component":
      return `cc-cm-${subject.ref}.css`;
    case "reusable":
      return `cc-rb-${subject.id}.css`;
  }
}

/** Parsed files, per site: a file is read and parsed once however many subjects load it (the global classes, a header part). */
const parsedFiles = new WeakMap<object, Map<string, Promise<OrderedCssIndex>>>();

function parsedFile(site: SiteContext, name: string): Promise<OrderedCssIndex> {
  let files = parsedFiles.get(site);
  if (!files) {
    files = new Map();
    parsedFiles.set(site, files);
  }
  let found = files.get(name);
  if (!found) {
    found = (async () => {
      // A name a source would refuse is a finding of the subject that built it (`cssPlanFor`), not a failure.
      if (!isCssFileName(name)) return emptyCssIndex();
      const css = await site.cssSource.get(name);
      if (css === null) {
        const index = emptyCssIndex();
        index.artifacts.push({
          code: CSS_ARTIFACT.missingFile,
          detail: `stylesheet ${name} was not found`,
          file: name,
        });
        return index;
      }
      return parseCwiclyCss(css, site.options.breakpoints, {
        file: name,
        // The palette lets the reader repair `!var=<id>!` references Cwicly's generator never resolved.
        palette: [...site.options.globalStyles.colorRefs.values()],
      });
    })();
    files.set(name, found);
    // A failed read is not remembered: a stylesheet every subject shares must not stay broken for
    // the whole sweep because the live site answered one request badly (urlCssSource does the same).
    const failed = found;
    failed.catch(() => {
      if (files.get(name) === failed) files.delete(name);
    });
  }
  return found;
}

/**
 * The merged CSS index of a subject's stylesheets (see {@link cssNamesFor}, which a caller that has
 * the names already passes in), in cascade order.
 */
export async function cssIndexFor(
  site: SiteContext,
  subject: Subject,
  names: readonly string[] = cssNamesFor(site, subject),
): Promise<OrderedCssIndex> {
  return mergeCssIndexes(...(await Promise.all(names.map((name) => parsedFile(site, name)))));
}

/**
 * What the reader found wrong in the subject's OWN stylesheet. The global files are the design
 * system's to report once, and a part's or component's file is reported by that part or component, so
 * a header embedded in a hundred pages is not a hundred reports.
 */
export async function reportOwnCss(
  site: SiteContext,
  subject: Subject,
  report: Report,
  where: string,
): Promise<void> {
  const own = ownCssName(site, subject);
  if (own === undefined || !isCssFileName(own)) return;
  // A missing file is nothing when the subject has no styled Cwicly block (Cwicly writes none then);
  // with one, the block's style comes from its attributes instead, which is worth a line.
  let styled = false;
  walkBlocks(subjectBlocks(site, subject), (block) => {
    if (block.name?.startsWith("cwicly/") && block.attrs.isStyling === true) styled = true;
  });
  // A post with none is not asked for a file (`cssPlanFor`).
  if (subject.kind === "post" && !styled) return;
  const index = await parsedFile(site, own);
  if (index.artifacts.length === 0) return;
  const post = subjectPost(site, subject);
  const url = post && post.type !== "wp_block" ? publicUrl(site.model.site, post) : undefined;
  const believed = remembersOf(site.cssSource)?.(own);
  for (const artifact of index.artifacts) {
    const missing = artifact.code === CSS_ARTIFACT.missingFile;
    const remembered = missing ? believed : undefined;
    report.add({
      severity: missing && !styled ? "info" : "warn",
      code: artifact.code,
      // A remembered 404 and a new one read alike to the converter, and only one of them is news.
      message:
        remembered === undefined
          ? artifact.detail
          : `${artifact.detail}; the live site was not asked this run: an earlier 404 is remembered until ${new Date(remembered.expires).toISOString()}. Delete ${remembered.file}, or convert with --css-cache-absent-ttl 0, to ask the site again`,
      where,
      ...(url === undefined ? {} : { url }),
      data: {
        file: own,
        ...(remembered === undefined
          ? {}
          : { remembered: true, rememberedUntil: new Date(remembered.expires).toISOString() }),
        ...(artifact.selector === undefined ? {} : { selector: artifact.selector }),
      } as Record<string, unknown>,
    });
  }
}

// ── Tag names ────────────────────────────────────────────────────────────────────────────────────

/** Names a custom element may not take (the HTML standard's list of hyphenated built-ins). */
const RESERVED_TAGS = new Set([
  "annotation-xml",
  "color-profile",
  "font-face",
  "font-face-src",
  "font-face-uri",
  "font-face-format",
  "font-face-name",
  "missing-glyph",
]);

/** Lower-case letters, digits and single hyphens, trimmed: what is left of a slug that can sit in a tag name. */
function tagSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A prefix a tag can start with: letters and digits, beginning with a letter; `wp` when nothing is left. */
export function tagPrefix(prefix: string | undefined): string {
  const clean = tagSlug(prefix ?? "").replace(/^[0-9-]+/, "");
  return clean === "" ? "wp" : clean;
}

/** Tags handed out so far in one allocation. */
class TagPool {
  readonly taken = new Set<string>();

  /** The first free of `candidates`, then `<first>-2`, `<first>-3`…; always a valid custom element name. */
  take(candidates: string[]): string {
    const free = candidates.find((tag) => !this.taken.has(tag) && !RESERVED_TAGS.has(tag));
    if (free !== undefined) {
      this.taken.add(free);
      return free;
    }
    const base = candidates[0]!;
    for (let n = 2; ; n++) {
      const tag = `${base}-${n}`;
      if (!this.taken.has(tag)) {
        this.taken.add(tag);
        return tag;
      }
    }
  }
}

/** `camelCase` of a name, a legal property key that cannot be mistaken for anything on `Object.prototype`. */
function propKey(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join("");
  const key = /^[A-Za-z_]/.test(joined) ? joined : `p${joined}`;
  return key in Object.prototype ? `${key}_` : key;
}

/**
 * Every published or private `cc_block`, keyed by its `reference` meta (a post with none, or one
 * under a reference another post has, is left out and said so in `report`). The tag is
 * `<prefix>-<slug>`: unique across the site (a second component whose slug reduces to the same text
 * gets `-2`), with a dash by construction, in the form a custom element name takes. Props keep
 * their stored order and get unique camelCase keys; variants are `{id, name}`.
 */
export function componentInfos(
  model: WpModel,
  prefix = "wp",
  report?: Report,
): Map<string, ComponentInfo> {
  const pre = tagPrefix(prefix);
  const pool = new TagPool();
  const out = new Map<string, ComponentInfo>();
  for (const post of model.posts.values()) {
    if (post.type !== "cc_block" || !LIVE_STATUSES.has(post.status)) continue;
    const ref = firstMeta(model, post.id, "reference");
    if (typeof ref !== "string" || ref === "") {
      report?.add({
        severity: "warn",
        code: "component.no-reference",
        message: `The component post ${post.id} (${post.slug}) has no \`reference\` meta, so no block can instantiate it; it is not converted.`,
        where: `post:${post.id}`,
        data: { post: post.id, slug: post.slug },
      });
      continue;
    }
    const taken = out.get(ref);
    if (taken !== undefined) {
      report?.add({
        severity: "warn",
        code: "component.duplicate-reference",
        message: `The component posts ${taken.postId} and ${post.id} share the reference ${ref} (a duplicated post keeps its meta); only ${taken.postId} is converted.`,
        where: `post:${post.id}`,
        data: { ref, kept: taken.postId, ignored: post.id },
      });
      continue;
    }
    const rawProps = firstMeta(model, post.id, "properties");
    const used = new Set<string>();
    const props: ComponentInfo["props"] = [];
    if (rawProps && typeof rawProps === "object") {
      for (const [id, def] of Object.entries(rawProps as Record<string, Record<string, unknown>>)) {
        const name = typeof def?.name === "string" && def.name !== "" ? def.name : id;
        let key = propKey(name);
        while (used.has(key)) key = `${key}_`;
        used.add(key);
        props.push({ id, key, name, type: String(def?.type ?? ""), default: def?.default });
      }
    }
    const rawVariants = firstMeta(model, post.id, "variants");
    const variants: ComponentInfo["variants"] = [];
    if (rawVariants && typeof rawVariants === "object") {
      for (const v of Object.values(rawVariants as Record<string, Record<string, unknown>>)) {
        if (typeof v?.id === "string") variants.push({ id: v.id, name: String(v.name ?? v.id) });
      }
    }
    const slug = tagSlug(post.slug) || `component-${post.id}`;
    const tagName = pool.take([`${pre}-${slug}`]);
    out.set(ref, { ref, postId: post.id, tagName, props, variants });
  }
  return out;
}

/** The tag a component's instances are written as, or undefined for a reference no component has. */
export const componentTag = (
  site: Pick<SiteContext, "components">,
  ref: string,
): string | undefined => site.components.get(ref)?.tagName;

interface TagTable {
  parts: Map<string, string>;
  reusables: Map<number, string>;
}

const tagTables = new WeakMap<object, TagTable>();

/**
 * Parts and reusable blocks are allocated after the components, so a component keeps the plain
 * `<prefix>-<slug>` and a part or a block that would collide with it (or with each other) takes
 * `<prefix>-part-<slug>` / `<prefix>-block-<slug>` and then a number.
 */
function tagTable(site: SiteContext): TagTable {
  let table = tagTables.get(site);
  if (table) return table;
  const pre = tagPrefix(site.componentPrefix);
  const pool = new TagPool();
  for (const info of site.components.values()) pool.taken.add(info.tagName);
  const parts = new Map<string, string>();
  const reusables = new Map<number, string>();
  for (const post of site.model.posts.values()) {
    if (
      post.type === "wp_template_part" &&
      !parts.has(post.slug) &&
      templatePost(site.model, "wp_template_part", post.slug)?.id === post.id
    ) {
      const slug = tagSlug(post.slug) || `part-${post.id}`;
      parts.set(post.slug, pool.take([`${pre}-${slug}`, `${pre}-part-${slug}`]));
    }
  }
  for (const post of site.model.posts.values()) {
    if (post.type !== "wp_block") continue;
    // A reusable block's slug is its title's, and may be a bare number (fineline's) or empty.
    const slug = tagSlug(post.slug);
    const named = slug !== "" && !/^[0-9]/.test(slug);
    reusables.set(
      post.id,
      pool.take(
        named ? [`${pre}-${slug}`, `${pre}-block-${slug}`] : [`${pre}-block-${slug || post.id}`],
      ),
    );
  }
  table = { parts, reusables };
  tagTables.set(site, table);
  return table;
}

/** Every tag the emitters write for this site: its components, template parts and reusable blocks. */
export function siteTags(site: SiteContext): Set<string> {
  const table = tagTable(site);
  return new Set([
    ...[...site.components.values()].map((info) => info.tagName),
    ...table.parts.values(),
    ...table.reusables.values(),
  ]);
}

/** The tag of the component a template part becomes (`fp-header`). */
export function partTag(site: SiteContext, slug: string): string {
  const known = tagTable(site).parts.get(slug);
  if (known !== undefined) return known;
  // A part nobody published (a reference to a missing one): a name that cannot collide with a real one.
  return `${tagPrefix(site.componentPrefix)}-part-${tagSlug(slug) || "unnamed"}`;
}

/** The tag of the component a reusable block becomes (`fp-block-63`, or `fp-contributor-teaser`). */
export function reusableTag(site: SiteContext, id: number): string {
  return tagTable(site).reusables.get(id) ?? `${tagPrefix(site.componentPrefix)}-block-${id}`;
}

// ── Loading ──────────────────────────────────────────────────────────────────────────────────────

export interface LoadSiteOptions {
  /** `mysql://user:pass@host:port/db` or `sqlite:<file>`. */
  db: string;
  /** Table prefix, trailing underscore included; detected when absent. */
  prefix?: string;
  /** The live address, when it differs from the `siteurl` option (a staging copy): uploads are resolved against it as well. */
  siteUrl?: string;
  /** Cwicly's stylesheets: a local uploads folder (`wp-content/uploads/cwicly`, or a copy), the live site, or both (the folder first). */
  cssFrom: { dir?: string; url?: string; cacheDir?: string; absentTtlMs?: number };
  /** The plugin's files and the theme's `style.css`: a site checkout or WordPress root (a directory), or the live site's address (a URL). */
  pluginFrom?: string;
  /** Prefix of every tag the emitters write. Default: the site name's initials, else `wp`. */
  componentPrefix?: string;
  /** Post types to load. Default: {@link publishedPostTypes}. */
  postTypes?: string[];
  /** Rewrite rules of post types registered in code, which ACF knows nothing about (`RouteOptions.postTypes`). */
  routeTypes?: RouteOptions["postTypes"];
  report?: Report;
}

/**
 * Commerce and payment records: published rows that are orders, not content. WooCommerce's own
 * `shop_*` types are named; a custom type that merely starts with `shop_` (a store locator's
 * `shop_location`) is content.
 */
const COMMERCE_TYPES =
  /^(?:product(?:_variation)?|shop_(?:order|order_refund|order_placehold|coupon|webhook|subscription)|give_(?:payment|log|wp_log)|edd_[a-z_]+|wc_[a-z_]+)$/;

/** Types a model always needs when the database has them, even with no published row (ACF's definitions are published, but be explicit). */
const STRUCTURAL_TYPES = [
  "page",
  "post",
  "wp_template",
  "wp_template_part",
  "wp_block",
  "wp_navigation",
  "wp_global_styles",
  "custom_css",
  "cc_block",
  "acf-post-type",
  "acf-taxonomy",
  "acf-field-group",
  "acf-field",
];

/**
 * The post types worth loading: every type with a published or private row, less the bookkeeping
 * types WordPress and plugins keep and less commerce and payment records (a donation plugin's
 * `give_payment` was 3,780 of anabaptistperspectives' 7,152 posts), plus the structural ones.
 */
export async function publishedPostTypes(db: Pick<WpDb, "query" | "table">): Promise<string[]> {
  const rows = await db.query<{ post_type: string }>(
    `select distinct post_type from ${db.table("posts")} where post_status in ('publish', 'private') order by post_type`,
  );
  const found = rows.map((row) => String(row.post_type));
  const excluded = new Set(DEFAULT_EXCLUDED_POST_TYPES);
  const types = new Set([...found, ...STRUCTURAL_TYPES]);
  return [...types].filter((type) => !excluded.has(type) && !COMMERCE_TYPES.test(type)).sort();
}

/**
 * Say which post types the census left out, with their row counts (every status but the trash, the
 * empty auto-drafts and `inherit`, the status of attachments and revisions): a donation plugin's
 * `give_payment` is thousands of rows nobody migrates, and that is a decision the report must show,
 * as must a type that has only drafts. Reported `site.post-type-excluded` (info); pass `postTypes` to
 * convert one anyway.
 */
export async function reportExcludedTypes(
  db: Pick<WpDb, "query" | "table">,
  loaded: readonly string[],
  report: Report,
): Promise<void> {
  const rows = await db.query<{ post_type: string; n: number | string }>(
    `select post_type, count(*) as n from ${db.table("posts")} where post_status not in ('trash', 'auto-draft', 'inherit') group by post_type order by post_type`,
  );
  const wanted = new Set(loaded);
  for (const row of rows) {
    const type = String(row.post_type);
    if (wanted.has(type)) continue;
    const count = Number(row.n);
    const reason = DEFAULT_EXCLUDED_POST_TYPES.includes(type)
      ? "bookkeeping"
      : COMMERCE_TYPES.test(type)
        ? "commerce or payment records"
        : "no published or private row";
    report.add({
      severity: "info",
      code: "site.post-type-excluded",
      message: `The post type ${type} (${count} rows) is not converted: ${reason}. Pass it in postTypes to convert it.`,
      where: "site",
      data: { type, rows: count, reason },
    });
  }
}

/** A source that asks each in turn: the local copy first, the live site for what it lacks. */
function firstOf(
  ...sources: CssSource[]
): CssSource & { remembered(name: string): RememberedAbsence | undefined } {
  return {
    remembered: (name) => sources.map((source) => remembersOf(source)?.(name)).find(Boolean),
    async get(name) {
      for (const source of sources) {
        const text = await source.get(name);
        if (text !== null) return text;
      }
      return null;
    },
  };
}

/** What a source says about the names it answered from a remembered 404, when it keeps any. */
const remembersOf = (
  source: CssSource,
): ((name: string) => RememberedAbsence | undefined) | undefined =>
  (source as { remembered?: (name: string) => RememberedAbsence | undefined }).remembered?.bind(
    source,
  );

function cssSourceOf(from: LoadSiteOptions["cssFrom"]): CssSource {
  const sources: CssSource[] = [];
  if (from.dir !== undefined) sources.push(dirCssSource(from.dir));
  if (from.url !== undefined) {
    sources.push(
      urlCssSource(from.url, {
        ...(from.cacheDir === undefined ? {} : { cacheDir: from.cacheDir }),
        ...(from.absentTtlMs === undefined ? {} : { absentTtlMs: from.absentTtlMs }),
      }),
    );
  }
  if (sources.length === 0)
    throw new Error(
      "cssFrom needs a dir or a url: Cwicly's styles live in its generated stylesheets",
    );
  return sources.length === 1 ? sources[0]! : firstOf(...sources);
}

const isUrl = (text: string): boolean => /^https?:\/\//i.test(text);

/** The initials of a site name of several words, as text (`Anabaptist Perspectives` is `ap`; at most four), else `wp`. */
export function defaultPrefix(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((w) => /^[A-Za-z]/.test(w));
  return words.length >= 2
    ? tagPrefix(
        words
          .map((w) => w[0])
          .join("")
          .slice(0, 4),
      )
    : "wp";
}

/**
 * Open the site: read the model once, the Cwicly options, ACF, the media plan, the routes and the
 * URL tools over them. The database is closed before this resolves; nothing here writes anywhere.
 */
export async function loadSiteContext(opts: LoadSiteOptions): Promise<SiteContext> {
  const report = opts.report ?? createReport();
  const db = await openDb(opts.db, opts.prefix === undefined ? {} : { prefix: opts.prefix });
  let model: WpModel;
  let acf: AcfModel;
  let forms: Map<number, FluentForm> = new Map();
  try {
    const postTypes = opts.postTypes ?? (await publishedPostTypes(db));
    if (opts.postTypes === undefined) await reportExcludedTypes(db, postTypes, report);
    model = await loadModel(db, { postTypes, report });
    try {
      forms = await loadFluentForms(db);
    } catch (error) {
      report.add({
        severity: "warn",
        code: "form.load-failed",
        message: `The Fluent Forms tables could not be read (${error instanceof Error ? error.message : String(error)}); a page that embeds a form keeps a neutral stand-in.`,
        where: "site",
      });
    }
    // The people a post names in a user field and no profile has (a guest who never wrote anything).
    acf = loadAcf(model, report);
    await addReferencedUsers(db, model, referencedUsers(model, userFieldNames(acf)));
  } finally {
    await db.close();
  }

  const options = readCwiclyOptions(model.options, report);
  const media = planMedia(
    model,
    opts.siteUrl === undefined ? {} : { siteUrl: opts.siteUrl.replace(/\/+$/, "") },
  );
  const routes = buildRoutes(model, acf, {
    report,
    media,
    ...(opts.routeTypes === undefined ? {} : { postTypes: opts.routeTypes }),
  });
  const urls = createUrlTools(model, routes, media, { report });

  let pluginSource: PluginAssetSource | undefined;
  let theme: string | null = null;
  if (opts.pluginFrom !== undefined) {
    if (isUrl(opts.pluginFrom)) {
      pluginSource = await fetchPluginSource(opts.pluginFrom);
      theme = await fetchThemeCss(opts.pluginFrom);
    } else {
      pluginSource = dirPluginSource(opts.pluginFrom);
      theme = dirThemeCss(opts.pluginFrom);
      setUnregisteredBlockNamespaces(
        model,
        await findUnregisteredNamespaces(opts.pluginFrom, usedBlockNamespaces(model)),
      );
    }
    if (theme === null) {
      report.add({
        severity: "info",
        code: "site.theme-css-missing",
        message: `The theme's style.css (wp-content/themes/${model.site.theme}/style.css) was not found at ${opts.pluginFrom}; the theme's own body rule and comment-form rules are not shipped.`,
        where: "site",
        data: { from: opts.pluginFrom },
      });
    }
  }

  const componentPrefix = tagPrefix(
    opts.componentPrefix ?? defaultPrefix(decodeEntities(model.site.name)),
  );
  return {
    model,
    options,
    acf,
    media,
    routes,
    urls,
    cssSource: cssSourceOf(opts.cssFrom),
    ...(pluginSource === undefined ? {} : { pluginSource }),
    ...(forms.size === 0 ? {} : { forms }),
    report,
    componentPrefix,
    components: componentInfos(model, componentPrefix, report),
    theme,
  };
}

// ── The context of one subject ───────────────────────────────────────────────────────────────────

/** What a subject's kind implies for a conversion. {@link SubjectOptions} overrides each. */
export interface SubjectDefaults {
  mode: ConvertCtx["mode"];
  entryExpr: string;
  entryType?: string;
  termExpr?: string;
  target: "page" | "markdown";
}

export interface SubjectOptions {
  mode?: ConvertCtx["mode"];
  entryExpr?: string;
  entryType?: string;
  termExpr?: string;
  target?: "page" | "markdown";
}

/** Post types whose conversion is a JSON document; everything else that is a post is a Markdown entry. */
const DOCUMENT_TYPES = new Set(["page", "wp_template", "wp_template_part", "cc_block", "wp_block"]);

const longest = (candidates: Iterable<string>, text: (c: string) => boolean): string | undefined =>
  [...candidates].filter(text).sort((a, b) => b.length - a.length)[0];

/**
 * The template hierarchy's names, read as what they render: `single`, `single-<type>` and
 * `singular` are entries (`state.entry`, of the type the name gives); `taxonomy-<tax>`, `category`,
 * `tag` and `taxonomy` render a term (`state.term`); `archive-<type>` lists a type. Everything else
 * (`page`, `front-page`, `index`, `404`, a custom template) renders no entry the template can name,
 * and is converted as static. The templates emitter overrides any of it.
 */
function templateDefaults(
  site: Pick<SiteContext, "model">,
  slug: string,
): Omit<SubjectDefaults, "target" | "entryExpr"> {
  const types = new Set<string>();
  for (const post of site.model.posts.values()) types.add(post.type);
  if (slug === "single") return { mode: "entry", entryType: "post" };
  if (slug === "singular") return { mode: "entry" };
  if (
    slug === "category" ||
    slug === "tag" ||
    slug === "taxonomy" ||
    slug.startsWith("category-") ||
    slug.startsWith("tag-")
  ) {
    return { mode: "entry", termExpr: "state.term" };
  }
  const single = longest(types, (t) => slug === `single-${t}` || slug.startsWith(`single-${t}-`));
  if (slug.startsWith("single-")) {
    return single === undefined ? { mode: "entry" } : { mode: "entry", entryType: single };
  }
  if (slug.startsWith("taxonomy-")) {
    return { mode: "entry", termExpr: "state.term" };
  }
  const archive = longest(types, (t) => slug === `archive-${t}`);
  if (archive !== undefined) return { mode: "static", entryType: archive };
  return { mode: "static" };
}

export function subjectDefaults(
  site: Pick<SiteContext, "model">,
  subject: Subject,
): SubjectDefaults {
  const post = subjectPost(site, subject);
  const entryExpr = "state.entry";
  switch (subject.kind) {
    case "post":
      return {
        mode: "static",
        entryExpr,
        ...(post ? { entryType: post.type } : {}),
        target: post && !DOCUMENT_TYPES.has(post.type) ? "markdown" : "page",
      };
    case "reusable":
    case "part":
      return { mode: "static", entryExpr, target: "page" };
    case "component":
      return { mode: "component", entryExpr, target: "page" };
    case "template": {
      const { entryType, ...rest } = templateDefaults(site, subject.slug);
      return {
        ...rest,
        entryExpr,
        ...(entryType === undefined ? {} : { entryType }),
        target: "page",
      };
    }
  }
}

/**
 * The `@import` statements the subjects' stylesheets carry, per site. A style object cannot hold a
 * statement at-rule, so one hoisted onto a page would vanish from the build; Cwicly writes one per
 * block that picks a Google font (the header's `Reem Kufi`), and the project's head is where the
 * link belongs (`importedStyleRules`).
 */
const importsBySite = new WeakMap<object, Map<string, { key: string; style: JxStyle }>>();

const isImportStatement = (key: string, style: JxStyle): boolean =>
  /^@import\b/i.test(key.trim()) && Object.keys(style).length === 0;

function collectImports(site: object, rules: readonly { key: string; style: JxStyle }[]): void {
  let known = importsBySite.get(site);
  for (const rule of rules) {
    if (!isImportStatement(rule.key, rule.style)) continue;
    if (known === undefined) importsBySite.set(site, (known = new Map()));
    known.set(rule.key.trim(), { key: rule.key.trim(), style: {} });
  }
}

/** The `@import` statements the site's subjects met so far, in the order they were met (for `collectFontImports`). */
export function importedStyleRules(site: object): { key: string; style: JxStyle }[] {
  return [...(importsBySite.get(site)?.values() ?? [])];
}

/** One style rule that cannot live in an element's own `style`. */
export type HoistedRule = { selector: string; style: JxStyle };

/** The conversion context plus what a conversion collects while it runs. */
export interface SubjectSession {
  ctx: SubjectCtx;
  /** Rules `ctx.hoist` received, in order (duplicates not yet removed). */
  hoisted: HoistedRule[];
  /** Page-level state entries registered through `ctx.defineState`. */
  state: Map<string, unknown>;
  /** The stylesheets this subject's page loads. */
  cssNames: string[];
  /** Stylesheet names its blocks' attributes made unusable (see {@link CssPlan}); the conversion reports them. */
  cssInvalid: string[];
}

/** A `ConvertCtx` with the one facility the contract has no slot for: registering page-level state. */
export interface SubjectCtx extends ConvertCtx {
  /**
   * Register a page-level `state` entry (a `ContentCollection`, an `Array` source) and get the key it
   * was stored under: the same definition under the same key is one entry, a different one under a
   * taken key gets `<key>_2`. The emitter writes the entries into the page's `state`.
   */
  defineState(key: string, definition: unknown): string;
  /** The blocks become a component (a Cwicly component or a template part), not a page or a layout. */
  readonly inComponent?: boolean;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The session of one subject: its `ConvertCtx` and the collectors behind `hoist` and `defineState`.
 * `overrides` replace any field of the context (the reference and any value derived from it are
 * built first, so a given `report` receives the URL tools' findings too).
 */
export async function subjectSession(
  site: SiteContext,
  subject: Subject,
  overrides: Partial<ConvertCtx> = {},
): Promise<SubjectSession> {
  // The registry is built once; from here on a conversion is synchronous throughout.
  await ensureConverters();
  const post = subjectPost(site, subject);
  const defaults = subjectDefaults(site, subject);
  const id = subjectId(site, subject);
  const kind = ctxKind(subject);
  const report = overrides.report ?? createReport();
  const where = `${kind}:${id}`;
  const urls = site.urls.bind(report, where);
  const { names: cssNames, invalid: cssInvalid } = cssPlanFor(site, subject);
  const css = overrides.css ?? (await cssIndexFor(site, subject, cssNames));
  collectImports(site, css.atRules);

  const hoisted: HoistedRule[] = [];
  const state = new Map<string, unknown>();
  const mode = overrides.mode ?? defaults.mode;
  const entryType = overrides.entryType ?? defaults.entryType;
  const termExpr = overrides.termExpr ?? defaults.termExpr;
  const info = subject.kind === "component" ? site.components.get(subject.ref) : undefined;

  const ctx: SubjectCtx = {
    mode,
    model: site.model,
    cwicly: site.options,
    css,
    report,
    subject: { kind, id, ...(post ? { post } : {}) },
    entryExpr: overrides.entryExpr ?? defaults.entryExpr,
    ...(entryType === undefined ? {} : { entryType }),
    ...(termExpr === undefined ? {} : { termExpr }),
    target: overrides.target ?? defaults.target,
    urlForAuthor: (authorId) => urls.urlForAuthor(authorId),
    urlForArchive: (type) => urls.urlForArchive(type),
    hoist: (rule) => {
      if (isImportStatement(rule.selector, rule.style)) {
        collectImports(site, [{ key: rule.selector, style: rule.style }]);
        return;
      }
      hoisted.push(rule);
    },
    ...(info === undefined ? {} : { props: new Map(info.props.map((p) => [p.id, p.key])) }),
    components: site.components,
    urlFor: (what, objectId) => urls.urlFor(what, objectId),
    rewriteUrl: (url) => urls.rewriteUrl(url),
    acf: site.acf,
    mediaFor: (attachmentId) => site.media.mediaFor(attachmentId),
    mediaForUrl: (url) => site.media.mediaForUrl(url),
    convert: (blocks, more) => convertBlocks(blocks, more ? withOverrides(ctx, more) : ctx),
    inComponent: subject.kind === "component" || subject.kind === "part",
    defineState(key, definition) {
      let use = key;
      for (let n = 2; state.has(use) && !sameJson(state.get(use), definition); n++)
        use = `${key}_${n}`;
      state.set(use, definition);
      return use;
    },
    ...overrides,
  };
  return { ctx, hoisted, state, cssNames, cssInvalid };
}

/** The `ConvertCtx` of one subject, `convert` wired to the registry. */
export async function subjectCtx(
  site: SiteContext,
  subject: Subject,
  overrides: Partial<ConvertCtx> = {},
): Promise<SubjectCtx> {
  return (await subjectSession(site, subject, overrides)).ctx;
}
