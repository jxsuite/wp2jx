/**
 * The palette's custom properties under the project's own names.
 *
 * Cwicly names its palette `--cc-color-<n>` (a colour), `--cc-color-<n>-<step>` (a shade),
 * `--cc-color-<n>-lt-10` (a dynamic variant), `--cc-color-<n>-hsl` (the design system's HSL twin) and
 * `--cc-color-background`. The `cc-` is the plugin's namespace, which means nothing in a Jx project,
 * so every one of them is written as `--color-<rest>`: the declarations in `project.json`'s `style`,
 * every `var()` that reads one and the stylesheets copied into `public/css` alike. The migration report
 * keeps Cwicly's names, because it describes the source site.
 *
 * The rename is one pass over the text of every file the project gets, made just before the files are
 * written ({@link renameColorVariables}), rather than at each place a name is made: the names reach the
 * output from the palette option, from Cwicly's compiled CSS (global, per post, per class), from inline
 * styles in the block markup and from stylesheets copied as they are, and one pass cannot miss any of
 * them. The source model (`cwicly/options.ts`) keeps Cwicly's own names, because the legacy palette
 * slugs (`textColor: "cc-color-1"`) are read from them.
 *
 * A palette colour whose own variable is already `--color-<x>` (Cwicly lets an author name one) keeps
 * it. If that name is also what a `--cc-color-<x>` becomes, the two would be one property, so
 * {@link colorVariableCollisions} finds them and the caller reports it.
 *
 * Report code of this module (reported by `emit/project.ts`): `project.color-variable-collision`.
 */

/** `--cc-color-` at the start of a custom property: not inside a longer identifier (`x--cc-color-1`). */
const CC_COLOR = /(?<![\w-])--cc-color-(?=[\w-])/g;

/**
 * `text` with every Cwicly palette property renamed (see the module comment). A single name works too:
 * `--cc-color-1` is `--color-1`, and any other name is itself.
 */
export function renameColorVariables(text: string): string {
  return text.replace(CC_COLOR, "--color-");
}

/** The files whose text can hold a custom property. Media and fonts are left as they are. */
const TEXT_FILE = /\.(?:json|css|html?|md|js|mjs|svg|txt)$/i;

/** Whether a project file is text the rename applies to. */
export function isColorVariableText(path: string): boolean {
  return TEXT_FILE.test(path);
}

/**
 * The renamed names that a variable of the palette already has: `[renamed, from]` for each
 * `--cc-color-<x>` that becomes a `--color-<x>` the palette declares under its own name.
 */
export function colorVariableCollisions(variables: Iterable<string>): [string, string][] {
  const all = [...new Set(variables)];
  const own = new Set(all.filter((v) => renameColorVariables(v) === v));
  return all
    .filter((v) => renameColorVariables(v) !== v && own.has(renameColorVariables(v)))
    .map((v): [string, string] => [renameColorVariables(v), v])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
