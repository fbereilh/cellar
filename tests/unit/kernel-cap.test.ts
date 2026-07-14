/**
 * Kernel-count soft cap (kernel-per-notebook, Phase 6).
 *
 * The Kernels sidebar warns — warn-only, never blocks a run — once the live
 * kernel count passes `CELLAR_MAX_KERNELS` (default 8; 0 disables). These cover
 * the env parse and the over-cap predicate that drive that warning.
 */
import { describe, it, expect } from 'vitest';
import { parseMaxKernels, isOverKernelCap, DEFAULT_MAX_KERNELS } from '../../src/lib/kernelCap';

describe('parseMaxKernels', () => {
	it('defaults to 8 when unset or empty', () => {
		expect(parseMaxKernels(undefined)).toBe(DEFAULT_MAX_KERNELS);
		expect(parseMaxKernels(null)).toBe(8);
		expect(parseMaxKernels('')).toBe(8);
	});

	it('honors a positive integer (floored)', () => {
		expect(parseMaxKernels('4')).toBe(4);
		expect(parseMaxKernels('12')).toBe(12);
		expect(parseMaxKernels('3.9')).toBe(3);
	});

	it('treats 0 / negative / garbage as disabled (0)', () => {
		expect(parseMaxKernels('0')).toBe(0);
		expect(parseMaxKernels('-2')).toBe(0);
		expect(parseMaxKernels('nope')).toBe(0);
	});
});

describe('isOverKernelCap', () => {
	it('warns only strictly past the cap', () => {
		expect(isOverKernelCap(8, 8)).toBe(false); // at the cap = fine
		expect(isOverKernelCap(9, 8)).toBe(true); // over = warn
		expect(isOverKernelCap(0, 8)).toBe(false);
		expect(isOverKernelCap(100, 8)).toBe(true);
	});

	it('is disabled when the cap is 0 or less, at any count', () => {
		expect(isOverKernelCap(50, 0)).toBe(false);
		expect(isOverKernelCap(50, -1)).toBe(false);
	});
});
