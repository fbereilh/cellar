/**
 * The Evcxr kernel: FINDING the binary and WRITING Cellar's own `rust` kernelspec.
 *
 * Driven over a real filesystem. Cellar never installs Evcxr, so the two outcomes
 * that matter are opposite: a binary that exists must yield a kernelspec naming
 * it, and a missing one must throw the instruction, writing nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	EVCXR_BINARY,
	EVCXR_ENV,
	EVCXR_INSTALL_COMMAND,
	RUST_KERNEL_NAME,
	RustKernelMissing,
	ensureRustKernelspec,
	findEvcxr,
	rustKernelMissingMessage,
	rustKernelMissingOutput,
	rustKernelspec,
	rustKernelspecDir
} from '../../src/lib/server/rust';

let dir: string;

/** A fake `evcxr_jupyter` in `<dir>/<sub>`, returning its path. */
function fakeBinary(sub: string): string {
	const bin = join(dir, sub);
	mkdirSync(bin, { recursive: true });
	const file = join(bin, EVCXR_BINARY);
	writeFileSync(file, '#!/bin/sh\n');
	chmodSync(file, 0o755);
	return file;
}

/** An env with no Evcxr reachable unless a test adds one. */
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { PATH: join(dir, 'empty'), CARGO_HOME: join(dir, 'no-cargo'), ...extra };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-rust-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('findEvcxr', () => {
	it('answers null when the binary is nowhere', () => {
		expect(findEvcxr(env())).toBeNull();
	});

	it('finds the binary on PATH', () => {
		const file = fakeBinary('path-bin');
		expect(findEvcxr(env({ PATH: join(dir, 'path-bin') }))).toBe(file);
	});

	it('finds it in cargo home when PATH lacks it', () => {
		const file = fakeBinary(join('cargo', 'bin'));
		expect(findEvcxr(env({ CARGO_HOME: join(dir, 'cargo') }))).toBe(file);
	});

	it('prefers PATH over cargo home', () => {
		const onPath = fakeBinary('path-bin');
		fakeBinary(join('cargo', 'bin'));
		expect(findEvcxr(env({ PATH: join(dir, 'path-bin'), CARGO_HOME: join(dir, 'cargo') }))).toBe(onPath);
	});

	it('uses the override when it names a file', () => {
		const file = fakeBinary('custom');
		fakeBinary('path-bin');
		expect(findEvcxr(env({ PATH: join(dir, 'path-bin'), [EVCXR_ENV]: file }))).toBe(file);
	});

	it('answers null for an override naming no file, even with a binary on PATH', () => {
		fakeBinary('path-bin');
		expect(findEvcxr(env({ PATH: join(dir, 'path-bin'), [EVCXR_ENV]: join(dir, 'gone') }))).toBeNull();
	});

	it('ignores a DIRECTORY named like the binary', () => {
		mkdirSync(join(dir, 'path-bin', EVCXR_BINARY), { recursive: true });
		expect(findEvcxr(env({ PATH: join(dir, 'path-bin') }))).toBeNull();
	});
});

describe('the kernelspec', () => {
	it('names the binary and handles interrupts as a message', () => {
		expect(rustKernelspec('/x/evcxr_jupyter')).toEqual({
			argv: ['/x/evcxr_jupyter', '--control_file', '{connection_file}'],
			display_name: 'Rust',
			language: 'rust',
			interrupt_mode: 'message'
		});
	});

	it('lives beside the python3 kernelspec', () => {
		expect(rustKernelspecDir({ CELLAR_KERNELSPEC_DIR: '/j/kernels/python3' })).toBe(`/j/kernels/${RUST_KERNEL_NAME}`);
		expect(rustKernelspecDir({})).toBeNull();
	});
});

describe('ensureRustKernelspec', () => {
	const specEnv = (extra: NodeJS.ProcessEnv = {}) =>
		env({ CELLAR_KERNELSPEC_DIR: join(dir, 'jupyter', 'kernels', 'python3'), ...extra });
	const specFile = () => join(dir, 'jupyter', 'kernels', RUST_KERNEL_NAME, 'kernel.json');

	it('writes a kernelspec naming the binary it found', () => {
		const file = fakeBinary('path-bin');
		expect(ensureRustKernelspec(specEnv({ PATH: join(dir, 'path-bin') }))).toBe(file);
		expect(JSON.parse(readFileSync(specFile(), 'utf8'))).toEqual(rustKernelspec(file));
	});

	it('writes nothing when the kernelspec is already right', () => {
		fakeBinary('path-bin');
		const e = specEnv({ PATH: join(dir, 'path-bin') });
		ensureRustKernelspec(e);
		const before = statSync(specFile());
		ensureRustKernelspec(e);
		const after = statSync(specFile());
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	it('rewrites the kernelspec when the binary moves', () => {
		fakeBinary('path-bin');
		ensureRustKernelspec(specEnv({ PATH: join(dir, 'path-bin') }));
		const moved = fakeBinary('elsewhere');
		ensureRustKernelspec(specEnv({ [EVCXR_ENV]: moved }));
		expect(JSON.parse(readFileSync(specFile(), 'utf8')).argv[0]).toBe(moved);
	});

	it('throws the instruction and writes nothing when Evcxr is missing', () => {
		expect(() => ensureRustKernelspec(specEnv())).toThrow(RustKernelMissing);
		expect(existsSync(specFile())).toBe(false);
	});

	it('picks up a binary installed after a first failure, with no restart', () => {
		const e = specEnv({ PATH: join(dir, 'path-bin') });
		expect(() => ensureRustKernelspec(e)).toThrow(RustKernelMissing);
		const file = fakeBinary('path-bin');
		expect(ensureRustKernelspec(e)).toBe(file);
	});

	it('refuses without a kernelspec directory', () => {
		fakeBinary('path-bin');
		expect(() => ensureRustKernelspec(env({ PATH: join(dir, 'path-bin') }))).toThrow(/kernelspec dir/);
	});
});

describe('the missing-kernel report', () => {
	it('names the binary, the install command and the override', () => {
		const message = rustKernelMissingMessage();
		expect(message).toContain(EVCXR_BINARY);
		expect(message).toContain(EVCXR_INSTALL_COMMAND);
		expect(message).toContain(EVCXR_ENV);
		expect(message).toContain('No restart is needed');
	});

	it('is the default message of the error', () => {
		expect(new RustKernelMissing().message).toBe(rustKernelMissingMessage());
	});

	it('renders as a cell error output', () => {
		expect(rustKernelMissingOutput('why')).toEqual({
			output_type: 'error',
			ename: 'RustKernelMissing',
			evalue: 'why',
			traceback: ['why']
		});
	});
});
