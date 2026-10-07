/**
 * User profiles: what a site prints about a person, apart from the account.
 *
 * `WpModel.users` holds the authors of what was loaded and nothing but their id, address name and display
 * name (the account's email, login and password hash never leave the table). A site that shows a person
 * (an author's page, a podcast's host and guests) prints more than that: a photograph, a position, a
 * biography, which an ACF field group on the user form stores as user meta, one `<name>` row for the value
 * and one `_<name>` row naming the field (`field_62d8…`). Those rows, and only those rows, are the profile:
 * a meta key is read when its `_<key>` partner points at an ACF field, plus the WordPress `description`
 * (the biography field of the profile screen) and the first and last name an author page prints. Session
 * tokens, contact details a plugin keeps, billing addresses and every other row of `usermeta` are not read,
 * apart from the role names of the capabilities row. A person is kept for what is filled in (an account
 * that holds only the empty field rows ACF writes for everyone has no profile), and the emitters write only
 * the profiles of the people the converted content shows.
 *
 * The model's type has no place for them (it is the contract of `src/types.ts`), so they are kept beside
 * it, by model, and read through {@link userProfiles}.
 */
import type { Report, WpDb, WpModel, WpUser } from "../types.ts";
import { tableExists } from "./db.ts";
import { maybeUnserialize } from "./phpser.ts";

export interface UserProfile extends WpUser {
  /** The profile's meta by name: the ACF fields of the user form, and `description`. Values are unserialised. */
  meta: Record<string, unknown>;
  /**
   * The roles the account holds (`staff`, `board_member`), for the lists a page makes of a role's people.
   * Only the role names are read from the capabilities row, never what a role may do.
   */
  roles: string[];
}

const PROFILES = new WeakMap<object, ReadonlyMap<number, UserProfile>>();

const EMPTY: ReadonlyMap<number, UserProfile> = new Map();

/** The profiles of the people a model's site shows, by user id; empty for a model that was not loaded here. */
export function userProfiles(model: WpModel): ReadonlyMap<number, UserProfile> {
  return PROFILES.get(model) ?? EMPTY;
}

/** Keep the profiles beside the model they were read for. */
export function setUserProfiles(model: WpModel, profiles: ReadonlyMap<number, UserProfile>): void {
  PROFILES.set(model, profiles);
}

type Row = Record<string, unknown>;

const text = (v: unknown): string =>
  v === null || v === undefined
    ? ""
    : v instanceof Uint8Array
      ? new TextDecoder().decode(v)
      : String(v);

const FIELD_KEY = /^field_[0-9a-f]+$/i;

/**
 * The WordPress profile fields an author's page prints (`{authorinfo=first_name}`): the biography box and
 * the two names. Read for the people who have a profile; the names do not make one (every account has them).
 */
const PROFILE_NAMES = ["description", "first_name", "last_name"] as const;
const MARKS_CHUNK = 400;

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/** A key that is safe to write as a property of a plain object. */
const own = (record: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

/**
 * Read the profiles. `known` are the users the model already has (the authors); a person with profile meta
 * who is not an author (a guest, a host who never posted) is added with their own account row.
 */
export async function loadUserProfiles(
  db: WpDb,
  known: ReadonlyMap<number, WpUser>,
  report?: Report,
): Promise<Map<number, UserProfile>> {
  const out = new Map<number, UserProfile>();
  const columns = ["umeta_id", "user_id", "meta_key", "meta_value"] as const;
  if (!(await tableExists(db, "usermeta", columns)) || !(await tableExists(db, "users", ["ID"]))) {
    return out;
  }
  const t = (name: string): string => db.table(name);

  // The fields: every `_<name>` row that holds an ACF field key.
  const names = new Set<string>();
  for (const row of await db.query<Row>(
    `select meta_key from ${t("usermeta")} where meta_value like 'field%' order by umeta_id`,
  )) {
    const key = text(row.meta_key);
    if (key.startsWith("_") && key.length > 1) names.add(key.slice(1));
  }
  const fieldNames = new Set<string>();
  // Which of them really hold a field key (`like 'field%'` is looser): the value is read below with the row.
  const wanted = [...names, ...[...names].map((n) => `_${n}`), ...PROFILE_NAMES];
  const rows: Row[] = [];
  for (let i = 0; i < wanted.length; i += MARKS_CHUNK) {
    const part = wanted.slice(i, i + MARKS_CHUNK);
    rows.push(
      ...(await db.query<Row>(
        `select user_id, meta_key, meta_value from ${t("usermeta")} where meta_key in (${marks(part.length)}) order by umeta_id`,
        part,
      )),
    );
  }
  for (const row of rows) {
    const key = text(row.meta_key);
    if (key.startsWith("_") && FIELD_KEY.test(text(row.meta_value))) fieldNames.add(key.slice(1));
  }

  const byUser = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    const key = text(row.meta_key);
    const field = key.startsWith("_") ? key.slice(1) : key;
    if (!(PROFILE_NAMES as readonly string[]).includes(key) && !fieldNames.has(field)) continue;
    const id = Number(text(row.user_id));
    if (!Number.isInteger(id)) continue;
    let meta = byUser.get(id);
    if (!meta) {
      meta = {};
      byUser.set(id, meta);
    }
    // Last value wins (rows arrive in meta_id order), as WordPress reads a single meta value.
    own(meta, key, row.meta_value === null ? null : maybeUnserialize(text(row.meta_value)));
  }

  // A person is kept for what is filled in: ACF writes the `_<name>` field rows for every account it
  // sees, so a row that names a field says nothing until its value is there.
  const filled = (meta: Record<string, unknown>): boolean =>
    Object.entries(meta).some(
      ([key, value]) =>
        !key.startsWith("_") &&
        key !== "first_name" &&
        key !== "last_name" &&
        value !== null &&
        value !== "" &&
        value !== "0" &&
        !(Array.isArray(value) && value.length === 0),
    );
  for (const [id, meta] of byUser) if (!filled(meta)) byUser.delete(id);

  const missing = [...byUser.keys()].filter((id) => !known.has(id)).sort((a, b) => a - b);
  const accounts = new Map<number, WpUser>(known);
  for (let i = 0; i < missing.length; i += MARKS_CHUNK) {
    const part = missing.slice(i, i + MARKS_CHUNK);
    for (const row of await db.query<Row>(
      `select ID as id, user_nicename, display_name from ${t("users")} where ID in (${marks(part.length)}) order by ID`,
      part,
    )) {
      const id = Number(text(row.id));
      accounts.set(id, { id, slug: text(row.user_nicename), displayName: text(row.display_name) });
    }
  }
  // The roles of those people: the keys of the capabilities map, which `<prefix>capabilities` holds.
  const roles = new Map<number, string[]>();
  const ids = [...byUser.keys()];
  for (let i = 0; i < ids.length; i += MARKS_CHUNK) {
    const part = ids.slice(i, i + MARKS_CHUNK);
    for (const row of await db.query<Row>(
      `select user_id, meta_value from ${t("usermeta")} where meta_key = ? and user_id in (${marks(part.length)}) order by umeta_id`,
      [`${db.prefix}capabilities`, ...part],
    )) {
      const caps = row.meta_value === null ? undefined : maybeUnserialize(text(row.meta_value));
      if (caps === null || typeof caps !== "object" || Array.isArray(caps)) continue;
      roles.set(
        Number(text(row.user_id)),
        Object.entries(caps as Record<string, unknown>)
          .filter(([, granted]) => granted === true || granted === 1 || granted === "1")
          .map(([role]) => role),
      );
    }
  }
  for (const [id, meta] of [...byUser].sort((a, b) => a[0] - b[0])) {
    const account = accounts.get(id);
    if (account) out.set(id, { ...account, meta, roles: roles.get(id) ?? [] });
  }
  if (report && out.size > 0) {
    report.add({
      severity: "info",
      code: "wp.user-profiles",
      message: `${out.size} people have a profile (${[...fieldNames].sort().join(", ")}) that the pages that show them can print. Only those fields are read from the users' meta; nothing else about an account is.`,
      where: `table:${db.table("usermeta")}`,
      data: { people: out.size, fields: [...fieldNames].sort() },
    });
  }
  return out;
}

const idsOfValue = (value: unknown): number[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .flat()
    .map((v) =>
      typeof v === "object" && v !== null ? Number((v as { ID?: unknown }).ID) : Number(v),
    )
    .filter((n) => Number.isInteger(n) && n > 0);

/**
 * The people the posts name in an ACF user field (a podcast's host and guests): the ids the posts'
 * meta holds under the names of the user fields. The model's `users` are the authors, so a guest who
 * never wrote anything is only known by being named.
 */
export function referencedUsers(model: WpModel, userFieldNames: ReadonlySet<string>): number[] {
  const ids = new Set<number>();
  if (userFieldNames.size === 0) return [];
  for (const meta of model.postMeta.values()) {
    for (const name of userFieldNames) {
      if (!Object.hasOwn(meta, name)) continue;
      for (const id of idsOfValue(meta[name]![0])) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Add the people the posts name in a user field and no profile holds: their account's display name and
 * address name, and their roles. Nothing else of the account is read.
 */
export async function addReferencedUsers(
  db: WpDb,
  model: WpModel,
  ids: readonly number[],
): Promise<void> {
  const have = new Map(userProfiles(model));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length === 0 || !(await tableExists(db, "users", ["ID"]))) return;
  const t = (name: string): string => db.table(name);
  const added = new Map(have);
  for (let i = 0; i < missing.length; i += MARKS_CHUNK) {
    const part = missing.slice(i, i + MARKS_CHUNK);
    const known = model.users;
    for (const row of await db.query<Row>(
      `select ID as id, user_nicename, display_name from ${t("users")} where ID in (${marks(part.length)}) order by ID`,
      part,
    )) {
      const id = Number(text(row.id));
      const account = known.get(id) ?? {
        id,
        slug: text(row.user_nicename),
        displayName: text(row.display_name),
      };
      added.set(id, { ...account, meta: {}, roles: [] });
    }
  }
  setUserProfiles(model, added);
}
