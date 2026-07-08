import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { deleteConversation, getMessages, setFeedback } from '$lib/server/conversations';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) =>
	json({ messages: getMessages(db, Number(params.id)) });

export const DELETE: RequestHandler = ({ params }) => {
	deleteConversation(db, Number(params.id));
	return json({ ok: true });
};

/** Thumbs on one of this conversation's assistant replies — stored locally, sent nowhere. */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { messageId?: number; feedback?: unknown };
	const feedback = body.feedback === 'up' || body.feedback === 'down' ? body.feedback : null;
	if (!Number.isInteger(body.messageId)) return json({ message: 'bad messageId' }, { status: 400 });
	setFeedback(db, body.messageId as number, feedback);
	return json({ ok: true });
};
