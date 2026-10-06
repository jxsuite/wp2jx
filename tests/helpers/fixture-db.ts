/**
 * Hermetic WordPress database for tests: the committed `rows/*.json` of a fixture set, loaded
 * into a SQLite file under `.dev/` (rebuilt only when the rows are newer than the file).
 *
 *   const { url, prefix } = await fixtureDb("fineline");
 *   const db = await openDb(url, { prefix });
 */
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
export const FIXTURES = join(ROOT, "tests/fixtures");

export function fixtureDir(site: string): string {
  return join(FIXTURES, site);
}

export function readFixtureJson<T = unknown>(site: string, rel: string): T {
  return JSON.parse(readFileSync(join(fixtureDir(site), rel), "utf8")) as T;
}

export function readFixtureText(site: string, rel: string): string {
  return readFileSync(join(fixtureDir(site), rel), "utf8");
}

const ISO = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)\.\d{3}Z$/;
const sqlValue = (v: unknown): string | number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const m = ISO.exec(v);
    return m ? `${m[1]} ${m[2]}` : v;
  }
  return JSON.stringify(v);
};

export async function fixtureDb(
  site: string,
): Promise<{ url: string; path: string; prefix: string }> {
  const dir = fixtureDir(site);
  const { prefix } = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { prefix: string };
  const rowsDir = join(dir, "rows");
  const files = readdirSync(rowsDir).filter((f) => f.endsWith(".json"));
  const newest = Math.max(...files.map((f) => statSync(join(rowsDir, f)).mtimeMs));
  mkdirSync(join(ROOT, ".dev"), { recursive: true });
  const path = join(ROOT, ".dev", `fixture-${site}.sqlite`);
  const url = `sqlite:${path}`;
  if (existsSync(path) && statSync(path).mtimeMs >= newest) return { url, path, prefix };

  // Build beside the target and rename into place: parallel test files may all find the file stale
  // at once, and a half-written database must never be visible under its final name.
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  const db = new Database(tmp, { create: true });
  db.run("pragma journal_mode = off");
  for (const f of files) {
    const rows = JSON.parse(readFileSync(join(rowsDir, f), "utf8")) as Record<string, unknown>[];
    const table = prefix + f.replace(/\.json$/, "");
    db.run(`drop table if exists ${table}`);
    if (rows.length === 0) {
      // Keep the table so queries against it return no rows instead of failing.
      db.run(`create table ${table} (id integer)`);
      continue;
    }
    const cols = Object.keys(rows[0]!);
    const typeOf = (c: string) =>
      rows.every((r) => r[c] === null || typeof r[c] === "number") ? "integer" : "text";
    db.run(`create table ${table} (${cols.map((c) => `${c} ${typeOf(c)}`).join(", ")})`);
    const ins = db.prepare(`insert into ${table} values (${cols.map(() => "?").join(",")})`);
    db.transaction(() => {
      for (const r of rows) ins.run(...cols.map((c) => sqlValue(r[c])));
    })();
  }
  db.close();
  renameSync(tmp, path);
  return { url, path, prefix };
}
