/**
 * The addresses in a style tree. A `url()` in a style (a background image) holds the source site's
 * `/wp-content/uploads/` address unless something moves it to the project's `/media/`, and it would
 * break the day the old site goes: every emitter that writes converted styles (pages, templates, the
 * Markdown entries) runs its trees through {@link rewriteStyleUrls}.
 */
import { rewriteCssUrls } from "./design-system.ts";

const SITE_ADDRESS = /^(?:https?:)?\/\//i;

/**
 * Every `url(…)` of a style tree that names an absolute address, through `rewrite`, in place; a value
 * that holds a binding is left alone.
 */
export function rewriteStyleUrls(style: unknown, rewrite: (url: string) => string): void {
  if (typeof style !== "object" || style === null) return;
  for (const [key, value] of Object.entries(style)) {
    if (typeof value === "string") {
      if (value.includes("url(") && !value.includes("${")) {
        (style as Record<string, unknown>)[key] = rewriteCssUrls(value, (url) =>
          SITE_ADDRESS.test(url) ? rewrite(url) : url,
        );
      }
    } else rewriteStyleUrls(value, rewrite);
  }
}
