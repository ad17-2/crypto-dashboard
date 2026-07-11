import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ensureSchema } from './schema.js';

/**
 * `foreign_keys` is forced OFF: better-sqlite3 defaults it to ON, but the production database
 * has factor_history rows whose run_id has no matching `runs` row (backfills write directly to
 * factor_history). Turning the pragma on would make those inserts fail.
 */
export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  ensureSchema(db);
  return db;
}
