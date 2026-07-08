import { db } from '$lib/server/db';
import { isSyncing } from '$lib/server/sync-runner';
import { anthropicReady } from '$lib/server/llm';
import { readSidebar } from '$lib/server/dashboard';
import { splitDisplayName } from '$lib/server/split-usage';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => {
	const lastSyncedAt = db
		.prepare('SELECT MAX(last_synced_at) FROM connections')
		.pluck()
		.get() as string | null;
	const failures = db
		.prepare(
			"SELECT institution_name, health, last_sync_error FROM connections WHERE health != 'healthy'"
		)
		.all() as { institution_name: string; health: string; last_sync_error: string | null }[];
	// the key is the opt-in: no key, no Assistant anywhere (Session 5)
	return {
		sync: { syncing: isSyncing(), lastSyncedAt, failures },
		assistantReady: anthropicReady(),
		sidebar: readSidebar(db),
		// Cost Split nav label is owner-named (identity lives in settings, not code)
		splitLabel: splitDisplayName(db)
	};
};
