import { json } from '@sveltejs/kit';
import { getLogs, clearLogs, MAX_ENTRIES } from '$lib/server/logs';

/**
 * Backfill the Logs panel with the current ring buffer. New entries after this
 * snapshot arrive live over the SSE bus (`/api/events`, `{ type: 'log' }`), so a
 * panel opens with history and then streams.
 */
export function GET() {
	return json({ logs: getLogs(), max: MAX_ENTRIES });
}

/** Clear the buffer (the panel's Clear button); broadcasts `log:cleared`. */
export function DELETE() {
	clearLogs();
	return json({ ok: true });
}
