import { json } from '@sveltejs/kit';
import { invalidateChatAuthCache, listChatSlots, resolveChatAuth } from '$lib/server/chat/auth';

/**
 * Chat account status for the sidebar: which credential a chat run would use
 * RIGHT NOW (the same `resolveChatAuth` the run path calls, so the panel and
 * the engine can never disagree) plus every named Cellar slot with who is
 * signed in to it. `?fresh=1` drops the short-lived probe cache first - the
 * panel's manual refresh, so "am I signed in yet" answers from the CLI, not
 * from a 5s-old memo. Identity only; a token never rides this response.
 */
export async function GET({ url }) {
	if (url.searchParams.get('fresh')) invalidateChatAuthCache();
	const [resolution, slots] = await Promise.all([resolveChatAuth(), listChatSlots()]);
	return json({ resolution, slots });
}
