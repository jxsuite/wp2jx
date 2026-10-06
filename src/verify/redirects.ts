/**
 * `_redirects`, the way the Jx build writes it and the way a static host reads it.
 *
 * The build writes one line per `project.json` redirect: `<source> <destination> <status>`, a
 * wildcard source as `/docs/*` with `:splat` (or a bare `*`, which the build writes verbatim when
 * the author did) in the destination, and `:name` placeholders for one segment. A rule that is a
 * rewrite carries status 200. Matching ignores a trailing slash on either side, as Netlify does.
 *
 * The oracle reads the file for two reasons: the local server answers a redirected URL the way the
 * host would, and the comparison maps every link through the table so `/old/` on one side and
 * `/new/` on the other count as the same place.
 */

export interface RedirectRule {
  from: string;
  to: string;
  status: number;
  /** A `!` after the status: the rule wins over a file at the same path. */
  force: boolean;
  /** The 1-based line of `_redirects` (0 for a rule built from `project.json`). */
  line: number;
}

const STATUS = /^(\d{3})(!?)$/;

/** Parse `_redirects`. Comment and blank lines, and lines with fewer than two fields, are skipped. */
export function parseRedirects(text: string): RedirectRule[] {
  const rules: RedirectRule[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    const from = fields[0];
    const to = fields[1];
    if (from === undefined || to === undefined) continue;
    let status = 301;
    let force = false;
    const third = fields[2];
    if (third !== undefined) {
      const match = STATUS.exec(third);
      if (match !== null) {
        status = Number(match[1]);
        force = match[2] === "!";
      }
    }
    rules.push({ from, to, status, force, line: index + 1 });
  }
  return rules;
}

type ProjectRedirects = Record<
  string,
  string | { destination: string; status?: number; rewrite?: boolean }
>;

/** The rules of a `project.json` `redirects` object, for a build that left no `_redirects`. */
export function rulesFromProject(redirects: ProjectRedirects | undefined): RedirectRule[] {
  const out: RedirectRule[] = [];
  for (const [from, target] of Object.entries(redirects ?? {})) {
    if (typeof target === "string") {
      out.push({ from, to: target, status: 301, force: false, line: 0 });
    } else {
      out.push({
        from,
        to: target.destination,
        status: target.rewrite === true ? 200 : (target.status ?? 301),
        force: false,
        line: 0,
      });
    }
  }
  return out;
}

const trimSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/** Match one rule against a path; returns the destination with the captures substituted. */
function apply(rule: RedirectRule, pathname: string): string | undefined {
  const from = trimSlash(rule.from).split("/");
  const path = trimSlash(pathname).split("/");
  const captures = new Map<string, string>();
  for (let i = 0; i < from.length; i++) {
    const part = from[i] ?? "";
    if (part === "*") {
      captures.set("splat", path.slice(i).join("/"));
      return substitute(rule.to, captures);
    }
    const here = path[i];
    if (here === undefined) return undefined;
    if (part.startsWith(":") && part.length > 1) {
      if (here === "") return undefined;
      captures.set(part.slice(1), here);
      continue;
    }
    if (part !== here) return undefined;
  }
  if (path.length !== from.length) return undefined;
  return substitute(rule.to, captures);
}

function substitute(to: string, captures: Map<string, string>): string {
  let out = to.replace(/:([A-Za-z_][\w]*)/g, (whole, name: string) =>
    captures.has(name) ? (captures.get(name) as string) : whole,
  );
  // A bare `*` in the destination is the splat: the build writes it that way when the author did.
  const splat = captures.get("splat");
  if (splat !== undefined) out = out.replace(/\*/g, () => splat);
  return out;
}

export interface RedirectMatch {
  rule: RedirectRule;
  /** The destination, captures substituted. May be an absolute URL. */
  to: string;
}

/** The first rule that matches the path, in file order (the host's own precedence). */
export function matchRedirect(
  rules: readonly RedirectRule[],
  pathname: string,
): RedirectMatch | undefined {
  for (const rule of rules) {
    const to = apply(rule, pathname);
    if (to !== undefined) return { rule, to };
  }
  return undefined;
}

export interface RedirectChain {
  /** Where the path ends up (the input when no rule matches). */
  path: string;
  hops: { from: string; to: string; status: number }[];
  /** The chain came back to a path it had been at, or ran past the hop limit. */
  loop: boolean;
}

/** Follow redirects (not rewrites) until a path no rule moves, up to `limit` hops. */
export function resolveRedirects(
  rules: readonly RedirectRule[],
  pathname: string,
  limit = 10,
): RedirectChain {
  const hops: RedirectChain["hops"] = [];
  const seen = new Set<string>([trimSlash(pathname)]);
  let current = pathname;
  for (let i = 0; i < limit; i++) {
    const match = matchRedirect(
      rules.filter((rule) => rule.status !== 200),
      current,
    );
    if (match === undefined) return { path: current, hops, loop: false };
    // A destination off this site ends the chain: the visitor leaves.
    if (/^[a-z][a-z0-9+.-]*:/i.test(match.to)) {
      hops.push({ from: current, to: match.to, status: match.rule.status });
      return { path: match.to, hops, loop: false };
    }
    hops.push({ from: current, to: match.to, status: match.rule.status });
    const key = trimSlash(match.to);
    if (seen.has(key)) return { path: match.to, hops, loop: true };
    seen.add(key);
    current = match.to;
  }
  return { path: current, hops, loop: true };
}
