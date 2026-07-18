/**
 * Parse a required numeric row id from a form. Missing/NaN/non-positive ids
 * return null so actions can fail(400) instead of silently no-op'ing a
 * DELETE/UPDATE (Number(null) === 0 and NaN both match zero rows).
 */
export function formId(f: FormData, field = 'id'): number | null {
	const n = Number(f.get(field));
	return Number.isInteger(n) && n > 0 ? n : null;
}
