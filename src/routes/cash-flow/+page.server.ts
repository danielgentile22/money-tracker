import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Retired by ADR-0008 — the Categories page carries the month Sankey now.
// Old FilterSet params don't map to the month cursor; land on the default month.
export const load: PageServerLoad = () => {
	redirect(301, '/categories');
};
