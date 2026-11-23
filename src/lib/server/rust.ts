/**
 * Rust notebooks run on the Evcxr Jupyter kernel (`evcxr_jupyter`).
 *
 * Unlike Mojo, Rust has a REAL kernel: state persists between cells and output
 * streams live. So a Rust notebook gets its own kernel process, started from a
 * `rust` kernelspec Cellar writes beside its `python3` one.
 *
 * DETECT AND INSTRUCT. Cellar never installs Evcxr (it is a `cargo install`
 * that compiles for minutes). `ensureRustKernelspec` looks for the binary each
 * time a Rust kernel is about to start, so installing it mid-session and
 * re-running the cell works with no restart. A missing binary throws
 * `RustKernelMissing`, whose message names the fix.
 *
 * The kernelspec is Cellar's own, written into the launcher's private
 * `JUPYTER_PATH` directory. It does not depend on `evcxr_jupyter --install`
 * having been run, and it never writes into the user's Jupyter data dir.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { writeFileAtomic } from './write-file-atomic.js';

/** The kernelspec name a Rust notebook's kernel is started under. */
export const RUST_KERNEL_NAME = 'rust';

/** The Evcxr Jupyter kernel binary. */
export const EVCXR_BINARY = 'evcxr_jupyter';

/** The command a user runs to install it. */
export const EVCXR_INSTALL_COMMAND = 'cargo install --locked evcxr_jupyter';

/** Env override: an absolute path to the `evcxr_jupyter` binary. */
export const EVCXR_ENV = 'CELLAR_EVCXR';

/** Thrown when a Rust kernel is asked for and Evcxr cannot be found. */
export class RustKernelMissing extends Error {
	constructor(message: string = rustKernelMissingMessage()) {
		super(message);
		this.name = 'RustKernelMissing';
	}
}

/** The actionable message for a missing Evcxr kernel. */
export function rustKernelMissingMessage(): string {
	return (
		`Rust cells run on the Evcxr Jupyter kernel, and ${EVCXR_BINARY} was not found on PATH or in ~/.cargo/bin. ` +
		`Install it with: ${EVCXR_INSTALL_COMMAND} - it compiles from source and takes a few minutes, so Cellar does not run it for you. ` +
		`Then run this cell again. No restart is needed. ` +
		`To use a binary somewhere else, set ${EVCXR_ENV} to its absolute path before starting Cellar.`
	);
}

/** That message as a cell error output, so it renders where the user is looking. */
export function rustKernelMissingOutput(message: string): {
	output_type: 'error';
	ename: string;
	evalue: string;
	traceback: string[];
} {
	return { output_type: 'error', ename: 'RustKernelMissing', evalue: message, traceback: [message] };
}

function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

/**
 * The absolute path of the `evcxr_jupyter` binary, or null when there is none.
 * Order: the `CELLAR_EVCXR` override, then PATH, then cargo's bin directory
 * (`$CARGO_HOME/bin`, default `~/.cargo/bin`), which a GUI-launched or
 * minimal-PATH process often lacks.
 *
 * An override that names no file answers null rather than falling through:
 * the user named a binary, so silently running a different one would be wrong.
 */
export function findEvcxr(env: NodeJS.ProcessEnv = process.env): string | null {
	const override = env[EVCXR_ENV]?.trim();
	if (override) return isFile(override) ? override : null;
	const names = process.platform === 'win32' ? [`${EVCXR_BINARY}.exe`, EVCXR_BINARY] : [EVCXR_BINARY];
	const cargoHome = env.CARGO_HOME?.trim() || join(homedir(), '.cargo');
	const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(cargoHome, 'bin')];
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (isFile(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * The kernelspec Evcxr's own `--install` writes, pointed at `binary`.
 * `interrupt_mode: message` is required: Evcxr handles an interrupt as a
 * control-channel message, not a signal.
 */
export function rustKernelspec(binary: string): Record<string, unknown> {
	return {
		argv: [binary, '--control_file', '{connection_file}'],
		display_name: 'Rust',
		language: 'rust',
		interrupt_mode: 'message'
	};
}

/**
 * Where the `rust` kernelspec lives: a sibling of the `python3` one the
 * launcher wrote (`CELLAR_KERNELSPEC_DIR` = `<jupyter>/kernels/python3`).
 */
export function rustKernelspecDir(env: NodeJS.ProcessEnv = process.env): string | null {
	const pythonDir = env.CELLAR_KERNELSPEC_DIR;
	return pythonDir ? join(dirname(pythonDir), RUST_KERNEL_NAME) : null;
}

/**
 * Make sure a `rust` kernelspec naming a real Evcxr binary exists, and return
 * the binary. Called right before every Rust kernel start. Jupyter re-reads
 * its kernelspec directories on each start, so a spec written here is seen by
 * the very start that follows. Writes nothing when the spec is already right.
 */
export function ensureRustKernelspec(env: NodeJS.ProcessEnv = process.env): string {
	const binary = findEvcxr(env);
	if (!binary) throw new RustKernelMissing();
	const dir = rustKernelspecDir(env);
	if (!dir) throw new Error('no kernelspec dir configured; launch via `cellar`');
	const file = join(dir, 'kernel.json');
	const wanted = JSON.stringify(rustKernelspec(binary), null, 1) + '\n';
	let current: string | null = null;
	try {
		current = existsSync(file) ? readFileSync(file, 'utf8') : null;
	} catch {
		current = null;
	}
	if (current !== wanted) {
		mkdirSync(dir, { recursive: true });
		writeFileAtomic(file, wanted);
	}
	return binary;
}
