import { json } from '@sveltejs/kit';
import { isValidChatSlotName } from '$lib/chatCell';
import { selectChatSlot } from '$lib/server/chat/auth';

/**
 * Select which account chat runs use: `{slot: '<name>'}` for a Cellar slot,
 * `{slot: null}` to borrow the ambient terminal login. A SELECTION, not a
 * credential operation - nothing is authenticated or revoked here.
 */
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, reason: 'bad-request' }, { status: 400 });
	}
	const slot = body?.slot ?? null;
	if (slot !== null && !isValidChatSlotName(slot)) {
		return json({ ok: false, reason: 'bad-slot-name' }, { status: 400 });
	}
	selectChatSlot(slot);
	return json({ ok: true });
}
