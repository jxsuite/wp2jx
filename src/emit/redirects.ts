/**
 * Redirects: the `project.json` `redirects` map of the migrated site. Two things feed it, and the
 * first one wins where they disagree:
 *
 * 1. The Rank Math redirections of the source site. Rank Math answers them before WordPress looks
 *    at the address, so a rule outranks a page of the same address there. Each rule keeps its
 *    status where Jx has one (301, 302, 303, 307, 308: `410` and `451` have none, and are reported),
 *    its destination goes through `rewriteUrl` (a destination on the old site is a Jx route, an
 *    external one is left alone), and its source is rewritten into Jx's pattern syntax.
 * 2. The routes whose address changed (`Route.jxRoute` differs from `Route.wpPath`): the front
 *    page's own slug, a segment that started with an underscore, an old slug, an attachment page.
 *
 * ## How Rank Math compares, and what Jx can say
 *
 * Rank Math compares the request path with its slashes trimmed on both sides (a source stored as
 * `quote-page` and one stored as `310-2/` both work), and `regex` runs `preg_match` unanchored. A
 * Jx source is a path in URLPattern syntax, written to `_redirects` as it is, so a source can hold
 * one `*` or `:param` and nothing else, and a hosting platform that reads `_redirects` takes a
 * destination's `*` as `:splat`:
 *
 * - `exact` is the literal path. Jx also writes a meta-refresh page at it, so it must not be a live
 *   route (it would overwrite the page): that is `redirect.shadowed`.
 * - `start` is `/<text>*`, `end` is `/*<text>`: one wildcard, and the destination is fixed.
 * - `contains` needs two wildcards, which a rule cannot have. It becomes one literal rule for each
 *   address of the migrated site that holds the text (and the old addresses of the routes), and
 *   `redirect.unsupported` when no such address exists.
 * - `regex` is read when it is literal text around at most one group that matches any run of
 *   characters (`(.*)`, `(.+)`, `(.*?)`) or a single segment (`([^/]+)`), with `$1` in the
 *   destination; anything richer is `redirect.unsupported`. The pattern is read as anchored (a
 *   regex that is not is `redirect.approximated`).
 * - A source with a query string (`?page_id=482`) cannot be a path: `redirect.unsupported`.
 * - Characters that mean something in a pattern (`:`, `*`, parentheses) are written percent-encoded
 *   in an `exact` source, so they stay literal.
 *
 * ## What is dropped, and in which order it is judged
 *
 * Per source, Rank Math's rule comes before a route's own redirect and, between two Rank Math
 * rules, the one whose destination exists does, and then the LATER one: Rank Math tries its rules
 * most recently updated first, and on the live site the later of every duplicate pair answered
 * (6 of 6 on anabaptistperspectives). A stored source is un-slashed first (`keeshon\'s-story` is
 * `keeshon's-story`), and only an `exact` comparison honours `ignore: case`. Then, in this order: a
 * literal source that is a page of the migrated site is `redirect.shadowed` (Jx would overwrite
 * the page; note that on the live sites such a rule did redirect the old page, e.g. fineline's
 * `/hardwood-floor-refinishing/`, so the migrated site serves pages the old one hid); a wildcard
 * that leads where its own pattern matches again (the identity `/*` to `/:splat`, `/news/*` to
 * `/news/archive/:splat`, `/*` to a fixed page) is `redirect.loop`, as is a rule that leads back
 * to itself. A literal rule whose destination is its own source with the slash added or taken
 * away (`/x` to `/x/`) is no loop: the host does that for every page, so it is dropped as
 * information (`redirect.trailing-slash`). A rule that leads to another redirect leads to its end
 * instead (`redirect.chain`, through at most ten hops, and through a `contains` rule, which Rank Math applies to the address
 * a visitor was sent to); and a destination on the old site that the new site has no page for is
 * `redirect.dangling` and dropped.
 *
 * "Has no page for" is judged the way WordPress answered the address, because a plain lookup was
 * wrong for 22 live rules: paths are read with every segment sanitised (`...--episode-15` is the
 * episode `...-episode-15`), and an address nothing answers goes through
 * `redirect_guess_404_permalink`, which sends a visitor to the first viewable post whose slug
 * starts with the last segment (`/blog/<slug>/` reaches `/<slug>/`; under a custom type's base only
 * that type is searched). Such a rule is carried and reported as `redirect.guessed`. The guess is
 * WordPress core's; on fineline it answers any `/<prefix>/<slug>/`, on anabaptistperspectives only
 * under the posts base and a type's own base (something outside core stops the rest there), so a
 * few rules there are carried that the old site left as 404: a redirect to the page the rule meant.
 *
 * A destination is an http(s), protocol-relative or root-relative address and nothing else
 * (`javascript:` and friends are unsupported), a source with a `.` or `..` segment would leave the
 * output folder and is unsupported, and whitespace in a destination is percent-encoded because
 * `_redirects` splits its lines on spaces. A wildcard that covers pages of the migrated site is
 * reported (`redirect.wildcard-overlap`): a host that applies `_redirects` before it serves files
 * sends those pages away. The redirect table is carried whether or not Rank Math is still active
 * (the rules are the site owner's data), and the report says when it is not.
 *
 * Jx's own docs show `"/legacy/*": {"destination": "/archive/*"}`, but `jx build` writes the
 * destination into `_redirects` unchanged, and Netlify and Cloudflare name the capture `:splat` in
 * a destination (Jx's own build test uses `/docs/* /documentation/:splat`), so that is what is
 * written. This is a discrepancy in Jx's docs and specs/site-architecture.md section 11.2, not
 * something the migration can fix.
 *
 * The output is sorted and deterministic. `_redirects` is first-match-wins, so literal sources come
 * first (sorted) and wildcard sources after them, the longest fixed prefix first.
 */
import {
  createUrlTools,
  pathKey,
  sameSiteLocation,
  type Route,
  type RouteTable,
  type UrlTools,
} from "../routes.ts";
import { planMedia, type MediaPlan } from "../media.ts";
import type { Report, WpModel, WpRedirect } from "../types.ts";

// ── Contract ─────────────────────────────────────────────────────────────────────────────────────

export type RedirectTarget = string | { destination: string; status?: number; rewrite?: boolean };

export interface RedirectOptions {
  report?: Report | undefined;
  /** Rewrites a destination on the old site. Default: `createUrlTools(model, routes, media)`. */
  tools?: Pick<UrlTools, "rewriteUrl"> | undefined;
  /** Used by the default tools. Default: the real plan of the model. */
  media?: MediaPlan | undefined;
  /**
   * Redirect the old attachment pages too. Default false: a library has one page per file (1,233 on
   * finelinepainting, 1,794 on anabaptistperspectives), the sites' own Rank Math already sent every
   * one of them away, none is in a sitemap, and static hosts cap the number of redirect rules
   * (Cloudflare Pages: 2,000 static and 100 dynamic). They stay in the route table, so a link to
   * one is still rewritten.
   */
  attachments?: boolean | undefined;
  /**
   * Keep a rule whose destination is an address of the old site that the migrated site has no page
   * for, and that WordPress could not place either (see the module header). Default false: such a
   * rule only sends a visitor to a 404, which is also what the old site answered there.
   */
  keepDangling?: boolean | undefined;
}

export interface RedirectSummary {
  /** Rules that came from Rank Math. */
  rankMath: number;
  /** Rules for a route that moved or was renamed, and for old slugs. */
  routes: number;
  /** Rank Math rules left out, by code. */
  dropped: Record<string, number>;
  /** Literal and wildcard sources in the output. */
  literal: number;
  wildcard: number;
}

export interface RedirectBuild {
  redirects: Record<string, RedirectTarget>;
  summary: RedirectSummary;
  /**
   * Addresses of pages of the migrated site that a Rank Math rule answers first (`redirect.supersedes-page`):
   * the rule is kept and the page is not to be written, as on the source site, where nobody reached it.
   */
  supersedes: string[];
}

/** The statuses `project.json` accepts (RFC 9110 §15.4 without 300 and 304-306). */
const JX_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const PERMANENT = new Set([301, 308]);

/** Static hosts' limits on `_redirects`, as Cloudflare Pages states them (the strictest in use). */
const HOST_LIMITS = { literal: 2000, wildcard: 100 } as const;

// ── Rules ────────────────────────────────────────────────────────────────────────────────────────

/** A wildcard source: `<prefix><token><suffix>`, the token a `*` or a `:param`. */
interface Wildcard {
  prefix: string;
  suffix: string;
  kind: "splat" | "param";
}

interface Rule {
  /** The Jx source key (`/old`, `/user/*`). */
  source: string;
  wildcard?: Wildcard;
  destination: string;
  status: number;
  origin: "rank-math" | "route";
  where: string;
  /** Input order, the tie-break between two rules for one source. */
  order: number;
  /**
   * The destination is an address of the old site that the migrated site has no page for. It is
   * judged after chains are followed (the destination may be another rule's source), so the rule
   * carries what the verdict needs.
   */
  dangling?: { raw: string; data: Record<string, unknown> };
}

const PARAM = ":slug";
const slashes = (s: string): string => s.replace(/^\/+|\/+$/g, "");

/** `%` plus the hex of every UTF-8 byte of one character. */
function percent(ch: string): string {
  return [...new TextEncoder().encode(ch)]
    .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

/** PHP's `stripslashes` for the quotes and backslashes `addslashes` doubles: a stored `keeshon\\'s` is `keeshon's`. */
const unslash = (text: string): string => text.replace(/\\(['"\\])/g, "$1");

/** Whitespace in a destination would split a `_redirects` line into more than three fields. */
const encodeWhitespace = (text: string): string => text.replace(/\s/gu, percent);

/** What a literal segment must not hold: pattern syntax, and what no URL path carries bare. */
const SEGMENT_SPECIAL = /[\s:*(){}[\]?+\\%#<>"|^`$]/gu;

/** One path segment as a Jx source: readable, with the characters that mean something in a pattern encoded. */
function encodeSegment(raw: string, lower: boolean): string {
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    text = raw;
  }
  text = text.normalize("NFC");
  if (lower) text = text.toLowerCase();
  return text.replace(SEGMENT_SPECIAL, percent);
}

/** Text of a source with the slashes it has kept and each segment encoded. */
const encodeText = (text: string, lower: boolean): string =>
  text
    .split("/")
    .map((segment) => encodeSegment(segment, lower))
    .join("/");

/** The pattern a wildcard stands for, as a string. */
const patternOf = (w: Wildcard): string =>
  `${w.prefix}${w.kind === "splat" ? "*" : PARAM}${w.suffix}`;

/** What a wildcard captured from a path, or undefined when it does not match. */
function capture(w: Wildcard, path: string): string | undefined {
  if (!path.startsWith(w.prefix) || !path.endsWith(w.suffix)) return undefined;
  if (path.length < w.prefix.length + w.suffix.length) return undefined;
  const middle = path.slice(w.prefix.length, path.length - w.suffix.length);
  if (w.kind === "param" && (middle === "" || middle.includes("/"))) return undefined;
  return middle;
}

// ── Reading a Rank Math source ───────────────────────────────────────────────────────────────────

type Parsed =
  | { kind: "literal"; path: string }
  | { kind: "wildcard"; wildcard: Wildcard; loose?: string }
  | { kind: "contains"; text: string }
  | { kind: "unsupported"; reason: string };

/** The groups of a regex a Jx wildcard can stand for. */
const ANY_RUN = ["(.*?)", "(.+?)", "(.*)", "(.+)"];
const ONE_SEGMENT = [
  "([^/]+?)",
  "([^/]+)",
  "([^/]*)",
  "([\\w-]+)",
  "([a-z0-9-]+)",
  "([a-z0-9_-]+)",
  "([A-Za-z0-9_-]+)",
];

interface RegexShape {
  prefix: string;
  suffix: string;
  token?: "splat" | "param";
  anchoredStart: boolean;
  anchoredEnd: boolean;
}

/** A regex that is literal text around at most one group; an error text for anything richer. */
function readRegex(pattern: string): RegexShape | { error: string } {
  let text = pattern.trim();
  let anchoredStart = false;
  let anchoredEnd = false;
  if (text.startsWith("^")) {
    anchoredStart = true;
    text = text.slice(1);
  }
  if (text.endsWith("$") && !text.endsWith("\\$")) {
    anchoredEnd = true;
    text = text.slice(0, -1);
  }
  // Rank Math compares against a path that has no leading slash.
  text = text.replace(/^\/+/, "");
  let prefix = "";
  let suffix = "";
  let token: "splat" | "param" | undefined;
  const add = (literal: string): void => {
    if (token) suffix += literal;
    else prefix += literal;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined || !/[./\-_~+()*?[\]{}|^$\\]/.test(next))
        return { error: `the escape ${c}${next ?? ""}` };
      add(next);
      i += 2;
    } else if (c === "(") {
      const any = ANY_RUN.find((g) => text.startsWith(g, i));
      const one = ONE_SEGMENT.find((g) => text.startsWith(g, i));
      const group = any ?? one;
      if (!group) return { error: `the group at "${text.slice(i, i + 14)}"` };
      if (token) return { error: "more than one group" };
      token = any ? "splat" : "param";
      i += group.length;
    } else if (c === "." && text[i + 1] === "*") {
      if (token) return { error: "more than one wildcard" };
      token = "splat";
      i += 2;
    } else if (/[\p{L}\p{N}_\-/%~,'.]/u.test(c)) {
      add(c);
      i += 1;
    } else {
      return { error: `the character ${c}` };
    }
  }
  return { prefix, suffix, ...(token ? { token } : {}), anchoredStart, anchoredEnd };
}

const unsupported = (reason: string): Parsed => ({ kind: "unsupported", reason });

function startOf(text: string, lower: boolean): Parsed {
  return {
    kind: "wildcard",
    wildcard: {
      prefix: `/${encodeText(text.replace(/^\/+/, ""), lower)}`,
      suffix: "",
      kind: "splat",
    },
  };
}

function endOf(text: string, lower: boolean): Parsed {
  return {
    kind: "wildcard",
    wildcard: { prefix: "/", suffix: encodeText(text.replace(/\/+$/, ""), lower), kind: "splat" },
  };
}

/** `.` and `..` as a whole segment would make a build write outside its output folder. */
const dotSegment = (segments: readonly string[]): boolean =>
  segments.some((segment) => segment === "." || segment === "..");

function parseSource(rule: WpRedirect, model: WpModel): Parsed {
  const parsed = readSource(rule, model);
  // A wildcard's first and last segments may be partial (`/a/.` before the token), so only the whole ones count.
  const whole =
    parsed.kind === "literal"
      ? parsed.path.split("/")
      : parsed.kind === "wildcard"
        ? [
            ...parsed.wildcard.prefix.split("/").slice(0, -1),
            ...parsed.wildcard.suffix.split("/").slice(1),
          ]
        : [];
  return dotSegment(whole)
    ? unsupported(
        'the source has a "." or ".." segment, which would leave the site\'s own folder when it is written',
      )
    : parsed;
}

function readSource(rule: WpRedirect, model: WpModel): Parsed {
  // Rank Math stores a source through `addslashes`, and its regex alone is un-slashed before use.
  const raw = rule.comparison === "regex" ? rule.source.trim() : unslash(rule.source.trim());
  // Only an exact comparison honours `ignore: case` (class-db.php, compare_sources).
  const lower = rule.ignoreCase === true && rule.comparison === "exact";
  let path = raw;
  if (/^https?:\/\//i.test(raw) || raw.startsWith("//")) {
    const where = sameSiteLocation(model, raw);
    if (!where)
      return unsupported("the source is on another host, which a static redirect cannot match");
    if (where.search !== "" || where.hash !== "")
      return unsupported(
        "the source has a query string or a fragment, which a static redirect cannot match",
      );
    path = where.path;
  }

  if (rule.comparison === "regex") {
    const shape = readRegex(rule.source);
    if ("error" in shape)
      return unsupported(`the regular expression is richer than one wildcard (${shape.error})`);
    if (!shape.token) {
      const text = shape.prefix + shape.suffix;
      if (shape.anchoredStart && shape.anchoredEnd)
        return { kind: "literal", path: `/${slashes(encodeText(text, lower))}` };
      if (shape.anchoredStart) return startOf(text, lower);
      if (shape.anchoredEnd) return endOf(text, lower);
      return { kind: "contains", text: slashes(text) };
    }
    const atStart = shape.prefix === "";
    const atEnd = shape.suffix === "";
    const loose =
      (!shape.anchoredStart && !atStart) || (!shape.anchoredEnd && !atEnd)
        ? "the expression is not anchored; it is applied to the whole path"
        : undefined;
    return {
      kind: "wildcard",
      wildcard: {
        prefix: `/${encodeText(shape.prefix, lower)}`,
        suffix: encodeText(shape.suffix, lower),
        kind: shape.token,
      },
      ...(loose ? { loose } : {}),
    };
  }

  if (/[?#]/.test(path))
    return unsupported(
      "the source has a query string or a fragment, which a static redirect cannot match",
    );
  switch (rule.comparison) {
    case "start":
      return startOf(path, lower);
    case "end":
      return endOf(path, lower);
    case "contains":
      return { kind: "contains", text: slashes(path) };
    default:
      return { kind: "literal", path: `/${slashes(encodeText(slashes(path), lower))}` };
  }
}

// ── Reading a destination ────────────────────────────────────────────────────────────────────────

interface Guessed {
  from: string;
  to: string;
}

type Destination =
  | { ok: true; text: string; dangling?: boolean; guessed?: Guessed }
  | { ok: false; reason: string };

/**
 * A destination for the Jx site. Where the rule has a wildcard, `$1` becomes the host's `:splat`
 * (or `:slug` for a one-segment group); a destination on the old site becomes a path, and a path
 * that is a route of the migrated site becomes that route.
 */
function readDestination(
  raw: string,
  model: WpModel,
  routes: RouteTable,
  tools: Pick<UrlTools, "rewriteUrl">,
  guess: (path: string) => Route | undefined,
  wildcard: Wildcard | undefined,
  regex: boolean,
): Destination {
  const entered = raw.trim();
  if (entered === "") return { ok: false, reason: "the rule has no destination" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(entered)?.[1];
  if (scheme !== undefined && !/^https?$/i.test(scheme))
    return {
      ok: false,
      reason: `the destination is a ${scheme}: address, and a redirect leads to an http(s) or root-relative address only`,
    };
  const refs = [...entered.matchAll(/\$(\d+)|\\(\d+)/g)];
  if (refs.some((m) => (m[1] ?? m[2]) !== "1"))
    return { ok: false, reason: "the destination uses a capture group other than the first" };
  if (refs.length > 0 && !(regex && wildcard))
    return { ok: false, reason: "the destination uses a capture, and the source has no wildcard" };
  const token = wildcard?.kind === "param" ? PARAM : ":splat";
  const hasCapture = refs.length > 0;
  // `\1` is the same capture as `$1`; a URL parser would turn its backslash into a slash.
  const text = entered.replace(/\\1/g, "$1");
  const withCapture = (value: string): string => value.replace(/\$1/g, token);
  const ok = (
    value: string,
    more: { dangling?: boolean; guessed?: Guessed } = {},
  ): Destination => ({
    ok: true,
    text: encodeWhitespace(value),
    ...more,
  });

  const address =
    text.startsWith("/") || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(text) ? text : `/${text}`;
  const where = sameSiteLocation(model, address);
  if (!where) return ok(withCapture(text));
  // A path with a capture in it is not a route: only the host can fill it in.
  if (hasCapture) return ok(withCapture(`${where.path}${where.search}${where.hash}`));
  const rewritten = tools.rewriteUrl(address);
  // An address that is already spelled as its route comes back unchanged: the table vouches for it.
  if (rewritten !== address || routes.byWpPath(where.path)) return ok(rewritten);
  // WordPress answers an address it does not know with a guess at the post it meant (see guessRoute).
  const guessed = guess(where.path);
  if (guessed)
    return ok(`${guessed.jxRoute}${where.search}${where.hash}`, {
      guessed: { from: where.path, to: guessed.jxRoute },
    });
  return ok(`${where.path}${where.search}${where.hash}`, { dangling: true });
}

// ── What WordPress answers for an address it does not know ──────────────────────────────────────

/** `sanitize_title` as far as a slug goes: lower case, runs of dashes collapsed, none at either end. */
const sanitizeSlug = (segment: string): string =>
  segment
    .toLowerCase()
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The page or entry WordPress sends an unknown address to. Two things happen to a request that no
 * rewrite rule answers: its path is read with every segment sanitised (`...--episode-15` is the
 * episode `...-episode-15`, served as it is), and what is still a 404 goes through
 * `redirect_guess_404_permalink`, which takes the last segment as a post name, looks for the first
 * viewable post whose `post_name` STARTS with it (`LIKE 'name%'`, in slug order: the index scan) and
 * redirects there. A path under the rewrite base of a custom type only looks among that type's
 * entries, since the rule that read it also set `post_type`; every other path, `/blog/<slug>/`
 * included, looks among them all.
 */
function makeGuesser(model: WpModel, routes: RouteTable): (path: string) => Route | undefined {
  interface Candidate {
    route: Route;
    slug: string;
    type: string;
    id: number;
  }
  const candidates: Candidate[] = [];
  const typeAtBase = new Map<string, string>();
  for (const route of routes.all()) {
    if (route.kind === "entry" && route.type !== "post" && !route.wpPath.includes("?")) {
      const parts = pathKey(route.wpPath).split("/").filter(Boolean);
      const below = route.entryId === undefined ? 1 : route.entryId.split("/").length;
      typeAtBase.set(parts.slice(0, Math.max(0, parts.length - below)).join("/"), route.type ?? "");
    }
    if (!["page", "front", "posts-page", "entry"].includes(route.kind)) continue;
    const post = typeof route.id === "number" ? model.posts.get(route.id) : undefined;
    if (!post || post.slug === "") continue;
    let slug = post.slug;
    try {
      slug = decodeURIComponent(slug);
    } catch {
      // A slug that is not valid percent-encoding is compared as it is.
    }
    candidates.push({ route, slug: sanitizeSlug(slug), type: post.type, id: post.id });
  }
  candidates.sort((a, b) => compare(a.slug, b.slug) || a.id - b.id);

  return (path) => {
    const segments = pathKey(path).split("/").filter(Boolean);
    const name = sanitizeSlug(segments.at(-1) ?? "");
    if (name === "") return undefined;
    const sanitized = routes.byWpPath(`/${segments.map(sanitizeSlug).join("/")}/`);
    if (sanitized && sanitized.kind !== "attachment") return sanitized;
    const type = segments.length > 1 ? typeAtBase.get(segments.slice(0, -1).join("/")) : undefined;
    return candidates.find(
      (c) => (type === undefined || c.type === type) && c.slug.startsWith(name),
    )?.route;
  };
}

// ── Building ─────────────────────────────────────────────────────────────────────────────────────

/** A destination that is a file or one of WordPress's own addresses: not a page, so no route can vouch for it. */
const FILE_LIKE = /\.[a-z0-9]{2,5}(?:[?#]|$)|^\/wp-/i;

const sourceKey = (rule: Rule): string =>
  rule.wildcard ? `wild:${rule.source}` : `path:${pathKey(rule.source)}`;

const destinationPath = (destination: string): string | undefined =>
  destination.startsWith("/") &&
  !destination.startsWith("//") &&
  !/[*]|:splat|:slug/.test(destination)
    ? destination.replace(/[?#].*$/s, "")
    : undefined;

const target = (rule: Rule): RedirectTarget =>
  rule.status === 301 ? rule.destination : { destination: rule.destination, status: rule.status };

export function buildRedirects(
  model: WpModel,
  routes: RouteTable,
  opts: RedirectOptions = {},
): RedirectBuild {
  const { report } = opts;
  const tools = opts.tools ?? createUrlTools(model, routes, opts.media ?? planMedia(model));
  const guess = makeGuesser(model, routes);
  const home = model.site.home;
  const summary: RedirectSummary = { rankMath: 0, routes: 0, dropped: {}, literal: 0, wildcard: 0 };
  const drop = (code: string): void => {
    summary.dropped[code] = (summary.dropped[code] ?? 0) + 1;
  };
  const say = (
    severity: "info" | "warn" | "error",
    code: string,
    message: string,
    where: string,
    source: string | undefined,
    data: Record<string, unknown> = {},
  ): void => {
    report?.add({
      severity,
      code,
      message,
      where,
      ...(source !== undefined && !source.includes("*")
        ? { url: `${home}/${slashes(source)}` }
        : {}),
      data,
    });
  };

  /** What the migrated site serves: a rule for one of these addresses would overwrite a page. */
  const live = new Set<string>();
  /** The addresses whose page is one file of its own (a page, an entry): the ones a rule can hide by the page not being written. */
  const single = new Set<string>();
  for (const route of routes.all()) {
    if (route.kind !== "attachment") live.add(pathKey(route.jxRoute));
    if (route.kind === "page" || route.kind === "entry") single.add(pathKey(route.jxRoute));
  }

  const rules: Rule[] = [];
  let order = 0;
  const inactive: string[] = [];
  /** The `contains` rules that lead somewhere: Rank Math applies them to the address a rule sent a visitor to. */
  const answers: { needle: string; text: string; destination: string; status: number }[] = [];

  // ── 1. Rank Math ───────────────────────────────────────────────────────────────────────────────
  if (
    model.redirects.length > 0 &&
    !model.site.activePlugins.some((p) => p.startsWith("seo-by-rank-math"))
  )
    say(
      "info",
      "redirect.plugin-inactive",
      `Rank Math is not an active plugin of the source site, so its ${model.redirects.length} stored redirect sources were not answering there; they are carried anyway, as the site owner's data.`,
      "table:rank_math_redirections",
      undefined,
      { count: model.redirects.length },
    );
  for (const wp of model.redirects) {
    const where = `redirect:${wp.source}`;
    const data = {
      source: wp.source,
      comparison: wp.comparison,
      destination: wp.destination,
      status: wp.status,
    };
    if (!wp.active) {
      inactive.push(wp.source);
      continue;
    }
    summary.rankMath += 1;
    if (!JX_STATUSES.has(wp.status)) {
      drop("redirect.unsupported");
      say(
        "warn",
        "redirect.unsupported",
        wp.status === 410 || wp.status === 451
          ? `Rank Math answered this address with ${wp.status}${wp.status === 410 ? " Gone" : " Unavailable For Legal Reasons"}; a Jx redirect has only the statuses 301, 302, 303, 307 and 308, so there is no way to say it. The address is simply absent from the migrated site (404).`
          : `The status ${wp.status} is not one a Jx redirect can have (301, 302, 303, 307 or 308); the rule is not carried over.`,
        where,
        wp.source,
        { ...data, reason: "status" },
      );
      continue;
    }
    const parsed = parseSource(wp, model);
    if (parsed.kind === "unsupported") {
      drop("redirect.unsupported");
      say(
        "warn",
        "redirect.unsupported",
        `Rank Math rule not carried over: ${parsed.reason}.`,
        where,
        wp.source,
        {
          ...data,
          reason: "source",
        },
      );
      continue;
    }

    const wildcard = parsed.kind === "wildcard" ? parsed.wildcard : undefined;
    const dest = readDestination(
      wp.destination,
      model,
      routes,
      tools,
      guess,
      wildcard,
      wp.comparison === "regex",
    );
    if (!dest.ok) {
      drop("redirect.unsupported");
      say(
        "warn",
        "redirect.unsupported",
        `Rank Math rule not carried over: ${dest.reason}.`,
        where,
        wp.source,
        {
          ...data,
          reason: "destination",
        },
      );
      continue;
    }
    if (parsed.kind === "wildcard" && parsed.loose)
      say("info", "redirect.approximated", `${parsed.loose}.`, where, wp.source, {
        ...data,
        reason: "unanchored",
      });
    if (dest.guessed)
      say(
        "info",
        "redirect.guessed",
        `The destination ${dest.guessed.from} is not an address of the site, but WordPress answered it with a guess at the post it meant (its 404 permalink guess), and so the rule leads to ${dest.guessed.to}.`,
        where,
        wp.source,
        { ...data, from: dest.guessed.from, to: dest.guessed.to },
      );
    if (parsed.kind === "contains" && !dest.dangling)
      answers.push({
        needle: parsed.text.toLowerCase(),
        text: parsed.text,
        destination: dest.text,
        status: wp.status,
      });
    if (wp.ignoreCase === true && wp.comparison === "exact" && /\p{L}/u.test(wp.source))
      say(
        "info",
        "redirect.approximated",
        "The rule ignores case; Jx sources are written in lower case, and a host that compares case-sensitively will not match a differently capitalised address.",
        where,
        wp.source,
        { ...data, reason: "ignore-case" },
      );

    const base = {
      destination: dest.text,
      status: wp.status,
      origin: "rank-math" as const,
      where,
      order: order++,
      ...(dest.dangling
        ? { dangling: { raw: wp.destination, data: { ...data, resolved: dest.text } } }
        : {}),
    };
    if (parsed.kind === "literal") {
      rules.push({ ...base, source: parsed.path });
    } else if (parsed.kind === "wildcard") {
      rules.push({ ...base, source: patternOf(parsed.wildcard), wildcard: parsed.wildcard });
    } else {
      // `contains` has no pattern: it stands for every address of the new site that holds the text.
      const needle = parsed.text.toLowerCase();
      const found = new Set<string>();
      for (const route of routes.all()) {
        if (route.kind === "attachment") continue;
        for (const path of [route.wpPath, ...(route.aliases ?? [])])
          if (!path.includes("?") && pathKey(path).includes(needle)) found.add(pathKey(path));
      }
      if (found.size === 0) {
        drop("redirect.unsupported");
        say(
          "warn",
          "redirect.unsupported",
          `Rank Math rule not carried over: it matches every address that contains "${parsed.text}", which needs two wildcards, and no address of the site contains it.`,
          where,
          wp.source,
          { ...data, reason: "contains" },
        );
        continue;
      }
      const shadowed = [...found].filter((key) => live.has(key));
      const open = [...found].filter((key) => !live.has(key)).sort();
      say(
        "info",
        "redirect.approximated",
        `A "contains" rule is written for the ${found.size} addresses of the site that hold "${parsed.text}", not for every address that could.`,
        where,
        wp.source,
        { ...data, reason: "contains", count: found.size },
      );
      if (shadowed.length > 0) {
        drop("redirect.shadowed");
        say(
          "warn",
          "redirect.shadowed",
          `${shadowed.length} of the addresses this rule matches are pages of the migrated site (${shadowed.slice(0, 3).join(", ")}${shadowed.length > 3 ? ", …" : ""}); Jx would overwrite those pages with a redirect, so they are left alone.`,
          where,
          wp.source,
          { ...data, shadowed },
        );
      }
      for (const key of open)
        rules.push({
          ...base,
          source: `/${slashes(encodeText(slashes(key), lower(wp)))}`,
          order: order++,
        });
    }
  }
  if (inactive.length > 0) {
    say(
      "info",
      "redirect.inactive",
      `${inactive.length} Rank Math rules are switched off and are not carried over: ${inactive.slice(0, 8).join(", ")}${inactive.length > 8 ? ", …" : ""}.`,
      "table:rank_math_redirections",
      undefined,
      { count: inactive.length, sources: inactive },
    );
  }

  // ── 2. Routes that moved ───────────────────────────────────────────────────────────────────────
  const queryForms: string[] = [];
  let attachmentPages = 0;
  for (const route of routes.all()) {
    if (route.kind === "attachment") {
      attachmentPages += 1;
      if (opts.attachments !== true) continue;
    }
    for (const path of [route.wpPath, ...(route.aliases ?? [])]) {
      if (path.includes("?")) {
        queryForms.push(path);
        continue;
      }
      if (pathKey(path) === pathKey(route.jxRoute)) continue;
      if (dotSegment(segmentsOfPath(path))) {
        say(
          "warn",
          "redirect.unsupported",
          `The old address ${path} has a "." or ".." segment, which would leave the site's own folder when a redirect page is written there; it is not redirected.`,
          routeWhere(route),
          undefined,
          { reason: "source", path },
        );
        continue;
      }
      summary.routes += 1;
      rules.push({
        source: `/${slashes(encodeText(slashes(path), false))}`.replace(/^\/$/, "/"),
        destination: encodeWhitespace(route.jxRoute),
        status: 301,
        origin: "route",
        where: routeWhere(route),
        order: order++,
      });
    }
  }
  if (queryForms.length > 0) {
    say(
      "info",
      "redirect.unsupported",
      `${queryForms.length} objects were at query-string addresses (${queryForms.slice(0, 3).join(", ")}…) on the source site; a static host cannot redirect those.`,
      "site",
      undefined,
      { reason: "query-address", count: queryForms.length },
    );
  }
  if (attachmentPages > 0 && opts.attachments !== true) {
    say(
      "info",
      "redirect.attachments-omitted",
      `${attachmentPages} attachment pages are not redirected (see RedirectOptions.attachments); a link to one inside content is still rewritten.`,
      "site",
      undefined,
      { count: attachmentPages },
    );
  }

  // ── 3. One rule per source ─────────────────────────────────────────────────────────────────────
  const bySource = new Map<string, Rule>();
  // Rank Math before routes. Between two Rank Math rules for one address, the one that leads somewhere
  // first and then the later one: Rank Math tries its rules most recently updated first, and the live
  // site agrees (6 of 6 duplicate pairs). Two route rules keep the order the routes came in.
  const precedence = (a: Rule, b: Rule): number =>
    a.origin === b.origin
      ? Number(a.dangling !== undefined) - Number(b.dangling !== undefined) ||
        (a.origin === "rank-math" ? b.order - a.order : a.order - b.order)
      : a.origin === "rank-math"
        ? -1
        : 1;
  for (const rule of [...rules].sort(precedence)) {
    const key = sourceKey(rule);
    const owner = bySource.get(key);
    if (!owner) {
      bySource.set(key, rule);
      continue;
    }
    if (owner.destination !== rule.destination || owner.status !== rule.status) {
      const sameKind = owner.origin === rule.origin;
      say(
        sameKind ? "warn" : "info",
        sameKind ? "redirect.duplicate" : "redirect.overridden",
        sameKind
          ? owner.order > rule.order
            ? `Two rules have the source ${rule.source}; the later one (to ${owner.destination}) wins, as it does on the source site, and this earlier one (to ${rule.destination}) is dropped.`
            : `Two rules have the source ${rule.source}; the later one (to ${rule.destination}) leads nowhere, so the earlier one (to ${owner.destination}) is kept and the later one is dropped.`
          : `The moved route ${rule.source} would lead to ${rule.destination}, but a Rank Math rule for the same address leads to ${owner.destination}; the Rank Math rule is kept, as it was on the source site.`,
        rule.where,
        rule.source,
        { kept: owner.destination, dropped: rule.destination },
      );
      if (rule.origin === "rank-math") drop("redirect.duplicate");
    }
  }
  // Reports and output follow the order of the table: Rank Math's rules first, each side as it came.
  let kept = [...bySource.values()].sort(
    (a, b) =>
      Number(a.origin !== "rank-math") - Number(b.origin !== "rank-math") || a.order - b.order,
  );

  // ── 4. Sources that are pages ──────────────────────────────────────────────────────────────────
  // Rank Math answers before WordPress looks for a page, so on the source site the page behind such a
  // rule is unreachable and the visitor is sent away: the rule stays, and the caller does not write
  // the page (Jx writes a redirect page at the address, where the page would be; step 8 lists them).
  // A route that merely moved has no such rule on the source site, so its page stays and its redirect
  // gives way.
  kept = kept.filter((rule) => {
    if (rule.wildcard || !live.has(pathKey(rule.source))) return true;
    if (rule.origin === "rank-math" && single.has(pathKey(rule.source))) return true;
    if (rule.origin === "rank-math") drop("redirect.shadowed");
    say(
      "warn",
      "redirect.shadowed",
      `${rule.source} is an address of the migrated site, and Jx writes a redirect page where a page of that address would be; the redirect to ${rule.destination} is dropped and the page is kept.`,
      rule.where,
      rule.source,
      { source: rule.source, destination: rule.destination },
    );
    return false;
  });

  // ── 5. Chains and loops ────────────────────────────────────────────────────────────────────────
  // A destination that a `contains` rule answers leads where that rule leads, before and after the
  // chains are collapsed (a chain can end on such an address).
  const followContains = (list: readonly Rule[]): Rule[] =>
    list.map((rule) => {
      if (!rule.dangling) return rule;
      const at = destinationPath(rule.destination);
      if (at === undefined) return rule;
      const key = pathKey(at);
      const answer = [...answers].reverse().find((a) => key.includes(a.needle));
      if (!answer) return rule;
      say(
        "info",
        "redirect.chain",
        `${rule.source} led to ${rule.destination}, which a "contains" rule for "${answer.text}" answers; it now leads straight to ${answer.destination}.`,
        rule.where,
        rule.source,
        {
          source: rule.source,
          via: [`contains:${answer.text}`],
          from: rule.destination,
          to: answer.destination,
        },
      );
      const { dangling: _was, ...rest } = rule;
      return {
        ...rest,
        destination: answer.destination,
        status:
          PERMANENT.has(rule.status) && !PERMANENT.has(answer.status) ? answer.status : rule.status,
      };
    });
  kept = settle(followContains(kept), say, drop);
  kept = followContains(kept);

  // ── 6. Destinations that lead nowhere ──────────────────────────────────────────────────────────
  kept = kept.filter((rule) => {
    if (!rule.dangling) return true;
    const keep = opts.keepDangling === true || FILE_LIKE.test(rule.destination);
    say(
      "warn",
      "redirect.dangling",
      `The destination ${rule.dangling.raw} is on the source site but is not an address of the migrated site, and WordPress could not place it either (no page or entry has that name, even by its 404 guess)${keep ? "; the rule is kept as a path, but it leads to a page that does not exist" : ", so the rule would only lead to a 404 and is dropped"}. Point the rule at an existing page to bring it back.`,
      rule.where,
      rule.source,
      { ...rule.dangling.data, dropped: !keep },
    );
    if (!keep) drop("redirect.dangling");
    return keep;
  });

  // ── 7. Wildcards that cover pages ──────────────────────────────────────────────────────────────
  for (const rule of kept) {
    if (!rule.wildcard || rule.origin !== "rank-math") continue;
    const covered = [...live].filter((key) => {
      const trimmed = key.replace(/\/+$/, "");
      return capture(rule.wildcard!, trimmed === "" ? "/" : trimmed) !== undefined;
    });
    if (covered.length === 0) continue;
    say(
      "warn",
      "redirect.wildcard-overlap",
      `${rule.source} also matches ${covered.length} pages of the migrated site (${covered.slice(0, 3).join(", ")}${covered.length > 3 ? ", …" : ""}); a host that applies _redirects before it serves files sends those pages away.`,
      rule.where,
      rule.source,
      {
        source: rule.source,
        destination: rule.destination,
        count: covered.length,
        pages: covered.slice(0, 20),
      },
    );
  }

  // ── 8. Output ──────────────────────────────────────────────────────────────────────────────────
  const literals = kept.filter((r) => !r.wildcard).sort((a, b) => cmp(a.source, b.source));
  const wildcards = kept
    .filter((r) => r.wildcard)
    .sort(
      (a, b) => b.wildcard!.prefix.length - a.wildcard!.prefix.length || cmp(a.source, b.source),
    );
  const redirects: Record<string, RedirectTarget> = {};
  for (const rule of [...literals, ...wildcards]) redirects[rule.source] = target(rule);
  const supersedes: string[] = [];
  for (const rule of literals) {
    if (rule.origin !== "rank-math" || !single.has(pathKey(rule.source))) continue;
    supersedes.push(rule.source);
    say(
      "info",
      "redirect.supersedes-page",
      `${rule.source} is an address of the migrated site, but Rank Math sends its visitors to ${rule.destination} before WordPress looks for a page there, so the page was never reached on the source site: the redirect is kept and the page is not written.`,
      rule.where,
      rule.source,
      { source: rule.source, destination: rule.destination },
    );
  }
  summary.literal = literals.length;
  summary.wildcard = wildcards.length;
  if (literals.length > HOST_LIMITS.literal || wildcards.length > HOST_LIMITS.wildcard) {
    say(
      "warn",
      "redirect.host-limit",
      `${literals.length} literal and ${wildcards.length} wildcard redirects exceed what Cloudflare Pages accepts in _redirects (${HOST_LIMITS.literal} and ${HOST_LIMITS.wildcard}); another host may take them, or the rule set needs trimming.`,
      "site",
      undefined,
      { literal: literals.length, wildcard: wildcards.length },
    );
  }
  return { redirects, summary, supersedes };
}

const lower = (wp: WpRedirect): boolean => wp.ignoreCase === true && wp.comparison === "exact";
const segmentsOfPath = (path: string): string[] => path.split("/").filter(Boolean);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function routeWhere(route: Route): string {
  switch (route.kind) {
    case "term":
      return `term:${route.id}`;
    case "author":
      return `user:${route.id}`;
    case "post-archive":
      return `post-type:${route.id}`;
    default:
      return `post:${route.id}`;
  }
}

type Say = (
  severity: "info" | "warn" | "error",
  code: string,
  message: string,
  where: string,
  source: string | undefined,
  data?: Record<string, unknown>,
) => void;

/** The most redirects a chain is followed through before it is called a tangle and left as it is. */
const MAX_HOPS = 10;

/**
 * A wildcard whose own pattern matches where it sends a visitor: `/*` to `/:splat` (the identity),
 * `/news/*` to `/news/archive/:splat` (feeds itself), `/*` to a fixed page (loops on that page).
 */
function feedsItself(rule: Rule): boolean {
  const w = rule.wildcard!;
  const sample = rule.destination.replace(/:splat|:slug/g, "zz");
  const path = destinationPath(sample);
  if (path === undefined) return false;
  const trimmed = path.replace(/\/+$/, "");
  return capture(w, trimmed === "" ? "/" : trimmed) !== undefined;
}

/**
 * A literal rule whose destination is its own source with a slash added or taken away (`/x` to
 * `/x/`). It is no loop to a visitor: the host answers `/x` with `/x/` for every page it serves, so
 * the rule only repeats that.
 */
function onlyTheSlash(rule: Rule): boolean {
  if (rule.wildcard) return false;
  const path = destinationPath(rule.destination);
  if (path === undefined || path !== rule.destination || path === rule.source) return false;
  return path.replace(/\/+$/, "") === rule.source.replace(/\/+$/, "");
}

/**
 * Collapses a redirect that leads to another redirect (a second round trip), and drops every rule
 * on a cycle (a page nobody can open). A destination is followed through a literal rule, or through
 * a wildcard rule that matches it.
 */
function settle(rules: readonly Rule[], say: Say, drop: (code: string) => void): Rule[] {
  const literal = new Map<string, Rule>();
  const dead = new Set<Rule>();
  const slashOnly = new Set<Rule>();
  const wild: Rule[] = [];
  for (const rule of rules) {
    if (onlyTheSlash(rule)) slashOnly.add(rule);
    else if (!rule.wildcard) literal.set(pathKey(rule.source), rule);
    else if (feedsItself(rule)) dead.add(rule);
    else wild.push(rule);
  }
  /** The rule that answers a path, and the destination it gives. */
  const step = (path: string): { rule: Rule; next: string } | undefined => {
    const direct = literal.get(pathKey(path));
    if (direct) return { rule: direct, next: direct.destination };
    const trimmed = path.replace(/\/+$/, "");
    for (const rule of wild) {
      const got = capture(rule.wildcard!, trimmed === "" ? "/" : trimmed);
      if (got === undefined) continue;
      return { rule, next: rule.destination.replace(/:splat|:slug/g, got) };
    }
    return undefined;
  };

  const finals = new Map<
    Rule,
    { destination: string; status: number; via: string[]; last: Rule }
  >();
  for (const rule of literal.values()) {
    if (rule.wildcard) continue;
    const seen = [pathKey(rule.source)];
    const via: string[] = [];
    let destination = rule.destination;
    let status = rule.status;
    let loop = false;
    let last = rule;
    const visited = new Set<Rule>([rule]);
    for (;;) {
      const path = destinationPath(destination);
      if (path === undefined) break;
      const hop = step(path);
      if (!hop) break;
      const key = pathKey(path);
      if (seen.includes(key)) {
        // Only a rule on the cycle is a loop; one that leads into it just has a broken destination.
        loop = key === seen[0];
        if (!loop) via.length = 0;
        break;
      }
      // Two wildcards that hand each other's output back and forth never repeat an address, so the
      // rules visited and the number of hops bound the walk too; a rule that leads into such a
      // tangle just keeps the destination it has.
      if (visited.has(hop.rule) || via.length >= MAX_HOPS) {
        via.length = 0;
        break;
      }
      visited.add(hop.rule);
      seen.push(key);
      via.push(hop.rule.source);
      last = hop.rule;
      if (PERMANENT.has(status) && !PERMANENT.has(hop.rule.status)) status = hop.rule.status;
      destination = hop.next;
    }
    if (loop) {
      dead.add(rule);
      continue;
    }
    if (via.length > 0) finals.set(rule, { destination, status, via, last });
  }
  const members = [...dead];
  if (members.length > 0) {
    for (const rule of members) {
      if (rule.origin === "rank-math") drop("redirect.loop");
      say(
        "error",
        "redirect.loop",
        rule.wildcard
          ? `${rule.source} leads to ${rule.destination}, where its own pattern matches again; a visitor would be sent round in circles, so the rule is dropped.`
          : `${rule.source} leads to ${rule.destination}, which leads back to ${rule.source}; a visitor would be sent round in circles, so the rule is dropped.`,
        rule.where,
        rule.source,
        { source: rule.source, destination: rule.destination },
      );
    }
  }
  for (const rule of slashOnly) {
    if (rule.origin === "rank-math") drop("redirect.trailing-slash");
    say(
      "info",
      "redirect.trailing-slash",
      `${rule.source} leads to ${rule.destination}, the same address with the slash the migrated site's pages are served at; the host redirects every address to its slashed form already, so the rule is dropped.`,
      rule.where,
      rule.source,
      { source: rule.source, destination: rule.destination },
    );
  }
  const out: Rule[] = [];
  for (const rule of rules) {
    if (dead.has(rule) || slashOnly.has(rule)) continue;
    const collapsed = finals.get(rule);
    if (!collapsed) {
      out.push(rule);
      continue;
    }
    say(
      "info",
      "redirect.chain",
      `${rule.source} led to ${rule.destination}, itself redirected; it now leads straight to ${collapsed.destination}.`,
      rule.where,
      rule.source,
      {
        source: rule.source,
        via: collapsed.via,
        from: rule.destination,
        to: collapsed.destination,
      },
    );
    const { dangling: _was, ...rest } = rule;
    out.push({
      ...rest,
      destination: collapsed.destination,
      status: collapsed.status,
      ...(collapsed.last.dangling ? { dangling: collapsed.last.dangling } : {}),
    });
  }
  return out;
}
