import { db } from '$lib/server/db';
import { parseFilters, serializeFilters } from '$lib/server/filters';
import { reportData, netWorthReport, type ReportTab, type GroupBy } from '$lib/server/reports';
import { groupedCategories } from '$lib/server/groups';
import { listTags } from '$lib/server/tags';
import { listReports } from '$lib/server/saved-reports';
import { savedReportActions } from '$lib/server/saved-report-actions';
import type { PageServerLoad, Actions } from './$types';

const DEFAULT_PRESET = 'last-12-months';
const TABS = ['spending', 'income', 'networth'] as const;
const GROUP_BYS = ['group', 'category', 'merchant', 'tag'] as const;

export const load: PageServerLoad = ({ url }) => {
	const tab = (TABS as readonly string[]).includes(url.searchParams.get('tab') ?? '')
		? (url.searchParams.get('tab') as (typeof TABS)[number])
		: 'spending';
	const by = (GROUP_BYS as readonly string[]).includes(url.searchParams.get('by') ?? '')
		? (url.searchParams.get('by') as GroupBy)
		: 'group';
	const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
	const f = parseFilters(url.searchParams, DEFAULT_PRESET);

	return {
		tab,
		by,
		page,
		report:
			tab === 'networth' ? null : reportData(db, f, tab as ReportTab, by, { page }),
		netWorth: tab === 'networth' ? netWorthReport(db, f) : null,
		filterQuery: serializeFilters(f),
		tree: groupedCategories(db, { includeDisabled: true }),
		accounts: db.prepare('SELECT id, name FROM accounts ORDER BY name').all() as {
			id: number;
			name: string;
		}[],
		allTags: listTags(db),
		merchants: db
			.prepare(
				`SELECT DISTINCT COALESCE(merchant, name) FROM transactions
				 WHERE is_investment_activity = 0 ORDER BY 1 COLLATE NOCASE`
			)
			.pluck()
			.all() as string[],
		saved: listReports(db, url.pathname)
	};
};

export const actions: Actions = savedReportActions('/reports', DEFAULT_PRESET);
