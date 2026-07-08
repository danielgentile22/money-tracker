import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Retired by ADR-0008 — the Categories page carries budgets now. ?month survives.
export const load: PageServerLoad = ({ url }) => {
	const m = url.searchParams.get('month');
	redirect(301, m ? `/categories?month=${m}` : '/categories');
};
