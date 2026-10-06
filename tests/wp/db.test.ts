import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { openDb, type ReservingPool, readOnlyRunner, tableExists } from "../../src/wp/db.ts";
import type { WpDb } from "../../src/types.ts";
import { fixtureDb } from "../helpers/fixture-db.ts";

const scratch = mkdtempSync(join(tmpdir(), "wp2jx-db-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
interface FakeSite {
  prefix: string;
  siteurl?: string;
  posts: number;
}

/** A SQLite file holding just enough of one or more WordPress installs to exercise prefix detection. */
function makeDb(sites: FakeSite[], extraTables: string[] = []): string {
  const path = join(scratch, `db-${counter++}.sqlite`);
  const db = new Database(path, { create: true });
  // Names are quoted so that a prefix WordPress could not have written (`we-ird_`) can be made too.
  for (const site of sites) {
    const t = (name: string): string => `\`${site.prefix}${name}\``;
    db.run(`create table ${t("options")} (option_id integer, option_name text, option_value text)`);
    db.run(`create table ${t("posts")} (ID integer, post_title text)`);
    db.run(`create table ${t("postmeta")} (meta_id integer, post_id integer)`);
    if (site.siteurl !== undefined) {
      db.run(`insert into ${t("options")} values (1, 'siteurl', '${site.siteurl}')`);
    }
    db.run(`insert into ${t("options")} values (2, 'blogname', 'x')`);
    for (let i = 0; i < site.posts; i++)
      db.run(`insert into ${t("posts")} values (${i + 1}, 'p${i}')`);
  }
  for (const name of extraTables) db.run(`create table \`${name}\` (id integer)`);
  db.close();
  return `sqlite:${path}`;
}

const SITES = { fineline: "KjLnF_", ap: "wp_" } as const;

// ── The two fixture sites ────────────────────────────────────────────────────────────────────────

describe.each(Object.entries(SITES))("%s fixture", (site, prefix) => {
  test("the prefix is detected from the table list", async () => {
    const { url } = await fixtureDb(site);
    const db = await openDb(url);
    try {
      expect(db.prefix).toBe(prefix);
      expect(db.table("posts")).toBe(`${prefix}posts`);
      expect(db.table("rank_math_redirections")).toBe(`${prefix}rank_math_redirections`);
    } finally {
      await db.close();
    }
  });

  test("an explicit prefix is honoured", async () => {
    const { url } = await fixtureDb(site);
    const db = await openDb(url, { prefix });
    try {
      expect(db.prefix).toBe(prefix);
      const rows = await db.query<{ n: number }>(`select count(*) as n from ${db.table("posts")}`);
      expect(rows[0]!.n).toBeGreaterThan(1000);
    } finally {
      await db.close();
    }
  });

  test("rows come back as a plain array of plain objects", async () => {
    const { url, path } = await fixtureDb(site);
    const db = await openDb(url);
    try {
      const rows = await db.query<{ id: number; post_name: string }>(
        `select ID as id, post_name from ${db.table("posts")} order by ID limit 5`,
      );
      expect(Array.isArray(rows)).toBe(true);
      expect(Object.getPrototypeOf(rows)).toBe(Array.prototype);
      expect(rows).toHaveLength(5);
      expect(Object.keys(rows)).toEqual(["0", "1", "2", "3", "4"]); // no count/command/affectedRows riding along
      for (const row of rows) expect(Object.getPrototypeOf(row)).toBe(Object.prototype);

      // The same rows, straight from the SQLite file.
      const direct = new Database(path, { readonly: true });
      const expected = direct
        .query(`select ID as id, post_name from ${prefix}posts order by ID limit 5`)
        .all();
      direct.close();
      expect(rows).toEqual(expected as typeof rows);
    } finally {
      await db.close();
    }
  });

  test("placeholders bind, and a query with no matching rows is an empty array", async () => {
    const { url, path } = await fixtureDb(site);
    const direct = new Database(path, { readonly: true });
    const sample = direct
      .query(
        `select ID, post_title, post_type from ${prefix}posts where post_title <> '' order by ID desc limit 1`,
      )
      .get() as { ID: number; post_title: string; post_type: string };
    const total = (
      direct
        .query(`select count(*) as n from ${prefix}posts where post_type = ?`)
        .get(sample.post_type) as { n: number }
    ).n;
    direct.close();

    const db = await openDb(url);
    try {
      const one = await db.query<{ post_title: string }>(
        `select post_title from ${db.table("posts")} where ID = ?`,
        [sample.ID],
      );
      expect(one).toEqual([{ post_title: sample.post_title }]);
      const byType = await db.query<{ n: number }>(
        `select count(*) as n from ${db.table("posts")} where post_type = ? and post_status <> ?`,
        [sample.post_type, "no-such-status"],
      );
      expect(Number(byType[0]!.n)).toBe(total);
      expect(await db.query(`select ID from ${db.table("posts")} where ID = ?`, [-1])).toEqual([]);
      // An undefined parameter is NULL, not an error.
      expect(
        await db.query(`select ID from ${db.table("posts")} where post_title = ?`, [undefined]),
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });

  test("close() is idempotent and a closed handle refuses to query", async () => {
    const { url } = await fixtureDb(site);
    const db = await openDb(url);
    await db.close();
    await db.close();
    await expect(db.query("select 1")).rejects.toThrow(/this database handle is closed/);
  });

  test("a prefix that is not in this database is refused, and the error names the right one", async () => {
    const { url } = await fixtureDb(site);
    await expect(openDb(url, { prefix: "nope_" })).rejects.toThrow(
      new RegExp(`no nope_options, nope_posts, nope_postmeta table.*${prefix}`),
    );
  });
});

// ── Handles are independent, and several can be open at once ─────────────────────────────────────

test("two handles on two databases do not interfere", async () => {
  const [a, b] = await Promise.all([fixtureDb("fineline"), fixtureDb("ap")]);
  const [dbA, dbB] = await Promise.all([openDb(a.url), openDb(b.url)]);
  try {
    expect([dbA.prefix, dbB.prefix]).toEqual(["KjLnF_", "wp_"]);
    const [x, y] = await Promise.all([
      dbA.query<{ v: string }>(
        `select option_value as v from ${dbA.table("options")} where option_name = 'siteurl'`,
      ),
      dbB.query<{ v: string }>(
        `select option_value as v from ${dbB.table("options")} where option_name = 'siteurl'`,
      ),
    ]);
    expect(x[0]!.v).toBe("https://finelinepainting.pro");
    expect(y[0]!.v).toBe("https://anabaptistperspectives.org");
  } finally {
    await Promise.all([dbA.close(), dbB.close()]);
  }
});

// ── URL forms ────────────────────────────────────────────────────────────────────────────────────

describe("locations", () => {
  test("every sqlite: spelling of the same file opens it", async () => {
    const { path } = await fixtureDb("fineline");
    for (const url of [`sqlite:${path}`, `sqlite://${path}`, `SQLITE:${path}`, path]) {
      const db = await openDb(url);
      expect(db.prefix, url).toBe("KjLnF_");
      await db.close();
    }
  });

  test("a relative sqlite: path is relative to the working directory", async () => {
    const { path } = await fixtureDb("fineline");
    const rel = relative(process.cwd(), path);
    expect(isAbsolute(rel)).toBe(false);
    for (const url of [`sqlite:${rel}`, `sqlite://./${rel}`]) {
      const db = await openDb(url);
      expect(db.prefix, url).toBe("KjLnF_");
      await db.close();
    }
  });

  test("a bare path to an existing SQLite file opens it whatever the file is called", async () => {
    const { path } = await fixtureDb("fineline");
    const bare = join(scratch, "wordpress-dump");
    copyFileSync(path, bare);
    const db = await openDb(bare);
    expect(db.prefix).toBe("KjLnF_");
    await db.close();
    // A bare path that is not there is not guessed at.
    await expect(openDb(join(scratch, "no-such-dump"))).rejects.toThrow(
      /unsupported database location/,
    );
  });

  test("a schemeless string that is not a database file is refused", async () => {
    await expect(openDb("definitely not a url")).rejects.toThrow(/unsupported database location/);
    await expect(openDb("")).rejects.toThrow(/unsupported database location/);
  });

  test("other schemes are refused, with the password masked", async () => {
    const error = await openDb("postgres://user:hunter2@127.0.0.1:5432/db").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/unsupported database location/);
    expect((error as Error).message).not.toContain("hunter2");
  });

  test("a missing SQLite file is an error, and no file is created", async () => {
    const missing = join(scratch, "does-not-exist.sqlite");
    await expect(openDb(`sqlite:${missing}`)).rejects.toThrow(/SQLite database not found/);
    expect(readdirSync(scratch)).not.toContain("does-not-exist.sqlite");
  });

  test("a SQLite file that is not a WordPress database says what is missing", async () => {
    const url = makeDb([], ["customers", "orders"]);
    await expect(openDb(url)).rejects.toThrow(/no WordPress tables found.*customers/);
    const empty = makeDb([]);
    await expect(openDb(empty)).rejects.toThrow(/no WordPress tables found/);
  });

  test.skipIf(!existsSync("/proc/self/fd"))(
    "a failed open gives its connection back: no file descriptor is left behind",
    async () => {
      // A person who retries a mistyped prefix a hundred times must not leak a hundred handles.
      const fds = (): number => readdirSync("/proc/self/fd").length;
      const notWordPress = makeDb([], ["customers"]);
      const twins = makeDb([
        { prefix: "wp_", siteurl: "https://x.test", posts: 7 },
        { prefix: "wp_2_", siteurl: "https://y.test", posts: 7 },
      ]);
      const before = fds();
      for (let i = 0; i < 30; i++) {
        await openDb(notWordPress).catch(() => undefined);
        await openDb(notWordPress, { prefix: "wp_" }).catch(() => undefined);
        await openDb(twins).catch(() => undefined);
      }
      expect(fds() - before).toBeLessThan(5);
    },
  );

  test("an invalid prefix is refused before anything is opened", async () => {
    const { url } = await fixtureDb("fineline");
    await expect(openDb(url, { prefix: "a; drop table x; --" })).rejects.toThrow(
      /invalid table prefix/,
    );
    await expect(openDb(url, { prefix: "a b" })).rejects.toThrow(/invalid table prefix/);
  });

  test("an unreachable MySQL server fails with a clear error that never contains the password", async () => {
    const error = await openDb("mysql://root:s3cret-pass@127.0.0.1:1/wp").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/^cannot open mysql:\/\/root:\*\*\*@127\.0\.0\.1:1\/wp: /);
    expect(message).not.toContain("s3cret-pass");
  });

  test("a password never reaches an error message, whatever characters it holds", async () => {
    // An unencoded password is what people paste. `/`, `?` and `#` end the authority for the URL
    // parser, so these cannot be parsed at all, and the message still must not carry them.
    const SECRET = "S3cr3tPW";
    const passwords = [
      `${SECRET}/x`,
      `/${SECRET}`,
      `a/b@c:${SECRET}`,
      `pa/ss/${SECRET}`,
      `pa?ss#${SECRET}`,
      `${SECRET}#frag`,
      `${SECRET}?x=1`,
      `p@${SECRET}`,
      `p:${SECRET}`,
      `${SECRET}%zz`,
      `[${SECRET}`,
      `${SECRET} two words`,
    ];
    for (const password of passwords) {
      for (const scheme of ["mysql", "mariadb"]) {
        const url = `${scheme}://root:${password}@127.0.0.1:1/wp`;
        const error = await openDb(url).catch((e: Error) => e);
        expect(error, url).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message, url).not.toContain(SECRET);
        // What is left says where it tried, so the person can see what was parsed.
        expect(message, url).toMatch(
          new RegExp(`^cannot open ${scheme}://root:\\*\\*\\*@127\\.0\\.0\\.1:1/wp: `),
        );
      }
    }
  });

  test("a password with an unencoded `/`, `?` or `#` is refused with the fix, not sent to a host named after the user", async () => {
    // The URL parser ends the authority at the first of those, so `root:/pw@host` reads as host `root`
    // with the rest in the path; the connection would have gone to `root` (and waited for DNS).
    const started = performance.now();
    for (const password of [
      "/S3cr3tPW",
      "S3cr3tPW/x",
      "S3cr3tPW?x=1",
      "S3cr3tPW#frag",
      "p@a/S3cr3tPW",
    ]) {
      const error = await openDb(`mysql://root:${password}@127.0.0.1:1/wp`).catch((e: Error) => e);
      const message = (error as Error).message;
      expect(message, password).toMatch(/percent-encoded \(%2F, %3F, %23\)/);
      expect(message, password).not.toContain("S3cr3tPW");
    }
    expect(performance.now() - started).toBeLessThan(2000);
    // Encoded, the same password is an ordinary URL: the attempt is made, and fails to connect.
    const encoded = await openDb("mysql://root:S3cr3t%2FPW@127.0.0.1:1/wp").catch((e: Error) => e);
    expect((encoded as Error).message).toMatch(
      /^cannot open mysql:\/\/root:\*\*\*@127\.0\.0\.1:1\/wp: /,
    );
    expect((encoded as Error).message).not.toMatch(/percent-encoded/);
  });

  test("a secret in the query string is masked, and the rest of the URL is kept", async () => {
    const SECRET = "S3cr3tPW";
    for (const key of ["password", "PASSWORD", "pass", "passwd", "pwd"]) {
      const url = `mysql://root@127.0.0.1:1/wp?ssl=true&${key}=${SECRET}&x=1`;
      const error = await openDb(url).catch((e: Error) => e);
      const message = (error as Error).message;
      expect(message, url).not.toContain(SECRET);
      expect(message, url).toContain(`ssl=true&${key}=***&x=1`);
    }
    // Also when the URL is one the parser rejects, and when it is the only thing in the query.
    const slashed = await openDb(`mysql://root:a/b@127.0.0.1:1/wp?password=${SECRET}`).catch(
      (e: Error) => e,
    );
    expect((slashed as Error).message).not.toContain(SECRET);
    expect((slashed as Error).message).toContain("password=***");
  });

  test("the unsupported-location message masks a password it cannot parse, and one with no scheme", async () => {
    const SECRET = "S3cr3tPW";
    for (const url of [
      `postgres://root:${SECRET}/x@127.0.0.1:5432/db`,
      `postgres://root:${SECRET}@127.0.0.1:5432/db?password=${SECRET}`,
      `root:${SECRET}@127.0.0.1/db`,
      `root:${SECRET}/x@127.0.0.1/db`,
      `user:${SECRET}@localhost`,
    ]) {
      const error = await openDb(url).catch((e: Error) => e);
      expect(error, url).toBeInstanceOf(Error);
      expect((error as Error).message, url).toMatch(/unsupported database location/);
      expect((error as Error).message, url).not.toContain(SECRET);
    }
  });

  test("nothing is masked that was not a secret", async () => {
    // No userinfo, a port, a user without a password, query parameters, an IPv6 host.
    for (const url of [
      "mysql://127.0.0.1:1/wp",
      "mysql://root@127.0.0.1:1/wp",
      "mysql://root@127.0.0.1:1/wp?ssl=true",
      "mysql://[::1]:1/wp?charset=utf8mb4",
    ]) {
      const error = await openDb(url).catch((e: Error) => e);
      expect((error as Error).message, url).toContain(`cannot open ${url}: `);
    }
  });

  test("mariadb:// is accepted as MySQL", async () => {
    const error = await openDb("mariadb://root@127.0.0.1:1/wp").catch((e: Error) => e);
    expect((error as Error).message).toMatch(/^cannot open mariadb:\/\/root@127\.0\.0\.1:1\/wp: /);
    expect((error as Error).message).not.toMatch(/unsupported/);
  });
});

// ── Prefix detection when more than one install is in the database ───────────────────────────────

describe("prefix detection", () => {
  test("a plugin table that happens to end in 'options' is not a candidate", async () => {
    const url = makeDb(
      [{ prefix: "KjLnF_", siteurl: "https://a.test", posts: 3 }],
      ["KjLnF_wpvivid_options", "KjLnF_actionscheduler_actions"],
    );
    const db = await openDb(url);
    expect(db.prefix).toBe("KjLnF_");
    await db.close();
  });

  test("a table that ends in 'options' under characters WordPress never allows in a prefix is not a candidate", async () => {
    // A detected prefix goes into SQL as it is, so only letters, digits, `_` and `$` can be one, however
    // many posts and however good a siteurl the lookalike has.
    const url = makeDb([
      { prefix: "we-ird_", siteurl: "https://x.test", posts: 90 },
      { prefix: "wp_", siteurl: "https://x.test", posts: 3 },
    ]);
    const db = await openDb(url);
    expect(db.prefix).toBe("wp_");
    await db.close();
    // With nothing else to choose, the install is not found rather than guessed.
    await expect(
      openDb(makeDb([{ prefix: "we ird_", siteurl: "https://x.test", posts: 4 }])),
    ).rejects.toThrow(/no WordPress tables found/);
  });

  test("a stale tmp prefix with no siteurl loses, even with more posts", async () => {
    const url = makeDb([
      { prefix: "tmp7f3a_", posts: 500 },
      { prefix: "wp_", siteurl: "https://live.test", posts: 40 },
    ]);
    const db = await openDb(url);
    expect(db.prefix).toBe("wp_");
    await db.close();
  });

  test("when both have a siteurl, the one with more posts wins, whichever is listed first", async () => {
    for (const order of [
      [
        { prefix: "old_", siteurl: "https://x.test", posts: 5 },
        { prefix: "wp_", siteurl: "https://x.test", posts: 50 },
      ],
      [
        { prefix: "wp_", siteurl: "https://x.test", posts: 50 },
        { prefix: "old_", siteurl: "https://x.test", posts: 5 },
      ],
    ]) {
      const db = await openDb(makeDb(order));
      expect(db.prefix).toBe("wp_");
      await db.close();
    }
  });

  test("three candidates: only the one with a siteurl and the most posts is chosen", async () => {
    const url = makeDb([
      { prefix: "a_", posts: 900 },
      { prefix: "b_", siteurl: "https://x.test", posts: 10 },
      { prefix: "c_", siteurl: "https://x.test", posts: 20 },
    ]);
    const db = await openDb(url);
    expect(db.prefix).toBe("c_");
    await db.close();
  });

  test("no candidate has a siteurl: the one with the most posts is still chosen", async () => {
    const db = await openDb(
      makeDb([
        { prefix: "a_", posts: 3 },
        { prefix: "b_", posts: 8 },
      ]),
    );
    expect(db.prefix).toBe("b_");
    await db.close();
  });

  test("a tie is an error that names every candidate", async () => {
    const url = makeDb([
      { prefix: "wp_", siteurl: "https://x.test", posts: 7 },
      { prefix: "wp_2_", siteurl: "https://y.test", posts: 7 },
      { prefix: "tmp_", posts: 99 },
    ]);
    const error = await openDb(url).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('"wp_"');
    expect(message).toContain('"wp_2_"');
    expect(message).toContain('"tmp_"');
    expect(message).toMatch(/siteurl set, 7 posts/);
    expect(message).toMatch(/Pass the prefix explicitly/);
  });

  test("an explicit prefix settles what detection cannot", async () => {
    const url = makeDb([
      { prefix: "wp_", siteurl: "https://x.test", posts: 7 },
      { prefix: "wp_2_", siteurl: "https://y.test", posts: 7 },
    ]);
    await expect(openDb(url)).rejects.toThrow(/cannot tell which table prefix/);
    const db = await openDb(url, { prefix: "wp_2_" });
    expect(db.prefix).toBe("wp_2_");
    const [row] = await db.query<{ v: string }>(
      `select option_value as v from ${db.table("options")} where option_name = 'siteurl'`,
    );
    expect(row!.v).toBe("https://y.test");
    await db.close();
  });

  test("an explicit prefix on a database with no WordPress tables says only what is missing", async () => {
    const error = await openDb(makeDb([], ["customers"]), { prefix: "wp_" }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(
      /no wp_options, wp_posts, wp_postmeta table in this database$/,
    );
  });

  test("an explicit prefix is taken even when detection would choose another", async () => {
    const url = makeDb([
      { prefix: "wp_", siteurl: "https://x.test", posts: 50 },
      { prefix: "old_", siteurl: "https://x.test", posts: 5 },
    ]);
    const db = await openDb(url, { prefix: "old_" });
    expect(db.prefix).toBe("old_");
    await db.close();
  });

  test("an empty prefix is a valid prefix", async () => {
    const db = await openDb(makeDb([{ prefix: "", siteurl: "https://x.test", posts: 2 }]));
    expect(db.prefix).toBe("");
    expect(db.table("posts")).toBe("posts");
    await db.close();
  });
});

// ── table() ──────────────────────────────────────────────────────────────────────────────────────

test("table() refuses a name that is not a bare identifier", async () => {
  const { url } = await fixtureDb("ap");
  const db = await openDb(url);
  try {
    for (const bad of ["", "posts; drop table x", "a b", "a`b", "x.y", "posts--"]) {
      expect(() => db.table(bad), JSON.stringify(bad)).toThrow(/invalid table name/);
    }
    expect(db.table("term_relationships")).toBe("wp_term_relationships");
  } finally {
    await db.close();
  }
});

// ── Read-only ────────────────────────────────────────────────────────────────────────────────────

describe("read-only", () => {
  test("statements that change anything are refused before they reach the database", async () => {
    const { url } = await fixtureDb("fineline");
    const db = await openDb(url);
    try {
      for (const sql of [
        "delete from KjLnF_posts",
        "update KjLnF_posts set post_title = 'x'",
        "insert into KjLnF_options (option_name) values ('x')",
        "replace into KjLnF_options (option_name) values ('x')",
        "drop table KjLnF_posts",
        "create table x (a integer)",
        "alter table KjLnF_posts add column z integer",
        "pragma writable_schema = 1",
        "  /* sneaky */ delete from KjLnF_posts",
        "-- comment\ndelete from KjLnF_posts",
        "select 1; delete from KjLnF_posts",
        "select * from KjLnF_posts into outfile '/tmp/x'",
      ]) {
        await expect(db.query(sql), sql).rejects.toThrow(/read-only/);
      }
      const [row] = await db.query<{ n: number }>("select count(*) as n from KjLnF_posts");
      expect(Number(row!.n)).toBeGreaterThan(1000);
    } finally {
      await db.close();
    }
  });

  test("`--` hides text only when whitespace follows it, as MySQL reads it, so it cannot hide a second statement", async () => {
    // `select 5 --1` is `select 5 - -1` to MySQL, and Bun's MySQL client runs statements stacked with
    // `;`. Were `--1; delete ...` taken for a comment, the delete would reach the server and run.
    const { url } = await fixtureDb("fineline");
    const db = await openDb(url);
    try {
      for (const sql of [
        "select 5 --1; delete from KjLnF_posts",
        "select 5 --1;delete from KjLnF_posts",
        "select 5 --x; update KjLnF_posts set post_title = 'x'",
        "select 5 -- ok\n--1; delete from KjLnF_posts",
      ]) {
        await expect(db.query(sql), sql).rejects.toThrow(/read-only/);
      }
      for (const sql of [
        "select 5 - -1 as n",
        "select 1 as n -- trailing comment",
        "select 1 as n --",
        "select 1 as n; --",
        "select 1 as n --\n",
        "select 1 -- comment\n as n",
        "select '--1; delete from KjLnF_posts' as n",
      ]) {
        await expect(db.query(sql), sql).resolves.toHaveLength(1);
      }
    } finally {
      await db.close();
    }
  });

  test("a MySQL executable comment runs on the server, so it is not skipped as a comment", async () => {
    // `/*!50000 ... */` and MariaDB's `/*M!50000 ... */` are comments only to other engines.
    const { url } = await fixtureDb("fineline");
    const db = await openDb(url);
    try {
      for (const sql of [
        "select 1 as a /*!50000 , 2 as injected */",
        "select 1 as a /*M!50000 , 2 as injected */",
        "select 1 as a /*!*/",
        "select 1 /*!50000 into outfile '/tmp/x' */",
        "/*!40001 select 1 */ select 2 as a",
      ]) {
        await expect(db.query(sql), sql).rejects.toThrow(/read-only.*executable comment/);
      }
      for (const sql of [
        "select 1 as n /* plain */",
        "select /*+ optimizer hint */ 1 as n",
        "select '/*! text */' as n",
        "select 1 as n /* ! not executable */",
      ]) {
        await expect(db.query(sql), sql).resolves.toHaveLength(1);
      }
    } finally {
      await db.close();
    }
  });

  test("reads in every form the loaders use are allowed", async () => {
    const { url } = await fixtureDb("fineline");
    const db = await openDb(url);
    try {
      for (const sql of [
        "select 1 as n",
        "SELECT 1 AS n",
        "  \n select 1 as n",
        "/* hello */ select 1 as n",
        "-- hello\nselect 1 as n",
        "select 1 as n;",
        "select 1 as n; ",
        "with t as (select 1 as n) select n from t",
      ]) {
        await expect(db.query(sql), sql).resolves.toHaveLength(1);
      }
    } finally {
      await db.close();
    }
  });

  test("a semicolon, a comment marker or a keyword inside a string literal is only text", async () => {
    const { url } = await fixtureDb("fineline");
    const db = await openDb(url);
    try {
      for (const literal of [
        "%;s:%",
        "a; delete from x",
        "#not a comment",
        "-- nor this",
        "/* or this */",
        "into outfile",
        "it''s; fine",
      ]) {
        const sql = `select option_name from KjLnF_options where option_value = '${literal}' or option_name = "${literal.replace(/'/g, "")}"`;
        await expect(db.query(sql), sql).resolves.toEqual([]);
      }
    } finally {
      await db.close();
    }
  });

  test("the engine itself refuses a write that gets past the check", async () => {
    // `with ... delete` is not caught by the statement guard; SQLite's own read-only open is.
    const { url } = await fixtureDb("fineline");
    const db = await openDb(url);
    try {
      await expect(
        db.query("with t as (select 1) delete from KjLnF_posts where ID = -1"),
      ).rejects.toThrow();
      const [row] = await db.query<{ n: number }>(
        "select count(*) as n from KjLnF_posts where ID = -1",
      );
      expect(Number(row!.n)).toBe(0);
    } finally {
      await db.close();
    }
  });
});

// ── MySQL statements run on a read-only session ──────────────────────────────────────────────────
// MySQL has no read-only open flag. `bun` cannot be mocked, so the part of `openDb` that is specific
// to it is a function over a pool, and these tests hand it a pool that records what it is asked.

describe("readOnlyRunner", () => {
  function fakePool(opts: { failOn?: RegExp; failReserve?: Error } = {}) {
    const log: string[] = [];
    let reserved = 0;
    const pool: ReservingPool = {
      async reserve() {
        if (opts.failReserve) throw opts.failReserve;
        const id = ++reserved;
        log.push(`reserve #${id}`);
        return {
          async unsafe(sql, params) {
            log.push(
              `#${id} ${sql}${params && params.length > 0 ? ` ${JSON.stringify(params)}` : ""}`,
            );
            if (opts.failOn?.test(sql))
              throw Object.assign(new Error(`failed: ${sql}`), { errno: 1792 });
            return [{ n: id }];
          },
          release() {
            log.push(`release #${id}`);
          },
        };
      },
    };
    return { pool, log };
  }

  test("every statement gets its own connection, put in read-only mode first, then released", async () => {
    const { pool, log } = fakePool();
    const run = readOnlyRunner(pool);
    expect(await run("select 1")).toEqual([{ n: 1 }]);
    expect(await run("select ? + ?", [1, 2])).toEqual([{ n: 2 }]);
    expect(log).toEqual([
      "reserve #1",
      "#1 set session transaction read only",
      "#1 select 1",
      "release #1",
      "reserve #2",
      "#2 set session transaction read only",
      "#2 select ? + ? [1,2]",
      "release #2",
    ]);
  });

  test("the session is set again for every statement, since the next connection may be a new one", async () => {
    // A pool reconnects after the server drops a connection, and a new connection is read-write.
    const { pool, log } = fakePool();
    const run = readOnlyRunner(pool);
    await Promise.all([run("select 1"), run("select 2"), run("select 3")]);
    expect(log.filter((l) => l.endsWith("set session transaction read only"))).toHaveLength(3);
    // On each connection the setting comes before the statement.
    for (const id of [1, 2, 3]) {
      const own = log.filter((l) => l.startsWith(`#${id} `));
      expect(own[0]).toBe(`#${id} set session transaction read only`);
    }
  });

  test("a failing statement hands its connection back and its error through unchanged", async () => {
    const { pool, log } = fakePool({ failOn: /boom/ });
    const run = readOnlyRunner(pool);
    const error = await run("select boom").catch((e: unknown) => e);
    expect((error as { errno?: number }).errno).toBe(1792);
    expect((error as Error).message).toBe("failed: select boom");
    expect(log.at(-1)).toBe("release #1");
  });

  test("when the session cannot be made read-only the statement is not sent", async () => {
    const { pool, log } = fakePool({ failOn: /^set session/ });
    const run = readOnlyRunner(pool);
    await expect(run("select 1")).rejects.toThrow(/failed: set session/);
    expect(log).toEqual(["reserve #1", "#1 set session transaction read only", "release #1"]);
  });

  test("a connection that cannot be had is an error, with nothing to release", async () => {
    const { pool, log } = fakePool({ failReserve: new Error("Failed to connect") });
    await expect(readOnlyRunner(pool)("select 1")).rejects.toThrow("Failed to connect");
    expect(log).toEqual([]);
  });
});

// ── tableExists ──────────────────────────────────────────────────────────────────────────────────

describe("tableExists", () => {
  test("true for a table that is there, even an empty one", async () => {
    const { url } = await fixtureDb("fineline");
    const db = await openDb(url);
    try {
      expect(await tableExists(db, "posts")).toBe(true);
      expect(await tableExists(db, "rank_math_redirections")).toBe(true);
    } finally {
      await db.close();
    }
  });

  test("false for one that is not", async () => {
    const { url } = await fixtureDb("fineline");
    const db = await openDb(url);
    try {
      expect(await tableExists(db, "no_such_table")).toBe(false);
    } finally {
      await db.close();
    }
  });

  test("with columns: true only when the table has all of them", async () => {
    const { url } = await fixtureDb("fineline");
    const db = await openDb(url);
    try {
      expect(await tableExists(db, "posts", ["ID", "post_title"])).toBe(true);
      expect(await tableExists(db, "posts", ["ID", "no_such_column"])).toBe(false);
      expect(await tableExists(db, "no_such_table", ["ID"])).toBe(false);
    } finally {
      await db.close();
    }
  });

  test("a table that is only an id column, as the fixture helper makes for an empty file, is absent", async () => {
    const path = join(scratch, `stub-${counter++}.sqlite`);
    const sqlite = new Database(path, { create: true });
    for (const t of ["options", "posts", "postmeta"])
      sqlite.run(`create table wp_${t} (id integer)`);
    sqlite.run("create table wp_termmeta (id integer)");
    sqlite.close();
    const db = await openDb(`sqlite:${path}`);
    try {
      expect(await tableExists(db, "termmeta")).toBe(true);
      expect(await tableExists(db, "termmeta", ["term_id", "meta_key", "meta_value"])).toBe(false);
    } finally {
      await db.close();
    }
  });

  test("a MySQL server's own no-such-table and no-such-column errors count as absence", async () => {
    // The default suite runs on SQLite, whose errors are recognised by their text. MySQL and MariaDB
    // say it with error numbers and SQLSTATEs (1146/42S02 and 1054/42S22), which only a server shows.
    const failing = (error: unknown): WpDb => ({
      prefix: "wp_",
      table: (name) => `wp_${name}`,
      query: () => Promise.reject(error),
      close: async () => {},
    });
    for (const error of [
      { errno: 1146, message: "Table 'wp.wp_nope' doesn't exist" },
      { errno: 1054, message: "Unknown column 'z' in 'field list'" },
      { sqlState: "42S02", message: "Table doesn't exist" },
      { sqlState: "42S22", message: "Column not found" },
      Object.assign(new Error("Table 'wp.wp_nope' doesn't exist"), {
        errno: 1146,
        sqlState: "42S02",
      }),
    ]) {
      expect(await tableExists(failing(error), "nope"), JSON.stringify(error)).toBe(false);
    }
    // Anything else is a real failure and comes out as it went in.
    for (const error of [
      { errno: 1045, sqlState: "28000", message: "Access denied for user" },
      { errno: 2013, message: "Lost connection to server during query" },
      { errno: 1064, sqlState: "42000", message: "You have an error in your SQL syntax" },
      new Error("boom"),
    ]) {
      await expect(tableExists(failing(error), "nope")).rejects.toBe(error);
    }
  });

  test("any other failure is not mistaken for absence", async () => {
    const { url } = await fixtureDb("fineline");
    const db = await openDb(url);
    await db.close();
    await expect(tableExists(db, "posts")).rejects.toThrow(/this database handle is closed/);
  });
});

// ── A real MySQL/MariaDB server, when one is configured ─────────────────────────────────────────
// Skipped unless WP2JX_TEST_DB is set. With the throwaway server up (scripts/dev-db.sh start):
//   WP2JX_TEST_DB=mysql://root@127.0.0.1:3399/s212682_fineline bun test --isolate tests/wp/db.test.ts

const LIVE = process.env.WP2JX_TEST_DB;

describe.skipIf(!LIVE)("live MySQL (WP2JX_TEST_DB)", () => {
  test("detects the prefix and reads rows, over mysql:// and mariadb://", async () => {
    for (const url of [LIVE!, LIVE!.replace(/^mysql:/, "mariadb:")]) {
      const db = await openDb(url);
      try {
        expect(db.prefix).toMatch(/_$/);
        const rows = await db.query<{ v: string }>(
          `select option_value as v from ${db.table("options")} where option_name = 'siteurl'`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.v).toMatch(/^https?:\/\//);
        expect(Object.getPrototypeOf(rows)).toBe(Array.prototype);
        expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
      } finally {
        await db.close();
      }
    }
  });

  test("MySQL hands back Date for DATETIME, and the zero date as an Invalid Date", async () => {
    const db = await openDb(LIVE!);
    try {
      const [post] = await db.query<{ d: unknown }>(
        `select post_date as d from ${db.table("posts")} where post_date > '2000-01-01' limit 1`,
      );
      expect(post!.d).toBeInstanceOf(Date);
      const zero = await db.query<{ d: Date }>(
        `select post_date_gmt as d from ${db.table("posts")} where post_date_gmt < '1971-01-01' limit 1`,
      );
      for (const row of zero) expect(Number.isNaN(row.d.getTime())).toBe(true);
    } finally {
      await db.close();
    }
  });

  test("read-only holds against MySQL too", async () => {
    const db = await openDb(LIVE!);
    try {
      await expect(db.query(`delete from ${db.table("posts")} where ID = -1`)).rejects.toThrow(
        /read-only/,
      );
    } finally {
      await db.close();
    }
  });

  test("the engine refuses what the statement guard lets through: a locking read", async () => {
    const db = await openDb(LIVE!);
    try {
      // `select … for update` is a read to the guard. On an ordinary connection the server takes the
      // lock and drops it at once; on a read-only session it is refused (1792).
      const error = await db
        .query(`select option_id from ${db.table("options")} where option_id = -1 for update`)
        .catch((e: unknown) => e);
      expect((error as { errno?: number }).errno).toBe(1792);
      expect((error as Error).message).toMatch(/READ ONLY/i);
      expect(await db.query(`select count(*) as n from ${db.table("options")}`)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  test("a stacked COMMIT does not make the next statement read-write", async () => {
    // Bun's MySQL client runs `;`-stacked statements, and a `COMMIT` ends a READ ONLY transaction. The
    // session default is what holds: this goes round the statement guard on purpose, to the engine.
    const probe = await openDb(LIVE!);
    const pool = new SQL(LIVE!);
    try {
      const run = readOnlyRunner(pool);
      const error = await run(
        `select 1 as a; commit; delete from ${probe.table("options")} where option_id = -1`,
      ).catch((e: unknown) => e);
      expect((error as { errno?: number }).errno).toBe(1792);
    } finally {
      await pool.close();
      await probe.close();
    }
  });

  test("a connection the server dropped is replaced by one that is read-only too", async () => {
    const probe = await openDb(LIVE!);
    const pool = new SQL(LIVE!);
    const killer = new SQL(LIVE!);
    try {
      const run = readOnlyRunner(pool);
      const [connection] = (await run("select connection_id() as id")) as { id: number }[];
      await killer.unsafe(`kill ${connection!.id}`);
      await Bun.sleep(300);
      const error = await run(`delete from ${probe.table("options")} where option_id = -1`).catch(
        (e: unknown) => e,
      );
      expect((error as { errno?: number }).errno).toBe(1792);
      expect(await run("select 1 as a")).toHaveLength(1);
    } finally {
      await Promise.all([pool.close(), killer.close(), probe.close()]);
    }
  });

  test("tableExists tells a missing table from a present one", async () => {
    const db = await openDb(LIVE!);
    try {
      expect(await tableExists(db, "posts")).toBe(true);
      expect(await tableExists(db, "definitely_not_a_table")).toBe(false);
    } finally {
      await db.close();
    }
  });

  test("tableExists with columns tells a missing column from a present one on MySQL too", async () => {
    const db = await openDb(LIVE!);
    try {
      expect(await tableExists(db, "posts", ["ID", "post_title"])).toBe(true);
      expect(await tableExists(db, "posts", ["ID", "no_such_column"])).toBe(false);
    } finally {
      await db.close();
    }
  });

  test("a wrong password fails at open with the database's own message and never echoes the password", async () => {
    const url = new URL(LIVE!);
    url.password = "wrong-password-xyz";
    const error = await openDb(url.toString()).catch((e: Error) => e);
    // A server that accepts any password (this throwaway one may) would resolve; only assert when it refuses.
    if (error instanceof Error) {
      expect(error.message).toMatch(/^cannot open mysql:\/\//);
      expect(error.message).not.toContain("wrong-password-xyz");
    } else {
      await error.close();
    }
  });
});
