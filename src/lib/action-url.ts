import { page } from '$app/state';

/**
 * Named-action URL that carries the page's current query (cursor month, open
 * category, filters). Plain-form POSTs re-render at the action URL, so
 * dropping the query resets the view. Stale `/action` params left by a
 * previous POST are stripped so two actions never collide.
 */
export function actionUrl(name: string): string {
	const q = [...page.url.searchParams].filter(([k]) => !k.startsWith('/'));
	const s = new URLSearchParams(q).toString();
	return s ? `?${s}&/${name}` : `?/${name}`;
}
