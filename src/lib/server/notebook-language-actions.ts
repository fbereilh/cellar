/**
 * Notebook language - the action that brings the KERNEL in line with it.
 *
 * `notebook.ts` records the language. It may not reach the kernel, so this module
 * pairs the two, exactly as `notebook-root-actions.ts` does for a code root. The
 * REST route and the MCP tool both call it after the setter.
 *
 * WHICH SWITCHES COST A KERNEL. Python and Mojo share one kernel (ipykernel), so
 * a switch between them keeps the process and its namespace. Rust runs on Evcxr,
 * a different process. A kernel's language is fixed when it spawns, so a switch
 * that crosses that line frees the kernel (`rebindKernel`, the same path a root
 * change uses). The next run starts the right one.
 *
 * It compares the kernel that is RUNNING against what the document holds now. It
 * does not take a before/after pair. So it is correct after a failed save too,
 * where the live document already holds the new language.
 */
import { notebookKernelLanguage } from '../cellLanguage';
import { getNotebookLanguage, resolveNotebookPath } from './notebook';
import { liveKernelLanguage, rebindKernel } from './kernel';

/** What a language change did to the notebook's kernel. */
export interface KernelLanguageChange {
	/** True when this notebook's kernel was freed so the next run starts the right one. */
	kernel_restarted: boolean;
	/** True whenever a kernel was freed: its variables and imports are gone. */
	namespace_cleared: boolean;
	/**
	 * Present only when freeing the kernel THREW. The two flags beside it are then
	 * read off what is left afterwards, not assumed: a throw after the kernel was
	 * already dropped still reports it freed.
	 */
	kernel_error?: string;
}

const UNCHANGED: KernelLanguageChange = { kernel_restarted: false, namespace_cleared: false };

/**
 * Free the notebook's kernel when it is the wrong kind for the language the
 * document now holds. A notebook with no kernel, or one already on the right
 * kernel, is untouched. Never throws: the language is already applied.
 *
 * A kernel that could not be READ is reported as unchanged, since nothing was
 * attempted. A rebind that THROWS is different: it may have freed the kernel
 * before failing, so the reply says what is true afterwards (is a kernel still
 * registered for this notebook) and carries the failure as `kernel_error`.
 */
export async function syncKernelToNotebookLanguage(nb?: string | null): Promise<KernelLanguageChange> {
	let abs: string;
	try {
		abs = resolveNotebookPath(nb ?? undefined);
		const live = liveKernelLanguage(abs);
		if (live === null || live === notebookKernelLanguage(getNotebookLanguage(abs))) return UNCHANGED;
	} catch {
		return UNCHANGED;
	}
	try {
		const { rebound } = await rebindKernel(abs);
		return { kernel_restarted: rebound > 0, namespace_cleared: rebound > 0 };
	} catch (err) {
		const freed = liveKernelLanguage(abs) === null;
		return {
			kernel_restarted: freed,
			namespace_cleared: freed,
			kernel_error: err instanceof Error ? err.message : String(err)
		};
	}
}
