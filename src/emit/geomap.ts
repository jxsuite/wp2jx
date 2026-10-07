/**
 * Interactive Geo Maps, drawn as the empty stage the plugin prints.
 *
 * `[display-map id=N]` prints a fixed container (`map_wrapper` > `map_box` > `map_aspect_ratio` >
 * `map_container` > `map_render`) and a script draws the map into it from amCharts' geodata, so a
 * static site cannot show the map. What it can keep is the stage: its box is as tall as the map's
 * `paddingTop` percentage of its width, and everything below it on the page sits under that height.
 * Leaving the shortcode's text there instead (the neutral element) puts a line of bracketed text in a
 * 36px box where the live page has a 765px one, and every block after it is displaced by the
 * difference.
 *
 * The markup is the plugin's own (`Map::render`), read from the map's `map_info` post meta (the
 * `visual` group: `paddingTop`, `maxWidth`, `paddingTopMobile`), and the plugin's public stylesheet,
 * shipped by the project assembler, gives it its size exactly as it does on the live site. The
 * plugin's script also switches the ratio at 780px and below when a mobile ratio is set: the stylesheet
 * says the same with a media query for the maps that set one.
 *
 * What is not carried, and said so in the report: the map itself, its regions' links and tooltips
 * (`map.not-interactive`), and a map the database does not hold (`map.missing`: the plugin prints
 * nothing for an id that is not a published `igmap`, and so does this).
 *
 * Report codes: `map.not-interactive` (warn, once per map and page), `map.missing` (warn),
 * `map.css-missing` (warn).
 */
import { escapeTemplate } from "../jx-util.ts";
import type { Placeholder } from "../placeholders.ts";
import type { JxElement, WpModel } from "../types.ts";
import { readPluginFile, type SayForm } from "./fluentform.ts";

/** The shortcode names the plugin registers for a map. */
const SHORTCODES = new Set(["display-map", "display-igmap"]);

/** The plugin's public stylesheet, relative to the site root. */
const PLUGIN_CSS = "wp-content/plugins/interactive-geo-maps/assets/public/css/styles.min.css";

export const GEO_MAP_CSS_PATH = "public/css/geo-map.css";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** What the plugin reads of a map to print its stage. */
export interface GeoMap {
  id: number;
  title: string;
  /** The stage's height as a percentage of its width, as the plugin prints it (`56`, `56.25`). */
  height: string;
  /** The stage's `max-width` in px. */
  maxWidth: string;
  /** `data-padding-top-mobile` as the plugin prints it: `floatval()` of the setting when the map has one (`0%` for an empty one), "" for a map without. */
  heightMobile: string;
  /** The ratio the plugin's script applies at 780px and below: only a map that actually sets one has it. */
  mobileRatio: string | undefined;
}

/** `floatval()` of a stored setting, printed the way PHP prints a float (`56.0` is `56`). */
function floatText(value: unknown): string | undefined {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? String(n) : undefined;
}

/** The map `id` of the site, or undefined when it is not a published `igmap`. */
export function geoMapOf(
  model: Pick<WpModel, "posts" | "postMeta">,
  id: number,
): GeoMap | undefined {
  const post = model.posts.get(id);
  if (post === undefined || post.type !== "igmap" || post.status !== "publish") return undefined;
  const info = model.postMeta.get(id)?.map_info?.[0];
  const visual = isRecord(info) && isRecord(info.visual) ? info.visual : {};
  // Map.php: a missing paddingTop is 56.25, and a max width that is empty or 0 is 2200.
  const height = visual.paddingTop === undefined ? "56.25" : (floatText(visual.paddingTop) ?? "0");
  const width = floatText(visual.maxWidth);
  // Map.php: `floatval("")` is 0, so a map that stores an empty mobile ratio prints `0%`; the script's
  // `String("") + "%"` is no length, and the browser keeps the inline ratio.
  const stored = visual.paddingTopMobile;
  const raw = stored === undefined ? undefined : (floatText(stored) ?? "0");
  const mobile = floatText(stored);
  return {
    id,
    title: post.title,
    height,
    maxWidth: width === undefined || width === "0" ? "2200" : width,
    heightMobile: raw === undefined ? "" : `${raw}%`,
    mobileRatio: mobile,
  };
}

/** The maps each site's pages drew so far, in the order first drawn: the project assembler ships their stylesheet. */
const usedBySite = new WeakMap<object, Map<number, GeoMap>>();

export const usedGeoMaps = (site: object): GeoMap[] => [...(usedBySite.get(site)?.values() ?? [])];

/** The map a `display-map` shortcode names, when the placeholder is one. */
function mapIdOf(placeholder: Placeholder): number | undefined {
  if (placeholder.kind !== "shortcode") return undefined;
  if (!SHORTCODES.has(placeholder.attrs["data-shortcode"] ?? "")) return undefined;
  const raw = placeholder.attrs["data-attributes"];
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    // The plugin lower-cases the attribute names (`ID="3"` is `id`).
    const key = isRecord(parsed)
      ? Object.keys(parsed).find((name) => name.toLowerCase() === "id")
      : undefined;
    const id =
      key === undefined ? Number.NaN : Math.trunc(Number((parsed as Record<string, unknown>)[key]));
    return Number.isInteger(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Map.php's template, tabs removed. */
export function geoMapMarkup(map: GeoMap): string {
  return (
    `<div class="map_wrapper" id="map_wrapper_${map.id}">` +
    `<div class="map_box" style="max-width:${map.maxWidth}px">` +
    `<div class="map_aspect_ratio" style="padding-top:${map.height}%" data-padding-top="${map.height}%" data-padding-top-mobile="${map.heightMobile}">` +
    `<div class="map_container"><div class="map_render map_loading" id="map_${map.id}"></div></div>` +
    `</div></div></div>`
  );
}

/**
 * The element for a placeholder that stands for an Interactive Geo Maps map, or undefined when it is
 * not one (the caller's neutral stand-in then holds its place). A map the database does not hold
 * draws nothing, as the plugin does, and says so.
 */
export function geoMapFor(
  site: { model?: Pick<WpModel, "posts" | "postMeta"> },
  placeholder: Placeholder,
  say: SayForm,
): JxElement | null | undefined {
  const id = mapIdOf(placeholder);
  if (id === undefined) return undefined;
  const map = site.model === undefined ? undefined : geoMapOf(site.model, id);
  if (map === undefined) {
    say({
      severity: "warn",
      code: "map.missing",
      message: `The map ${id} is not a published Interactive Geo Maps map in the database, so the shortcode printed nothing on the live pages and nothing is drawn for it.`,
      data: { map: id },
    });
    return null;
  }
  const used = usedBySite.get(site) ?? new Map<number, GeoMap>();
  used.set(id, map);
  usedBySite.set(site, used);
  say({
    severity: "warn",
    code: "map.not-interactive",
    message: `The map "${map.title}" is drawn as the empty stage the plugin prints, with its size: the plugin's script draws the map (its regions, their links and tooltips) from amCharts' geodata, and is not carried over.`,
    data: { map: id, title: map.title },
  });
  return {
    tagName: "div",
    attributes: { "data-wp2jx": `geomap:${id}` },
    innerHTML: escapeTemplate(geoMapMarkup(map)),
  };
}

/**
 * The stylesheet for the maps the pages draw: the plugin's own, read from the site checkout or the
 * live site `from`, and the mobile ratio of each map that sets one. Undefined when no map is drawn;
 * a plugin file that cannot be read is reported and the stage is left to the page's own styles (an
 * unstyled stage is 0px high).
 */
export async function geoMapStylesheet(
  maps: readonly GeoMap[],
  from: string | undefined,
  report: {
    add(entry: {
      severity: "warn";
      code: string;
      message: string;
      where: string;
      data?: Record<string, unknown>;
    }): void;
  },
): Promise<{ path: string; content: string } | undefined> {
  if (maps.length === 0) return undefined;
  const css = from === undefined ? null : await readPluginFile(from, PLUGIN_CSS);
  const parts: string[] = [];
  if (css === null) {
    report.add({
      severity: "warn",
      code: "map.css-missing",
      message: `The plugin stylesheet ${PLUGIN_CSS} was not found${from === undefined ? " (no plugin source was given)" : ` at ${from}`}, so the drawn map stage has none of the plugin's styles.`,
      where: "plugin:interactive-geo-maps",
      data: { file: PLUGIN_CSS },
    });
    // Without the plugin's rules the stage is a box of no height: its ratio is all that is left to say.
    parts.push(
      `/* wp2jx: the plugin stylesheet was not found; the stage's own size */\n.map_wrapper .map_aspect_ratio{max-width:100%;width:100%;position:relative;height:0}\n.map_wrapper .map_container{position:absolute;top:0;left:0;bottom:0;right:0}\n.map_box{max-width:100%;margin:0 auto}`,
    );
  } else {
    parts.push(`/* ${PLUGIN_CSS} */\n${css.trim()}`);
  }
  for (const map of maps) {
    if (map.mobileRatio === undefined) continue;
    // The script sets the ratio at 780px and below when the map has a mobile one (an inline style, so !important).
    parts.push(
      `/* wp2jx: the mobile ratio of map ${map.id}, which the plugin's script applies */\n@media (max-width:780px){#map_wrapper_${map.id} .map_aspect_ratio{padding-top:${map.mobileRatio}% !important}}`,
    );
  }
  return { path: GEO_MAP_CSS_PATH, content: `${parts.join("\n\n")}\n` };
}
