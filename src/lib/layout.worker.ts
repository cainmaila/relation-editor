// 在 Worker 內跑 d3-force-3d（力的設定同 three-forcegraph 預設），算完回傳位置，主執行緒不卡
import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'd3-force-3d';

type In = { n: number; links: [number, number][]; ticks: number };
type P = { id: number; x: number; y: number; z: number };

self.onmessage = (e: MessageEvent<In>) => {
	const { n, links, ticks } = e.data;
	const nodes: P[] = Array.from({ length: n }, (_, id) => ({ id, x: 0, y: 0, z: 0 }));
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
	for (let i = 0; i < ticks; i++) sim.tick();
	const pos = new Float32Array(n * 3);
	nodes.forEach((d, i) => pos.set([d.x, d.y, d.z], i * 3));
	postMessage(pos, { transfer: [pos.buffer] });
};
