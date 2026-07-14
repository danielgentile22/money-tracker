// Split a balance series into contiguous runs by the `estimated` flag, so the
// dashed (estimated) and solid (real) lines render correctly for ANY
// interleaving — not just an estimated prefix (p9-10). A second institution
// linked after day 1 gets reconstructed estimated points mid-series, so a
// series can go real → estimated → real.

export type Run<T> = { estimated: boolean; points: T[] };

/**
 * Each estimated run is extended by its adjacent real neighbors so the dashed
 * segment meets the solid ones with no gap; real runs are returned as-is. Draw
 * one line mark per run (dashed when estimated). Runs of a single point produce
 * no visible line — the neighboring estimated run already bridges through them.
 */
export function segmentByEstimated<T extends { estimated: boolean }>(data: T[]): Run<T>[] {
	const runs: Run<T>[] = [];
	for (const d of data) {
		const last = runs[runs.length - 1];
		if (last && last.estimated === d.estimated) last.points.push(d);
		else runs.push({ estimated: d.estimated, points: [d] });
	}
	return runs.map((run, i) => {
		if (!run.estimated) return run;
		const prev = runs[i - 1]?.points.at(-1);
		const next = runs[i + 1]?.points[0];
		return {
			estimated: true,
			points: [...(prev ? [prev] : []), ...run.points, ...(next ? [next] : [])]
		};
	});
}
