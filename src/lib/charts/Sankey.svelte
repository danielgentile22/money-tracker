<script lang="ts">
	import { fmtUSD } from '$lib/money';
	import { sliceColor, LIME, MAGENTA, OTHER } from './theme';

	// Fixed two-level Sankey: income Categories → central spine → expense
	// Groups, plus a Savings terminal or Shortfall source. Dumb by design —
	// fed computed nodes/links; the general n-level layout problem is
	// deliberately out of scope. Ribbon click applies a filter upstream.
	type Node = {
		id: string;
		label: string;
		kind: 'income' | 'spine' | 'group' | 'savings' | 'shortfall';
		filterKind?: 'categories' | 'groups';
		filterId?: number;
	};
	type Link = { source: string; target: string; value_cents: number };

	let {
		nodes,
		links,
		onribbon
	}: { nodes: Node[]; links: Link[]; onribbon: (n: Node) => void } = $props();

	const W = 860;
	const H = 420;
	const NODE_W = 10;
	const GAP = 12; // ≥ label height so adjacent small-node labels never collide
	const LABEL_W = 190; // room for text either side
	const X_LEFT = LABEL_W;
	const X_MID = W / 2 - NODE_W / 2;
	const X_RIGHT = W - LABEL_W - NODE_W;

	type Placed = {
		node: Node;
		value: number;
		x: number;
		y: number;
		h: number;
		side: 'left' | 'right' | 'mid';
	};

	const layout = $derived.by(() => {
		const value = (id: string) =>
			links.filter((l) => l.source === id || l.target === id).reduce((s, l) => s + l.value_cents, 0);
		// left column: income sources + shortfall; right: expense groups + savings
		const left = nodes.filter((n) => n.kind === 'income' || n.kind === 'shortfall');
		const right = nodes.filter((n) => n.kind === 'group' || n.kind === 'savings');
		const spineTotal = value('spine') / 2; // spine sees every link once per side
		const scaleDenom = Math.max(spineTotal, 1);
		const usable = (count: number) => H - GAP * Math.max(count - 1, 0);
		const px = (v: number, count: number) => Math.max((v / scaleDenom) * usable(count), 3);

		const place = (col: Node[], x: number, side: 'left' | 'right'): Placed[] => {
			let y = (H - (col.reduce((s, n) => s + px(value(n.id), col.length), 0) + GAP * Math.max(col.length - 1, 0))) / 2;
			return col.map((n) => {
				const h = px(value(n.id), col.length);
				const p = { node: n, value: value(n.id), x, y, h, side };
				y += h + GAP;
				return p;
			});
		};
		const placed = new Map<string, Placed>();
		for (const p of place(left, X_LEFT, 'left')) placed.set(p.node.id, p);
		for (const p of place(right, X_RIGHT, 'right')) placed.set(p.node.id, p);
		const spine = nodes.find((n) => n.kind === 'spine');
		if (spine) {
			const h = Math.max((spineTotal / scaleDenom) * H, 2);
			placed.set(spine.id, { node: spine, value: spineTotal, x: X_MID, y: (H - h) / 2, h, side: 'mid' });
		}
		return placed;
	});

	// ribbons: cumulative offsets per node side keep flows stacked without overlap
	const ribbons = $derived.by(() => {
		const offsets = new Map<string, number>(); // key: nodeId + ':in' | ':out'
		const out: {
			link: Link;
			path: string;
			color: string;
			endNode: Node;
			thick: number;
		}[] = [];
		for (const l of links) {
			const s = layout.get(l.source);
			const t = layout.get(l.target);
			if (!s || !t) continue;
			const sKey = `${l.source}:out`;
			const tKey = `${l.target}:in`;
			const sOff = offsets.get(sKey) ?? 0;
			const tOff = offsets.get(tKey) ?? 0;
			const sFrac = s.value > 0 ? l.value_cents / s.value : 0;
			const tFrac = t.value > 0 ? l.value_cents / t.value : 0;
			const sThick = s.h * sFrac;
			const tThick = t.h * tFrac;
			offsets.set(sKey, sOff + sThick);
			offsets.set(tKey, tOff + tThick);
			const x0 = s.x + NODE_W;
			const x1 = t.x;
			const y0a = s.y + sOff;
			const y0b = y0a + sThick;
			const y1a = t.y + tOff;
			const y1b = y1a + tThick;
			const cx = (x0 + x1) / 2;
			const end = t.node.kind === 'spine' ? s.node : t.node;
			const rank = nodes.filter((n) => n.kind === end.kind).indexOf(end);
			const color =
				end.kind === 'savings' ? LIME
				: end.kind === 'shortfall' ? MAGENTA
				: end.filterId == null ? OTHER
				: sliceColor(rank);
			out.push({
				link: l,
				endNode: end,
				thick: Math.max(sThick, tThick),
				color,
				path: `M ${x0} ${y0a} C ${cx} ${y0a} ${cx} ${y1a} ${x1} ${y1a} L ${x1} ${y1b} C ${cx} ${y1b} ${cx} ${y0b} ${x0} ${y0b} Z`
			});
		}
		return out;
	});

	const nodeColor = (n: Node): string =>
		n.kind === 'savings' ? LIME
		: n.kind === 'shortfall' ? MAGENTA
		: n.kind === 'spine' ? 'var(--color-border-strong)'
		: n.filterId == null ? OTHER
		: sliceColor(nodes.filter((x) => x.kind === n.kind).indexOf(n));
</script>

<svg viewBox="0 0 {W} {H + 20}" role="img" aria-label="Cash flow Sankey">
	{#each ribbons as r (r.link.source + r.link.target)}
		<path
			d={r.path}
			fill={r.color}
			class="ribbon"
			class:clickable={r.endNode.filterKind != null}
			role="button"
			tabindex="0"
			onclick={() => onribbon(r.endNode)}
			onkeydown={(e) => e.key === 'Enter' && onribbon(r.endNode)}
		>
			<title>{r.endNode.label} · {fmtUSD(r.link.value_cents)}</title>
		</path>
	{/each}
	{#each [...layout.values()] as p (p.node.id)}
		<rect x={p.x} y={p.y} width={NODE_W} height={p.h} rx="2" fill={nodeColor(p.node)} />
		{#if p.side !== 'mid'}
			<text
				x={p.side === 'left' ? p.x - 8 : p.x + NODE_W + 8}
				y={p.y + p.h / 2 + 4}
				class="label"
				text-anchor={p.side === 'left' ? 'end' : 'start'}
			>
				{p.node.label}
				<tspan class="amount">{fmtUSD(p.value)}</tspan>
			</text>
		{/if}
	{/each}
</svg>

<style>
	svg {
		width: 100%;
		height: auto;
	}
	.ribbon {
		opacity: 0.45;
		transition: opacity var(--motion-base) var(--easing-standard);
	}
	.ribbon:hover,
	.ribbon:focus-visible {
		opacity: 0.85;
	}
	.clickable {
		cursor: pointer;
	}
	.label {
		font-size: 12px;
		fill: var(--color-text-secondary);
	}
	.amount {
		fill: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: 11px;
	}
</style>
