import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { migrate } from './migrate';

// Financial data lives in Application Support, never the repo (ADR-0001/0002).
const DATA_DIR =
	process.env.MONEY_TRACKER_DATA_DIR ??
	join(homedir(), 'Library', 'Application Support', 'Money Tracker');

function open(): Database.Database {
	mkdirSync(DATA_DIR, { recursive: true });
	const db = new Database(join(DATA_DIR, 'money.db'));
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	migrate(db);
	return db;
}

export const db = open();
