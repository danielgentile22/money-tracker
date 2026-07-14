import { test, expect } from 'vitest';
import { segmentByEstimated } from './segments';

const p = (v: number, estimated: boolean) => ({ v, estimated });
const shape = (data: ReturnType<typeof p>[]) =>
	segmentByEstimated(data).map((r) => ({ estimated: r.estimated, v: r.points.map((x) => x.v) }));

test('estimated prefix then real: dashed run reaches into the first real point', () => {
	expect(shape([p(1, true), p(2, true), p(3, false), p(4, false)])).toEqual([
		{ estimated: true, v: [1, 2, 3] },
		{ estimated: false, v: [3, 4] }
	]);
});

test('real → estimated → real (a later-linked account): no solid bridge over estimated data (p9-10)', () => {
	expect(shape([p(1, false), p(2, false), p(3, true), p(4, true), p(5, false), p(6, false)])).toEqual([
		{ estimated: false, v: [1, 2] }, // solid stops before the estimated gap
		{ estimated: true, v: [2, 3, 4, 5] }, // dashed bridges into both real neighbors
		{ estimated: false, v: [5, 6] } // solid resumes after
	]);
});

test('all real: a single solid run', () => {
	expect(shape([p(1, false), p(2, false)])).toEqual([{ estimated: false, v: [1, 2] }]);
});
