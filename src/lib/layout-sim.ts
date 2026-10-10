// d3-force-3d 版面計算（力的設定同 three-forcegraph 預設）；Worker 與量測腳本共用同一份。
import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'd3-force-3d';

/** zero：全部從原點出發（目前正式行為）；d3：交給 d3 的非重合起始點（P1 對照實驗用） */
export type LayoutInit = 'zero' | 'd3';
export type LayoutIn = { n: number; links: [number, number][]; ticks: number; init?: LayoutInit };
export type LayoutOut = { pos: Float32Array; tickMs: Float64Array };
type P = { id: number; x?: number; y?: number; z?: number };

export function runLayout({ n, links, ticks, init = 'zero' }: LayoutIn): LayoutOut {
	const nodes: P[] = Array.from({ length: n }, (_, id) =>
		init === 'zero' ? { id, x: 0, y: 0, z: 0 } : { id }
	);
	const sim = forceSimulation()
		.force('link', forceLink())
		.force('charge', forceManyBody())
		.force('center', forceCenter())
		.stop();
	sim.alpha(1).numDimensions(3).nodes(nodes);
	sim
		.force('link')
		.id((d: P) => d.id)
		.links(links.map(([source, target]) => ({ source, target })));
	const tickMs = new Float64Array(ticks);
	for (let i = 0; i < ticks; i++) {
		const t = performance.now();
		sim.tick();
		tickMs[i] = performance.now() - t;
	}
	const pos = new Float32Array(n * 3);
	nodes.forEach((d, i) => pos.set([d.x!, d.y!, d.z!], i * 3));
	return { pos, tickMs };
}
