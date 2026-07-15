import { db } from '$lib/server/db';
import { reconcileBackfillProgress } from '$lib/server/backfill';
import { syncOnLaunch } from '$lib/server/sync-runner';

// #81: a scan killed by a hard crash left a stale mid-scan progress row; clear it
// before anything reads it (no scan can be running in a just-booted process).
reconcileBackfillProgress(db);
syncOnLaunch();
