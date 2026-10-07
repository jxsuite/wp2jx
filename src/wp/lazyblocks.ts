/**
 * Lazy Blocks: blocks whose output is a PHP template the site's own author wrote.
 *
 * A block `lazyblock/<slug>` has no saved markup (WordPress runs the template for each request), and the
 * template is stored as a post of the plugin's type `lazyblocks` (`lazyblocks_code_frontend_html` is the
 * PHP, `lazyblocks_slug` the name). PHP cannot run on a static site, so a template is carried over only
 * where it is a recognised shape, a **recipe**: the two the sites seen so far write for an embedded
 * player, each a few lines that read an ACF field of the current post and print an `<iframe>` (and a
 * link) around the value:
 *
 * - **youtube-field**: the post's ACF field holds a YouTube address, and the template prints the privacy
 *   (`youtube-nocookie.com`) embed of the video it names;
 * - **captivate-player**: the post's ACF field holds a podcast episode post, whose meta has the Captivate
 *   episode's id and the audio file's address, and the template prints Captivate's player and a download
 *   link.
 *
 * Either may be gated by `get_field('premium')` with `current_user_can('read_premium_content')`: the
 * block then prints nothing for a visitor who cannot, and a static site has only visitors who cannot, so
 * a gated entry has no embed and its data carries nothing of the media. The HTML the template echoes is
 * kept as it is written (the iframe's style and attributes); only its `{$variable}` holes are filled.
 */
import type { WpModel, WpPost } from "../types.ts";

export interface LazyBlockDef {
  slug: string;
  title: string;
  /** The PHP of the front-end template. */
  code: string;
  postId: number;
}

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const textOf = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";

const cache = new WeakMap<object, ReadonlyMap<string, LazyBlockDef>>();

/** The block definitions of a site by slug (the part of the block's name after `lazyblock/`). */
export function lazyBlockDefs(model: WpModel): ReadonlyMap<string, LazyBlockDef> {
  const hit = cache.get(model);
  if (hit) return hit;
  const out = new Map<string, LazyBlockDef>();
  for (const post of model.posts.values()) {
    if (post.type !== "lazyblocks" || post.status !== "publish") continue;
    const meta = model.postMeta.get(post.id) ?? {};
    const slug = textOf(first(meta.lazyblocks_slug)) || "no-slug";
    const code = textOf(first(meta.lazyblocks_code_frontend_html));
    if (!out.has(slug)) out.set(slug, { slug, title: post.title, code, postId: post.id });
  }
  cache.set(model, out);
  return out;
}

/** A recognised template. `html` is what it echoes, one string per `echo`, with its `{$variable}` holes. */
export interface Recipe {
  kind: "youtube-field" | "captivate-player";
  /** The ACF field of the current post the template reads. */
  field: string;
  /** Whether the template is gated by the `premium` field. */
  gated: boolean;
  /** The markup the template echoes, in order. */
  html: string[];
  /** The post meta keys of the episode post (`captivate-player`): its Captivate id and audio address. */
  meta?: { id: string; media: string };
}

/** The PHP double-quoted strings an `echo` prints, unescaped (`\"` is `"`); the `{$name}` holes stay. */
function echoed(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\becho\s+"((?:[^"\\]|\\.)*)"\s*;/g)) {
    out.push(m[1]!.replaceAll(/\\(["\\$])/g, "$1"));
  }
  return out;
}

const FIELD = /get_field\(\s*['"]([\w-]+)['"]/g;

/** The recipe a template is, or undefined for a template that is arbitrary PHP. */
export function recipeOf(def: LazyBlockDef): Recipe | undefined {
  const { code } = def;
  const html = echoed(code);
  if (html.length === 0 || !html.some((h) => /<iframe\b/i.test(h))) return undefined;
  const gated =
    /get_field\(\s*['"]premium['"]/.test(code) &&
    /current_user_can\(\s*['"]read_premium_content['"]/.test(code);
  const fields = [...code.matchAll(FIELD)].map((m) => m[1]!).filter((f) => f !== "premium");
  const field = fields[0];
  if (field === undefined) return undefined;
  if (/player\.captivate\.fm\/episode\/\{\$\w+\}/.test(code)) {
    const id = /get_post_meta\([^,]+,\s*['"](cfm_episode_id)['"]/.exec(code)?.[1];
    const media = /get_post_meta\([^,]+,\s*['"](cfm_episode_media_url)['"]/.exec(code)?.[1];
    if (id === undefined || media === undefined) return undefined;
    return { kind: "captivate-player", field, gated, html, meta: { id, media } };
  }
  if (
    /youtube(?:-nocookie)?\.com\/embed\/\{\$\w+\}/.test(code) &&
    /preg_match\([^;]*youtu/.test(code)
  ) {
    return { kind: "youtube-field", field, gated, html };
  }
  return undefined;
}

/** The recipe of the block `lazyblock/<slug>`, when the site defines it and it is one. */
export function recipeFor(model: WpModel, slug: string): Recipe | undefined {
  const def = lazyBlockDefs(model).get(slug);
  return def === undefined ? undefined : recipeOf(def);
}

/** A YouTube video's id from an address, as the PHP of the recipe reads it. */
export const YOUTUBE_ID =
  /(?:youtu\.be\/|youtube\.com\/(?:(?:watch)?\?(?:.*&)?v(?:i)?=|(?:embed|v|vi|user|shorts)\/))([^?&"'>]+)/;

/** The address a field holds: text, or the `url` of a link field (`{title, url, target}`, which ACF's own `get_field` returns as an array). */
export function addressOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const url = (value as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  return "";
}

export function youtubeId(address: unknown): string {
  return YOUTUBE_ID.exec(addressOf(address))?.[1] ?? "";
}

const truthy = (v: unknown): boolean => {
  const x = first(v);
  return x !== undefined && x !== null && x !== "" && x !== "0" && x !== 0 && x !== false;
};

/**
 * What the recipes need of a post, as entry data: `captivate: {episodeId, downloadUrl}` for a post whose
 * field holds a podcast episode post with a Captivate id. Nothing for a gated post, and nothing for a
 * site with no such recipe. (The YouTube address is the ACF field's own value, already in the entry.)
 */
export function recipeData(model: WpModel, post: WpPost): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const meta = model.postMeta.get(post.id) ?? {};
  for (const def of lazyBlockDefs(model).values()) {
    const recipe = recipeOf(def);
    if (recipe?.kind !== "captivate-player" || recipe.meta === undefined) continue;
    if (recipe.gated && truthy(meta.premium)) continue;
    const linked = Number(textOf(first(meta[recipe.field])));
    const episode = model.postMeta.get(linked);
    const episodeId = textOf(first(episode?.[recipe.meta.id]));
    if (episodeId === "") continue;
    const media = textOf(first(episode?.[recipe.meta.media]));
    out.captivate = {
      episodeId,
      ...(media === "" ? {} : { downloadUrl: `${media}?download=1` }),
    };
  }
  return out;
}

/** Whether the post's own gate keeps its embeds from a visitor. */
export function gatedPost(model: WpModel, post: WpPost): boolean {
  return truthy(model.postMeta.get(post.id)?.premium);
}
