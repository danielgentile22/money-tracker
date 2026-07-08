// 'Other' is the ladder's fallback; 'Income' and 'Transfer' anchor analytics
// and transfer detection — none may be merged away or deleted (story 11).
// Shared by the server guard and the manage UI so the Delete affordance and
// the refusal can never disagree.
export const PROTECTED_CATEGORIES = ['other', 'income', 'transfer'];

export const isProtectedCategory = (name: string) =>
	PROTECTED_CATEGORIES.includes(name.toLowerCase());
