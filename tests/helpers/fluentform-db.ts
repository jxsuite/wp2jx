/**
 * The Fluent Forms rows of the pilot site (`tests/data/fluentform-fineline.json`: forms 1, 3, 5 and 6
 * and the meta rows the renderer reads, dumped from its database), loaded into a SQLite file so the
 * production loader reads them the way it reads a site's own tables. The fixture sites' own rows
 * hold no Fluent Forms tables.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "../../src/wp/db.ts";
import { loadFluentForms, type FluentForm } from "../../src/wp/fluentform.ts";
import type { WpDb } from "../../src/types.ts";

const ROOT = resolve(import.meta.dir, "../..");

interface Dump {
  prefix: string;
  forms: Record<string, unknown>[];
  meta: Record<string, unknown>[];
}

export const dump: Dump = await Bun.file(join(ROOT, "tests/data/fluentform-fineline.json")).json();

/** A SQLite database holding the dump's tables, with the changes `edit` makes to the open handle. */
export async function openFormDb(
  edit?: (db: Database) => void,
): Promise<{ db: WpDb; close(): Promise<void> }> {
  mkdirSync(join(ROOT, ".dev/tmp"), { recursive: true });
  const dir = mkdtempSync(join(ROOT, ".dev/tmp/forms-"));
  const path = join(dir, "forms.sqlite");
  const raw = new Database(path);
  // openDb wants the tables every WordPress has
  raw.run(`create table ${dump.prefix}options (option_name text)`);
  raw.run(`create table ${dump.prefix}postmeta (post_id integer)`);
  raw.run(`create table ${dump.prefix}posts (id integer)`);
  raw.run(
    `create table ${dump.prefix}fluentform_forms (id integer primary key, title text, status text, type text, form_fields text)`,
  );
  raw.run(
    `create table ${dump.prefix}fluentform_form_meta (id integer primary key, form_id integer, meta_key text, value text)`,
  );
  for (const f of dump.forms) {
    raw
      .query(`insert into ${dump.prefix}fluentform_forms values (?, ?, ?, ?, ?)`)
      .run(
        f.id as number,
        f.title as string,
        f.status as string,
        f.type as string,
        f.form_fields as string,
      );
  }
  for (const m of dump.meta) {
    raw
      .query(`insert into ${dump.prefix}fluentform_form_meta values (?, ?, ?, ?)`)
      .run(m.id as number, m.form_id as number, m.meta_key as string, m.value as string);
  }
  edit?.(raw);
  raw.close();
  const db = await openDb(`sqlite:${path}`, { prefix: dump.prefix });
  return {
    db,
    async close() {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The pilot's forms by id, read through the production loader. */
export async function pilotForms(): Promise<Map<number, FluentForm>> {
  const opened = await openFormDb();
  try {
    return await loadFluentForms(opened.db);
  } finally {
    await opened.close();
  }
}
