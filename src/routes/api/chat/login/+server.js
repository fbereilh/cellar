import { json } from '@sveltejs/kit';
import { isValidChatSlotName } from '$lib/chatCell';
import { cancelChatLogin, chatLoginStatus, startChatLogin, submitChatLoginCode } from '$lib/server/chat/auth';

/**
 * The sign-in lifecycle for a Cellar account slot. One dispatch route (the
 * `/api/fs/op` idiom):
 *
 *   POST {op:'start', slot}     -> begin `claude auth login` into the slot
 *   POST {op:'code', id, code}  -> forward the pasted authorisation code
 *   POST {op:'cancel', id}      -> kill the attempt
 *   GET  ?id=<login id>         -> poll the attempt's state
 *
 * The login state never carries a credential: URLs to open, running/ok flags,
 * and the account identity once settled. The pasted code goes straight to the
 * child's stdin and is never logged or echoed back (see chat/auth.ts).
 */
export function GET({ url }) {
	const id = url.searchParams.get('id') || '';
	const state = chatLoginStatus(id);
	if (!state) return json({ ok: false, reason: 'unknown-login' }, { status: 404 });
	return json({ ok: true, login: state });
}

export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, reason: 'bad-request' }, { status: 400 });
	}
	const op = body?.op;
	if (op === 'start') {
		if (!isValidChatSlotName(body?.slot)) return json({ ok: false, reason: 'bad-slot-name' }, { status: 400 });
		return json({ ok: true, login: startChatLogin(body.slot) });
	}
	if (op === 'code') {
		if (typeof body?.id !== 'string' || typeof body?.code !== 'string' || !body.code.trim()) {
			return json({ ok: false, reason: 'bad-request' }, { status: 400 });
		}
		const sent = submitChatLoginCode(body.id, body.code);
		return sent ? json({ ok: true }) : json({ ok: false, reason: 'unknown-login' }, { status: 404 });
	}
	if (op === 'cancel') {
		if (typeof body?.id !== 'string') return json({ ok: false, reason: 'bad-request' }, { status: 400 });
		cancelChatLogin(body.id);
		return json({ ok: true });
	}
	return json({ ok: false, reason: 'unknown-op' }, { status: 400 });
}
