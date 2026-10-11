import { describe, expect, it, vi } from 'vitest';
import { idsKey, type LayoutReply, type LayoutRequest, type LayoutStart } from './layout';
import {
	UniverseRuntime,
	type CameraDriver,
	type LayoutWorkerLike,
	type Topology
} from './runtime';

/** 同協定的假 Worker：記錄收到的訊息（含 transfer），回覆由測試手動送出 */
function fakeWorkers() {
	const made: (LayoutWorkerLike & { sent: LayoutRequest[]; dead: boolean })[] = [];
	const opts = { fail: false };
	const create = () => {
		if (opts.fail) throw new Error('Worker 無法啟動');
		const w = {
			sent: [] as LayoutRequest[],
			dead: false,
			onmessage: null as ((e: MessageEvent<LayoutReply>) => void) | null,
			onerror: null as ((e: Event) => void) | null,
			postMessage(msg: LayoutRequest, transfer: Transferable[]) {
				// 真 Worker：postMessage 會把 transfer 的 buffer 從送出端 detach
				w.sent.push(structuredClone(msg, { transfer }));
			},
			terminate() {
				w.dead = true;
			}
		};
		made.push(w);
		return w;
	};
	return { made, create, opts };
}

const topo = (ids: string[], edges: [string, string][] = []): Topology => {
	const near = new Map<string, string[]>(ids.map((id) => [id, []]));
	for (const [a, b] of edges) {
		near.get(a)?.push(b);
		near.get(b)?.push(a);
	}
	return {
		ids,
		edges: edges.map(([from, to]) => ({ from, to })),
		neighbors: (id) => near.get(id) ?? []
	};
};
const IDS = ['a', 'b', 'c', 'd'];
const EDGES: [string, string][] = [
	['a', 'b'],
	['b', 'c']
];

function setup() {
	const w = fakeWorkers();
	const rt = new UniverseRuntime({ createWorker: w.create });
	rt.sync(topo(IDS, EDGES), 0);
	return { rt, w };
}
/** 依 start 請求組一個回覆（座標全部 +dx） */
const reply = (
	req: LayoutStart,
	type: 'progress' | 'done',
	dx: number,
	over: Partial<LayoutReply> = {}
): LayoutReply =>
	({
		type,
		generation: req.generation,
		topologyRevision: req.topologyRevision,
		idsKey: idsKey(req.ids),
		tick: type === 'done' ? req.budget : 1,
		budget: req.budget,
		positions: req.positions.map((v) => v + dx),
		tickMs: [1],
		...over
	}) as LayoutReply;
const send = (w: LayoutWorkerLike, r: LayoutReply) =>
	w.onmessage!({ data: r } as MessageEvent<LayoutReply>);
const positions = (rt: UniverseRuntime) => structuredClone([...rt.positions()]);

describe('UniverseRuntime 座標', () => {
	it('同步後立即有非重合 seed，不需等 Worker', () => {
		const { rt, w } = setup();
		const s = rt.snapshot();
		expect(s.ids).toEqual(IDS);
		expect(s.positions.length).toBe(12);
		expect(new Set(IDS.map((id) => rt.position(id)!.join())).size).toBe(4);
		expect(rt.status.phase).toBe('seed');
		expect(w.made).toHaveLength(0);
	});

	it('同一 topologyRevision 再 sync 不做任何事；拓撲變更保留既有座標、新點放鄰居旁、不重啟 layout', () => {
		const { rt, w } = setup();
		const before = rt.snapshot();
		rt.sync(topo(IDS, EDGES), 0);
		expect(rt.snapshot()).toBe(before);
		const a = rt.position('a');
		rt.sync(topo([...IDS.filter((x) => x !== 'd'), 'x'], [...EDGES, ['x', 'a']]), 1);
		expect(rt.position('a')).toEqual(a);
		expect(rt.position('d')).toBeUndefined();
		const x = rt.position('x')!;
		expect(Math.hypot(x[0] - a![0], x[1] - a![1], x[2] - a![2])).toBeLessThan(60);
		expect(w.made).toHaveLength(0);
		expect(rt.workerStarts).toBe(0);
	});
});

describe('UniverseRuntime 版面 Worker', () => {
	it('start 送出 generation／topologyRevision／ids／座標複本／links；目前使用中的座標不被 detach', () => {
		const { rt, w } = setup();
		const cur = rt.snapshot().positions;
		const copy = cur.slice();
		expect(rt.start()).toBe(true);
		const req = w.made[0].sent[0] as LayoutStart;
		expect(req).toMatchObject({ type: 'start', topologyRevision: 0, ids: IDS });
		expect([...req.positions]).toEqual([...copy]);
		expect([...req.links]).toEqual([0, 1, 1, 2]);
		// renderer 正在用的 array 仍完整
		expect(cur.length).toBe(12);
		expect([...cur]).toEqual([...copy]);
		expect(rt.status).toMatchObject({ phase: 'running', tick: 0 });
	});

	it('進度與完成更新座標並凍結；完成後不自動再跑', () => {
		const { rt, w } = setup();
		rt.start();
		const req = w.made[0].sent[0] as LayoutStart;
		send(w.made[0], reply(req, 'progress', 1, { tick: 40 }));
		expect(rt.position('a')![0]).toBeCloseTo(req.positions[0] + 1);
		expect(rt.status).toMatchObject({ phase: 'running', tick: 40 });
		send(w.made[0], reply(req, 'done', 2));
		expect(rt.position('a')![0]).toBeCloseTo(req.positions[0] + 2);
		expect(rt.status).toMatchObject({ phase: 'done', tick: req.budget });
		expect(w.made[0].dead).toBe(true);
		expect(rt.workerStarts).toBe(1);
	});

	it('舊 generation／舊拓撲／ID 不符的回覆都丟棄，不污染目前座標', () => {
		const { rt, w } = setup();
		rt.start();
		const old = w.made[0].sent[0] as LayoutStart;
		rt.stop();
		rt.start();
		const cur = w.made[1].sent[0] as LayoutStart;
		send(w.made[1], reply(cur, 'progress', 5));
		const current = positions(rt);
		send(w.made[0], reply(old, 'progress', 100));
		send(w.made[1], reply(cur, 'progress', 100, { topologyRevision: 9 }));
		send(w.made[1], reply(cur, 'progress', 100, { idsKey: idsKey(['a']) }));
		expect(positions(rt)).toEqual(current);
		expect(rt.status.phase).toBe('running');
		expect(w.made[1].dead).toBe(false);
	});

	it.each([
		['progress 長度不符', 'progress', new Float32Array(3)],
		['done 長度不符', 'done', new Float32Array(0)],
		['done 型別不符', 'done', [0, 0, 0]]
	] as const)(
		'目前 job 的回覆座標格式錯誤（%s）：明確 error、結束 Worker、座標保留、可重試',
		(_, type, bad) => {
			const { rt, w } = setup();
			rt.start();
			const req = w.made[0].sent[0] as LayoutStart;
			const before = positions(rt);
			send(w.made[0], reply(req, type, 1, { positions: bad as unknown as Float32Array }));
			expect(rt.status).toMatchObject({
				phase: 'error',
				generation: req.generation,
				message: expect.stringContaining('座標格式')
			});
			expect(w.made[0].dead).toBe(true);
			expect(positions(rt)).toEqual(before);
			expect(rt.start()).toBe(true);
			expect(rt.status.phase).toBe('running');
		}
	);

	it('非有限座標視為錯誤，保留上一版座標', () => {
		const { rt, w } = setup();
		rt.start();
		const req = w.made[0].sent[0] as LayoutStart;
		const before = positions(rt);
		send(w.made[0], reply(req, 'progress', NaN));
		expect(positions(rt)).toEqual(before);
		expect(rt.status.phase).toBe('error');
		expect(w.made[0].dead).toBe(true);
	});

	it('停止：結束 Worker、保留目前座標、狀態誠實；可再次啟動', () => {
		const { rt, w } = setup();
		rt.start();
		const req = w.made[0].sent[0] as LayoutStart;
		send(w.made[0], reply(req, 'progress', 3, { tick: 12 }));
		const at = positions(rt);
		rt.stop();
		expect(w.made[0].dead).toBe(true);
		expect(rt.status).toMatchObject({ phase: 'stopped', tick: 12, reason: 'user' });
		expect(positions(rt)).toEqual(at);
		expect(rt.start()).toBe(true);
		expect((w.made[1].sent[0] as LayoutStart).generation).toBeGreaterThan(req.generation);
		expect([...(w.made[1].sent[0] as LayoutStart).positions]).toEqual([...rt.snapshot().positions]);
	});

	it('拓撲變更取消進行中的整理、標示版面尚未重整，但不自動重啟', () => {
		const { rt, w } = setup();
		rt.start();
		const req = w.made[0].sent[0] as LayoutStart;
		rt.sync(topo([...IDS, 'x'], [...EDGES, ['x', 'c']]), 1);
		expect(w.made[0].dead).toBe(true);
		expect(rt.status).toMatchObject({ phase: 'stopped', reason: 'topology', stale: true });
		send(w.made[0], reply(req, 'done', 50));
		expect(rt.position('a')![0]).not.toBeCloseTo(req.positions[0] + 50);
		expect(rt.workerStarts).toBe(1);
		rt.start();
		expect(rt.status.stale).toBe(false);
		expect((w.made[1].sent[0] as LayoutStart).topologyRevision).toBe(1);
	});

	it('startInitial 一個 session 只啟動一次', () => {
		const { rt } = setup();
		expect(rt.startInitial()).toBe(true);
		rt.stop('detached');
		expect(rt.startInitial()).toBe(false);
		expect(rt.workerStarts).toBe(1);
		expect(rt.status).toMatchObject({ phase: 'stopped', reason: 'detached' });
	});

	it('Worker 無法建立或回報錯誤：明確 error、座標保留、可重試', () => {
		const { rt, w } = setup();
		w.opts.fail = true;
		expect(rt.start()).toBe(false);
		expect(rt.status).toMatchObject({
			phase: 'error',
			message: expect.stringContaining('無法啟動')
		});
		w.opts.fail = false;
		expect(rt.start()).toBe(true);
		const req = w.made[0].sent[0] as LayoutStart;
		send(w.made[0], {
			...reply(req, 'progress', 0),
			type: 'error',
			message: 'boom'
		} as LayoutReply);
		expect(rt.status).toMatchObject({ phase: 'error', message: expect.stringContaining('boom') });
		expect(w.made[0].dead).toBe(true);
		expect(rt.start()).toBe(true);
		w.made[1].onerror!(new Event('error'));
		expect(rt.status.phase).toBe('error');
	});

	it('停止時 stop 訊息送不出：仍確實 terminate、狀態 stopped、記錄診斷、不拋出', () => {
		const { rt, w } = setup();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		rt.start();
		const wk = w.made[0];
		wk.postMessage = () => {
			throw new Error('post boom');
		};
		expect(() => rt.stop()).not.toThrow();
		expect(wk.dead).toBe(true);
		expect(rt.status).toMatchObject({ phase: 'stopped', reason: 'user' });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('stop'), expect.any(Error));
		expect(rt.start()).toBe(true);
		warn.mockRestore();
	});

	it('停止時 terminate 拋出：狀態仍 stopped、記錄診斷、不拋出', () => {
		const { rt, w } = setup();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		rt.start();
		w.made[0].terminate = () => {
			throw new Error('term boom');
		};
		expect(() => rt.stop()).not.toThrow();
		expect(rt.status).toMatchObject({ phase: 'stopped', reason: 'user' });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminate'), expect.any(Error));
		warn.mockRestore();
	});

	it('完成時 terminate 拋出：仍套用座標並標示 done、初始入鏡照常、記錄診斷、不拋出', () => {
		const { rt, w } = setup();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const calls: string[] = [];
		rt.camera.attach({
			fit: (ids, ms) => void calls.push(`fit:${ids.join(',')}:${ms}`),
			restore: () => {},
			pose: () => ({ position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } })
		});
		rt.startInitial();
		const req = w.made[0].sent[0] as LayoutStart;
		w.made[0].terminate = () => {
			throw new Error('term boom');
		};
		expect(() => send(w.made[0], reply(req, 'done', 2))).not.toThrow();
		expect(rt.position('a')![0]).toBeCloseTo(req.positions[0] + 2);
		expect(rt.status).toMatchObject({ phase: 'done', tick: req.budget });
		expect(calls).toEqual(['fit::0', 'fit::600']);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminate'), expect.any(Error));
		warn.mockRestore();
	});

	it('訂閱者收到 positions 與 status 通知；取消訂閱後不再收到', () => {
		const { rt, w } = setup();
		const fn = vi.fn();
		const off = rt.subscribe(fn);
		rt.start();
		send(w.made[0], reply(w.made[0].sent[0] as LayoutStart, 'progress', 1));
		expect(fn).toHaveBeenCalledWith('status');
		expect(fn).toHaveBeenCalledWith('positions');
		off();
		fn.mockClear();
		rt.stop();
		expect(fn).not.toHaveBeenCalled();
	});
});

describe('UniverseRuntime 相機', () => {
	function driver() {
		const calls: string[] = [];
		let pose = { position: { x: 0, y: 0, z: 100 }, target: { x: 0, y: 0, z: 0 } };
		const d: CameraDriver = {
			fit: (ids, ms) => void calls.push(`fit:${ids.join(',')}:${ms}`),
			restore: (p) => void ((pose = p), calls.push(`restore:${p.position.z}`)),
			pose: () => pose
		};
		return { d, calls, move: (z: number) => (pose = { ...pose, position: { x: 0, y: 0, z } }) };
	}

	it('ready 前的請求只留最後一次；第一次掛上先整體入鏡再套用', () => {
		const { rt } = setup();
		const { d, calls } = driver();
		rt.camera.request(['a']);
		rt.camera.request(['b']);
		rt.camera.attach(d);
		expect(calls).toEqual(['fit::0', 'fit:b:600']);
	});

	it('使用者操作過相機，初始整理完成時不再自動入鏡；沒動過才補一次', () => {
		const a = setup();
		const da = driver();
		a.rt.camera.attach(da.d);
		a.rt.startInitial();
		a.rt.camera.interacted();
		send(a.w.made[0], reply(a.w.made[0].sent[0] as LayoutStart, 'done', 1));
		expect(da.calls).toEqual(['fit::0']);

		const b = setup();
		const db = driver();
		b.rt.camera.attach(db.d);
		b.rt.startInitial();
		send(b.w.made[0], reply(b.w.made[0].sent[0] as LayoutStart, 'done', 1));
		expect(db.calls).toEqual(['fit::0', 'fit::600']);
	});

	it('明確 relayout 完成不自動移動相機', () => {
		const { rt, w } = setup();
		const { d, calls } = driver();
		rt.camera.attach(d);
		rt.camera.interacted();
		rt.start();
		send(w.made[0], reply(w.made[0].sent[0] as LayoutStart, 'done', 1));
		expect(calls).toEqual(['fit::0']);
	});

	it('卸載保存相機，重掛恢復而不是重新入鏡；卸載後的請求等重掛', () => {
		const { rt } = setup();
		const m = driver();
		rt.camera.attach(m.d);
		m.move(321);
		rt.camera.detach();
		expect(rt.camera.saved?.position.z).toBe(321);
		const n = driver();
		rt.camera.attach(n.d);
		expect(n.calls).toEqual(['restore:321']);
		rt.camera.detach();
		rt.camera.request(['c']);
		const o = driver();
		rt.camera.attach(o.d);
		expect(o.calls).toEqual(['restore:321', 'fit:c:600']);
	});
});
