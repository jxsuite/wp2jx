# wp2jx

Migrate a [Cwicly](https://cwicly.com) WordPress site to a [Jx](https://github.com/jxsuite/jx) project.

wp2jx reads a WordPress database (MySQL/MariaDB or SQLite), the stylesheets Cwicly generated for each page, and the plugin's own CSS, and writes a Jx project that builds with `jx build`:

- WordPress **pages** become JSON pages (`pages/**.json`); **posts and every custom post type** become Markdown content collections (`content/<type>/*.md`) with frontmatter and a schema generated from the ACF field groups.
- Cwicly **blocks** are converted from their attributes (the saved HTML holds unresolved tokens): styles come from Cwicly's own generated CSS, dynamic data (ACF fields, post fields, links, visibility conditions) becomes Jx bindings, **components** become Jx components, templates and template parts become layouts, archives and entry pages.
- Global styles, fonts, breakpoints, redirects (Rank Math), SEO metadata, menus and media are carried over; one original per image-size family is downloaded.
- Everything that cannot be carried over (JavaScript widgets, forms, WooCommerce, conditions a static site cannot decide) is listed in `migration-report.md` with a location and a URL. Nothing is dropped silently.
- `wp2jx verify` compares the built site with the live one URL by URL (screenshots, text, links, images, computed styles).

## Use

Needs [Bun](https://bun.sh).

```sh
bun install
bun src/cli.ts --help
bun src/cli.ts inventory --db mysql://user@host:3306/wordpress
bun src/cli.ts convert --db mysql://user@host:3306/wordpress --out ../my-site-jx --install --validate --build
bun src/cli.ts verify --out ../my-site-jx --live https://example.com
```

`scripts/dev-db.sh` starts a throwaway MariaDB (via Nix) and loads a `mysqldump` into it, which is the easiest way to work from a database dump.

## Status

Working end to end on real sites; fidelity work against live sites is ongoing (see `docs/fidelity-log.md`). Design and the facts it rests on are in `docs/design.md` and `docs/bindings.md`; module contracts are in `src/types.ts`.

## Tests

`bun test --isolate` (the only supported mode). The tests run against fixtures cut from real WordPress databases and live pages (`tests/fixtures/`, produced by `scripts/make-fixtures.ts`). Those fixtures contain real site data and are **not** published; generate your own with `bun scripts/make-fixtures.ts --db <url> --url <site url> --out tests/fixtures/<name>`. Tests that need a fixture you have not generated will fail.
