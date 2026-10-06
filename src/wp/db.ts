/**
 * Read-only access to a WordPress database, MySQL/MariaDB or SQLite, through `Bun.SQL`.
 *
 * Callers write one dialect (`?` placeholders, no quoting, no vendor functions) and get plain arrays
 * of plain row objects back. Value types still differ by engine and are NOT normalised here: MySQL
 * returns `Date` for DATETIME and a string for a BIGINT past 2^31 or a DECIMAL, SQLite returns date
 * strings; `wp/model.ts` is where those become the one shape the rest of wp2jx reads.
 *
 * Read-only is enforced twice, because the database being migrated may be a live production one. A
 * statement guard refuses anything that is not a single read before it is sent, and the engine
 * refuses writes behind it: SQLite is opened read-only, and every MySQL statement runs on a
 * connection whose session has just been told `SET SESSION TRANSACTION READ ONLY`. The guard is the
 * layer that must be right about statements stacked with `;`: Bun's MySQL client runs them, and a
 * stacked `START TRANSACTION READ WRITE` undoes even a read-only session. So it reads comments the way
 * MySQL does: `--1` is not a comment, and a `/*!` comment is SQL. Where a MySQL account exists that
 * can only read, use it.
 */
import { SQL } from "bun";
import { existsSync } from "node:fs";
import type { WpDb } from "../types.ts";

export interface OpenDbOptions {
  /** The table prefix, trailing underscore included. Detected from the table list when absent. */
  prefix?: string | undefined;
}

type Engine = "mysql" | "sqlite";

type Row = Record<string, unknown>;

/** Runs one statement and answers its rows. */
type Run = (sql: string, params?: unknown[]) => Promise<Row[]>;

interface Target {
  engine: Engine;
  /** What to call it in an error message: the input with any password masked. */
  label: string;
  /** For SQLite, the file; for MySQL, the original URL. */
  location: string;
}

/** Query parameters that carry a secret (`?password=…`). */
const SECRET_PARAM = /([?&;](?:password|passwd|pwd|pass)=)[^&#;]*/gi;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The location with any password replaced, for error messages.
 *
 * Done on the text, not through `URL`: a password is whatever a person pasted, `/`, `?` and `#`
 * included, and a URL parser ends the authority at the first of those, so it either refuses the
 * location or accepts it with the password left sitting in the path. The user holds none of
 * `: / ? # @`; the password runs to the LAST `@`. Masking too much is harmless, leaking is not.
 */
function redact(url: string): string {
  const scheme = SCHEME.exec(url)?.[0] ?? "";
  const masked = url.slice(scheme.length).replace(/^([^:/?#@]*):[\s\S]*@/, "$1:***@");
  return `${scheme}${masked}`.replace(SECRET_PARAM, "$1***");
}

/**
 * Whether an `@` follows the end of the authority (the first `/`, `?` or `#`): the sign of a password
 * that held one of those characters unencoded, so the host part was cut short. Such a URL would be
 * read as a host named after the user, and the connection would go there.
 */
function authorityCutShort(url: string): boolean {
  const rest = url.replace(SCHEME, "");
  const end = rest.search(/[/?#]/);
  if (end === -1) return false;
  const authority = rest.slice(0, end);
  return (authority.includes(":") || authority.includes("@")) && rest.slice(end).includes("@");
}

const SQLITE_FILE = /\.(?:sqlite3?|db3?)$/i;

function parseTarget(input: string): Target {
  const url = input.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === "mysql" || scheme === "mariadb") {
    if (authorityCutShort(url)) {
      throw new Error(
        `cannot open ${redact(url)}: an "@" after the host part means the password holds a "/", "?" or "#"; write it percent-encoded (%2F, %3F, %23)`,
      );
    }
    return { engine: "mysql", label: redact(url), location: url };
  }
  if (scheme === "sqlite") {
    // `sqlite:/abs`, `sqlite:///abs`, `sqlite://./rel` and `sqlite:rel` all name a file; two slashes
    // introduce an (empty) authority and are not part of the path.
    const rest = url.slice("sqlite:".length);
    const file = rest.startsWith("//") ? rest.slice(2) : rest;
    return { engine: "sqlite", label: `sqlite:${file}`, location: file };
  }
  if (scheme === undefined && (SQLITE_FILE.test(url) || existsSync(url))) {
    return { engine: "sqlite", label: `sqlite:${url}`, location: url };
  }
  throw new Error(
    `unsupported database location ${JSON.stringify(redact(url))}: expected mysql://, mariadb:// or sqlite:<file>`,
  );
}

/** The part of Bun's connection pool {@link readOnlyRunner} uses: one connection, taken out of it. */
export interface ReservingPool {
  reserve(): Promise<{
    unsafe(sql: string, params?: unknown[]): PromiseLike<unknown[]>;
    release(): void;
  }>;
}

/**
 * Runs each statement on a connection whose session has just been put in read-only mode. MySQL has no
 * read-only open flag, so the engine is asked on every statement rather than once at open: the pool
 * may hand out a different connection next time, or reconnect after the server dropped one, and a new
 * connection is read-write. A read-only session also survives a stacked `COMMIT`, which would end a
 * `START TRANSACTION READ ONLY` and leave the next statement read-write.
 *
 * Fails closed: if the session cannot be made read-only the statement is not sent. The connection is
 * handed back to the pool either way.
 */
export function readOnlyRunner(pool: ReservingPool): Run {
  return async (sql, params = []) => {
    const connection = await pool.reserve();
    try {
      await connection.unsafe("set session transaction read only");
      return (await connection.unsafe(sql, params)) as Row[];
    } finally {
      connection.release();
    }
  };
}

interface Connection {
  run: Run;
  close(): Promise<void>;
}

function connect(target: Target): Connection {
  if (target.engine === "mysql") {
    const client = new SQL(target.location);
    return { run: readOnlyRunner(client), close: () => client.close() };
  }
  if (!existsSync(target.location)) {
    // Without this a mistyped path is silently created as an empty database and the failure
    // surfaces later as "no WordPress tables".
    throw new Error(`SQLite database not found: ${target.location}`);
  }
  // `readonly` is enforced by the engine itself. (A WAL-mode database also needs its directory to be
  // writable for the shared-memory file; WordPress dumps loaded for migration are not in WAL mode.)
  const client = new SQL({ adapter: "sqlite", filename: target.location, readonly: true });
  return {
    run: async (sql, params = []) => (await client.unsafe(sql, params)) as Row[],
    close: () => client.close(),
  };
}

const PREFIX_CHARS = /^[A-Za-z0-9_$]*$/;
const TABLE_CHARS = /^[A-Za-z0-9_]+$/;
const REQUIRED = ["options", "posts", "postmeta"] as const;

async function listTables(run: Run, engine: Engine): Promise<string[]> {
  const rows =
    engine === "sqlite"
      ? await run("select name from sqlite_master where type = 'table'")
      : await run("show tables");
  return rows.map((row) => String(Object.values(row)[0]));
}

/** Every prefix P for which P+options, P+posts and P+postmeta all exist. */
function candidatePrefixes(tables: readonly string[]): string[] {
  const present = new Set(tables);
  const found: string[] = [];
  for (const table of tables) {
    if (!table.endsWith("options")) continue;
    const prefix = table.slice(0, -"options".length);
    // A prefix is interpolated into SQL below, so only the characters WordPress itself allows count.
    if (!PREFIX_CHARS.test(prefix) || found.includes(prefix)) continue;
    if (REQUIRED.every((name) => present.has(`${prefix}${name}`))) found.push(prefix);
  }
  return found;
}

const count = (rows: Row[]): number => Number(rows[0]?.n ?? 0);

/**
 * Picks the live install among the candidate prefixes. A migrated site often carries stale `tmp…_`
 * copies of the same tables next to the live ones, so when several qualify the live one is the one
 * whose options table has a `siteurl` and that holds the most posts; a tie is an error, not a guess.
 */
async function choosePrefix(
  run: Run,
  candidates: readonly string[],
  tables: readonly string[],
): Promise<string> {
  if (candidates.length === 0) {
    throw new Error(
      `no WordPress tables found: expected <prefix>options, <prefix>posts and <prefix>postmeta among ${tables.length} tables` +
        (tables.length > 0
          ? ` (${tables.slice(0, 8).join(", ")}${tables.length > 8 ? ", …" : ""})`
          : ""),
    );
  }
  if (candidates.length === 1) return candidates[0]!;

  const stats: { prefix: string; hasSiteurl: boolean; posts: number }[] = [];
  for (const prefix of candidates) {
    const siteurl = await run(
      `select count(*) as n from ${prefix}options where option_name = 'siteurl'`,
    );
    const posts = await run(`select count(*) as n from ${prefix}posts`);
    stats.push({ prefix, hasSiteurl: count(siteurl) > 0, posts: count(posts) });
  }
  const live = stats.filter((s) => s.hasSiteurl);
  const pool = live.length > 0 ? live : stats;
  const most = Math.max(...pool.map((s) => s.posts));
  const winners = pool.filter((s) => s.posts === most);
  if (winners.length === 1) return winners[0]!.prefix;
  const named = stats.map(
    (s) =>
      `${JSON.stringify(s.prefix)} (siteurl ${s.hasSiteurl ? "set" : "missing"}, ${s.posts} posts)`,
  );
  throw new Error(
    `cannot tell which table prefix is the live site: ${named.join("; ")}. Pass the prefix explicitly.`,
  );
}

// What a read-only handle will run. A statement that starts with anything else is a mistake in the
// caller, and the database being migrated may be a live production one.
const READ_ONLY_START = /^(?:select|with|show|describe|desc|explain)\b/i;
/**
 * String literals, quoted identifiers and comments: replaced by a space before the statement is judged.
 * `--` starts a comment only when whitespace (or the end) follows, as MySQL reads it: `select 5 --1` is
 * `select 5 - -1` there, and everything after it is live SQL, so it must stay visible to the checks below.
 */
const LITERALS_AND_COMMENTS =
  /'(?:[^'\\]|\\[\s\S]|'')*'|"(?:[^"\\]|\\[\s\S]|"")*"|`[^`]*`|--(?=\s|$)[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g;
/** `/*! … *\/` and MariaDB's `/*M! … *\/`: comments to every other engine, SQL to MySQL. */
const EXECUTABLE_COMMENT = /^\/\*M?!/;

function assertReadOnly(statement: string): void {
  const sql = statement
    .replace(LITERALS_AND_COMMENTS, (token) => {
      if (EXECUTABLE_COMMENT.test(token)) {
        throw new Error(
          "this database handle is read-only; refusing a MySQL executable comment (/*! … */), which the server runs as SQL",
        );
      }
      return " ";
    })
    .trimStart();
  if (!READ_ONLY_START.test(sql)) {
    throw new Error(
      `this database handle is read-only; refusing a statement that starts ${JSON.stringify(sql.slice(0, 30))}`,
    );
  }
  if (/\binto\s+(?:outfile|dumpfile)\b/i.test(sql))
    throw new Error("this database handle is read-only; refusing INTO OUTFILE");
  if (/;\s*\S/.test(sql))
    throw new Error("this database handle is read-only; refusing more than one statement");
}

/**
 * Opens a WordPress database.
 *
 * `url` is `mysql://user:pass@host:port/db` (or `mariadb://`), `sqlite:<file>`, or a bare path to an
 * existing `.sqlite`/`.db` file. The connection is made, and the table prefix checked or detected,
 * before this resolves, so a wrong password or a database that is not WordPress fails here with a
 * message that names the problem (never the password, whatever characters it holds).
 */
export async function openDb(url: string, opts: OpenDbOptions = {}): Promise<WpDb> {
  const target = parseTarget(url);
  if (opts.prefix !== undefined && !PREFIX_CHARS.test(opts.prefix)) {
    throw new Error(
      `invalid table prefix ${JSON.stringify(opts.prefix)}: letters, digits, _ and $ only`,
    );
  }
  let connection: Connection | undefined;
  let prefix: string;
  try {
    connection = connect(target);
    const tables = await listTables(connection.run, target.engine);
    const candidates = candidatePrefixes(tables);
    if (opts.prefix !== undefined) {
      const missing = REQUIRED.filter((name) => !tables.includes(`${opts.prefix}${name}`));
      if (missing.length > 0) {
        throw new Error(
          `no ${missing.map((n) => `${opts.prefix}${n}`).join(", ")} table in this database` +
            (candidates.length > 0
              ? `; WordPress tables were found under the prefix ${candidates.map((c) => JSON.stringify(c)).join(", ")}`
              : ""),
        );
      }
      prefix = opts.prefix;
    } else {
      prefix = await choosePrefix(connection.run, candidates, tables);
    }
  } catch (error) {
    try {
      await connection?.close();
    } catch {
      // The failure worth reporting is the one that got us here, not a close that follows it.
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot open ${target.label}: ${reason}`, { cause: error });
  }
  const open = connection;

  let closed = false;
  return {
    prefix,
    table(name: string): string {
      if (!TABLE_CHARS.test(name)) throw new Error(`invalid table name ${JSON.stringify(name)}`);
      return `${prefix}${name}`;
    },
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (closed) throw new Error("this database handle is closed");
      assertReadOnly(sql);
      // `undefined` is not a bindable value; a missing optional is NULL.
      const bound = params.map((p) => (p === undefined ? null : p));
      const rows = await open.run(sql, bound);
      // Bun hands back an array subclass carrying `count`, `command` and friends; callers get a plain one.
      return Array.from(rows) as T[];
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await open.close();
    },
  };
}

/**
 * Whether `<prefix><name>` exists and has `columns` (default: none in particular).
 *
 * Asked of the database rather than a table list because a `WpDb` offers only `query`: a `select`
 * that can match nothing succeeds on a table that is there and fails with the engine's own "no such
 * table" / "no such column" (SQLite's messages; MySQL errors 1146 and 1054) on one that is not. A
 * table that exists without the columns counts as absent: the fixture helper makes exactly that,
 * a table of one `id` column, for a table whose JSON file was empty. Any other failure is a real
 * error and is rethrown.
 */
export async function tableExists(
  db: WpDb,
  name: string,
  columns: readonly string[] = [],
): Promise<boolean> {
  try {
    await db.query(
      `select ${columns.length > 0 ? columns.join(", ") : "1"} from ${db.table(name)} where 1 = 0`,
    );
    return true;
  } catch (error) {
    const e = error as { errno?: unknown; sqlState?: unknown; message?: unknown };
    const absent =
      e.errno === 1146 ||
      e.errno === 1054 ||
      e.sqlState === "42S02" ||
      e.sqlState === "42S22" ||
      /no such (?:table|column)/i.test(String(e.message));
    if (absent) return false;
    throw error;
  }
}
