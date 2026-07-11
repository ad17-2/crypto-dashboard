import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ensureSchema } from './schema.js';

/**
 * Opens (creating if necessary) the screener SQLite database and ensures its
 * schema is up to date. Mirrors crypto_screener/storage.py::connect().
 *
 * better-sqlite3 defaults `PRAGMA foreign_keys` to ON, unlike Python's
 * sqlite3 module which defaults it to OFF and never enables it. The
 * production database was built under that OFF behavior (e.g. factor_history
 * backfills write rows for run_ids that don't exist in `runs`), so we
 * explicitly disable it here to match, rather than silently inheriting a
 * stricter driver default.
 *
 * WAL journal mode is a deliberate addition for this long-lived Express
 * process (better concurrent read/write behavior than the rollback journal
 * Python used); it is a fully backward-compatible SQLite feature, so the
 * database remains readable by the reference Python implementation.
 */
export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  ensureSchema(db);
  return db;
}
