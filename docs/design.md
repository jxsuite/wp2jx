# wp2jx design

wp2jx migrates a Cwicly WordPress site into a Jx project. This document is the shared ground truth: what the source looks like, what the target requires, and the rules that connect them. `src/types.ts` holds the module contracts.

Jx is the framework at `/home/batonac/Development/jx` (npm: `@jxsuite/*`). Its `specs/` are normative and its `docs/` describe shipped behaviour. Cite those, not this file, when the two disagree, and say so in your report.

## Decisions (made by the user)

- **Pages** (WordPress `page`) become Jx **JSON pages** (`pages/**.json`).
- **Posts and every custom post type** become **Markdown content collections** (`content/<type>/*.md`), with Cwicly structure inside an entry expressed as Jx directives, even for layout-heavy entries.
- Pilot site: **finelinepainting** (fixtures `tests/fixtures/fineline`, live at https://finelinepainting.pro). Second: **anabaptistperspectives** (`tests/fixtures/ap`, https://anabaptistperspectives.org). littlecocalico is deferred.
- Media: download one original per image-size family into `public/media/…` so Jx's image pipeline optimises it.
- Language: TypeScript on Bun (the `@jxsuite/*` packages export `.ts` source, so only Bun imports them directly). The database is read through `Bun.SQL`, `mysql://` or `sqlite:`.
- Nothing is dropped silently. Everything unconverted lands in the migration report with a location and public URL.

## Source: what a Cwicly site is

### Block markup is not final output
`post_content` is serialized Gutenberg blocks. Cwicly's `save()` writes HTML containing render-time **tokens** that PHP resolves per request, so the stored HTML cannot be trusted. **Block attributes are the source of truth.** Tokens are `{name=arg=arg}` or `<ccd>name=args</ccd>`; unknown ones are returned verbatim by PHP:

- ids and classes: `{idadd}`/`{loop-id}` (loop suffix), `{loop-index}`, `{class}` (classID), `{acl}`/`{sacl}` (additional classes), `{gcl}` (global class names), `{aclv}`/`{gclv}`/`{cs-index}` (component variant classes), `{cccomp}`, `{currentpageclass}`, `{darkmode_force=…}`
- images: `{image=ID}`, `{imagealt=ID}`, `{imagesrc=ID}`, `{imageset=ID}` (srcset), `{imagesizes=…}`, `{imagewidth=ID}`, `{imageheight=ID}`, `{featuredimage}`, `{bgfeaturedimage}`, `{attachmenturl}`, `{svg…}`, `{acfgallery}`
- post/site data: `{postcontent}`, `{title}`/`{post_title}`, `{postexcerpt}`, `{pagetitle}`, `{archivetitle}`, `{archivedescription}`, `{sitetitle}`, `{sitetagline}`, `{siteoption}`, `{id}`, `{posttype}`, `{postcategories}`, `{posttags}`, `{postdate}`, `{currentdate}`, `{customfield=key}`, `{authorname}`, `{shortcode=…}`, `{readtime}`
- ACF: `{acffield=<field>=<location|false>=<subkey>=<fallback>=<opts>}`, `{acfrepeater=…}`, `{acfvideo…}`
- URLs: `{pageobject=ID=type=kind}` (permalink of a post, term or archive), `{pageurl}`, `{archiveurl}`, `{homeurl}`, `{siteurl}`, `{loginurl}`, `{authorurl}`, `{previouspost}`/`{nextpost}`, `{taxonomytermsurl}`
- queries: `{taxterms}`, `{termquery}`, `{postquery=…}`, `{pagination}`, `{filter…}`
- menus and UI: `{menu}` (a rendered nav), `{menuname}`, `{nav_menu=ID}`, `{hide}`, `{return=fn}`, `{empty}`, `{slider=…}`, `{tab_state}`
- components: `{component=parameter=<propId>[=boolean|lg|video…]}`, `{component=class|link|image|icon|gallery=<propId>}`; the child block also carries `componentConnectors:{content:{ref:<propId>}}`
- `{shell=name}` Tailwind shells; about 60 WooCommerce tokens (out of scope).

### Blocks (50 types; each is "static save plus server post-processing")
- Layout/text: `section` (default tag `<section>`), `div`, `container`, `styler`, `columns` (`columnsTemplateColumns:{lg,sm}`, gaps), `column`, `heading` (`headingTag`, `content`), `paragraph` (`content`), `list` (`listTag`, `listOrdered`, `listIcon*`), `button`/`navlink` (`content`, `buttonIcon*`), `icon` (`iconIcon`, `iconLibrary`), `svg` (`inlineSvg`), `image` (`imageID`, `imageURL`, `imageAlt`, `imageThumbnailSize`, `imageLightbox`, `lazyLoad`), `video`, `gallery` (`galleries`, `galleryDynamic*`), `maps`, `code` (`code`, `codeCSS`, `codeJS`, `codeRender`), `hook`, `fragment`, `content` (post-content slot in templates).
- Interactive: `accordions` > `accordion` > `accordionheader`/`accordioncontent` (`accordionOpen`, `accordionGroup`), `tablist` > `tab`, `tabcontents` > `tabcontent`, `modal`, `popover`, `slider` > `sliderchild`, `nav` > `navitems` > `navlink`/`navmenu`/`navdropdown`, `menu`, `input`, `filter` > `rangeslider`, `swatch`.
- Data: `query` (about 100 `query*` attrs, each `{source,type,group,field}`; `frontendRendering`), `query-template`, `query-pagination`, `query-pagination-numbers`, `repeater` (`dynamic`, `dynamicACFGroup`, `dynamicACFField`), `taxonomyterms`, `component` (`ref`, `properties`, `variant`, `variations`, `serializedInnerBlocks`), `innerblocks`.
- There is no `cwicly/link`: any block with `linkWrapperActive` is a link (`linkWrapper*`, about 80 attrs: Url, Type, Action, SourceType, SourceDynamic).
- Attributes common to every block: `uniqueID`, `id` (HTML id, e.g. `heading-c008b94`), `classID` (per-block CSS class, e.g. `heading-c34c93b`), `anchor`, `isStyling` (block has its own styles, so classID is emitted), `htmlRender` (cached opening tag), `additionalClass[]`/`additionalClassesR`, `globalClass[]` (ids into `cwicly_global_classes`), `htmlAttributes[]`, `customCSS`/`customSCSS`, `relativeStyles[]`, `pseudoClasses[]`, `hideConditions[]` (+`hideConditionsType` `&&`/`||`, `hideLoggedIn`, `hideGuest`), `interactions{}`, `tooltip*`, `animateOnScroll*`, `containerLayoutTag`.
- `hideConditions` entries are `{condition, operator, data, key, acfGroup, …}`; conditions include `device`, `posttitle`, `userrole`, `acf`, `urlparameter`, `cookie`, `querycount`.

### Styling
- Each CSS property is its own block attribute whose value is an object keyed by **breakpoint + pseudo concatenated**: `{lg:"90px", md:"…", lghover:"…", smbefore:"…"}` (`marginTop`, `containerLayoutDisplay`, `fontSize`, …). Built-in pseudos: `hover`, `active`, `focus`, `before`, `after`; custom ones in option `cwicly_pseudos`. Component-variant keys are `cs<bp><variantId>` (e.g. `cslgbmuh8n`), relativeStyles keys are `rs<bp><id>`.
- **The CSS is compiled in the editor's JavaScript** and saved as files; it never lives in post meta. It is served from `/wp-content/uploads/cwicly/`: `css/cc-post-<ID>.css`, `css/cc-tp-<theme>_<slug>.css` (templates and parts, `cc-tp-cwicly_header.css`), `css/cc-cm-<reference>.css` (components), `css/cc-rb-<wp_blockID>.css`, plus `cc-global-classes.css`, `cc-global-stylesheets.css`, `cc-main.css`. **These files are the primary source for styles**; the converter parses them back into Jx style objects. The generator is about 135 KB of minified code (module `ZP` in the plugin's `build/index.js`); do not try to extract it.
- **Output shape (measured over 155 real files, 11,484 selectors):** most rules are a flat `.classID`, but 1,354 selectors are descendant forms (`.cls svg`, `.cls > div:nth-of-type(1)`, `a.cls, .cls a`), 26 are `a.cls`, 21 two-class compounds, 5 `:where(.a .b)`, plus `body` and `fieldset#id` from user custom CSS. Pseudos append `:hover`/`:before`/`:after`. The same selector can appear in several rules (merge them). Output was autoprefixed, so `-moz-column-gap`-style duplicates appear; the only prefixed VALUES are `-webkit-fit-content`/`-moz-fit-content` on width/height. Per-post files begin with an empty placeholder rule for every block, `cc-global-classes.css` begins with an `@media` block (user CSS) before its base rules, and `max-width:992px` appears both with and without a space.
- **Breakpoints** (option `cwicly_breakpoints_list`, a JSON string): default `{"lg":{width:1366,isMain:true},"md":{width:992},"sm":{width:576}}`. Breakpoints listed *before* the main one are `@media screen and (min-width: Wpx)` (sorted ascending); those *after* are `@media screen and (max-width: Wpx)` (sorted descending). The exact width is used (no `.98`). Real files only contain `max-width: 992px` and `max-width: 576px`.
- **Artefacts to detect and report, never emit:** `!var=<id>!` (a palette reference Cwicly's generator never resolved: it is usually repairable against the active palette with `resolvePaletteRefs`, and only a truly dangling id is lost; 1 occurrence in the fixtures, 5 in ap's full CSS directory), `.undefined{}` empty rules (90 of 96 `undefined` selectors) and a glued `undefinedsection-c0c88bd p` member (6, after a valid first list member), `width:[object Object]px`, a mangled selector `.cc-nav-toggle){…}`, unresolved `{…}` tokens (none in the real files; only synthetic tests cover them).
- **Global classes:** option `cwicly_global_classes` (JSON string `{<id>:{attributes:{classID,…style attrs}}}`), compiled to `cc-global-classes.css`; folders in `cwicly_global_classes_folders`.
- **Option formats vary:** Cwicly options are JSON strings, PHP-serialised arrays (`cwicly_global_parts`, `cwicly_global_classes_rendered`, `cwicly_optimise`, `cwicly_deprecated`, `cwicly_section_defaults`, …) or plain text (`cwicly_global_css`, `cwicly_global_fonts`, `cwicly_global_stylesheets_rendered`, `cwicly_db_version`). `cwicly_global_fonts` is HTML `<link>` text printed verbatim into every page's head (fineline's repeats one link 7 times). `cwicly_global_classes_rendered` is a stale PHP-serialised per-class cache, not a stylesheet. `cwicly_tailwind` is `'1'` on every site (the plugin default) and Tailwind is only served for the string `'true'`, so it is off. Per-block Google fonts arrive only as `@import` in per-post CSS, not in any option. `theme_mods_cwicly.nav_menu_locations` maps `cc-menu` to the nav menu term, needed to resolve the `{menu}` token. Read all of it through `readCwiclyOptions`.
- **Global styles:** option `cwicly_global_styles` (JSON string `{activeStyle:"style1",styles:{style1:{colors:[{id,name,color,variable:"cc-color-1"}],globalElements:[{tag:"h1",value:{fontSize:{lg}}}],typography:[…]}}}`), colours referenced as `var(--cc-color-N)`; compiled to option `cwicly_global_css`. Fonts: `cwicly_global_fonts`, `cwicly_local_fonts`, `cwicly_local_active_fonts` (files in `uploads/cwicly/local-fonts/`). Custom CSS: `cwicly_global_stylesheets`. Other: `cwicly_custom_code` (GTM), `cwicly_tailwind*`.
- `customCSS` is **not** in the generated file: it is printed inline at render time with the tokens `blockclass`→classID, `blockid`→id, `breakpoint-md`/`media-breakpoint-md` expanded. Read it from the attributes.
- Colour attributes can hold `!var=<paletteId>!`, resolved against the `cwicly_global_styles` colours.
- The live site also loads Cwicly's own `assets/css/base.css` and `build/style-index.css` (resets and block defaults). They are in the plugin at `/home/batonac/Development/cwicly/assets/css/` and `build/`. A faithful result needs their effect; decide whether to ship `base.css` as `public/css/cwicly-base.css` linked from `$head` or port the rules.

### Structural classes and the plugin's own CSS
The live class list of a block element is `<classID> <global class names> <structural classes>`, e.g. `section-c93760b section-hero cc-sct`, `cc-cntr` on containers, `cc-nav…`/`cc-hamburger…` on navigation. The structural classes (`cc-sct`, `cc-cntr`, `cc-ovrl`, …) come from the block's saved opening tag (`<section class="section-c93760b {gcl} cc-sct">`: `{gcl}` is replaced by the global class names) and are styled by the **plugin's** CSS, not by the per-post files: `assets/css/base.css` (a reset), `build/style-index.css` (35 KB: `.cc-cntr,.cc-sct{width:100%}`, `.cc-cntr{margin-left:auto;margin-right:auto;max-width:1366px}`, all of `.cc-nav*`, `.cc-hamburger*`, `.cc-menu*`), `assets/css/gallery.css` and `assets/css/aos.css` when those features are used. Block elements carry **no `id` attribute** on the live site (the attribute `id` is editor-side only). Decision: keep the structural classes exactly as the live HTML has them, and ship the plugin CSS the live pages load as a compatibility stylesheet `public/css/cwicly-base.css`, linked first in `project.json` `$head`. The list of files a page loads is in its `<link rel="stylesheet">` tags (see `tests/fixtures/*/html`); the plugin copy lives at `<site checkout>/wp-content/plugins/cwicly/` and is also served from `<site>/wp-content/plugins/cwicly/`. Cwicly's JavaScript behaviours (nav toggle, accordion, modal, slider, lightbox, AOS) are never ported: use native elements (`<details>`, `popover`) or report.
- More real CSS artefacts: `width:[object Object]px` (a JavaScript object stringified into a value), `.cc-nav-toggle){…}` (a mangled selector).

### Components, templates, parts
- **Components** are posts of type `cc_block` (REST base `components`). Meta: `reference` (a 10-char random string), `properties` (`{propId:{name,type,default,options,responsive,isDynamic,…}}`), `propertyGroups`, `variants[{id,name}]`, `variantGroups`, `styleVariations`, `preview`. An instance is the block `cwicly/component` with `ref` = the `reference` meta (NOT the post id), `properties{propId:{value|value.maker|parent}}`, `variant`/`variations` (become `cs-<variant>` classes), and `serializedInnerBlocks` for slot content (rendered by a `cwicly/innerblocks` inside the component). Children bind to props via the tokens above. Blocks inside a component are marked `isComponentChild:"<reference>"`.
- **Templates** are core FSE: `wp_template`, `wp_template_part` (no custom post type). Display rules are in option `cwicly_conditions`: `{include:{<templateSlug>:{all,singular[],archive[],author[],acf[],custom[],includeCondition,priority,statusCode}},exclude:{<slug>:{…,excludeCondition}}}`; `cwicly_pre_conditions` is a separate editor-side model. Global header/footer/fragments: option `cwicly_global_parts.fragments[<name>].conditions`, rendered by `cwicly/fragment`.
- Plain WordPress reusable blocks (`wp_block`, `core/block`) are supported; CSS is `cc-rb-<id>`.

### Other WordPress facts
- ACF (secure-custom-fields): post types and taxonomies are `acf-post-type`/`acf-taxonomy` posts (PHP-serialised settings in `post_content`), field groups `acf-field-group`, fields `acf-field`. Values are post meta (`field_name` → value, `_field_name` → field key); taxonomy values are term meta.
- Rank Math SEO: post meta `rank_math_title`, `rank_math_description`, `rank_math_facebook_image`…; redirects in the `rank_math_redirections` table (`sources` is PHP-serialised `[{pattern, comparison, ignore}]`, `url_to`, `header_code`, `status`).
- Menus: `nav_menu_item` posts (`_menu_item_*` meta) joined to `nav_menu` terms; plus `wp_navigation`.
- Attachments: `_wp_attached_file`, `_wp_attachment_metadata` (PHP-serialised; `sizes`), `_wp_attachment_image_alt`.
- Dates: MySQL DATETIME columns come back as `Date`, SQLite ones as `"YYYY-MM-DD HH:MM:SS"` strings. `post_date_gmt` is NULL (SQLite) or an invalid Date (MySQL) on drafts: `loadModel` falls back to `post_date` converted from the site's timezone. Attachment width/height can be strings, `false` or absent (SVGs; 254 ap attachments).

## Target: Jx facts that decide the output

Verified against the specs and by running `jx build`. Read the normative specs (`/home/batonac/Development/jx/specs/`) for anything not listed.

- **Layout on disk:** `project.json` and `pages/` required; optional `layouts/`, `components/` (flat: the build compiles only files directly in `components/`), `content/<collection>/`, `data/`, `public/` (copied verbatim), `styles/`. Files under `pages/` starting with `_` are not routed. `pages/about/team.json` → `/about/team/`; `about/index.json` → `/about/`. `[slug].json` is a dynamic page.
- **project.json keys** (unknown keys are rejected): `name`, `url`, `defaults.{layout,lang}`, `$head`, `$media`, `style`, `state`, `redirects`, `imports`, `extensions`, `content`, `copy`, `$elements`, `build{…}`, `images`. Markdown needs `"extensions": ["@jxsuite/parser"]`.
- **`$media`**: keys are declared without `@` and referenced as `@--md`: `{"--":"1366px","--md":"(max-width: 992px)","--sm":"(max-width: 576px)"}`; `"--"` is the base width.
- **Global rules:** `project.json` `style` accepts `--*` custom properties (land on `:root`), plain properties (land on `body`) and selector keys (`h1`, `.card`) emitted **unscoped**. A class rule: `".card": {"padding":"1rem", ":hover": {…}, "@--md": {"padding":".5rem"}}`. Project-level rules are emitted **before** every element's own rules, which matches Cwicly's own cascade (global classes first, then the page's CSS).
- **Element shape:** `tagName`, `textContent`, `children` (strings and nodes mixed), `className`, `id`, `attributes{}`, `style{}` (camelCase; nested keys beginning `:`, `.`, `&` or `[`; at-rules `@--md` / `@(min-width:…)`), `innerHTML`.
  - **`href`, `src`, `alt`, `type`, `name`, `aria-*`, `data-*` go under `attributes`.** Top-level they are dropped by the static emitter.
  - **Never emit `attributes.class` next to `className`/`style`:** two class attributes result and the browser keeps the first.
  - **Style scoping (verified by build).** An element's own `style` is written to a selector chosen like this: `#id` if the element has an `id`; else `.` + the **first** word of `className`; else a generated `jx-N`. An element with `className:"card"` and its own style therefore writes its rules onto every `.card` on the site. So **put the block's unique `classID` FIRST in `className`** (`"div-cf3ac5e card section-default"`): the rules land on `.div-cf3ac5e`, which is exactly Cwicly's own selector, nothing leaks, specificity matches Cwicly's (`.classID` is 0,1,0, so a global class's `:hover` rule still beats a block's base rule, as it does on the live site), and `relativeStyles`/`customCSS` selectors keep working. Do **not** set `id` on every styled element: `#id` (1,0,0) would beat global classes' `:hover` states, and an element inside a component repeats its id in every instance. Nested keys work as expected: `"& a"` → `.cls a`, `"&:is(a)"` → `.cls:is(a)` (the same specificity as `a.cls`), `"@--md"` → `@media (max-width: 992px)`.
- **`htmlToJx` (`@jxsuite/markup/html-to-jx`) is not good enough as is** (verified): it puts `class` and `id` under `attributes` (never `className`/`id`), leaves inline style keys kebab-case (`margin-top`; Jx wants camelCase), drops whitespace-only text between inline siblings (`<a>x</a> <b>y</b>` loses its space), and mangles SVG attributes (`stroke-width` → `strokeWidth`, which is invalid SVG). wp2jx ships its own converter (`src/html.ts`).
- **SVG:** a `{"tagName":"svg","attributes":{…},"innerHTML":"<path …/>"}` element builds to correct inline SVG (verified).
- **Pages:** `{title, $layout?, $head:[{tagName:"meta",attributes:{name:"description",content:"…"}}], $elements?, state?, children:[…]}`. `title` becomes `<title>`; `$head` entries use `attributes` (top-level `name`/`content` are silently dropped); `$head` `title` entries are ignored. **Without a `$layout` the page's `title` also lands as a `title="…"` attribute on the root element** (a tooltip over the whole page), so every emitted page uses a layout (`defaults.layout` in `project.json`, or `$layout`). When a layout is applied, the page root element itself is dropped and only its children are slotted. Layouts live in `layouts/*.json` as body content (not `<html>`), with one `<slot>`; `$layout` paths are project-root-relative (`"./layouts/base.json"`).
- **Components:** a JSON document `{tagName:"fp-icon-card", state:{label:""}, children:[…]}` (kebab-case with a dash and a prefix). Declared inputs are `state` defaults; an instance passes `$props`. Register through `$elements: [{"$ref":"../components/x.json"}]` (an **array**) on the page, layout or collection, then use the tag. A `{$ref}` directly in `children` renders an empty div. Use only a single default `<slot>` (named slots break in built output). Components go flat in `components/`.
- **Collections:** `project.json` `content.<name> = {source:"content/<name>", format:"Markdown", schema:{type:"object",properties,required}, $elements?}`. Entry id = path relative to the source (nested folders allowed; no frontmatter override of the id). A collection with no `$elements` parses **no** directives (they render as literal text): declare `$elements` for every component used in entries. Render entries from `pages/<base>/[slug].json`:
  ```json
  "$paths": {"contentType":"projects","param":"slug","field":"slug"},
  "state": {"entry": {"$prototype":"ContentEntry","contentType":"projects","field":"slug","id":{"$ref":"#/$params/slug"},"$src":"@jxsuite/parser/ContentEntry.class.json"}}
  … {"tagName":"div","children":"${state.entry.$children}"}
  ```
  Lists use `{"$prototype":"ContentCollection","contentType":…,"filter":…,"sort":…,"limit":…}` and `{"$prototype":"Array","items":{"$ref":"#/state/x"},"map":{…}}` with `$map.item.x`. There is no pagination yet (`limit` only). Drafts are NOT filtered by the build: exclude them at import. There is no taxonomy primitive: tags are frontmatter arrays, tag pages come from `$paths` `{values:[…],param}`.
- **Markdown dialect** (`specs/jx-markdown.md`): YAML frontmatter (any key passes through); containers `:::name{…}`, leaves `::name{…}`, inline `:name[text]{…}`; attribute dot-paths (`props.title=`, `style.--md.gridTemplateColumns=`, `className=`, `id=`); outer containers use more colons. Always emit through **`serializeJxMarkdown(doc, {mode:"roundtrip"})` from `@jxsuite/parser/serialize`**, never by hand, and re-parse with `transpileJxMarkdown` in tests. Footnotes and reference-style links/images are dropped by the parser.
- **Redirects:** `project.json` `redirects`: `{"/old":"/new","/a/*":{"destination":"/b/*","status":301}}`.
- **Media:** `public/media/YYYY/MM/file.jpg` referenced as `/media/YYYY/MM/file.jpg`. Collapse WordPress `-WxH`/`-scaled` derivatives to the largest original and drop `srcset`/`sizes`; Jx regenerates them. Reference implementation: `/home/batonac/Development/jx/packages/import/src/image-family.ts` (not exported; copy the logic).
- **Validation/build:** `node_modules/.bin/jx schema` (generates `project.schema.json`; `jx validate` fails with "project.schema.json not found" until it has run), then `jx validate` and `jx build` (cwd = the project; a tiny project builds in 0.2 s here). `tests/helpers/jx-build.ts` wraps all of it. `jx validate` checks `project.json` and every file under `pages/`, `components/`, `layouts/`. Output must pass both. Sharp cannot load on this NixOS machine; if a build with images fails because of it, say so rather than working around it in the converter.
- **Pitfalls in `@jxsuite/import`:** never use `emitMultiPageProject` (it strips every class); import from subpaths, because the package root loads puppeteer-core.

## Mapping rules

| Source | Target |
|---|---|
| `cwicly_breakpoints_list` | `$media` (`--` base = main breakpoint width; other keys `--<bpkey>` with `(max-width: Wpx)` / `(min-width: Wpx)`) |
| `cwicly_global_styles` colours/fonts/typography/elements | `project.json` `style` custom properties (`--cc-color-N` kept), tag rules; fonts via `$head` link or `public/fonts` + `@font-face` |
| `cwicly_global_classes` | `.<classID>` rules in `project.json` `style`, from `cc-global-classes.css` |
| per-block style attributes | the block's `classID` rules from its `cc-*.css` → the element's `style`, with `classID` first in `className` |
| `customCSS` / `relativeStyles` | nested keys (`& a`, `& > div:nth-of-type(1)`) in the element's `style` |
| `hideConditions` `device` | `display:none` at the matching `@--bp` |
| other `hideConditions`, `interactions`, animations | dropped, reported |
| `cc_block` | `components/<prefix>-<slug>.json`; props → `state`; `{component=parameter=…}` → `${state.<prop>}` |
| `cwicly/component` instance | custom-element tag + `$props` (+ variant as className) |
| `cwicly/innerblocks` | one default `<slot>` |
| accordion | `<details>`/`<summary>` |
| modal / popover | `popover` attribute + `popovertarget` |
| tabs, slider, lightbox, image-compare | plain fallback + report |
| `page` | `pages/<page uri>.json` (front page `pages/index.json`), `title` + `$head` from Rank Math |
| `post`, CPTs | `content/<type>/<slug>.md`, frontmatter from ACF/terms/SEO; schema generated from ACF groups |
| ACF-heavy entries with empty content | frontmatter only; the layout template renders it |
| `wp_template` single/archive/taxonomy | `pages/<base>/[slug].json` (`$paths`+`ContentEntry`), archive pages with `ContentCollection` |
| header/footer parts | components; `page`/`single` templates → `layouts/*.json` |
| `cwicly/query` | `ContentCollection` + `Array` |
| menus (`nav_menu_item`, `cwicly/menu`) | nav component with resolved URLs |
| Rank Math redirects + route changes | `project.json` `redirects` |
| attachments | one original per family under `public/media/…` |
| `fluentfom/*`, shortcodes, WooCommerce | placeholder component + report |

## Entry data contract

Collection entries (Markdown frontmatter) and the bindings in entry templates must agree on key names. A template reads an entry through `ctx.entryExpr` (`state.entry`, or `$map.item` inside a query loop) as `${<entryExpr>.data.<key>}`, the rendered body as `${<entryExpr>.$children}`, and the entry id as `${<entryExpr>.id}`. Frontmatter keys (collections emitter) and binding paths (dynamic resolver) are exactly:

| Key | Content |
|---|---|
| `title`, `slug`, `date`, `modified`, `excerpt` | the post's own fields (`date`/`modified` RFC 3339) |
| `author` | the author's display name |
| `url` | the entry's public path in the Jx site (`/projects/foo/`) |
| `featuredImage` | `{src, width, height, alt}` or absent |
| `terms` | `{<taxonomy>: [{slug, name, url}]}`, one array per taxonomy the post carries |
| `<acfFieldName>` | an ACF value by field type: text/textarea/wysiwyg/number/date/select/true_false → string, number or boolean (wysiwyg stays HTML); image → `{src, width, height, alt}`; gallery → array of those; link → `{url, title, target}`; repeater → array of row objects keyed by sub-field name; group → object; relationship/post_object/taxonomy → array of `{id, slug, title, url}`; url/email → string |
| `seo` | `{title, description, image, robots}` from Rank Math |

Image values are produced at emit time from attachment ids, so templates never see ids.

## The two fixture sites

### finelinepainting (the pilot)
siteurl https://finelinepainting.pro, permalinks `/%postname%/`, prefix `KjLnF_`, theme `cwicly`, Cwicly DB 1.4.7, front page 5246 ("Home-current", slug `home-2`), posts page 2588. Published: 11 pages (+2 private), 11 posts, 82 `project` (+2 private; 25 have empty content and render from ACF), 19 `service`, 13 `wp_template`, 3 `wp_template_part` (header, footer, old header), 2 `cc_block` ("Icon Card" ref `0a275b695a`, "Image card" ref `244868a12d`; 161 + 128 instances), 1 `wp_block`, 1 `wp_navigation`, 45 `nav_menu_item`, 1,233 attachments (local media, about 680 MB). 6,438 blocks: 4,964 cwicly (heading 966, div 845, container 548, section 527, paragraph 474, image 425, component 290, column 278, columns 193, button 121, icon 70, gallery 64, query 58, query-template 58, navlink 23, filter 2…), 1,460 core. ACF post types `project` and `service` (hierarchical, archives), taxonomies `project_tag`, `location` (slug `service_area`, has ACF term fields), `project_type`, `service-type`; 34 global classes; 22 colours; body font Source Sans Pro 20px; breakpoints lg 1366 / md 992 / sm 576. All 58 queries use `source:"static"`. Dynamic features: Fluent Forms (5 forms), Trustindex reviews shortcode, one Interactive Geo Map shortcode, `icb/image-compare` (11), YouTube embeds, Google Maps iframe in the footer, GTM. 67 Rank Math redirect sources (57 table rows; some rows hold two sources).

### anabaptistperspectives (the core-heavy second site)
siteurl https://anabaptistperspectives.org, prefix `wp_`, permalinks `/essays/%postname%/`, static front page 819 ("welcome"), posts page 830 ("essays"). About 102 posts (almost pure core blocks: paragraph 2,373, group 217, heading 161, list 66, quote 67, verse 11) plus `episode` 505 (thin ACF wrapper pointing at a `captivate_podcast` post; 79 premium), `captivate_podcast` 784 (classic HTML, no blocks), `supporters_update` 13; 30 pages that are Cwicly; 20 `wp_template`, 7 `wp_template_part`, 7 `wp_block`, 6 `cc_block`. 70 distinct block names (966 cwicly, 3,776 core, plus stale `drupalblock`, `ideabox`, `lazyblock`). Taxonomies `post_tag` 183, `series` 33, `category` 15, `season` 5. 400 Rank Math redirect sources (391 table rows). Footnotes in post meta (`footnotes`, 1,032 rows). Fixtures keep at most 100 posts of each non-structural type, so the counts above describe the live database, not the fixture.

## Report

`migration-report.md` and `migration-report.json`, grouped by severity then code, each entry with a location and public URL. It is the punch list per site. Codes are stable kebab-case, namespaced (`block.unsupported`, `css.artifact`, `token.unresolved`, `option.malformed`, `condition.dropped`, `interaction.dropped`).

## Verification

- Unit tests per module against the fixture rows (`tests/helpers/fixture-db.ts`), CSS files and rendered HTML under `tests/fixtures/<site>`.
- CSS oracle: Cwicly's own generated CSS must round-trip through `cwicly/css.ts`.
- Serializer oracle: every emitted `.md` re-parsed by `transpileJxMarkdown` reproduces the tree it came from.
- Pilot end to end: `wp2jx convert`, then `jx validate` and `jx build` pass in the output, then `wp2jx verify` screenshots each URL against the live site.

## Field notes from building the foundations

Things the first modules found by running real data and real builds. They override anything above that disagrees.

**Jx emitter behaviour (verified by building; some are upstream Jx bugs, worked around here)**
- The static, client and element emitters join sibling children with a newline and two spaces, which is visible between inline siblings (`Hello <b>x</b>.` renders `x .`). Put inline content in ONE element via `htmlToContent(html)` (`src/html.ts`: returns `{textContent?, children?, innerHTML?}` to spread into the element) instead of building inline children by hand.
- `textContent` is HTML-escaped, which breaks `<script>`/`<style>` text: use `innerHTML` for those.
- A literal dollar-brace in text is NOT escapable the way the spec implies; only the character reference `&#36;{` works. `escapeTemplate` (`src/jx-util.ts`) does this and every text/attribute value we emit goes through it.
- The scope selector is not escaped: an id or first class like `x{idadd}` or `1st` yields an invalid rule and the element's style is silently lost. Resolve tokens first; never emit a classID that starts with a digit unescaped.
- Top-level `hidden`, `tabIndex`, `title`, `lang` and `dir` ARE emitted as attributes by the static emitter (only `href`, `src`, `alt`, `type`, `name`… are dropped).
- Every `<img>` gets `loading="lazy" decoding="async"`, even in a project with no `images` key.
- Inline `style` converted to a style object loses to any `!important` or more specific rule in Cwicly's compiled CSS, where on the source site the inline style won: `htmlToNodes` has an `inlineStyle: "attribute"` option for markup whose inline styles must keep winning.

**Source data**
- Rank Math: one `WpRedirect` per source, not per row (fineline 67 sources from 57 rows, ap 400 from 391).
- Attachment guids can sit on another host: 1,793 of 1,794 ap attachments are on `media.anabaptistperspectives.org`, one fineline attachment on `finelinepainting.avunu.io`. Download from the guid host or resolve `file` against the uploads base.
- classIDs repeat across posts with DIFFERENT declarations (a duplicated page keeps its block ids): 144 differing declarations among fineline's files, 37 in ap's. A `CssIndex` is built per subject (post, template, component), never merged across unrelated posts.
- Global class ids can dangle: 31 fineline blocks on 16 pages reference `3yEPq5XEDBJoOaj`, an id that no longer exists (it was `.icon-white`, recreated as `C0p333zURK0EsPV`); the live page prints no class for it. Report `class.dangling-global`, do not guess.
- Two ap global classes reference palette ids that belong to the littlecocalico palette (copied between sites): their colour declarations are lost and reported.
- A classID can contain a dot (`relevanssi-live-search-results.relevanssi-live-search-results-showing`: a compound selector used as a class name); the CSS reader files it under `other`.
- Component variant rules and Cwicly-internal compound rules live in `CssIndex.other` (selectors like `.<classID>.cs-…`); component converters find them by key.
- Default `loadModel` loads every post type except six bookkeeping ones (7,152 posts on ap including 3,780 `give_payment`): the CLI passes `postTypes` explicitly.

**Injected third-party markup on live pages**
A live page can carry markup that is not content and must never be migrated or compared: hidden spam links right after `<body>` and an async script from a lookalike CDN domain were seen on one pilot site. They are not in the database (the migrator never carries them over); the verifier masks them (`DEFAULT_NOISE` in `src/verify/browser.ts`). Treat any live fixture page the same way: a test must not take that markup for content.

## Field notes from wave 2 (styling, dynamic data, routes, design system, core blocks)

These override anything above that disagrees. `docs/bindings.md` is the authority for every `${...}` we emit.

**Bindings (see docs/bindings.md; each rule was measured by a real build)**
- Put `"timing": "compiler"` on every `ContentEntry` and `ContentCollection` of an entry template, or the page ships a client runtime. A single `${expr}` that yields `undefined`/`null` is NOT resolved by the build (the element comes out empty): always coalesce (`?? ''`, `|| false`).
- Never bind `className`, `id`, anything inside a nested style block, a text child in `children`, or the top-level `hidden`/`title`/`tabIndex`/`lang`/`dir`. Conditional rendering is `attributes.hidden` plus the element's own `"&[hidden]": {"display": "none !important"}` rule (`blockVisibility` returns both). Loops over entry data use `{"$ref": "#/state/entry/data/rows"}` pointers; an empty array makes the whole parent client-rendered, so repeaters that can be empty become an `innerHTML` expression.
- A literal dollar-brace in `textContent` or an attribute cannot be escaped (the earlier claim that `escapeTemplate` covers every text is wrong: it is the rule for `innerHTML` only; `tokens.ts` degrades the rare literal with a zero-width space and reports `token.literal-template`). Bindings pass through `htmlToNodes`/`htmlToContent` as private-use placeholders (`bindingMarker`, `finishBindings`, `finishNodes` in `src/jx-util.ts`/`src/cwicly/tokens.ts`): always finish nodes before they are emitted.
- Dates in entries are UTC strings; format with `toLocaleDateString` plus the site's time zone in the expression.

**Cwicly data**
- Block elements DO carry an `id` on the live site for nav, query, query-template, taxonomyterms, forms/inputs and any block with `forceShowID` (`BlockStyling.id`); never put an `id` on an element that has its own style (the style would scope to `#id`).
- Component-variant rules are two-class compounds `.div-xyz.cs-abc` (21+ selectors), plus `:where(.nav .x)` and `.query-container.filter-visible .query-episodes`; `CssIndex.other` holds rules whose first compound is not a lone class. `.a .b` is nested under class `a` as `& .b`, not in `other`.
- Tokens `{acl}`/`{sacl}`/`{aclv}`/`{gclv}`/`{cccomp}`/`{darkmode_force}` occur in 0 of 5,929 real tags (additional classes are written literally); only `{gcl}`, `{currentpageclass}` (308; a static site cannot know the current page, so active-link styling needs a Jx-side mechanism), `{cs-index}` and `{class}` occur.
- `customSCSS` (not `customCSS`) is what the plugin prints when `cwicly_scss_compiler` is on, and nothing when `customCSS` is empty even if `customSCSS` is set.
- Block style source over the fixtures: from the CSS index 4,152 (fineline) / 538 (ap) blocks, from the attribute fallback 506 / 65, from neither 16 / 351 (unstyled blocks), plus 290 / 12 component instances (no element). Some fineline stylesheets are stale (blocks edited after the CSS was written): the fallback then disagrees with the stale file, correctly. `menu*`/`nav*`, gallery filter, modal, slider, pagination, fluid font sizes and clip-path blob attributes are not ported by `attrStyle` (reported `style.attr-unsupported`).
- WordPress prints typographic quotes, dashes and ellipses (wptexturize) on the live pages where the saved text has ASCII ones, and Cloudflare obfuscates e-mail addresses (`[email protected]`): live pages are not the source of truth for raw text. `texturize`/`texturizeHtml` (`src/cwicly/tokens.ts`) port it; everything text we emit (core blocks, Cwicly text, entry titles/excerpts) is texturized at conversion, because after migration nothing else will.
- Only ap post 12549 has real footnotes (`core/footnotes`, `data-fn`); the ~1,000 `footnotes` meta rows are empty strings WordPress registers on every post. The ap essays' notes are hand-written `#noteN` anchors.
- The fixtures are not one snapshot: the live sitemap and CSS are newer than the dumps (fineline: 3 projects of the sitemap are missing from the dump; some CSS files are newer than their posts).
- Author data: the author's own ACF user fields (`currentauthor`, `userquery`, `user_N` locations) cannot be carried (no usermeta in the model): `dynamic.unsupported`. Comments, login, user queries, WooCommerce, filters, pagination, shortcodes, readtime and `return` tokens are dropped with `token.unresolved`.

**Jx behaviour found by building (several are upstream Jx bugs; the user owns Jx and may want them fixed)**
- The Jx Markdown parser reads any `N:M` in text (`John 3:16`, `12:30pm`) as a text directive and the serializer does not escape the colon: 67 of 436 fixture entries (every essay citing a verse) are damaged. The collections emitter must work around it and report.
- The build joins sibling children of a Markdown entry with a newline and indent, which shows as a space (`20 th`, `link .`); reported `block.inline-gap`. `serializeJxMarkdown` is not lossless: tables always promote the first row to header cells and lose colspan/rowspan, cell classes and alignment; `<br>` inside emphasis prints `&#xA;`; text beside an inline element in li/dd/figcaption/blockquote splits into paragraphs.
- `buildSiteStyleCSS` (@jxsuite/site 2.0.2) drops an `@font-face` given as an ARRAY at project style level, and `jx validate` rejects it; `@keyframes`, `@property` and `@counter-style` as single objects work. A family with several weights goes in a verbatim stylesheet.
- A template-string `hidden` makes the build write `data-bind :hidden` and ship the client runtime; use `attributes.hidden`.
- `redirects`: the build writes a wildcard destination verbatim into `_redirects`, and hosts want `:splat` (`"/docs/*": "/documentation/:splat"`), not `*`, despite what Jx's own docs show.

**Routes and entries**
- Entry ids are paths relative to the collection: `content/post/2024/03/hello.md`, `content/service/exterior/doors.md` for date structures and hierarchical CPTs, rendered by `pages/<base>/[...path].json` with `$paths {contentType, param: "path"}` (no `field`: the id is used). The slug-only form holds only for flat structures. Emitters write only routed entries (`RouteTable.all()`/`Route.file`): an entry with no route or that lost a collision gets no file.
- Rank Math redirects outrank live pages on the live sites (fineline `/hardwood-floor-refinishing/` 301s away from an existing page); 64 of fineline's 67 sources are active (ap 392 of 400); 159 (ap) and 11 (fineline) destinations were already dead (`redirect.dangling`). Plugin post types (ap `captivate_podcast`, fineline `grw_feed`, `igmap`) are not routed unless the CLI passes `RouteOptions.postTypes`.
- Bind the URL tools per subject: `urls.bind(ctx.report, where)` (`tests/helpers/ctx.ts` does).

**Design system and core CSS**
- Live CSS order: `base.css`, `style-index.css`, `cc-global-inline-css`, `cc-global-stylesheets.css`, `cc-global-classes.css`, then template/post CSS, then the theme's `style.css` (`body{position:relative}`: the only computed-style difference found in the browser check) and WordPress block-library inline CSS. WordPress "Additional CSS" (`custom_css` post of the active theme) prints last on ap. The theme CSS goes through `buildCompatCss({theme})` (`dirThemeCss`/`fetchThemeCss`); the assembler must pass it.
- The live pages print only `wp-block-library-inline-css` (the common sheet), one `wp-block-<name>-inline-css` per rendered block and `wp-img-auto-sizes-contain-inline-css`; no `global-styles-inline-css`, no `classic-theme-styles`. Only fineline's checkout has `wp-includes` (use it for ap too: the same WordPress 7.1). Groups and columns carry only `is-layout-*` classes with no layout rules, so converted groups, columns and buttons are not flex containers unless `coreBlockStyle` supplies it.
- `DesignSystem.customCode.bodyOpen`/`.footer` and `CoreBlockStyle.verbatim` are returned for the assembler/layout emitter to place; `fontDownloads` and `files` are written by the assembler. Dark mode is reported, never applied.
