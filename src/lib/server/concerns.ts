import type { Database } from 'better-sqlite3';

// Concern lifecycle engine (PRD Phase 2). Identity = detector:subject:period.
// Detectors emit candidates; this module owns dedup, dismissal, resurrection,
// and expiry. The stored shape is narration-ready for Phase 3.

export type ConcernCandidate = {
	detector: string;
	subject: string;
	period: string; // 'YYYY-MM' | 'YYYY-MM-DD' | 'ongoing'
	severity: number; // 0–100
	title: string;
	figures: Record<string, number | string>;
	txn_ids: number[];
};

export type ConcernRow = {
	id: number;
	detector: string;
	subject: string;
	period: string;
	severity: number;
	title: string;
	figures: string; // JSON
	txn_ids: string; // JSON
	status: 'active' | 'dismissed' | 'expired';
	dismissed_bucket: string | null;
	created_at: string;
	updated_at: string;
	narration: string | null; // one plain-English line (p3-06); null until narrated
	narrated_figures_hash: string | null;
};

export type Bucket = 'low' | 'medium' | 'high';

const BUCKET_RANK: Record<Bucket, number> = { low: 0, medium: 1, high: 2 };

export function bucketFor(severity: number): Bucket {
	return severity >= 67 ? 'high' : severity >= 34 ? 'medium' : 'low';
}

export const identityOf = (c: { detector: string; subject: string; period: string }): string =>
	`${c.detector}:${c.subject}:${c.period}`;

export function upsertConcerns(db: Database, candidates: ConcernCandidate[]): void {
	const find = db.prepare(
		'SELECT id, status, dismissed_bucket FROM concerns WHERE detector = ? AND subject = ? AND period = ?'
	);
	const insert = db.prepare(
		`INSERT INTO concerns (detector, subject, period, severity, title, figures, txn_ids)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	const update = db.prepare(
		`UPDATE concerns SET severity = ?, title = ?, figures = ?, txn_ids = ?, status = ?,
		   dismissed_bucket = ?, updated_at = datetime('now')
		 WHERE id = ?`
	);
	db.transaction(() => {
		for (const c of candidates) {
			const figures = JSON.stringify(c.figures);
			const txnIds = JSON.stringify(c.txn_ids);
			const existing = find.get(c.detector, c.subject, c.period) as
				| Pick<ConcernRow, 'id' | 'status' | 'dismissed_bucket'>
				| undefined;
			if (!existing) {
				insert.run(c.detector, c.subject, c.period, c.severity, c.title, figures, txnIds);
				continue;
			}
			let status: ConcernRow['status'] = 'active';
			let dismissedBucket = null as string | null;
			if (existing.status === 'dismissed') {
				// resurrect only when the bucket rises above the one dismissed at
				const rose =
					BUCKET_RANK[bucketFor(c.severity)] >
					BUCKET_RANK[(existing.dismissed_bucket ?? 'low') as Bucket];
				status = rose ? 'active' : 'dismissed';
				dismissedBucket = rose ? null : existing.dismissed_bucket;
			}
			update.run(c.severity, c.title, figures, txnIds, status, dismissedBucket, existing.id);
		}
	})();
}

/**
 * One expiry rule: a Concern whose identity did not fire this run is over —
 * its period ended (Detectors only evaluate the present), its condition
 * cleared, or the owner corrected the data underneath it. Expired identities
 * that fire again later revive as a fresh episode (dismissal forgotten).
 */
export function expireConcerns(db: Database, firedIdentities: Set<string>): void {
	const rows = db
		.prepare("SELECT id, detector, subject, period FROM concerns WHERE status != 'expired'")
		.all() as Pick<ConcernRow, 'id' | 'detector' | 'subject' | 'period'>[];
	const expire = db.prepare(
		"UPDATE concerns SET status = 'expired', updated_at = datetime('now') WHERE id = ?"
	);
	db.transaction(() => {
		for (const c of rows) if (!firedIdentities.has(identityOf(c))) expire.run(c.id);
	})();
}

/** True when an active concern was actually dismissed (stale ids no-op). */
export function dismissConcern(db: Database, id: number): boolean {
	return (
		db
			.prepare(
				`UPDATE concerns SET status = 'dismissed',
		   dismissed_bucket = CASE WHEN severity >= 67 THEN 'high' WHEN severity >= 34 THEN 'medium' ELSE 'low' END,
		   updated_at = datetime('now')
		 WHERE id = ? AND status = 'active'`
			)
			.run(id).changes > 0
	);
}

/** The feed: severity first, freshest first within a rank. */
export function activeConcerns(db: Database): ConcernRow[] {
	return db
		.prepare("SELECT * FROM concerns WHERE status = 'active' ORDER BY severity DESC, updated_at DESC, id DESC")
		.all() as ConcernRow[];
}
