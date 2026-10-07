/**
 * ACF (Secure Custom Fields) → what the converter needs: the schema of every post type, taxonomy and
 * field, which field groups apply to which post or term, the values those fields hold, and those
 * values in the shapes of the entry data contract (docs/design.md).
 *
 * Everything here is read from the WordPress model, never from PHP. ACF keeps its own definitions as
 * posts: `acf-post-type` and `acf-taxonomy` (the registered types), `acf-field-group` and `acf-field`
 * (fields hang under a group, or under another field through `post_parent`), each with its settings
 * PHP-serialised in `post_content`. A field's key is `post_name`, its label `post_title` and its name
 * `post_excerpt`. A group is active when its status is `publish`; ACF's own "inactive" is the status
 * `acf-disabled`, and an inactive group is applied to nothing, exactly as ACF applies it to nothing.
 *
 * The values live in meta: the field's name holds the value and `_<name>` holds the field key. ACF
 * names nested data by position (`<repeater>_<n>_<sub>`, `<group>_<sub>`, a flexible content field's
 * rows likewise), and `load_value` reads a meta row only when it exists: a field with no row at all
 * answers its default, which is why {@link acfValues} applies `default_value` the same way.
 *
 * The module is independent of the media and routes modules: {@link toEntryData} asks the caller for
 * the attachment, post, term and user objects through {@link EntryHooks}.
 */
import type { Report, WpModel, WpPost, WpTerm } from "../types.ts";
import { publicUrl } from "./model.ts";
import { userProfiles } from "./profiles.ts";
import { maybeUnserialize } from "./phpser.ts";

// ── Public types ─────────────────────────────────────────────────────────────────────────────────

/** The post types ACF keeps its own definitions in. A `loadModel` call must load them (`postTypes`). */
export const ACF_POST_TYPES = [
  "acf-post-type",
  "acf-taxonomy",
  "acf-field-group",
  "acf-field",
  "acf-ui-options-page",
] as const;

/**
 * The statuses ACF's definitions come in. A model loaded with an explicit `statuses` list must include
 * `acf-disabled`, or the groups that were switched off are not in it at all (and so cannot be reported).
 */
export const ACF_POST_STATUSES = ["publish", "acf-disabled"] as const;

/** The frontmatter keys of the entry data contract; an ACF field of the same name is renamed. */
export const BASE_KEYS: readonly string[] = [
  "title",
  "slug",
  "date",
  "modified",
  "excerpt",
  "author",
  "url",
  "featuredImage",
  "terms",
  "seo",
];

export interface AcfPostType {
  /** The registered post type name (`post_type`), also this entry's key in the map: `project`. */
  slug: string;
  /** ACF's own key for the definition (`post_name` of the `acf-post-type` post): `post_type_64fc5e8e5d94d`. */
  key: string;
  /** The `acf-post-type` post. */
  postId: number;
  /** False when ACF has the definition switched off: WordPress never registers such a type. */
  active: boolean;
  singular: string;
  plural: string;
  hierarchical: boolean;
  /** `false`: no archive; `true`: an archive at the rewrite slug; a string: the archive's own slug. */
  hasArchive: boolean | string;
  /** The URL base of the type's posts. `false` when ACF turned pretty permalinks off for it (`?project=slug`). */
  rewriteSlug: string | false;
  /** Whether the site's permalink front base (`/essays/` of `/essays/%postname%/`) is put before the slug. */
  rewriteWithFront: boolean;
  supports: string[];
  /** Taxonomies the post type lists; a taxonomy can also claim the type from its own side ({@link taxonomiesFor}). */
  taxonomies: string[];
  public: boolean;
  /** Every label, as stored. */
  labels: Record<string, string>;
}

export interface AcfTaxonomy {
  /** The registered taxonomy name, also this entry's key in the map: `location`. */
  slug: string;
  key: string;
  postId: number;
  active: boolean;
  singular: string;
  plural: string;
  objectTypes: string[];
  hierarchical: boolean;
  /** The URL base: `service_area` for `location` on fineline. `false` when permalinks are off for it. */
  rewriteSlug: string | false;
  rewriteWithFront: boolean;
  /** Whether a child term's URL carries its parents' slugs. */
  rewriteHierarchical: boolean;
  public: boolean;
  labels: Record<string, string>;
}

export interface AcfChoice {
  value: string;
  label: string;
}

/** One rule of a field's conditional logic; a field is shown when ANY group has ALL its rules true. */
export interface AcfCondition {
  /** The key of the field the rule looks at. */
  field: string;
  operator: string;
  value: string;
}

export interface AcfLayout {
  key: string;
  name: string;
  label: string;
  /** `block`, `table` or `row`: how the editor draws it. */
  display: string;
  min?: number;
  max?: number;
  subFields: AcfField[];
}

/** What a clone field copies and how it names the copy. */
export interface AcfClone {
  /** Group keys (`group_…`) and field keys (`field_…`) the clone copies. */
  selectors: string[];
  /** `seamless`: the copies sit in the parent as if they were its own fields; `group`: one object. */
  display: "seamless" | "group";
  /** Whether a copy's name is the clone's name plus `_` plus its own. */
  prefixName: boolean;
  prefixLabel: boolean;
}

export interface AcfField {
  /** `field_6985035a0b7cb`: stable, and what `_<name>` meta points at. */
  key: string;
  /** The `acf-field` post. */
  postId: number;
  /** The meta name (`post_excerpt`). Empty on the types that hold no value (tab, accordion, message). */
  name: string;
  label: string;
  type: string;
  required: boolean;
  instructions: string;
  menuOrder: number;
  conditionalLogic: AcfCondition[][];
  /** select, radio, checkbox, button_group; empty for every other type. */
  choices: AcfChoice[];
  /** Whether the field holds a list: a multi select, a checkbox, a gallery, a relationship… */
  multiple: boolean;
  /** `return_format` as ACF has it (`array`, `url`, `id`, `object`, `value`, `label`…). */
  returnFormat?: string;
  /** Row limits of a repeater, bounds of a number or range. */
  min?: number;
  max?: number;
  /** `default_value`, which ACF answers when a post has no meta row for the field. */
  default?: unknown;
  /** repeater and group: the fields inside. clone: the fields it copies, resolved. */
  subFields: AcfField[];
  /** flexible_content only. */
  layouts: AcfLayout[];
  clone?: AcfClone;
  /** The settings exactly as stored, for everything above that is not a field of its own. */
  settings: Readonly<Record<string, unknown>>;
}

export interface AcfLocationRule {
  param: string;
  operator: string;
  value: string;
}

export interface AcfGroup {
  key: string;
  postId: number;
  title: string;
  menuOrder: number;
  /** `publish`; every other status (`acf-disabled`) is ACF's "inactive". */
  active: boolean;
  status: string;
  /** Rule groups OR together; the rules inside one AND. */
  location: AcfLocationRule[][];
  /** The group's top-level fields, in editor order. */
  fields: AcfField[];
}

export interface AcfOptionsPage {
  /** The menu slug a location rule names: `acf-options-site-settings`. */
  slug: string;
  title: string;
  /** The `acf-ui-options-page` post, absent for a page that is only registered in PHP. */
  postId?: number;
  active: boolean;
  /** The prefix of its option rows (`options_<field>`); `options` unless the page sets its own `post_id`. */
  prefix: string;
  /** `ui`: defined in the database; `location`: only a location rule names it, so its definition is in code. */
  source: "ui" | "location";
}

export interface AcfModel {
  postTypes: ReadonlyMap<string, AcfPostType>;
  taxonomies: ReadonlyMap<string, AcfTaxonomy>;
  /** Every group, active or not, in ACF's order (menu order, then title). */
  groups: readonly AcfGroup[];
  optionsPages: readonly AcfOptionsPage[];
}

/**
 * What a field group's location rules are matched against. The optional properties are what a rule can
 * ask about; {@link postTarget} and {@link termTarget} fill them all from the model. A rule whose
 * answer is not in the target is reported and does not match (it never matches by default).
 */
export interface AcfPostTarget {
  kind: "post";
  postType: string;
  postId?: number;
  /** `_wp_page_template`: `default` or a template file/slug. */
  template?: string;
  status?: string;
  /** The post format (`aside`); `standard` for a post with none. */
  format?: string;
  parent?: number;
  /** The terms the post is filed under. */
  terms?: readonly { termId: number; taxonomy: string; slug: string }[];
  frontPage?: boolean;
  postsPage?: boolean;
  hasChildren?: boolean;
  /** An attachment's mime type. */
  mime?: string;
}

export interface AcfTermTarget {
  kind: "term";
  taxonomy: string;
  termId?: number;
  slug?: string;
}

export interface AcfOptionsTarget {
  kind: "options";
  /** The options page's menu slug. */
  page: string;
}

/**
 * A person: the field groups of the user form (`user_form == edit`, or `all`) apply, and the values are
 * the profile meta read beside the model (`wp/profiles.ts`). The roles of a user are not read, so a rule
 * on `user_role` cannot be evaluated for one.
 */
export interface AcfUserTarget {
  kind: "user";
  userId: number;
}

export type AcfTarget = AcfPostTarget | AcfTermTarget | AcfOptionsTarget | AcfUserTarget;

/** The stored value of a link field, however it was written. */
export interface AcfLink {
  url: string;
  title: string;
  target: string;
}

/**
 * A field's value as WordPress stores it, typed by what the field is. `type` is the ACF field type for
 * every kind a field of that type can produce; a clone shown as a group is a `group`, and a field type
 * this module does not know is `other` (with the real type on `field`).
 */
export type AcfRaw =
  | {
      type:
        | "text"
        | "textarea"
        | "wysiwyg"
        | "url"
        | "email"
        | "password"
        | "oembed"
        | "color_picker"
        | "time_picker";
      field: AcfField;
      value: string;
    }
  | { type: "number" | "range"; field: AcfField; value: number }
  | { type: "true_false"; field: AcfField; value: boolean }
  /** Always a list; `field.multiple` says whether the field answers with the list or its first value. */
  | { type: "select" | "radio" | "button_group" | "checkbox"; field: AcfField; values: string[] }
  /** `value` as stored (`20240215`, `2024-02-15 17:30:00`); `iso` is what Jx reads: a date or a UTC instant. */
  | { type: "date_picker" | "date_time_picker"; field: AcfField; value: string; iso?: string }
  /** An attachment id; `url` only where the value is an address instead (a field filled by an import). */
  | { type: "image" | "file"; field: AcfField; id?: number; url?: string }
  | { type: "gallery"; field: AcfField; ids: number[] }
  | { type: "link"; field: AcfField; value: AcfLink }
  | { type: "post_object" | "page_link" | "relationship"; field: AcfField; ids: number[] }
  /** A `nav_menu` field (SCF 6.5) holds the id of a menu, which is a term of the `nav_menu` taxonomy. */
  | { type: "taxonomy" | "nav_menu"; field: AcfField; ids: number[] }
  | { type: "user"; field: AcfField; ids: number[] }
  | { type: "repeater"; field: AcfField; rows: Record<string, AcfRaw>[] }
  | { type: "group"; field: AcfField; values: Record<string, AcfRaw> }
  | {
      type: "flexible_content";
      field: AcfField;
      rows: { layout: string; values: Record<string, AcfRaw> }[];
    }
  | { type: "google_map" | "icon_picker"; field: AcfField; value: Record<string, unknown> }
  | { type: "other"; field: AcfField; value: unknown };

/** The image object of the entry data contract. */
export interface EntryImage {
  src: string;
  width?: number;
  height?: number;
  alt: string;
}

/** A post, term or user as the entry data contract has it. */
export interface EntryRef {
  id: number;
  slug: string;
  title: string;
  url: string;
}

/**
 * What {@link toEntryData} needs from the rest of the pipeline. Each hook answers `undefined` for an id
 * it cannot resolve; the value is then dropped and `missing` is told, with the name of the field.
 */
export interface EntryHooks {
  attachment(id: number): EntryImage | undefined;
  post(id: number): EntryRef | undefined;
  term(id: number): EntryRef | undefined;
  user(id: number): EntryRef | undefined;
  missing?(kind: "attachment" | "post" | "term" | "user", id: number, field: string): void;
}

export type JsonSchema = Record<string, unknown>;

// ── Small PHP-shaped helpers ─────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * `object[key] = value` as an own property for every name, `__proto__` included: assigning that name sets the object's
 * prototype instead, and the value is silently gone. (Reading goes through `Object.hasOwn`, for the same reason.)
 */
function setOwn<T>(object: Record<string, T>, key: string, value: T): void {
  if (key === "__proto__") {
    Object.defineProperty(object, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else object[key] = value;
}

/** PHP's `(bool)` of a stored setting: `0`, `"0"`, `""`, `false`, `null` and an empty array are false. */
function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === "" || v === "0") return false;
  if (typeof v === "number") return v !== 0;
  // An empty PHP array unserialises to `[]`, so a record always has a key; a bigint is never 0n (it is only
  // used outside the safe integer range).
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** A stored scalar as text. Arrays and objects are not text: they become "" rather than "Array". */
function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (v === true) return "1";
  return "";
}

/** A stored number: a number, or text that is one; anything else (and the empty string) is no number. */
function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A stored whole number (an id, a count): what `num` says, when it is an integer. */
function int(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

/** A PHP array as a list, whatever keys it had; a lone scalar is a list of one; nothing is empty. */
function toList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isRecord(v)) return Object.values(v);
  if (v === undefined || v === null || v === "") return [];
  return [v];
}

const isDefined = <T>(v: T | undefined): v is T => v !== undefined;

const describe = (target: AcfTarget): string =>
  target.kind === "post"
    ? `post:${target.postId ?? target.postType}`
    : target.kind === "term"
      ? `term:${target.termId ?? target.taxonomy}`
      : target.kind === "user"
        ? `user:${target.userId}`
        : `options:${target.page}`;

/** Which reports a module has already filed, so one fact is told once however often it is met. */
const filed = new WeakMap<object, Set<string>>();
const reports = new WeakMap<AcfModel, Report | undefined>();

/** Which terms exist in the model a definition set was read from, for the location rules that name one. */
interface TermIndex {
  size: number;
  ids: Set<number>;
  slugs: Set<string>;
  /** `taxonomy:slug` and `taxonomy:id` of every term. */
  qualified: Set<string>;
}
const termIndexes = new WeakMap<AcfModel, TermIndex>();

function once(owner: object, key: string): boolean {
  let set = filed.get(owner);
  if (!set) filed.set(owner, (set = new Set()));
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

function add(
  report: Report | undefined,
  severity: "info" | "warn" | "error",
  code: string,
  message: string,
  where?: string,
  data?: Record<string, unknown>,
  url?: string,
): void {
  report?.add({
    severity,
    code,
    message,
    ...(where === undefined ? {} : { where }),
    ...(url === undefined ? {} : { url }),
    ...(data === undefined ? {} : { data }),
  });
}

// ── Field types ──────────────────────────────────────────────────────────────────────────────────

/** Types that draw something in the editor and hold no value. */
const LAYOUT_TYPES = new Set(["tab", "message", "accordion", "separator"]);

const TEXT_TYPES = new Set([
  "text",
  "textarea",
  "wysiwyg",
  "url",
  "email",
  "password",
  "oembed",
  "color_picker",
  "time_picker",
]);

const CHOICE_TYPES = new Set(["select", "radio", "button_group", "checkbox"]);
const REF_TYPES = new Set([
  "post_object",
  "page_link",
  "relationship",
  "taxonomy",
  "user",
  "nav_menu",
]);

/** Every field type the plugin ships that this module reads, plus the layout-only ones it skips. */
export const ACF_FIELD_TYPES: readonly string[] = [
  ...TEXT_TYPES,
  "number",
  "range",
  "true_false",
  ...CHOICE_TYPES,
  "date_picker",
  "date_time_picker",
  "image",
  "file",
  "gallery",
  "link",
  ...REF_TYPES,
  "google_map",
  "icon_picker",
  "repeater",
  "group",
  "flexible_content",
  "clone",
  ...LAYOUT_TYPES,
];

const KNOWN_TYPES = new Set(ACF_FIELD_TYPES);

/** Location parameters that name an object this tool does not migrate (users, comments, menus, widgets, blocks). */
const OTHER_OBJECT_PARAMS: Readonly<Record<string, string>> = {
  user_form: "users",
  user_role: "users",
  comment: "comments",
  nav_menu: "menus",
  nav_menu_item: "menu items",
  widget: "widgets",
  block: "blocks",
};

/** Parameters that depend on who is looking at the screen, which a migration has no answer for. */
const VIEWER_PARAMS = new Set(["current_user", "current_user_role"]);

/** Parameters {@link groupsFor} evaluates against a post, term or options target. */
const EVALUATED_PARAMS = new Set([
  "post_type",
  "post",
  "page",
  "page_template",
  "post_template",
  "post_status",
  "post_format",
  "post_category",
  "post_taxonomy",
  "page_type",
  "page_parent",
  "attachment",
  "taxonomy",
  "term",
  "options_page",
  "user_form",
]);

// ── Loading ──────────────────────────────────────────────────────────────────────────────────────

const lower = (s: string): string => s.toLowerCase();

/** ACF's order: `menu_order`, then title (MySQL compares it case-insensitively), then id for a stable tie. */
const byOrder = (a: WpPost, b: WpPost): number =>
  a.menuOrder - b.menuOrder ||
  (lower(a.title) < lower(b.title) ? -1 : lower(a.title) > lower(b.title) ? 1 : 0) ||
  a.id - b.id;

/** The settings of one ACF definition, or undefined (reported) when they do not parse as a PHP array. */
function settingsOf(
  post: WpPost,
  what: string,
  report: Report | undefined,
): Record<string, unknown> | undefined {
  const parsed = maybeUnserialize(post.content);
  if (isRecord(parsed)) return parsed;
  if (Array.isArray(parsed) && parsed.length === 0) return {};
  add(
    report,
    "warn",
    "acf.settings-malformed",
    `The ${what} "${post.title}" does not hold PHP-serialised settings that parse (usually string lengths broken by a search and replace); it was not carried over.`,
    `post:${post.id}`,
    { type: post.type, key: post.slug, sample: post.content.slice(0, 80) },
  );
  return undefined;
}

function stringList(v: unknown): string[] {
  return toList(v)
    .map(str)
    .filter((s) => s !== "");
}

function labelsOf(s: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(s.labels)) {
    for (const [k, v] of Object.entries(s.labels))
      if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

/**
 * `register_post_type`'s rewrite for an ACF definition: pretty permalinks may be off (`no_permalink`),
 * a custom slug counts only when ACF's select says so, and with none the base is the type's own name.
 */
function rewriteOf(
  s: Record<string, unknown>,
  name: string,
): { slug: string | false; withFront: boolean; hierarchical: boolean } {
  const rewrite = isRecord(s.rewrite) ? s.rewrite : {};
  // Without the select ACF writes (`post_type_key`, `taxonomy_key`) the base is the name itself.
  const mode = str(rewrite.permalink_rewrite);
  const custom = str(rewrite.slug);
  return {
    slug:
      mode === "no_permalink"
        ? false
        : mode === "custom_permalink" && custom !== ""
          ? custom
          : name,
    // ACF only ever writes `with_front` when it is false; absent means WordPress's default, true.
    withFront: !("with_front" in rewrite) || truthy(rewrite.with_front),
    hierarchical: truthy(rewrite.rewrite_hierarchical),
  };
}

function toPostType(
  post: WpPost,
  s: Record<string, unknown>,
  report: Report | undefined,
): AcfPostType | undefined {
  const name = str(s.post_type);
  if (name === "") {
    add(
      report,
      "warn",
      "acf.settings-malformed",
      `The ACF post type "${post.title}" names no post type; it was not carried over.`,
      `post:${post.id}`,
    );
    return undefined;
  }
  const labels = labelsOf(s);
  const rewrite = rewriteOf(s, name);
  const archiveSlug = str(s.has_archive_slug);
  return {
    slug: name,
    key: post.slug,
    postId: post.id,
    active: isActive(post),
    singular: labels.singular_name ?? post.title,
    plural: labels.name ?? post.title,
    hierarchical: truthy(s.hierarchical),
    hasArchive: truthy(s.has_archive) ? (archiveSlug !== "" ? archiveSlug : true) : false,
    rewriteSlug: rewrite.slug,
    rewriteWithFront: rewrite.withFront,
    // ACF's own default list applies only when the setting was never saved; a saved empty list is "none".
    supports:
      "supports" in s ? stringList(s.supports) : ["title", "editor", "thumbnail", "custom-fields"],
    taxonomies: stringList(s.taxonomies),
    // ACF defaults a post type to public (WordPress itself defaults to false).
    public: !("public" in s) || truthy(s.public),
    labels,
  };
}

function toTaxonomy(
  post: WpPost,
  s: Record<string, unknown>,
  report: Report | undefined,
): AcfTaxonomy | undefined {
  const name = str(s.taxonomy);
  if (name === "") {
    add(
      report,
      "warn",
      "acf.settings-malformed",
      `The ACF taxonomy "${post.title}" names no taxonomy; it was not carried over.`,
      `post:${post.id}`,
    );
    return undefined;
  }
  const labels = labelsOf(s);
  const rewrite = rewriteOf(s, name);
  return {
    slug: name,
    key: post.slug,
    postId: post.id,
    active: isActive(post),
    singular: labels.singular_name ?? post.title,
    plural: labels.name ?? post.title,
    objectTypes: stringList(s.object_type),
    hierarchical: truthy(s.hierarchical),
    rewriteSlug: rewrite.slug,
    rewriteWithFront: rewrite.withFront,
    rewriteHierarchical: rewrite.hierarchical,
    public: !("public" in s) || truthy(s.public),
    labels,
  };
}

/** ACF's `active`: a definition is on when its post is published (or an auto-draft). */
const isActive = (post: WpPost): boolean =>
  post.status === "publish" || post.status === "auto-draft";

/** `choices` as ACF stores them (value → label), or as the text a person typed (`value : label` per line). */
function choicesOf(raw: unknown): AcfChoice[] {
  if (Array.isArray(raw)) return raw.map((label, i) => ({ value: String(i), label: str(label) }));
  if (isRecord(raw))
    return Object.entries(raw).map(([value, label]) => ({ value, label: str(label) }));
  if (typeof raw === "string") {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const at = line.indexOf(" : ");
        return at === -1
          ? { value: line, label: line }
          : { value: line.slice(0, at).trim(), label: line.slice(at + 3).trim() };
      });
  }
  return [];
}

/** `conditional_logic`: `0` for none, else a list (OR) of lists (AND) of `{field, operator, value}`. */
function conditionsOf(raw: unknown): AcfCondition[][] {
  return toList(raw)
    .map((group) =>
      toList(group)
        .filter(isRecord)
        .map((r) => ({ field: str(r.field), operator: str(r.operator), value: str(r.value) })),
    )
    .filter((group) => group.length > 0);
}

function locationOf(raw: unknown): AcfLocationRule[][] {
  return toList(raw)
    .map((group) =>
      toList(group)
        .filter(isRecord)
        .map((r) => ({
          param: str(r.param),
          operator: str(r.operator) || "==",
          value: str(r.value),
        })),
    )
    .filter((group) => group.length > 0);
}

/** Whether a field of this type holds a list of values. */
function isMultiple(type: string, s: Record<string, unknown>): boolean {
  switch (type) {
    case "checkbox":
    case "gallery":
    case "relationship":
      return true;
    case "select":
    case "post_object":
    case "page_link":
    case "user":
      return truthy(s.multiple);
    case "taxonomy":
      // The taxonomy field's `field_type` decides: checkboxes and a multi select hold several terms.
      return ["checkbox", "multi_select", ""].includes(str(s.field_type));
    default:
      return false;
  }
}

/**
 * Reads the ACF definitions out of the model.
 *
 * Nothing is thrown for a definition that cannot be read: it is reported (`acf.settings-malformed`) and
 * skipped, and its fields, which then have no parent, are reported as orphans. Inactive groups, post
 * types and taxonomies stay in the result with `active: false` (and are reported once), because their
 * data is still in the database; {@link groupsFor} is what leaves them out, as ACF does.
 *
 * The report, when given, is also what {@link groupsFor} and {@link acfValues} report to later.
 */
export function loadAcf(model: WpModel, report?: Report): AcfModel {
  const all = [...model.posts.values()];
  const ofType = (type: string): WpPost[] => all.filter((p) => p.type === type).sort(byOrder);

  // A site that runs ACF but whose model has none of its posts was loaded without them: say so rather
  // than let every post look as if it had no custom fields.
  const plugins = model.site.activePlugins;
  const runsAcf =
    model.options.has("acf_version") ||
    plugins.some((p) => /^(?:secure-custom-fields|advanced-custom-fields(?:-pro)?)\//.test(p));
  if (runsAcf && ACF_POST_TYPES.every((type) => ofType(type).length === 0)) {
    add(
      report,
      "warn",
      "acf.not-loaded",
      "The site runs ACF but the model holds none of its definitions (acf-post-type, acf-taxonomy, acf-field-group, acf-field); load them with loadModel's postTypes and statuses (ACF_POST_TYPES, ACF_POST_STATUSES), or no custom field is read.",
      "option:acf_version",
    );
  }

  const postTypes = new Map<string, AcfPostType>();
  for (const post of ofType("acf-post-type")) {
    const s = settingsOf(post, "ACF post type", report);
    const def = s && toPostType(post, s, report);
    if (!def) continue;
    const prior = postTypes.get(def.slug);
    if (prior && (prior.active || !def.active)) {
      add(
        report,
        "info",
        "acf.duplicate-definition",
        `Two ACF definitions register the post type "${def.slug}"; the first active one is used.`,
        `post:${post.id}`,
        { kept: prior.postId },
      );
      continue;
    }
    postTypes.set(def.slug, def);
  }
  for (const def of postTypes.values()) {
    if (def.active) continue;
    add(
      report,
      "info",
      "acf.post-type-inactive",
      `The ACF post type "${def.slug}" is switched off, so WordPress does not register it; its posts have no page on the site.`,
      `post:${def.postId}`,
      { status: model.posts.get(def.postId)?.status },
    );
  }

  const taxonomies = new Map<string, AcfTaxonomy>();
  for (const post of ofType("acf-taxonomy")) {
    const s = settingsOf(post, "ACF taxonomy", report);
    const def = s && toTaxonomy(post, s, report);
    if (!def) continue;
    const prior = taxonomies.get(def.slug);
    if (prior && (prior.active || !def.active)) {
      add(
        report,
        "info",
        "acf.duplicate-definition",
        `Two ACF definitions register the taxonomy "${def.slug}"; the first active one is used.`,
        `post:${post.id}`,
        { kept: prior.postId },
      );
      continue;
    }
    taxonomies.set(def.slug, def);
  }
  for (const def of taxonomies.values()) {
    if (def.active) continue;
    add(
      report,
      "info",
      "acf.taxonomy-inactive",
      `The ACF taxonomy "${def.slug}" is switched off, so WordPress does not register it; its terms have no page on the site.`,
      `post:${def.postId}`,
      { status: model.posts.get(def.postId)?.status },
    );
  }

  // ── fields ──
  const children = new Map<number, WpPost[]>();
  const fieldPosts = ofType("acf-field");
  for (const post of fieldPosts) {
    const list = children.get(post.parent);
    if (list) list.push(post);
    else children.set(post.parent, [post]);
  }
  const reached = new Set<number>();

  const buildField = (post: WpPost): AcfField | undefined => {
    reached.add(post.id);
    const s = settingsOf(post, "ACF field", report);
    if (!s) return undefined;
    const type = str(s.type) || "text";
    const kids = (children.get(post.id) ?? []).map(buildField).filter(isDefined);
    const min = num(s.min);
    const max = num(s.max);
    const returnFormat = str(s.return_format);
    const field: AcfField = {
      key: post.slug,
      postId: post.id,
      name: post.excerpt,
      label: post.title,
      type,
      required: truthy(s.required),
      instructions: str(s.instructions),
      menuOrder: post.menuOrder,
      conditionalLogic: conditionsOf(s.conditional_logic),
      choices: CHOICE_TYPES.has(type) ? choicesOf(s.choices) : [],
      multiple: isMultiple(type, s),
      ...(returnFormat === "" ? {} : { returnFormat }),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...("default_value" in s ? { default: s.default_value } : {}),
      subFields: [],
      layouts: [],
      settings: s,
    };

    if (type === "repeater" || type === "group") {
      field.subFields = kids;
    } else if (type === "flexible_content") {
      field.layouts = toList(s.layouts)
        .filter(isRecord)
        .map((l) => {
          const lmin = num(l.min);
          const lmax = num(l.max);
          return {
            key: str(l.key),
            name: str(l.name),
            label: str(l.label),
            display: str(l.display) || "block",
            ...(lmin === undefined ? {} : { min: lmin }),
            ...(lmax === undefined ? {} : { max: lmax }),
            subFields: [],
          };
        });
      for (const kid of kids) {
        // A sub-field belongs to the layout its `parent_layout` names, and to the first one when it names none.
        const named = str(kid.settings.parent_layout);
        const layout = named === "" ? field.layouts[0] : field.layouts.find((l) => l.key === named);
        if (layout) layout.subFields.push(kid);
        else ignoredSubFields(report, post, [kid]);
      }
    } else if (type === "clone") {
      field.clone = {
        selectors: stringList(s.clone),
        display: str(s.display) === "group" ? "group" : "seamless",
        prefixName: truthy(s.prefix_name),
        prefixLabel: truthy(s.prefix_label),
      };
    } else {
      // A leftover of a field whose type was changed (fineline's gallery still has the repeater's image).
      ignoredSubFields(report, post, kids);
    }
    return field;
  };

  const groups: AcfGroup[] = [];
  for (const post of ofType("acf-field-group")) {
    const s = settingsOf(post, "ACF field group", report);
    if (!s) continue;
    const group: AcfGroup = {
      key: post.slug,
      postId: post.id,
      title: post.title,
      menuOrder: post.menuOrder,
      active: isActive(post),
      status: post.status,
      location: locationOf(s.location),
      fields: (children.get(post.id) ?? []).map(buildField).filter(isDefined),
    };
    groups.push(group);
    if (!group.active) {
      add(
        report,
        "info",
        "acf.group-inactive",
        `The field group "${post.title}" is switched off (${post.status}): ACF shows it on no screen, but a template that asks for one of its fields by name still gets the saved value. Its fields are not read unless acfValues, groupsFor and fieldsFor are given includeInactive; values saved under them are reported per post otherwise.`,
        `post:${post.id}`,
        { status: post.status, fields: group.fields.map((f) => f.name).filter((n) => n !== "") },
      );
    }
    reportLocations(group, post, report);
  }

  for (const post of fieldPosts) {
    if (reached.has(post.id)) continue;
    add(
      report,
      "warn",
      "acf.field-orphan",
      `The ACF field "${post.title}" (${post.excerpt || post.slug}) hangs under post ${post.parent}, which is not a field group or field that could be read; it was not carried over.`,
      `post:${post.id}`,
      { parent: post.parent },
    );
  }

  resolveClones(groups, report);

  const optionsPages = optionsPagesOf(ofType("acf-ui-options-page"), groups, report);

  const acf: AcfModel = { postTypes, taxonomies, groups, optionsPages };
  reports.set(acf, report);
  const terms: TermIndex = {
    size: model.terms.size,
    ids: new Set(),
    slugs: new Set(),
    qualified: new Set(),
  };
  for (const term of model.terms.values()) {
    terms.ids.add(term.termId);
    terms.slugs.add(term.slug);
    terms.qualified.add(`${term.taxonomy}:${term.slug}`).add(`${term.taxonomy}:${term.termId}`);
  }
  termIndexes.set(acf, terms);
  reportFields(acf, report);
  return acf;
}

function ignoredSubFields(report: Report | undefined, parent: WpPost, kids: AcfField[]): void {
  for (const kid of kids) {
    add(
      report,
      "info",
      "acf.subfield-ignored",
      `The ${kid.type} field "${kid.label}" sits under the ${parent.title} field, which does not hold sub-fields; it is ignored (a leftover of a field whose type was changed).`,
      `post:${kid.postId}`,
      { parent: parent.id },
    );
  }
}

/** What the location rules of a group say about screens this tool cannot evaluate, filed once per group. */
function reportLocations(group: AcfGroup, post: WpPost, report: Report | undefined): void {
  const others = new Set<string>();
  const unsupported = new Set<string>();
  const viewer = new Set<string>();
  const operators = new Set<string>();
  for (const rules of group.location) {
    for (const rule of rules) {
      if (rule.operator !== "==" && rule.operator !== "!=")
        operators.add(`${rule.param} ${rule.operator} ${rule.value}`);
      if (EVALUATED_PARAMS.has(rule.param)) continue;
      const object = OTHER_OBJECT_PARAMS[rule.param];
      if (object) others.add(object);
      else if (VIEWER_PARAMS.has(rule.param)) viewer.add(rule.param);
      else unsupported.add(rule.param);
    }
  }
  for (const param of viewer) {
    add(
      report,
      "warn",
      "acf.location-unsupported",
      `The field group "${group.title}" has a location rule on "${param}", which depends on who is looking at the screen; a migration has no viewer, so the rule never matches and the group may be missing from entries it applies to.`,
      `post:${post.id}`,
      { param },
    );
  }
  for (const object of others) {
    add(
      report,
      "info",
      "acf.location-other-object",
      `The field group "${group.title}" is attached to ${object}, which are not migrated; it applies to no post or term.`,
      `post:${post.id}`,
      { objects: object },
    );
  }
  for (const rule of operators) {
    add(
      report,
      "warn",
      "acf.location-unsupported",
      `The field group "${group.title}" has a location rule "${rule}" with an operator ACF does not have in its own rules; the rule never matches, so the group may be missing from entries it applies to.`,
      `post:${post.id}`,
      { rule },
    );
  }
  for (const param of unsupported) {
    add(
      report,
      "warn",
      "acf.location-unsupported",
      `The field group "${group.title}" has a location rule on "${param}", which this tool cannot evaluate; the rule never matches, so the group may be missing from entries it applies to.`,
      `post:${post.id}`,
      { param },
    );
  }
}

/** Fills in every clone field's `subFields` from the groups and fields it copies. */
function resolveClones(groups: readonly AcfGroup[], report: Report | undefined): void {
  const byGroup = new Map(groups.map((g) => [g.key, g]));
  const byField = new Map<string, AcfField>();
  const all: AcfField[] = [];
  const collect = (fields: readonly AcfField[]): void => {
    for (const f of fields) {
      all.push(f);
      byField.set(f.key, f);
      collect(f.subFields);
      for (const layout of f.layouts) collect(layout.subFields);
    }
  };
  for (const g of groups) collect(g.fields);

  const state = new Map<string, "resolving" | "resolved">();
  /** Resolves a clone's copies; false when the clone is one that is still being resolved (a cycle). */
  const ensure = (f: AcfField): boolean => {
    // Only a clone field carries `clone`.
    if (!f.clone || state.get(f.key) === "resolved") return true;
    if (state.get(f.key) === "resolving") {
      add(
        report,
        "warn",
        "acf.clone-cycle",
        `The clone field "${f.label}" copies a group or field that contains it; that copy is left out.`,
        `post:${f.postId}`,
      );
      return false;
    }
    state.set(f.key, "resolving");
    const copies: AcfField[] = [];
    for (const selector of f.clone.selectors) {
      const source = selector.startsWith("group_")
        ? byGroup.get(selector)?.fields
        : selector.startsWith("field_")
          ? [byField.get(selector)].filter(isDefined)
          : undefined;
      if (!source || source.length === 0) {
        add(
          report,
          "warn",
          "acf.clone-missing",
          `The clone field "${f.label}" copies "${selector}", which is not an ACF group or field that exists; nothing is copied for it.`,
          `post:${f.postId}`,
          { selector },
        );
        continue;
      }
      // A copy that is itself waiting to be resolved is one this clone sits inside: leaving it out ends the cycle.
      for (const copy of source) if (ensure(copy)) copies.push(copy);
    }
    f.subFields = copies;
    state.set(f.key, "resolved");
    return true;
  };
  for (const f of all) ensure(f);
}

/** The options pages ACF has in its own tables, plus the ones only a location rule mentions. */
function optionsPagesOf(
  posts: readonly WpPost[],
  groups: readonly AcfGroup[],
  report: Report | undefined,
): AcfOptionsPage[] {
  const pages: AcfOptionsPage[] = [];
  for (const post of posts) {
    const s = settingsOf(post, "ACF options page", report);
    if (!s) continue;
    const slug = str(s.menu_slug);
    if (slug === "") continue;
    pages.push({
      slug,
      title: str(s.page_title) || post.title,
      postId: post.id,
      active: isActive(post),
      prefix: str(s.post_id) || "options",
      source: "ui",
    });
  }
  const known = new Set(pages.map((p) => p.slug));
  for (const group of groups) {
    for (const rule of group.location.flat()) {
      if (rule.param !== "options_page" || rule.value === "" || rule.value === "all") continue;
      if (known.has(rule.value)) continue;
      known.add(rule.value);
      pages.push({
        slug: rule.value,
        title: rule.value,
        active: true,
        prefix: "options",
        source: "location",
      });
    }
  }
  return pages;
}

/** Everything that is true of a field definition by itself (not of a post): once per field. */
function reportFields(acf: AcfModel, report: Report | undefined): void {
  if (!report) return;
  const seen = new Set<string>();
  const visit = (group: AcfGroup, f: AcfField): void => {
    if (seen.has(f.key)) return;
    seen.add(f.key);
    const where = `post:${f.postId}`;
    if (!KNOWN_TYPES.has(f.type)) {
      add(
        report,
        "warn",
        "acf.field-unsupported",
        `The field "${f.label}" has the type "${f.type}", which this tool does not know; its stored value is copied as it is, so check what it holds.`,
        where,
        { type: f.type, name: f.name, group: group.title },
      );
    }
    if (
      (f.returnFormat === "label" || f.returnFormat === "array") &&
      f.choices.some((c) => c.label !== c.value)
    ) {
      add(
        report,
        "info",
        "acf.return-format",
        `The field "${f.name}" returns ${f.returnFormat === "label" ? "the label" : "an array"} of its choice on the site; entries hold the stored value, and the field's choices map it to its label.`,
        where,
        { name: f.name, returnFormat: f.returnFormat },
      );
    }
    if (f.type === "textarea" && ["wpautop", "br"].includes(str(f.settings.new_lines))) {
      add(
        report,
        "info",
        "acf.textarea-newlines",
        `The textarea "${f.name}" turns line breaks into ${str(f.settings.new_lines) === "br" ? "<br>" : "paragraphs"} on the site; the entry keeps the text with its line breaks.`,
        where,
        { name: f.name },
      );
    }
    for (const sub of f.subFields) visit(group, sub);
    for (const layout of f.layouts) for (const sub of layout.subFields) visit(group, sub);
  };
  const topLevel = new Set(acf.groups.flatMap((g) => g.fields.map((f) => f.name)));
  for (const group of acf.groups) {
    for (const f of group.fields) {
      visit(group, f);
      // Only a top-level field becomes a frontmatter key, so only it can collide with the contract's.
      if (f.name === "" || !BASE_KEYS.includes(f.name)) continue;
      const key = entryKey(f.name);
      if (topLevel.has(key)) {
        add(
          report,
          "warn",
          "acf.field-conflict",
          `The field "${f.name}" has the name of a frontmatter key of the entry data contract, so its value is kept as "${key}", which another field is called too. Where an entry has both, the later one's value is kept as "${key}_2" (or the next free number), and neither is lost.`,
          `post:${f.postId}`,
          { name: f.name, key, group: group.title },
        );
      } else {
        add(
          report,
          "info",
          "acf.field-name-collision",
          `The field "${f.name}" has the name of a frontmatter key of the entry data contract; its value is kept as "${key}".`,
          `post:${f.postId}`,
          { name: f.name, key, group: group.title },
        );
      }
    }
  }
}

// ── Locations ────────────────────────────────────────────────────────────────────────────────────

/** PHP's `==` between a screen value and a rule value: two numeric strings (or a number and one) compare as numbers. */
function looseEquals(a: string | number, b: string): boolean {
  const x = num(a);
  return a === b || (x !== undefined && x === num(b));
}

/** ACF's `compare_to_rule`: `==` with "all" matching anything, and `!=` reversing the answer. */
function compare(value: string | number, rule: AcfLocationRule): boolean {
  const result = rule.value === "all" || looseEquals(value, rule.value);
  return rule.operator === "!=" ? !result : result;
}

/** Whether the term a rule names is one the model has: by id, by `taxonomy:slug`, or (as `acf_get_term()` falls back to) by `taxonomy:id`. */
function termExists(
  index: TermIndex,
  wanted: { taxonomy?: string; slug?: string; id?: number },
): boolean {
  if (wanted.id !== undefined) return index.ids.has(wanted.id);
  if (wanted.slug === undefined) return false;
  return wanted.taxonomy === undefined
    ? index.slugs.has(wanted.slug)
    : index.qualified.has(`${wanted.taxonomy}:${wanted.slug}`);
}

/** "term-missing": the rule names a term that does not exist, which ACF answers false to whatever the operator. */
type Verdict = boolean | "unevaluable" | "term-missing";

/** `taxonomy:slug`, or a bare term id, as the rules of a taxonomy location write a term. */
function ruleTerm(value: string): { taxonomy?: string; slug?: string; id?: number } {
  const colon = value.indexOf(":");
  if (colon > 0) return { taxonomy: value.slice(0, colon), slug: value.slice(colon + 1) };
  const id = int(value);
  return id === undefined ? { slug: value } : { id };
}

/**
 * ACF's `match()` for one rule. Where ACF finds the answer in neither the screen nor the database it
 * returns false (and `!=` does not turn that into true); here that is false too, but when the target
 * could have told and does not, the verdict is "unevaluable" so the caller can say so.
 */
function matchRule(rule: AcfLocationRule, t: AcfTarget, known?: TermIndex): Verdict {
  // An operator ACF does not have is never evaluated (and was reported when the group was read).
  if (rule.operator !== "==" && rule.operator !== "!=") return false;
  switch (rule.param) {
    case "post_type":
      return t.kind === "post" ? compare(t.postType, rule) : false;

    case "post":
    case "page":
      return t.kind === "post" && t.postId !== undefined ? compare(t.postId, rule) : false;

    case "page_template":
    case "post_template": {
      if (t.kind !== "post") return false;
      // `acf_get_post_templates()`: a page always has templates, any other type only when the theme gives
      // it some, which a post that carries one shows.
      const template = t.template;
      const has =
        t.postType === "page" || (template !== undefined && !["", "default"].includes(template));
      if (!has) return false;
      if (rule.param === "page_template" && rule.value === "default" && t.postType !== "page")
        return false;
      if (template === undefined && t.postId !== undefined) return "unevaluable";
      return compare(template === undefined || template === "" ? "default" : template, rule);
    }

    case "post_status": {
      if (t.kind !== "post") return false;
      if (t.status === undefined) return t.postId === undefined ? false : "unevaluable";
      return compare(t.status === "auto-draft" ? "draft" : t.status, rule);
    }

    case "post_format": {
      if (t.kind !== "post") return false;
      if (t.format === undefined) return t.postId === undefined ? false : "unevaluable";
      return compare(t.format, rule);
    }

    case "post_category":
    case "post_taxonomy": {
      if (t.kind !== "post" || t.postId === undefined) return false;
      if (t.terms === undefined) return "unevaluable";
      const wanted = ruleTerm(rule.value);
      const terms =
        t.terms.length === 0 && wanted.taxonomy === "category"
          ? [{ termId: 1, taxonomy: "category", slug: "uncategorized" }]
          : t.terms;
      const isWanted = (term: { termId: number; taxonomy: string; slug: string }): boolean =>
        (wanted.id !== undefined && term.termId === wanted.id) ||
        (wanted.slug !== undefined &&
          term.slug === wanted.slug &&
          (wanted.taxonomy === undefined || term.taxonomy === wanted.taxonomy));
      // ACF's `acf_get_term()` finds no term, and the rule is false before its operator is looked at. (A model that
      // holds no terms was loaded without them, so nothing can be said to be missing; WordPress always has one.)
      if (known && known.size > 0 && !termExists(known, wanted) && !t.terms.some(isWanted))
        return "term-missing";
      const hit = terms.some(isWanted);
      return rule.operator === "!=" ? !hit : hit;
    }

    case "page_type": {
      if (t.kind !== "post" || t.postId === undefined) return false;
      let result: boolean | undefined;
      switch (rule.value) {
        case "front_page":
          result = t.frontPage;
          break;
        case "posts_page":
          result = t.postsPage;
          break;
        case "top_level":
          result = t.parent === undefined ? undefined : t.parent === 0;
          break;
        case "child":
          result = t.parent === undefined ? undefined : t.parent !== 0;
          break;
        case "parent":
          result = t.hasChildren;
          break;
        default:
          return false;
      }
      if (result === undefined) return "unevaluable";
      return rule.operator === "!=" ? !result : result;
    }

    case "page_parent": {
      if (t.kind !== "post") return false;
      if (t.parent === undefined) return t.postId === undefined ? false : "unevaluable";
      return compare(t.parent, rule);
    }

    case "attachment": {
      if (t.kind !== "post" || t.postType !== "attachment") return false;
      if (t.mime === undefined) return "unevaluable";
      // A rule value that is a kind ("image") matches every mime type of that kind.
      return compare(t.mime.split("/")[0] === rule.value ? rule.value : t.mime, rule);
    }

    case "taxonomy":
      return t.kind === "term" ? compare(t.taxonomy, rule) : false;

    case "term": {
      if (t.kind !== "term") return false;
      const wanted = ruleTerm(rule.value);
      let hit: boolean | undefined;
      if (wanted.id !== undefined)
        hit = t.termId === undefined ? undefined : t.termId === wanted.id;
      else if (wanted.slug !== undefined)
        hit =
          t.slug === undefined
            ? undefined
            : t.slug === wanted.slug &&
              (wanted.taxonomy === undefined || wanted.taxonomy === t.taxonomy);
      if (hit === undefined) return "unevaluable";
      return rule.operator === "!=" ? !hit : hit;
    }

    case "options_page":
      return t.kind === "options" ? compare(t.page, rule) : false;

    case "user_form": {
      // The profile screen: a user form shows the group on "edit" and on "all", and never on "add".
      if (t.kind !== "user") return false;
      const shown = rule.value === "edit" || rule.value === "all";
      return rule.operator === "!=" ? !shown : shown;
    }

    case "user_role":
      return t.kind === "user" ? "unevaluable" : false;

    default:
      // The screens of other objects (a user form, a comment, a widget) never match a post or term, as in ACF,
      // and a parameter this tool does not know matches nothing (it was reported when the group was read).
      return false;
  }
}

/**
 * The field groups that apply to a target, in ACF's order. Rule groups OR together and the rules inside
 * one group AND; a group that is not active applies to nothing. A rule on a parameter this tool cannot
 * evaluate, or whose answer the target does not carry, does not match, and is reported (once) to the
 * report `loadAcf` was given. A rule that names a term the model does not have matches nothing either way, as in
 * ACF, and is reported (`acf.location-term-missing`).
 *
 * With `includeInactive` the groups that are switched off are looked at as if they were on: ACF shows them on no
 * screen, but `get_field()` still resolves their fields, so what a template reads from one is theirs.
 */
export function groupsFor(
  acf: AcfModel,
  target: AcfTarget,
  opts: { includeInactive?: boolean } = {},
): AcfGroup[] {
  const report = reports.get(acf);
  const terms = termIndexes.get(acf);
  const out: AcfGroup[] = [];
  for (const group of acf.groups) {
    if (!group.active && !opts.includeInactive) continue;
    for (const rules of group.location) {
      let all = true;
      for (const rule of rules) {
        const verdict = matchRule(rule, target, terms);
        if (verdict === "term-missing") {
          const code = "acf.location-term-missing";
          if (report && once(acf, `${code}|${group.key}|${rule.param}|${rule.value}`)) {
            add(
              report,
              "warn",
              code,
              `The location rule "${rule.param} ${rule.operator} ${rule.value}" of the field group "${group.title}" names a term that does not exist (deleted, or renamed); ACF matches no screen for it, with either operator, so the group does not apply here.`,
              `post:${group.postId}`,
              { param: rule.param, value: rule.value, operator: rule.operator },
            );
          }
        }
        if (verdict === "unevaluable") {
          const code = "acf.location-unevaluable";
          if (report && once(acf, `${code}|${group.key}|${rule.param}|${rule.value}`)) {
            add(
              report,
              "warn",
              code,
              `The location rule "${rule.param}" of the field group "${group.title}" needs more of the target than was given (${describe(target)}); it does not match. Build the target with postTarget() or termTarget().`,
              `post:${group.postId}`,
              { param: rule.param, value: rule.value },
            );
          }
        }
        if (verdict !== true) {
          all = false;
          break;
        }
      }
      if (all) {
        out.push(group);
        break;
      }
    }
  }
  return out;
}

/** Whether any post of the same type has this one as its parent (ACF's "parent" page type). */
function hasChild(model: WpModel, post: WpPost): boolean {
  for (const other of model.posts.values()) {
    if (other.parent === post.id && other.type === post.type) return true;
  }
  return false;
}

/** The target for a post, with everything a location rule can ask about filled in from the model. */
export function postTarget(model: WpModel, post: WpPost): AcfPostTarget {
  const meta = model.postMeta.get(post.id) ?? {};
  const template = str(meta._wp_page_template?.[0]);
  const terms = (model.termsByPost.get(post.id) ?? [])
    .map((id) => model.terms.get(id))
    .filter(isDefined)
    .map((t) => ({ termId: t.termId, taxonomy: t.taxonomy, slug: t.slug }));
  const format = terms.find((t) => t.taxonomy === "post_format")?.slug.replace(/^post-format-/, "");
  const attachment = model.attachments.get(post.id);
  return {
    kind: "post",
    postType: post.type,
    postId: post.id,
    template: template === "" ? "default" : template,
    status: post.status,
    format: format ?? (post.type === "post" ? "standard" : ""),
    parent: post.parent,
    terms,
    frontPage: model.site.showOnFront === "page" && model.site.pageOnFront === post.id,
    postsPage: model.site.showOnFront === "page" && model.site.pageForPosts === post.id,
    hasChildren: hasChild(model, post),
    ...(attachment ? { mime: attachment.mime } : {}),
  };
}

export function termTarget(_model: WpModel, term: WpTerm): AcfTermTarget {
  return { kind: "term", taxonomy: term.taxonomy, termId: term.termId, slug: term.slug };
}

/**
 * The fields of every group that applies to at least one of the targets, in group order. This is what a
 * collection's schema is made from: the fields that can appear on some entry of it.
 */
export function fieldsFor(
  acf: AcfModel,
  targets: Iterable<AcfTarget>,
  opts: { includeInactive?: boolean } = {},
): AcfField[] {
  const keys = new Set<string>();
  for (const target of targets)
    for (const group of groupsFor(acf, target, opts)) keys.add(group.key);
  return acf.groups.filter((g) => keys.has(g.key)).flatMap((g) => g.fields);
}

/**
 * The taxonomies a post type has, from both sides: WordPress attaches a taxonomy to a type when either
 * names the other (fineline's `project_type` lists `project` while the type's own list omits it).
 */
export function taxonomiesFor(acf: AcfModel, postType: string): string[] {
  const names = new Set<string>(acf.postTypes.get(postType)?.taxonomies ?? []);
  for (const taxonomy of acf.taxonomies.values()) {
    if (taxonomy.active && taxonomy.objectTypes.includes(postType)) names.add(taxonomy.slug);
  }
  return [...names];
}

/** The frontmatter key an ACF field's value is kept under: its name, unless a contract key already has it. */
export function entryKey(name: string): string {
  return BASE_KEYS.includes(name) ? `acf_${name}` : name;
}

/**
 * The frontmatter key of each top-level name: {@link entryKey}, made unique. Two names can come to one key (`author`
 * is kept as `acf_author`, which a field may also be called); the first keeps it and the later one is numbered
 * (`acf_author_2`), so neither value is written over the other. A name a field really has is never handed out as a number.
 */
function entryKeys(names: Iterable<string>): Map<string, string> {
  const unique = [...new Set(names)];
  const literal = new Set(unique);
  const taken = new Set<string>();
  const keys = new Map<string, string>();
  for (const name of unique) {
    const wanted = entryKey(name);
    let key = wanted;
    for (let n = 2; taken.has(key) || (key !== wanted && literal.has(key)); n++) {
      key = `${wanted}_${n}`;
    }
    taken.add(key);
    keys.set(name, key);
  }
  return keys;
}

// ── Slots: the fields as they are stored and as they are named in an entry ───────────────────────

/**
 * One value position. `storage` is where the value's meta row is named (relative to the container's
 * prefix) and `entry` is what it is called in entry data; they differ only for a clone that does not
 * prefix its copies' names.
 */
interface Slot {
  field: AcfField;
  storage: string;
  entry: string;
  /** The slots inside a repeater or a group (and a clone shown as a group). */
  children: Slot[];
  /** A clone shown as a group whose copies keep their own names: its copies are stored beside it, not under it. */
  flat?: true;
}

const prefixed = (prefix: string, name: string): string =>
  prefix === "" ? name : `${prefix}_${name}`;

/**
 * Turns fields into value positions. A seamless clone is replaced by its copies (named with its own
 * name when it prefixes, else with their own), and the fields that hold no value are left out.
 */
function slotsOf(fields: readonly AcfField[]): Slot[] {
  const out: Slot[] = [];
  for (const f of fields) {
    if (f.clone) {
      const inner = slotsOf(f.subFields);
      if (f.clone.display === "seamless") {
        const prefix = f.clone.prefixName ? f.name : "";
        for (const s of inner) {
          out.push({
            ...s,
            storage: prefixed(prefix, s.storage),
            entry: prefixed(prefix, s.entry),
          });
        }
      } else if (f.name !== "") {
        out.push({
          field: f,
          storage: f.name,
          entry: f.name,
          children: inner,
          ...(f.clone.prefixName ? {} : { flat: true as const }),
        });
      }
      continue;
    }
    if (LAYOUT_TYPES.has(f.type) || f.name === "") continue;
    out.push({
      field: f,
      storage: f.name,
      entry: f.name,
      children: f.type === "repeater" || f.type === "group" ? slotsOf(f.subFields) : [],
    });
  }
  return out;
}

// ── Schema ───────────────────────────────────────────────────────────────────────────────────────

const imageSchema = (): JsonSchema => ({
  type: "object",
  properties: {
    src: { type: "string" },
    width: { type: "number" },
    height: { type: "number" },
    alt: { type: "string" },
  },
  required: ["src"],
});

const refSchema = (): JsonSchema => ({
  type: "object",
  properties: {
    id: { type: "number" },
    slug: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
  },
  required: ["id"],
});

const linkSchema = (): JsonSchema => ({
  type: "object",
  properties: { url: { type: "string" }, title: { type: "string" }, target: { type: "string" } },
  required: ["url"],
});

/**
 * The base frontmatter keys of the entry data contract as JSON Schema properties. The dates are
 * `date-time`, which Jx normalises to UTC (parser.md §9.3); `featuredImage`, `terms` and `seo` are
 * objects, which Jx does not check but Studio and any validator can.
 */
export const BASE_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  title: { type: "string" },
  slug: { type: "string" },
  date: { type: "string", format: "date-time" },
  modified: { type: "string", format: "date-time" },
  excerpt: { type: "string" },
  author: { type: "string" },
  url: { type: "string" },
  featuredImage: imageSchema(),
  terms: {
    type: "object",
    additionalProperties: {
      type: "array",
      items: {
        type: "object",
        properties: { slug: { type: "string" }, name: { type: "string" }, url: { type: "string" } },
        required: ["slug", "name"],
      },
    },
  },
  seo: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      image: imageSchema(),
      robots: { type: "string" },
    },
  },
};

/** The keys of a collection's schema that every entry has. */
export const BASE_REQUIRED: readonly string[] = ["title", "slug"];

const describeField = (f: AcfField): JsonSchema => ({
  ...(f.label === "" ? {} : { title: f.label }),
  ...(f.instructions === "" ? {} : { description: f.instructions }),
});

/** Whether the editor lets a person type a value outside the choices. */
const openChoices = (f: AcfField): boolean =>
  truthy(f.settings.allow_custom) || truthy(f.settings.other_choice);

function schemaOfSlot(
  slot: Slot,
  report: Report | undefined,
  where: string | undefined,
): JsonSchema {
  const f = slot.field;
  const meta = describeField(f);
  const array = (items: JsonSchema): JsonSchema => ({ type: "array", ...meta, items });
  const one = (schema: JsonSchema): JsonSchema =>
    f.multiple ? array(schema) : { ...meta, ...schema };
  switch (f.type) {
    case "text":
    case "textarea":
    case "wysiwyg":
    case "password":
    case "oembed":
    case "color_picker":
    case "time_picker":
      return { type: "string", ...meta };
    case "url":
      return { type: "string", format: "uri", ...meta };
    case "email":
      return { type: "string", format: "email", ...meta };
    case "number":
    case "range": {
      const min = num(f.settings.min);
      const max = num(f.settings.max);
      return {
        type: "number",
        ...(min === undefined ? {} : { minimum: min }),
        ...(max === undefined ? {} : { maximum: max }),
        ...meta,
      };
    }
    case "true_false":
      return { type: "boolean", ...meta };
    case "select":
    case "radio":
    case "button_group":
    case "checkbox": {
      const values = f.choices.map((c) => c.value).filter((v) => v !== "");
      const item: JsonSchema = {
        type: "string",
        ...(values.length === 0 || openChoices(f) ? {} : { enum: values }),
      };
      return f.multiple ? array(item) : { ...meta, ...item };
    }
    case "date_picker":
      return { type: "string", format: "date", ...meta };
    case "date_time_picker":
      return { type: "string", format: "date-time", ...meta };
    case "image":
    case "file":
      return { ...imageSchema(), ...meta };
    case "gallery":
      return array(imageSchema());
    case "link":
      return { ...linkSchema(), ...meta };
    case "post_object":
    case "page_link":
    case "relationship":
    case "taxonomy":
    case "user":
    case "nav_menu":
      return one(refSchema());
    case "google_map":
      return {
        type: "object",
        properties: {
          address: { type: "string" },
          lat: { type: "number" },
          lng: { type: "number" },
          zoom: { type: "number" },
        },
        ...meta,
      };
    case "icon_picker":
      return {
        type: "object",
        properties: { type: { type: "string" }, value: { type: "string" } },
        ...meta,
      };
    case "group":
    case "clone":
      return { ...objectSchema(slot.children, report, where), ...meta };
    case "repeater": {
      const min = f.min !== undefined && f.min > 0 ? { minItems: f.min } : {};
      const max = f.max !== undefined && f.max > 0 ? { maxItems: f.max } : {};
      return { ...array(objectSchema(slot.children, report, where)), ...min, ...max };
    }
    case "flexible_content": {
      const variants = f.layouts.map((layout) => {
        const inner = objectSchema(slotsOf(layout.subFields), report, where);
        const properties = inner.properties as Record<string, JsonSchema>;
        return {
          type: "object",
          ...(layout.label === "" ? {} : { title: layout.label }),
          properties: { acf_fc_layout: { const: layout.name }, ...properties },
          required: ["acf_fc_layout", ...((inner.required as string[] | undefined) ?? [])],
        };
      });
      return array(variants.length === 0 ? {} : { oneOf: variants });
    }
    default:
      // A type this module does not know keeps whatever value was stored, so it promises nothing about it.
      return { ...meta };
  }
}

/** A field is only required where it is always shown: a conditional field may legitimately be absent. */
const alwaysRequired = (f: AcfField): boolean => f.required && f.conditionalLogic.length === 0;

function objectSchema(
  slots: readonly Slot[],
  report: Report | undefined,
  where: string | undefined,
  top = false,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  // Only the top level is frontmatter, so only there can a name collide with the contract's keys.
  const keys = top ? entryKeys(slots.map((slot) => slot.entry)) : undefined;
  for (const slot of slots) {
    const key = keys?.get(slot.entry) ?? slot.entry;
    const prior = Object.hasOwn(properties, key) ? properties[key] : undefined;
    const schema = schemaOfSlot(slot, report, where);
    if (prior !== undefined) {
      if (prior.type !== schema.type) {
        add(
          report,
          "warn",
          "acf.field-conflict",
          `Two fields are both named "${key}" but hold different kinds of value (${String(prior.type)}, ${String(schema.type)}); the first one's schema is used.`,
          where ?? `post:${slot.field.postId}`,
          { name: key },
        );
      }
      continue;
    }
    setOwn(properties, key, schema);
    if (alwaysRequired(slot.field)) required.push(key);
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/**
 * A JSON Schema object (`type`, `properties`, `required`) for a Jx content collection built from
 * ACF fields, read against the entry data contract: images are `{src, width, height, alt}`, a link is
 * `{url, title, target}`, a relationship, post, taxonomy or user value is `{id, slug, title, url}` (a list
 * of them when the field holds several), a repeater is a list of row objects, a flexible content field a
 * list of rows each carrying `acf_fc_layout`.
 *
 * What Jx does with it (parser.md §9.3 and `validateEntries` in the parser's content loader): a field
 * with `format: "date"` or `"date-time"` has its values normalised to a date or a UTC instant, and
 * `format: "uri-reference"` rewrites a relative path; `required` and a top-level `type` of string,
 * number, boolean or array are checked and a miss is a console warning, never an error; every other
 * keyword (`enum`, `items`, nested `properties`, `oneOf`, `format: "uri"`) is ignored by the build and
 * kept for Studio and other validators. A field is listed as required only when ACF requires it and no
 * condition can hide it. A field whose name is a key of the entry data contract is named by
 * {@link entryKey}. A seamless clone is expanded in place; tabs, messages and accordions are ignored.
 */
export function acfSchema(
  fields: readonly AcfField[],
  opts: { report?: Report; where?: string } = {},
): JsonSchema {
  return objectSchema(slotsOf(fields), opts.report, opts.where, true);
}

// ── Site clock ───────────────────────────────────────────────────────────────────────────────────

/** The site's own clock: WordPress's `wp_timezone()`, which is `timezone_string`, else `gmt_offset`, else UTC. */
export interface SiteClock {
  /** The UTC instant (ms) of a wall-clock time written in the site's zone; the wall time is given as if it were UTC. */
  toUtc(wallMs: number): number;
  /** The wall-clock time in the site's zone (as if it were UTC) of a UTC instant. */
  toLocal(utcMs: number): number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The clock of a named zone, daylight saving included. Throws when the runtime does not know the name. */
export function zoneClock(zone: string): SiteClock {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  /** How far the zone's wall clock is ahead of UTC at the instant `utcMs`. */
  const offsetAt = (utcMs: number): number => {
    const part: Record<string, number> = {};
    for (const { type, value } of format.formatToParts(utcMs)) part[type] = Number(value);
    const wall = Date.UTC(
      part.year!,
      part.month! - 1,
      part.day!,
      part.hour!,
      part.minute!,
      part.second!,
    );
    return wall - Math.floor(utcMs / 1000) * 1000;
  };
  return {
    toLocal: (utcMs) => utcMs + offsetAt(utcMs),
    toUtc: (wallMs) => {
      // The offsets a day either side bracket any daylight-saving change that could touch this wall time.
      // A wall time that never happened takes the offset from before the change, and one that happened twice
      // is its first occurrence: the "compatible" choice of ECMAScript Temporal and java.time. PHP's DateTime
      // gives the same instant for every wall time but the repeated hour, where it takes the second
      // occurrence in a zone at or east of UTC (a timelib quirk); both instants read back as that wall time.
      const before = offsetAt(wallMs - DAY);
      const after = offsetAt(wallMs + DAY);
      const valid = [...new Set([before, after])].filter((o) => offsetAt(wallMs - o) === o);
      return wallMs - (valid.length === 0 ? before : Math.max(...valid));
    },
  };
}

export function siteClock(model: WpModel): SiteClock {
  const zone = (model.options.get("timezone_string") ?? "").trim();
  if (zone !== "") {
    try {
      return zoneClock(zone);
    } catch {
      // An unknown zone name: gmt_offset, or UTC, stands in (model.ts reports the bad name).
    }
  }
  const stated = (model.options.get("gmt_offset") ?? "").trim();
  const hours = Number(stated);
  const offset = stated !== "" && Number.isFinite(hours) ? hours * HOUR : 0;
  return { toLocal: (utcMs) => utcMs + offset, toUtc: (wallMs) => wallMs - offset };
}

// ── Dates ────────────────────────────────────────────────────────────────────────────────────────

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** `YYYY-MM-DD` when the digits name a real day, else undefined. */
function realDate(y: number, m: number, d: number): string | undefined {
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d
    ? `${pad(y, 4)}-${pad(m)}-${pad(d)}`
    : undefined;
}

/** A date picker's value (ACF stores `Ymd`, an import may leave `Y-m-d`) as `YYYY-MM-DD`. */
function dateOnly(raw: string): string | undefined {
  const text = raw.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return realDate(+compact[1]!, +compact[2]!, +compact[3]!);
  const dashed = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(text);
  return dashed ? realDate(+dashed[1]!, +dashed[2]!, +dashed[3]!) : undefined;
}

/**
 * A date-time picker's value (ACF stores `Y-m-d H:i:s` in the site's zone) as the UTC instant Jx stores,
 * `YYYY-MM-DDTHH:MM:SSZ`. A value that states its own zone is an instant already.
 */
function utcInstant(raw: string, clock: SiteClock): string | undefined {
  const text = raw.trim();
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?$/i.exec(
      text,
    );
  if (!m || realDate(+m[1]!, +m[2]!, +m[3]!) === undefined) return undefined;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, m[6] === undefined ? 0 : +m[6]);
  // `Z` is an instant as written; a numeric offset is how far that wall time is ahead of UTC; no zone at
  // all is the site's own.
  let utc: number;
  if (m[7] !== undefined) utc = wall;
  else if (m[8] !== undefined)
    utc = wall - (m[8] === "-" ? -1 : 1) * (+m[9]! * 60 + +m[10]!) * 60_000;
  else utc = clock.toUtc(wall);
  const d = new Date(utc);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

// ── Values ───────────────────────────────────────────────────────────────────────────────────────

/** Where a field's meta rows come from: a post's, a term's, or an options page's. */
interface Source {
  /** The first row's value under a meta name; undefined when there is no row at all (which is not the same as ""). */
  get(name: string): unknown;
  /** Names that were read, so the rest can be looked at afterwards. */
  consumed: Set<string>;
  /** Every non-empty name that ACF wrote (it has a `_name` row pointing at a field key). */
  keys(): string[];
}

function sourceOf(model: WpModel, target: AcfTarget, acf: AcfModel): Source | undefined {
  const consumed = new Set<string>();
  if (target.kind === "post") {
    const id = target.postId;
    const meta = id === undefined ? undefined : model.postMeta.get(id);
    return {
      get: (name) => (meta && Object.hasOwn(meta, name) ? meta[name]![0] : undefined),
      consumed,
      keys: () => Object.keys(meta ?? {}),
    };
  }
  if (target.kind === "user") {
    const meta = userProfiles(model).get(target.userId)?.meta;
    return {
      get: (name) => (meta && Object.hasOwn(meta, name) ? meta[name] : undefined),
      consumed,
      keys: () => Object.keys(meta ?? {}),
    };
  }
  if (target.kind === "term") {
    const term = target.termId === undefined ? undefined : model.terms.get(target.termId);
    const meta = term?.meta;
    return {
      get: (name) => (meta && Object.hasOwn(meta, name) ? meta[name] : undefined),
      consumed,
      keys: () => Object.keys(meta ?? {}),
    };
  }
  const page = acf.optionsPages.find((p) => p.slug === target.page);
  const prefix = page?.prefix ?? "options";
  const cache = new Map<string, unknown>();
  const read = (name: string): unknown => {
    // A value is `<prefix>_<name>` and the field key it belongs to is `_<prefix>_<name>`: the underscore
    // goes in front of the whole option name, not of the field's.
    const raw = model.options.get(
      name.startsWith("_") ? `_${prefix}_${name.slice(1)}` : `${prefix}_${name}`,
    );
    return raw === undefined ? undefined : maybeUnserialize(raw);
  };
  return {
    get: (name) => {
      if (!cache.has(name)) cache.set(name, read(name));
      return cache.get(name);
    },
    consumed,
    keys: () =>
      [...model.options.keys()]
        .filter((k) => k.startsWith(`${prefix}_`))
        .map((k) => k.slice(prefix.length + 1)),
  };
}

interface ReadContext {
  model: WpModel;
  source: Source;
  target: AcfTarget;
  clock: SiteClock;
  report: Report | undefined;
  where: string;
  url: string | undefined;
}

/** Whether a stored value says nothing: no row content, an empty list, or a blank string. */
function blank(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Ids in a stored list: ACF writes strings (`"4008"`), an import may leave numbers or a comma-separated string. */
function idsOf(raw: unknown): number[] {
  const parts = typeof raw === "string" && raw.includes(",") ? raw.split(",") : toList(raw);
  return parts
    .map((p) => (isRecord(p) ? int(p.ID ?? p.id ?? p.term_id) : int(p)))
    .filter(isDefined)
    .filter((n) => n > 0);
}

function unreadable(ctx: ReadContext, f: AcfField, raw: unknown): undefined {
  add(
    ctx.report,
    "warn",
    "acf.value-unreadable",
    `The ${f.type} field "${f.name}" holds a value that is not one a ${f.type} field stores; it was not carried over.`,
    ctx.where,
    { name: f.name, type: f.type, sample: JSON.stringify(raw)?.slice(0, 80) },
    ctx.url,
  );
  return undefined;
}

/**
 * Applies `default_value` when there is no row, as ACF's `acf_get_value` does. A default of `false`,
 * `null` or the empty string is ACF's "none" (it is what a field saved without one holds), and says nothing.
 */
function withDefault(row: unknown, f: AcfField): unknown {
  if (row !== undefined) return row;
  const d = f.default;
  return d === undefined || d === null || d === false || d === "" ? undefined : d;
}

/**
 * Reads one position. `prefix` is the stored name of everything above it (`rows_2_`), and the meta
 * name is the prefix and the slot's own: that is how ACF addresses a sub-field.
 */
function readSlot(slot: Slot, prefix: string, ctx: ReadContext): AcfRaw | undefined {
  const f = slot.field;
  const name = `${prefix}${slot.storage}`;
  const row = ctx.source.get(name);
  if (row !== undefined) ctx.source.consumed.add(name);
  const raw = withDefault(row, f);

  const children = (base: string): Record<string, AcfRaw> => {
    const values: Record<string, AcfRaw> = {};
    for (const child of pickSlots(slot.children, ctx.source, base)) {
      const v = readSlot(child, base, ctx);
      if (v) setOwn(values, child.entry, v);
    }
    return values;
  };

  switch (f.type) {
    case "text":
    case "textarea":
    case "wysiwyg":
    case "url":
    case "email":
    case "password":
    case "oembed":
    case "color_picker":
    case "time_picker": {
      if (blank(raw)) return undefined;
      if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint")
        return unreadable(ctx, f, raw);
      return { type: f.type, field: f, value: str(raw) };
    }
    case "number":
    case "range": {
      if (blank(raw)) return undefined;
      const n = num(raw);
      return n === undefined ? unreadable(ctx, f, raw) : { type: f.type, field: f, value: n };
    }
    case "true_false": {
      if (blank(raw)) return undefined;
      return { type: "true_false", field: f, value: truthy(raw) };
    }
    case "select":
    case "radio":
    case "button_group":
    case "checkbox": {
      if (blank(raw)) return undefined;
      const values = toList(raw)
        .map(str)
        .filter((v) => v !== "");
      return values.length === 0 ? undefined : { type: f.type, field: f, values };
    }
    case "date_picker":
    case "date_time_picker": {
      if (blank(raw)) return undefined;
      if (typeof raw !== "string" && typeof raw !== "number") return unreadable(ctx, f, raw);
      const value = String(raw);
      const iso = f.type === "date_picker" ? dateOnly(value) : utcInstant(value, ctx.clock);
      if (iso === undefined) {
        add(
          ctx.report,
          "warn",
          "acf.value-unreadable",
          `The ${f.type} field "${f.name}" holds ${JSON.stringify(value)}, which is not a date ACF stores; it is kept as written and Jx cannot sort it.`,
          ctx.where,
          { name: f.name, value },
          ctx.url,
        );
      }
      return { type: f.type, field: f, value, ...(iso === undefined ? {} : { iso }) };
    }
    case "image":
    case "file": {
      if (blank(raw)) return undefined;
      const id = isRecord(raw) ? int(raw.ID ?? raw.id) : int(raw);
      // An id of 0 is what some saves leave for "no image".
      if (id !== undefined) return id > 0 ? { type: f.type, field: f, id } : undefined;
      if (typeof raw === "string") return { type: f.type, field: f, url: raw };
      return unreadable(ctx, f, raw);
    }
    case "gallery": {
      if (blank(raw)) return undefined;
      const ids = idsOf(raw);
      return ids.length === 0 ? unreadable(ctx, f, raw) : { type: "gallery", field: f, ids };
    }
    case "link": {
      if (blank(raw)) return undefined;
      const link: AcfLink = isRecord(raw)
        ? { url: str(raw.url), title: str(raw.title), target: str(raw.target) }
        : typeof raw === "string"
          ? { url: raw, title: "", target: "" }
          : { url: "", title: "", target: "" };
      if (link.url === "" && link.title === "")
        return isRecord(raw) ? undefined : unreadable(ctx, f, raw);
      return { type: "link", field: f, value: link };
    }
    case "taxonomy": {
      // With `load_terms` ACF takes the value from the post's own term relationships, not from meta.
      if (
        truthy(f.settings.load_terms) &&
        ctx.target.kind === "post" &&
        ctx.target.postId !== undefined
      ) {
        const taxonomy = str(f.settings.taxonomy);
        const ids = (ctx.model.termsByPost.get(ctx.target.postId) ?? []).filter(
          (id) => ctx.model.terms.get(id)?.taxonomy === taxonomy,
        );
        return ids.length === 0 ? undefined : { type: "taxonomy", field: f, ids: [...ids] };
      }
      if (blank(raw)) return undefined;
      const ids = idsOf(raw);
      return ids.length === 0 ? unreadable(ctx, f, raw) : { type: "taxonomy", field: f, ids };
    }
    case "post_object":
    case "page_link":
    case "relationship":
    case "user":
    case "nav_menu": {
      if (blank(raw)) return undefined;
      const ids = idsOf(raw);
      return ids.length === 0 ? unreadable(ctx, f, raw) : { type: f.type, field: f, ids };
    }
    case "google_map":
    case "icon_picker": {
      if (blank(raw)) return undefined;
      return isRecord(raw) ? { type: f.type, field: f, value: raw } : unreadable(ctx, f, raw);
    }
    case "repeater": {
      // The row count is the stored value; a repeater without one has no rows, whatever else is stored.
      const count = int(raw) ?? 0;
      const rows: Record<string, AcfRaw>[] = [];
      const limit = Math.min(count, MAX_ROWS);
      if (count > MAX_ROWS) {
        add(
          ctx.report,
          "warn",
          "acf.value-unreadable",
          `The repeater "${f.name}" claims ${count} rows; only the first ${MAX_ROWS} are read.`,
          ctx.where,
          { name: f.name, count },
          ctx.url,
        );
      }
      for (let i = 0; i < limit; i++) {
        const values = children(`${name}_${i}_`);
        // A row with nothing in it says nothing: ACF keeps it, but there is no content to carry.
        if (Object.keys(values).length > 0) rows.push(values);
      }
      return rows.length === 0 ? undefined : { type: "repeater", field: f, rows };
    }
    case "group": {
      const values = children(`${name}_`);
      return Object.keys(values).length === 0 ? undefined : { type: "group", field: f, values };
    }
    case "clone": {
      // Only a clone shown as a group is a value of its own; a seamless one was replaced by its copies.
      const values = children(slot.flat ? prefix : `${name}_`);
      return Object.keys(values).length === 0 ? undefined : { type: "group", field: f, values };
    }
    case "flexible_content": {
      const names = toList(raw)
        .map(str)
        .filter((n) => n !== "");
      if (names.length === 0) return undefined;
      // An editor can switch a row off (SCF 6.5): the indices are in `_<name>_layout_meta`, and the site prints none of them.
      const meta = ctx.source.get(`_${name}_layout_meta`);
      const off = new Set(isRecord(meta) ? toList(meta.disabled).map(int).filter(isDefined) : []);
      const rows: { layout: string; values: Record<string, AcfRaw> }[] = [];
      names.slice(0, MAX_ROWS).forEach((layoutName, i) => {
        if (off.has(i)) {
          add(
            ctx.report,
            "info",
            "acf.layout-disabled",
            `Row ${i + 1} (${layoutName}) of the flexible content field "${f.name}" is switched off in the editor, so the live site does not print it; it was not carried over.`,
            ctx.where,
            { name: f.name, layout: layoutName, row: i },
            ctx.url,
          );
          return;
        }
        // ACF's `load_value` keeps the last of two layouts that share a name.
        const layout = f.layouts.findLast((l) => l.name === layoutName);
        if (!layout) {
          add(
            ctx.report,
            "warn",
            "acf.layout-unknown",
            `The flexible content field "${f.name}" has a row of the layout "${layoutName}", which the field no longer defines; the row was not carried over.`,
            ctx.where,
            { name: f.name, layout: layoutName },
            ctx.url,
          );
          return;
        }
        const values: Record<string, AcfRaw> = {};
        const base = `${name}_${i}_`;
        const inner = slotsOf(layout.subFields);
        for (const child of pickSlots(inner, ctx.source, base)) {
          const v = readSlot(child, base, ctx);
          if (v) setOwn(values, child.entry, v);
        }
        rows.push({ layout: layoutName, values });
      });
      return rows.length === 0 ? undefined : { type: "flexible_content", field: f, rows };
    }
    default: {
      if (blank(raw)) return undefined;
      return { type: "other", field: f, value: raw };
    }
  }
}

/** Rows read for one repeater; a stored count past this is corrupt, and each row costs a lookup per sub-field. */
const MAX_ROWS = 5000;

/**
 * Of several definitions that share a name, the one a post's own `_name` row points at; the first when
 * it points at none of them. (fineline's `county_image` exists in two groups, and each project says which.)
 */
function pickSlots(slots: readonly Slot[], source: Source, prefix: string): Slot[] {
  const first = new Map<string, Slot[]>();
  for (const slot of slots) {
    const list = first.get(slot.entry);
    if (list) list.push(slot);
    else first.set(slot.entry, [slot]);
  }
  const out: Slot[] = [];
  for (const [, list] of first) {
    if (list.length === 1) {
      out.push(list[0]!);
      continue;
    }
    const ref = source.get(`_${prefix}${list[0]!.storage}`);
    out.push(list.find((s) => s.field.key === ref) ?? list[0]!);
  }
  return out;
}

/**
 * The values of every field that applies to the target, as stored. Keyed by field name (not
 * {@link entryKey}). A field with nothing in it is left out; so is one whose group does not apply, and so is
 * one of a group that is switched off, unless `includeInactive` asks for those: ACF shows such a group on no
 * screen, but `get_field()` still serves the values of its fields to a template that asks for them.
 *
 * Meta that ACF wrote (it has a `_name` row naming a field key) but that no applicable field reads, and
 * that holds something, is reported as `acf.value-orphaned`: the field was deleted or renamed, or it
 * belongs to a group that is switched off.
 *
 * A post type and taxonomy have no entry here: only values are read, and only from meta (a post's, a
 * term's, or the rows of an options page).
 */
export function acfValues(
  model: WpModel,
  acf: AcfModel,
  target: AcfTarget,
  opts: { report?: Report; includeInactive?: boolean } = {},
): Record<string, AcfRaw> {
  const report = opts.report ?? reports.get(acf);
  const source = sourceOf(model, target, acf);
  const out: Record<string, AcfRaw> = {};
  if (!source) return out;

  const postId = target.kind === "post" ? target.postId : undefined;
  const post = postId === undefined ? undefined : model.posts.get(postId);
  const where = describe(target);
  const url = post ? publicUrl(model.site, post) : undefined;
  const ctx: ReadContext = { model, source, target, clock: siteClock(model), report, where, url };

  const slots = slotsOf(
    groupsFor(acf, target, opts.includeInactive ? { includeInactive: true } : {}).flatMap(
      (g) => g.fields,
    ),
  );
  for (const slot of pickSlots(slots, source, "")) {
    const value = readSlot(slot, "", ctx);
    if (value) setOwn(out, slot.entry, value);
  }

  // What ACF wrote that nothing above read.
  if (report) {
    const byKey = new Map<string, { field: AcfField; group: AcfGroup }>();
    const index = (group: AcfGroup, f: AcfField): void => {
      byKey.set(f.key, { field: f, group });
      for (const sub of f.subFields) index(group, sub);
      for (const layout of f.layouts) for (const sub of layout.subFields) index(group, sub);
    };
    for (const group of acf.groups) for (const f of group.fields) index(group, f);

    for (const name of source.keys()) {
      if (name.startsWith("_") || source.consumed.has(name)) continue;
      const reference = source.get(`_${name}`);
      if (typeof reference !== "string" || !reference.startsWith("field_")) continue;
      const value = source.get(name);
      if (blank(value) || value === "0") continue;
      const owner = byKey.get(reference);
      const renamed = owner !== undefined && owner.field.name !== name;
      add(
        report,
        "warn",
        "acf.value-orphaned",
        owner === undefined
          ? `The value of "${name}" belongs to a field (${reference}) that no longer exists; it was not carried over.`
          : renamed
            ? `The value of "${name}" was saved when the field "${owner.field.label}" of the group "${owner.group.title}" was called that; the field is now called "${owner.field.name}", and the old value was not carried over.`
            : `The value of "${name}" belongs to the field "${owner.field.label}" of the group "${owner.group.title}", which does not apply to this ${target.kind}${owner.group.active ? "" : " (the group is switched off; includeInactive reads it)"}; it was not carried over.`,
        where,
        { name, field: reference, value: sample(value) },
        url,
      );
    }
  }
  return out;
}

function sample(v: unknown): unknown {
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  const text =
    JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x)) ?? "";
  return text.length > 80 ? `${text.slice(0, 80)}…` : v;
}

// ── Entry data ───────────────────────────────────────────────────────────────────────────────────

/** A value that survives JSON and YAML: bigints are text, and anything else the stored value held is as it was. */
function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

function convert(raw: AcfRaw, hooks: EntryHooks): unknown {
  const f = raw.field;
  const resolve = <T>(
    ids: number[],
    kind: "attachment" | "post" | "term" | "user",
    hook: (id: number) => T | undefined,
  ): T[] =>
    ids
      .map((id) => {
        const found = hook(id);
        if (found === undefined) hooks.missing?.(kind, id, f.name);
        return found;
      })
      .filter(isDefined);

  switch (raw.type) {
    case "text":
    case "textarea":
    case "wysiwyg":
    case "url":
    case "email":
    case "password":
    case "oembed":
    case "color_picker":
    case "time_picker":
    case "number":
    case "range":
    case "true_false":
      return raw.value;
    case "select":
    case "radio":
    case "button_group":
    case "checkbox":
      return f.multiple ? raw.values : raw.values[0];
    case "date_picker":
    case "date_time_picker":
      return raw.iso;
    case "image":
    case "file": {
      if (raw.id !== undefined)
        return resolve([raw.id], "attachment", hooks.attachment.bind(hooks))[0];
      return raw.url === undefined ? undefined : ({ src: raw.url, alt: "" } satisfies EntryImage);
    }
    case "gallery": {
      const images = resolve(raw.ids, "attachment", hooks.attachment.bind(hooks));
      return images.length === 0 ? undefined : images;
    }
    case "link":
      return { ...raw.value };
    case "post_object":
    case "page_link":
    case "relationship":
    case "taxonomy":
    case "nav_menu":
    case "user": {
      // A menu is a term of the `nav_menu` taxonomy.
      const term = raw.type === "taxonomy" || raw.type === "nav_menu";
      const hook = term ? hooks.term : raw.type === "user" ? hooks.user : hooks.post;
      const kind = term ? "term" : raw.type === "user" ? "user" : "post";
      const refs = resolve(raw.ids, kind, hook.bind(hooks));
      if (refs.length === 0) return undefined;
      return f.multiple ? refs : refs[0];
    }
    case "repeater": {
      const rows = raw.rows
        .map((row) => convertObject(row, hooks))
        .filter((row) => Object.keys(row).length > 0);
      return rows.length === 0 ? undefined : rows;
    }
    case "group": {
      const values = convertObject(raw.values, hooks);
      return Object.keys(values).length === 0 ? undefined : values;
    }
    case "flexible_content": {
      const rows = raw.rows.map((row) => ({
        acf_fc_layout: row.layout,
        ...convertObject(row.values, hooks),
      }));
      return rows.length === 0 ? undefined : rows;
    }
    case "google_map":
    case "icon_picker":
      return plain(raw.value);
    case "other":
      return plain(raw.value);
  }
}

/** Row and group values keep the plain sub-field names: only the top level can collide with the contract. */
function convertObject(values: Record<string, AcfRaw>, hooks: EntryHooks): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(values)) {
    const v = convert(raw, hooks);
    if (v !== undefined) setOwn(out, name, v);
  }
  return out;
}

/**
 * Raw ACF values in the shapes of the entry data contract: text, numbers and booleans as they are
 * (wysiwyg stays HTML); a select, radio or button group as its value (a list when it holds several); a date
 * as `YYYY-MM-DD` or a UTC instant, which is what Jx's date coercion expects; an image or file as
 * `{src, width, height, alt}`; a gallery as a list of those; a link as `{url, title, target}`; a
 * relationship, post, taxonomy or user as `{id, slug, title, url}` (a list when the field holds several);
 * a repeater as a list of row objects keyed by sub-field name; a group as an object; a flexible content
 * field as a list of rows each with `acf_fc_layout`.
 *
 * Keys are {@link entryKey} of the field name. An id the hooks cannot resolve is dropped and handed to
 * `hooks.missing`; a value that comes out empty is left out.
 */
export function toEntryData(
  values: Record<string, AcfRaw>,
  hooks: EntryHooks,
): Record<string, unknown> {
  const converted: [string, unknown][] = [];
  for (const [name, raw] of Object.entries(values)) {
    const v = convert(raw, hooks);
    if (v !== undefined) converted.push([name, v]);
  }
  const keys = entryKeys(converted.map(([name]) => name));
  const out: Record<string, unknown> = {};
  for (const [name, v] of converted) setOwn(out, keys.get(name)!, v);
  return out;
}

/** The names of the ACF fields that hold a person (`user` fields), wherever they nest. */
export function userFieldNames(acf: AcfModel): Set<string> {
  const names = new Set<string>();
  const visit = (f: AcfField): void => {
    if (f.type === "user") names.add(f.name);
    for (const sub of f.subFields) visit(sub);
    for (const layout of f.layouts) for (const sub of layout.subFields) visit(sub);
  };
  for (const group of acf.groups) for (const f of group.fields) visit(f);
  return names;
}
