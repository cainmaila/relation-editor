// d3-force-3d 版面計算（力的設定同 three-forcegraph 預設）；Worker 與量測腳本共用同一份。
import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'd3-force-3d';
import { ROOT_ID } from './model/config';
import { idsKey, type LayoutReply, type LayoutStart } from './universe/layout';

/** zero：全部從原點出發（P1 基線）；d3：交給 d3 的非重合起始點（P1 對照實驗用） */
export type LayoutInit = 'zero' | 'd3';
export type LayoutIn = { n: number; links: [number, number][]; ticks: number; init?: LayoutInit };
export type LayoutOut = { pos: Float32Array; tickMs: Float64Array };
type P = { id: number; x?: number; y?: number; z?: number; fx?: number; fy?: number; fz?: number };

function simulation(nodes: P[], links: [number, number][]) {
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
	return sim;
}

function positionsOf(nodes: P[]) {
	const pos = new Float32Array(nodes.length * 3);
	nodes.forEach((d, i) => pos.set([d.x!, d.y!, d.z!], i * 3));
	return pos;
}

/** P1 量測腳本用：一次跑完 ticks */
export function runLayout({ n, links, ticks, init = 'zero' }: LayoutIn): LayoutOut {
	const nodes: P[] = Array.from({ length: n }, (_, id) =>
		init === 'zero' ? { id, x: 0, y: 0, z: 0 } : { id }
	);
	const sim = simulation(nodes, links);
	const tickMs = new Float64Array(ticks);
	for (let i = 0; i < ticks; i++) {
		const t = performance.now();
		sim.tick();
		tickMs[i] = performance.now() - t;
	}
	return { pos: positionsOf(nodes), tickMs };
}

export type JobIO = {
	post(reply: LayoutReply, transfer: Transferable[]): void;
	/** 排下一段（讓 stop 訊息有機會進來） */
	schedule(f: () => void): void;
	now(): number;
	/** 每段至少算多久才回報（ms）；0＝每 tick 回報 */
	segmentMs: number;
};

/**
 * 正式版面：從傳入座標出發分段跑 d3 tick，每段回報一份新配置的座標（可 transfer）；
 * 達 budget 回 done 後凍結。stop() 後在下一個分段邊界結束、不再回覆。
 */
export function startLayoutJob(req: LayoutStart, io: JobIO) {
	const stamp = {
		generation: req.generation,
		topologyRevision: req.topologyRevision,
		idsKey: idsKey(req.ids)
	};
	let stopped = false;
	let tick = 0;
	let sim: ReturnType<typeof simulation>;
	// 根節點固定在原點：關係網從它長出去，連不到它的節點被推到外圍
	const nodes: P[] = req.ids.map((nid, id) =>
		nid === ROOT_ID
			? { id, x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0 }
			: { id, x: req.positions[id * 3], y: req.positions[id * 3 + 1], z: req.positions[id * 3 + 2] }
	);
	const fail = (e: unknown) =>
		io.post({ ...stamp, type: 'error', message: e instanceof Error ? e.message : String(e) }, []);

	const segment = () => {
		if (stopped) return;
		const tickMs: number[] = [];
		try {
			const t0 = io.now();
			do {
				const t = io.now();
				sim.tick();
				tickMs.push(io.now() - t);
				tick++;
			} while (tick < req.budget && io.now() - t0 < io.segmentMs);
		} catch (e) {
			stopped = true;
			return fail(e);
		}
		const positions = positionsOf(nodes);
		const type = tick >= req.budget ? 'done' : 'progress';
		io.post({ ...stamp, type, tick, budget: req.budget, positions, tickMs }, [positions.buffer]);
		if (type === 'progress') io.schedule(segment);
	};

	try {
		const links: [number, number][] = [];
		for (let i = 0; i + 1 < req.links.length; i += 2) links.push([req.links[i], req.links[i + 1]]);
		sim = simulation(nodes, links);
		segment();
	} catch (e) {
		stopped = true;
		fail(e);
	}
	return {
		stop() {
			stopped = true;
		}
	};
}
