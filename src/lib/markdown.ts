import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

// The one markdown engine Cellar uses. Shared by notebook markdown cells
// (`Cell.svelte`), the file-preview view (`MarkdownView.svelte`) and the
// markdown-table-in-output path — so every rendered surface parses identically
// and there is never a second engine to drift from. Safe mode: `html:false`
// escapes raw HTML, then DOMPurify (client-only, needs a DOM) sanitizes what
// markdown-it emits, so notebook / file content can't inject script.
export const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

export function renderMarkdown(src: string | null | undefined): string {
	return DOMPurify.sanitize(md.render(src || ''));
}
