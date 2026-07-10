import { json } from '@sveltejs/kit';
import { listCatalogs, listSchemas, listTables, statusFor } from '$lib/server/databricks.js';
import { selectionFrom } from '../selection.js';

/**
 * One lazy level of the Unity Catalog tree, so the browser only pays for the
 * node the user actually expanded:
 *
 *   ?level=catalogs
 *   ?level=schemas&catalog=main
 *   ?level=tables&catalog=main&schema=default
 *
 * All three run the SDK server-side (a subprocess of the project venv), never in
 * the kernel: a metadata listing has no business occupying the one shared kernel.
 */
export async function GET({ url }) {
	const sel = selectionFrom(url);
	const level = url.searchParams.get('level');
	const catalog = url.searchParams.get('catalog') ?? '';
	const schema = url.searchParams.get('schema') ?? '';
	try {
		if (level === 'catalogs') return json(await listCatalogs(sel));
		if (level === 'schemas') return json(await listSchemas(sel, catalog));
		if (level === 'tables') return json(await listTables(sel, catalog, schema));
		return json({ code: 'bad_request', message: `unknown level: ${level}` }, { status: 400 });
	} catch (err) {
		const code = err?.code ?? 'error';
		return json({ code, message: String(err?.message ?? err) }, { status: statusFor(code) });
	}
}
