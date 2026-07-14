/**
 * `%restart_python` — a Cellar line magic that restarts the CURRENT notebook's
 * kernel with a fresh namespace, Databricks-style.
 *
 * MECHANISM (managed restart, not self-restart). The magic does NOT kill its own
 * process and rely on jupyter's autorestart. Instead it opens a comm on the
 * `cellar.control` target with `{op:'restart'}`. Cellar registers that target per
 * kernel connection (see `kernel.ts` `registerControlComm`), so the comm_open
 * lands on the SERVER, which knows exactly which notebook this kernel belongs to
 * and runs the managed `restartKernel(nbPath)` for it. That path keeps the same
 * connection (the sidebar card stays), bumps the session epoch (cells read "not
 * run this session"), clears this kernel's widgets + pending queue, and re-applies
 * the project-root `sys.path` setting via `initKernel` — the exact same
 * reconciliation the Kernels-sidebar "Restart" button triggers. Only the calling
 * notebook's kernel is touched; another notebook's kernel/namespace is untouched.
 *
 * The magic prints a friendly "Restarting Python kernel..." line and is registered
 * on every fresh start AND after a restart (it runs from `initKernel`, like the
 * matplotlib-inline + DataFrame-formatter injections), so it is always present.
 *
 * This module holds only the pure, kernel-free bits (the Python snippet + the
 * payload interpreter) so they are cheap to unit-test without a live kernel.
 */

/** Comm target Cellar registers to receive control ops (`%restart_python`, …). */
export const CONTROL_COMM_TARGET = 'cellar.control';

/**
 * Python injected at kernel start (and re-injected after a restart) that registers
 * the `%restart_python` line magic. Invoking it prints a friendly line and opens a
 * `cellar.control` comm carrying `{op:'restart'}`, which the server catches to run
 * a managed restart of THIS notebook's kernel.
 *
 * Guarded end-to-end: no IPython, no comm machinery, or any failure degrades to a
 * printed message and never breaks kernel bring-up. Both the modern `comm` package
 * (`create_comm`) and the classic `ipykernel.comm.Comm` are tried, so it works
 * across ipykernel versions.
 */
export const RESTART_MAGIC_CODE = [
	'def _cellar_register_control_magics():',
	'    try:',
	'        _ip = get_ipython()',
	'    except Exception:',
	'        return',
	'    if _ip is None:',
	'        return',
	"    def restart_python(line=''):",
	'        """Restart this notebook\'s Python kernel with a fresh namespace (Cellar).',
	'',
	'        Clears every variable/import defined this session (a previously-defined',
	'        name raises NameError afterwards), just like Databricks\' %restart_python.',
	'        """',
	"        print('Restarting Python kernel...')",
	'        _sent = False',
	'        try:',
	'            from comm import create_comm as _create_comm',
	"            _c = _create_comm(target_name='cellar.control', data={'op': 'restart'})",
	'            try:',
	'                _c.close()',
	'            except Exception:',
	'                pass',
	'            _sent = True',
	'        except Exception:',
	'            pass',
	'        if not _sent:',
	'            try:',
	'                from ipykernel.comm import Comm as _Comm',
	"                _c = _Comm(target_name='cellar.control', data={'op': 'restart'})",
	'                try:',
	'                    _c.close()',
	'                except Exception:',
	'                    pass',
	'                _sent = True',
	'            except Exception as _e:',
	"                print('cellar: unable to signal kernel restart:', _e)",
	'    try:',
	"        _ip.register_magic_function(restart_python, magic_kind='line', magic_name='restart_python')",
	'    except Exception:',
	'        pass',
	'_cellar_register_control_magics()',
	'del _cellar_register_control_magics'
].join('\n');

/**
 * Interpret a `cellar.control` comm payload into its normalized `op` string, or
 * null when the payload carries no recognizable op. Kept pure so the server's
 * dispatch (`kernel.ts`) can be unit-tested against wire-shaped data.
 */
export function controlOp(data: unknown): string | null {
	if (data && typeof data === 'object' && 'op' in data) {
		const op = (data as { op?: unknown }).op;
		if (typeof op === 'string') return op;
	}
	return null;
}
