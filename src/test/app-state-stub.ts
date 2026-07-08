// Test stub for $app/state and $app/navigation — just enough for components
// that read page.url and call goto.
export const page = { url: new URL('http://localhost:5273/transactions') };
export const gotoCalls: string[] = [];
export const goto = (href: string) => {
	gotoCalls.push(href);
	return Promise.resolve();
};
