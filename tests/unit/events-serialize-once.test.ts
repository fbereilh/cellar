import { describe, it, expect } from 'vitest';
import { subscribe, publish, publishGlobal, sseFrame } from '../../src/lib/server/events';

describe('events bus — serialize once, fan out', () => {
	it('hands every subscriber the SAME pre-serialized frame string (one stringify)', () => {
		const framesA: string[] = [];
		const framesB: string[] = [];
		const unA = subscribe((_e, frame) => framesA.push(frame));
		const unB = subscribe((_e, frame) => framesB.push(frame));
		try {
			publish({ type: 'run:output', nb: '/x.ipynb', cellId: 'c1', output: { output_type: 'stream', name: 'stdout', text: 'hi' }, index: 0 });
			expect(framesA.length).toBe(1);
			expect(framesB.length).toBe(1);
			// Identical string content, delivered to both — serialized once, shared.
			expect(framesA[0]).toBe(framesB[0]);
		} finally {
			unA();
			unB();
		}
	});

	it('per-notebook events carry an SSE id: line (their seq); the frame parses back', () => {
		let captured: { event: unknown; frame: string } | null = null;
		const un = subscribe((event, frame) => (captured = { event, frame }));
		try {
			const published = publish({ type: 'cell:edited', nb: '/y.ipynb', cellId: 'c9' });
			expect(captured).not.toBeNull();
			const { frame } = captured!;
			expect(frame).toMatch(/^id: \d+\n/);
			const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
			expect(JSON.parse(dataLine.slice('data: '.length))).toMatchObject({
				type: 'cell:edited',
				nb: '/y.ipynb',
				cellId: 'c9',
				seq: published.seq
			});
		} finally {
			un();
		}
	});

	it('global snapshots carry no SSE id: line (no gap to detect)', () => {
		const frame = sseFrame(publishGlobal({ type: 'queue:changed', running: null, queue: [] }));
		expect(frame.startsWith('id:')).toBe(false);
		expect(frame).toMatch(/^data: /);
		expect(frame.endsWith('\n\n')).toBe(true);
	});
});
