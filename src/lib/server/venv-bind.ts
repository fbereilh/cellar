/**
 * Runtime venv binding for the Settings control.
 *
 * The launcher establishes the initial binding (project python + a per-run
 * `python3` kernelspec dir, handed to this process via `CELLAR_PROJECT_VENV` /
 * `CELLAR_KERNELSPEC_DIR`). This module lets the running app *re-bind* to a
 * different or newly-created venv without restarting Cellar: it resolves/creates
 * the venv via uv, rewrites that same kernelspec in place, and the caller then
 * rebinds the kernel (kernel.js `rebindKernel`) so a fresh kernel launches the
 * new interpreter.
 */
import { dirname, resolve } from 'node:path';
import {
	hasUv,
	isValidVenv,
	venvPython,
	hasIpykernel,
	createVenv,
	ensureIpykernel,
	ensureIpywidgets,
	writeKernelspec
} from './venv.js';

function workspace(): string {
	return process.env.CELLAR_WORKSPACE || process.cwd();
}

/** The interpreter currently bound (tracked in-process; seeded from env). */
function currentPython(): string {
	return process.env.CELLAR_PROJECT_VENV || '';
}

/** Reported by {@link getVenvInfo} for the Settings UI. */
export interface VenvInfo {
	python: string;
	venvDir: string;
	workspace: string;
	defaultVenv: string;
	valid: boolean;
	hasIpykernel: boolean;
	uvAvailable: boolean;
	kernelspecDir: string | null;
}

/** Report the current binding for the Settings UI. */
export async function getVenvInfo(): Promise<VenvInfo> {
	const python = currentPython();
	return {
		python,
		venvDir: python ? dirname(dirname(python)) : '',
		workspace: workspace(),
		defaultVenv: resolve(workspace(), '.venv'),
		valid: !!python,
		hasIpykernel: python ? await hasIpykernel(python) : false,
		uvAvailable: await hasUv(),
		kernelspecDir: process.env.CELLAR_KERNELSPEC_DIR || null
	};
}

/** Options accepted by {@link bindVenv}: venv dir; `create` uses `uv venv` when it does not already exist. */
export interface BindVenvOptions {
	path: string;
	create?: boolean;
}

/** Result of {@link bindVenv}. */
export interface BindVenvResult {
	python: string;
	created: boolean;
	installedIpykernel: boolean;
}

/**
 * Bind the kernel to a venv, optionally creating it. Rewrites the kernelspec
 * and updates in-process state; the route then calls `rebindKernel()`.
 */
export async function bindVenv({ path, create = false }: BindVenvOptions): Promise<BindVenvResult> {
	if (!path || typeof path !== 'string') throw new Error('a venv path is required');
	if (!(await hasUv())) throw new Error('uv is not available on PATH; cannot create or bind venvs');

	const kernelspecDir = process.env.CELLAR_KERNELSPEC_DIR;
	if (!kernelspecDir) throw new Error('no kernelspec dir configured; launch via `cellar`');

	const venv = resolve(workspace(), path);
	let created = false;
	if (!isValidVenv(venv)) {
		if (!create) throw new Error(`no virtualenv at ${venv} (pass create to make one)`);
		await createVenv(venv, {});
		created = true;
	}
	const python = venvPython(venv);
	const { installed: installedIpykernel } = await ensureIpykernel(python, {});
	// Best-effort: enable ipywidgets (Databricks-style parameter widgets + any
	// ipywidget). Never blocks a rebind - the kernel shim degrades to value-only.
	await ensureIpywidgets(python, {});

	writeKernelspec(kernelspecDir, python);
	process.env.CELLAR_PROJECT_VENV = python;

	return { python, created, installedIpykernel };
}
