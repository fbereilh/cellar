import { json } from '@sveltejs/kit';
import { isValidChatSlotName } from '$lib/chatCell';
import { chatLogout } from '$lib/server/chat/auth';

/**
 * Sign a NAMED Cellar slot out. The slot is REQUIRED - by construction there is
 * no way to log the ambient (borrowed) terminal credential out through Cellar:
 * that login is the user's own, and the sidebar never offers a sign-out for it.
 */
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, reason: 'bad-request' }, { status: 400 });
	}
	if (!isValidChatSlotName(body?.slot)) {
		return json({ ok: false, reason: 'bad-slot-name' }, { status: 400 });
	}
	const result = await chatLogout(body.slot);
	return json({ ok: result.ok, account: result.account, error: result.error });
}
