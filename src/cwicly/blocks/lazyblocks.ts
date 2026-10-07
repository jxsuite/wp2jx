/**
 * `lazyblock/<slug>` blocks whose template is a recognised recipe (`wp/lazyblocks.ts`): an embedded
 * player. The block prints the markup its template echoes, with the template's own holes filled from
 * the page (a static conversion) or from the entry (an entry template, as bindings).
 *
 * The wrapper is the one the plugin prints (`wp-block-lazyblock-<slug>`). Each echoed element is hidden
 * when the entry has nothing to show (no episode, no video address, a gated post), by the same rule a
 * hidden block uses, so the element is in the page and takes no room. Anything the recipe cannot fill
 * (a variable it does not know, a Markdown entry, no entry data to read) leaves the block to the
 * generic path, a placeholder and `block.unsupported`.
 *
 * Report codes: `lazyblock.recipe` (info, once per block name: which recipe the PHP was taken for).
 */
import { htmlToNodes } from "../../html.ts";
import { targetOf } from "../../core/static.ts";
import type { ConvertCtx, JxElement, JxNode, WpBlock } from "../../types.ts";
import { entryKey } from "../../wp/acf.ts";
import {
  gatedPost,
  recipeData,
  recipeFor,
  YOUTUBE_ID,
  youtubeId,
  type Recipe,
} from "../../wp/lazyblocks.ts";
import { HIDDEN_STYLE } from "../conditions.ts";
import { entryDataExpr, optPath, propPath, subjectPost } from "../tokens.ts";
import { say } from "./common.ts";

const HOLE = /\{\$(\w+)\}/g;
const OPEN = "";
const CLOSE = "";
const SENTINEL = new RegExp(`${OPEN}(\\w+)${CLOSE}`, "g");
const SENTINEL_TEST = new RegExp(`${OPEN}\\w+${CLOSE}`);

/** The variables each recipe's template can print, and what each is. */
type Variable = "episodeId" | "downloadUrl" | "youtubeId";
const VARIABLES: Readonly<Record<Recipe["kind"], Readonly<Record<string, Variable>>>> = {
  "captivate-player": { cfm_episode_id: "episodeId", cfm_download_url: "downloadUrl" },
  "youtube-field": { youtube_id: "youtubeId" },
};

/** What a variable is for this entry: a text known now, or an expression the build evaluates. */
type Value = { lit: string } | { expr: string };

function valuesFor(recipe: Recipe, ctx: ConvertCtx): Record<Variable, Value> | string {
  const post = subjectPost(ctx);
  const model = ctx.model;
  if (post) {
    const gated = recipe.gated && gatedPost(model, post);
    const data = gated ? {} : recipeData(model, post);
    const captivate = data.captivate as { episodeId?: string; downloadUrl?: string } | undefined;
    const raw = model.postMeta.get(post.id)?.[recipe.field]?.[0];
    return {
      episodeId: { lit: captivate?.episodeId ?? "" },
      downloadUrl: { lit: captivate?.downloadUrl ?? "" },
      youtubeId: { lit: gated ? "" : youtubeId(raw) },
    };
  }
  if (ctx.mode !== "entry") return "there is no entry to read the player's data from";
  const data = entryDataExpr(ctx);
  const gate = recipe.gated
    ? `(${propPath(data, "premium")} && ${propPath(data, "premium")} !== '0') ? '' : `
    : "";
  const address = propPath(data, entryKey(recipe.field));
  return {
    episodeId: { expr: `${optPath(propPath(data, "captivate"), "episodeId")} ?? ''` },
    downloadUrl: { expr: `${optPath(propPath(data, "captivate"), "downloadUrl")} ?? ''` },
    youtubeId: {
      expr: `${gate}((u) => (${YOUTUBE_ID.toString()}.exec(String((u && typeof u === 'object' ? u.url : u) ?? '')) ?? [])[1] ?? '')(${address})`,
    },
  };
}

/**
 * The sentinel holes of a string with the values put in. Text known now is written into it. Otherwise it
 * is a binding that concatenates the literal parts and the expressions, and (for an attribute) is `false`
 * when the player has nothing to show, so the attribute is left out: an iframe that is only hidden still
 * loads its address.
 */
function filled(
  text: string,
  values: Record<string, Value>,
  present: string | undefined,
): string | false {
  if (!SENTINEL_TEST.test(text)) return text;
  const parts = text.split(SENTINEL);
  const dynamic = [...text.matchAll(SENTINEL)].some(
    (m) => "expr" in (values[m[1]!] ?? { lit: "" }),
  );
  if (!dynamic)
    return text.replaceAll(
      SENTINEL,
      (_, name: string) => (values[name] as { lit: string } | undefined)?.lit ?? "",
    );
  const joined = parts
    .map((part, index) => {
      if (index % 2 === 0) return JSON.stringify(part);
      const value = values[part];
      return value === undefined
        ? '""'
        : "lit" in value
          ? JSON.stringify(value.lit)
          : `(${value.expr})`;
    })
    .join(" + ");
  return present === undefined ? `\${${joined}}` : `\${(${present}) ? ${joined} : false}`;
}

function fillNodes(
  nodes: JxNode[],
  values: Record<string, Value>,
  present: string | undefined,
): void {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (typeof node.textContent === "string") {
      node.textContent = filled(node.textContent, values, undefined) || "";
    }
    const attributes = node.attributes;
    if (attributes !== undefined) {
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== "string") continue;
        const made = filled(value, values, present);
        if (made === false) delete attributes[key];
        else attributes[key] = made;
      }
    }
    if (Array.isArray(node.children)) {
      node.children = node.children.map((child) =>
        typeof child === "string" ? filled(child, values, undefined) || "" : child,
      );
      fillNodes(node.children, values, present);
    }
  }
}

export function lazyBlock(block: WpBlock, ctx: ConvertCtx): JxNode[] | undefined {
  const name = block.name ?? "";
  if (!name.startsWith("lazyblock/")) return undefined;
  const slug = name.slice("lazyblock/".length);
  const recipe = recipeFor(ctx.model, slug);
  if (recipe === undefined || targetOf(ctx) === "markdown") return undefined;
  const found = valuesFor(recipe, ctx);
  if (typeof found === "string") return undefined;
  const known = VARIABLES[recipe.kind];
  const values: Record<string, Value> = {};
  const used = new Set<string>();
  const html = recipe.html.map((piece) =>
    piece.replaceAll(HOLE, (_, variable: string) => {
      const kind = known[variable];
      if (kind === undefined) {
        used.add(`?${variable}`);
        return "";
      }
      used.add(kind);
      values[kind] = found[kind];
      return `${OPEN}${kind}${CLOSE}`;
    }),
  );
  if ([...used].some((u) => u.startsWith("?"))) return undefined;
  const children: JxNode[] = [];
  const present = presence(recipe, found);
  for (const piece of html) {
    const nodes = htmlToNodes(piece, { inlineStyle: "attribute" });
    fillNodes(nodes, values, present !== undefined && "expr" in present ? present.expr : undefined);
    for (const node of nodes) {
      if (typeof node !== "string" && present !== undefined && "expr" in present) {
        node.attributes = { ...node.attributes, hidden: `\${!(${present.expr})}` };
        node.style = { ...node.style, ...HIDDEN_STYLE };
      }
      children.push(node);
    }
  }
  say(
    ctx,
    block,
    "lazyblock.recipe",
    "info",
    `The PHP template of ${name} is a ${recipe.kind === "captivate-player" ? "Captivate player" : "YouTube embed"} for the field "${recipe.field}"${recipe.gated ? " (gated for visitors without the premium capability: a gated entry has none)" : ""}: its markup is written with the entry's own data.`,
    { detail: recipe.kind, recipe: recipe.kind, field: recipe.field },
  );
  const wrapper: JxElement = {
    tagName: "div",
    className: `lazyblock-${slug} wp-block-lazyblock-${slug}`,
    ...(present !== undefined && "lit" in present && present.lit === "" ? {} : { children }),
  };
  return [wrapper];
}

/** What decides whether the player shows: the value the recipe cannot do without. */
function presence(recipe: Recipe, values: Record<Variable, Value>): Value | undefined {
  return recipe.kind === "captivate-player" ? values.episodeId : values.youtubeId;
}
