/**
 * Whether the Jx this tool runs with builds an EMPTY list static, which decides how `data.ts` writes a
 * list a `ContentCollection` can say.
 *
 * A mapped `Array` (`{"$prototype": "Array", "items": {"$ref": "#/state/<list>"}, "map": <item>}`) is
 * what Jx Studio edits as a repeater. Before Jx's compiler 8.7.0 the build left one whose items came to
 * nothing for the browser: its parent became a client render (`data-bind :render`) and the page shipped
 * the runtime, the static siblings missing from the HTML (docs/bindings.md, rule 10). So wp2jx wrote
 * every list that could be empty on a route the page builds, every list empty today and every paged
 * list (a term with no entries is a page with none) as computed children, which validate, build static
 * and ship nothing however empty, and which Studio cannot open.
 *
 * Since compiler 8.7.0 (compiler.md §8.1, spec.md §10.5) a mapped `Array` whose items the BUILD resolved
 * (a `ContentCollection` or `ContentEntry` resolved through its class, the slice a paged route put in
 * place of its list, `$site` and `$page`) and that came to nothing renders as nothing, among siblings
 * or alone, and the page stays static. An authored list (`"rows": []`) is still client state the
 * browser may fill, and a pointer to a field an entry does not have is still no list at all: those keep
 * their old form whatever the Jx.
 *
 * The answer is asked of the installed package, not of a version number: the site build that renders an
 * empty build-resolved list says so by telling the lists the build resolved apart
 * (`buildResolvedStateKeys`). The same way `jxFormulas()` and `jxHolds()` (`emit/project.ts`) ask theirs.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What the site build of a compiler that renders an empty build-resolved list nothing holds. */
const MARKER = "buildResolvedStateKeys";

/** A file of a package installed beside this tool, read from the nearest `node_modules`. */
function installedFile(pkg: string, rel: string): string | undefined {
  for (let dir = import.meta.dir, last = ""; dir !== last; last = dir, dir = dirname(dir)) {
    const file = join(dir, "node_modules", pkg, rel);
    if (existsSync(file)) return file;
  }
  return undefined;
}

let known: boolean | undefined;
let override: boolean | undefined;

/** Whether a compiler's site build (`src/site/site-build.ts`, its source) renders an empty build-resolved list as nothing. */
export const rendersEmptyListsStatic = (siteBuild: string): boolean => siteBuild.includes(MARKER);

/**
 * Whether the installed `@jxsuite/compiler` builds an empty mapped `Array` over a list the build
 * resolved as nothing, with the page static. Read once.
 */
export function jxEmptyListsStatic(): boolean {
  if (known !== undefined) return known;
  const build = installedFile("@jxsuite/compiler", "src/site/site-build.ts");
  try {
    known = build !== undefined && rendersEmptyListsStatic(readFileSync(build, "utf8"));
  } catch {
    // A site build that does not read is one that is not known to keep an empty list static.
    known = false;
  }
  return known;
}

/**
 * Whether a list a collection can say is written as a mapped `Array` whatever it lists: the setting
 * ({@link setNativeLists}) where there is one, else what the installed Jx does ({@link jxEmptyListsStatic}).
 */
export const nativeLists = (): boolean => override ?? jxEmptyListsStatic();

/**
 * Settle {@link nativeLists} for the conversions that follow: `true` writes every list a collection can
 * say as a mapped `Array` (for a Jx this tool cannot see, or one the person knows), `false` the forms an
 * older Jx needs, `undefined` asks the installed Jx again.
 */
export function setNativeLists(value: boolean | undefined): void {
  override = value;
}
