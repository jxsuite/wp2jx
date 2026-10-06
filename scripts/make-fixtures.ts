#!/usr/bin/env bun
/**
 * Cut a hermetic fixture set for one site out of a live WordPress database and its public site.
 *
 *   bun scripts/make-fixtures.ts --db mysql://root@127.0.0.1:3399/s212682_fineline \
 *     --url https://finelinepainting.pro --out tests/fixtures/fineline
 *
 * Writes `rows/<table>.json` (real rows, WordPress table names with the prefix stripped, secrets
 * blanked), `css/<name>.css` (every Cwicly stylesheet the public pages reference) and
 * `html/<slug>.html` (a few rendered pages, the ground truth the converter is judged against).
 * Tests rebuild an in-memory SQLite database from `rows/` (see tests/helpers/fixture-db.ts), so no
 * test needs a MariaDB server.
 */
import { SQL } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    url: { type: "string" },
    out: { type: "string" },
    prefix: { type: "string" },
    "html-pages": { type: "string", default: "6" },
    /** Read Cwicly CSS from a local uploads dir instead of the live site (sitemap and HTML still come live). */
    uploads: { type: "string" },
    /** Keep at most this many posts per non-structural post type (newest first). */
    "max-per-type": { type: "string", default: "100" },
    /** Extra post types to leave out, comma separated. */
    "skip-types": { type: "string", default: "" },
  },
});
if (!values.db || !values.url || !values.out) {
  console.error(
    "usage: make-fixtures --db <mysql-url> --url <site-url> --out <dir> [--prefix wp_]",
  );
  process.exit(2);
}
const out = values.out;
const site = values.url.replace(/\/$/, "");
const sql = new SQL(values.db);

async function q(query: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return [...(await sql.unsafe(query, params))];
}

// Prefix detection: the table that ends in `_options` and has an `option_name` column.
let prefix = values.prefix;
if (!prefix) {
  const tables = await q("show tables");
  const t = tables.map((r) => Object.values(r)[0] as string).find((n) => n.endsWith("_options"));
  if (!t) throw new Error("cannot detect table prefix");
  prefix = t.slice(0, -"options".length);
}
const P = prefix;
console.log(`prefix ${P}`);

// Types whose every row is kept: they carry structure (templates, components, ACF definitions,
// menus, media) rather than content, and the converter reads all of them.
const STRUCTURAL_TYPES = [
  "page",
  "wp_template",
  "wp_template_part",
  "cc_block",
  "wp_block",
  "wp_navigation",
  "nav_menu_item",
  "attachment",
  "acf-field-group",
  "acf-field",
  "acf-post-type",
  "acf-taxonomy",
  "acf-ui-options-page",
  "wp_global_styles",
  "custom_css",
];
// Never fixtured: bookkeeping, commerce records and anything personal.
const SKIP_TYPES = new Set([
  "revision",
  "customize_changeset",
  "oembed_cache",
  "scheduled-action",
  "user_request",
  "give_payment",
  "give_log",
  "shop_order",
  "shop_order_refund",
  "shop_coupon",
  "shop_subscription",
  "product_variation",
  "gift_card",
  "wishlist",
  "fluentform",
  "fc_campaign",
  "automatewoo",
  "wp_font_face",
  "wp_font_family",
  ...String(values["skip-types"] ?? "")
    .split(",")
    .filter(Boolean),
]);
const MAX_PER_TYPE = Number(values["max-per-type"]);

const OPTION_EXACT = [
  "siteurl",
  "home",
  "blogname",
  "blogdescription",
  "permalink_structure",
  "show_on_front",
  "page_on_front",
  "page_for_posts",
  "active_plugins",
  "template",
  "stylesheet",
  "WPLANG",
  "timezone_string",
  "gmt_offset",
  "category_base",
  "tag_base",
  "default_category",
  "posts_per_page",
  "date_format",
  "time_format",
  "uploads_use_yearmonth_folders",
  "upload_path",
  "upload_url_path",
  "rewrite_rules",
  "sticky_posts",
  "nav_menu_options",
  "theme_mods_cwicly",
  "fresh_site",
  "wp_page_for_privacy_policy",
];
const OPTION_LIKE = ["cwicly%", "rank-math%", "rank_math%", "acf_%", "wpcodebox%"];
const OPTION_SKIP = /(transient|license|salt|heartbeat|rest_transients)/;

const typeRows = await q(
  `select post_type, count(*) c from ${P}posts where post_status not in ('auto-draft','trash') group by post_type`,
);
const present = typeRows.map((r) => r.post_type as string).filter((t) => !SKIP_TYPES.has(t));
const posts: Record<string, unknown>[] = [];
for (const type of present) {
  const rows = await q(
    `select * from ${P}posts where post_type = ? and post_status not in ('auto-draft','trash') order by ID desc`,
    [type],
  );
  const keep = STRUCTURAL_TYPES.includes(type) ? rows : rows.slice(0, MAX_PER_TYPE);
  if (keep.length < rows.length) console.log(`  ${type}: kept ${keep.length}/${rows.length}`);
  posts.push(...keep);
}
posts.sort((x, y) => (x.ID as number) - (y.ID as number));
const ids = posts.map((p) => p.ID as number);
console.log(`posts ${posts.length}`);

function inList(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}
async function chunked(
  table: string,
  col: string,
  idList: number[],
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < idList.length; i += 500) {
    const part = idList.slice(i, i + 500);
    rows.push(
      ...(await q(`select * from ${P}${table} where ${col} in (${inList(part.length)})`, part)),
    );
  }
  return rows;
}

const META_SKIP = new Set([
  "_edit_lock",
  "_edit_last",
  "_pingme",
  "_encloseme",
  "_wp_old_slug",
  "_wp_old_date",
]);
const postmeta = (await chunked("postmeta", "post_id", ids)).filter(
  (m) => !META_SKIP.has(m.meta_key as string),
);
const rel = await chunked("term_relationships", "object_id", ids);
const taxIds = [...new Set(rel.map((r) => r.term_taxonomy_id as number))];
const allTaxRows = await q(`select * from ${P}term_taxonomy`);
const termTax = allTaxRows;
const termIds = [...new Set(termTax.map((t) => t.term_id as number))];
const terms = await chunked("terms", "term_id", termIds);
const termmeta = await chunked("termmeta", "term_id", termIds);
const authorIds = [...new Set(posts.map((p) => p.post_author as number))];
const users = (await chunked("users", "ID", authorIds)).map((u) => ({
  ...u,
  user_pass: "",
  user_email: "",
  user_activation_key: "",
}));
const optionRows = (
  await q(`select option_id, option_name, option_value, autoload from ${P}options`)
).filter((o) => {
  const n = o.option_name as string;
  if (OPTION_SKIP.test(n)) return false;
  return OPTION_EXACT.includes(n) || OPTION_LIKE.some((l) => n.startsWith(l.replace("%", "")));
});
let redirections: Record<string, unknown>[] = [];
try {
  redirections = await q(`select * from ${P}rank_math_redirections`);
} catch {
  // Rank Math not installed
}
console.log(
  `postmeta ${postmeta.length} terms ${terms.length} options ${optionRows.length} redirections ${redirections.length}`,
);

const rowsDir = join(out, "rows");
mkdirSync(rowsDir, { recursive: true });
const dump = (name: string, rows: unknown) =>
  writeFileSync(
    join(rowsDir, `${name}.json`),
    JSON.stringify(rows, (_k, v) => (v instanceof Date ? v.toISOString() : v), 1),
  );
dump("posts", posts);
dump("postmeta", postmeta);
dump("term_relationships", rel);
dump("term_taxonomy", termTax);
dump("terms", terms);
dump("termmeta", termmeta);
dump("users", users);
dump("options", optionRows);
dump("rank_math_redirections", redirections);
writeFileSync(
  join(out, "meta.json"),
  JSON.stringify({ prefix: P, siteUrl: site, taxIds }, null, 1),
);
await sql.close();

// ── Public site: stylesheets and rendered pages ────────────────────────────────────────────────
async function get(path: string): Promise<string | null> {
  const res = await fetch(path.startsWith("http") ? path : `${site}${path}`, {
    redirect: "follow",
  });
  return res.ok ? await res.text() : null;
}
const sitemapIndex = (await get("/sitemap_index.xml")) ?? (await get("/wp-sitemap.xml")) ?? "";
const sitemapUrls = [...sitemapIndex.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
const pageUrls: string[] = [];
for (const s of sitemapUrls) {
  const xml = await get(s);
  if (!xml) continue;
  if (/<sitemapindex/.test(xml)) {
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) sitemapUrls.push(m[1]!);
  } else {
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) pageUrls.push(m[1]!);
  }
}
const uniquePages = [...new Set(pageUrls.filter((u) => !/\.(jpe?g|png|webp|gif|svg)$/i.test(u)))];
writeFileSync(join(out, "urls.json"), JSON.stringify(uniquePages, null, 1));
console.log(`sitemap: ${uniquePages.length} page urls`);

const cssDir = join(out, "css");
mkdirSync(cssDir, { recursive: true });
const cssNames = new Set<string>([
  "cc-global-classes.css",
  "cc-global-stylesheets.css",
  "cc-main.css",
]);
const htmlDir = join(out, "html");
mkdirSync(htmlDir, { recursive: true });
const keepHtml = Number(values["html-pages"]);
let kept = 0;
// Pages are fetched in small batches; this is a one-off fixture build, not a crawler.
for (let i = 0; i < uniquePages.length; i += 8) {
  const batch = uniquePages.slice(i, i + 8);
  const htmls = await Promise.all(batch.map((u) => get(u).catch(() => null)));
  htmls.forEach((html, j) => {
    if (!html) return;
    for (const m of html.matchAll(/cwicly\/((?:css\/)?cc-[^"'?]+\.css)/g)) cssNames.add(m[1]!);
    const url = batch[j]!;
    const slug = new URL(url).pathname.replace(/^\/|\/$/g, "").replace(/\//g, "__") || "home";
    if (kept < keepHtml && (j === 0 || /^(home|about|services|residential|projects)/.test(slug))) {
      writeFileSync(join(htmlDir, `${slug}.html`), html);
      kept++;
    }
  });
}
let nCss = 0;
for (const name of cssNames) {
  const rel = name.startsWith("css/") ? name : name;
  let css: string | null;
  if (values.uploads) {
    const f = Bun.file(join(values.uploads, "cwicly", rel));
    css = (await f.exists()) ? await f.text() : null;
  } else {
    css = await get(`/wp-content/uploads/cwicly/${rel}`);
  }
  if (css === null) continue;
  const file = join(cssDir, rel.replace(/^css\//, ""));
  writeFileSync(file, css);
  nCss++;
}
console.log(`css ${nCss}/${cssNames.size}, html ${kept}`);
