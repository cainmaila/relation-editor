// 3D 宇宙的 session runtime：ID→xyz 座標、layout Worker 生命週期與相機狀態。
// 由 Editor 持有，與 renderer（GraphView）掛載分離：切頁／重掛直接沿用；不保存任何 domain 變更。
// 不是 Svelte state：座標與進度以 subscribe 通知，renderer 自己讀 snapshot，不逐幀進 Svelte。
import {
	LAYOUT_BUDGET,
	idsKey,
	pack,
	reconcile,
	seedPositions,
	unpack,
	type LayoutReply,
	type LayoutRequest,
	type Position3
} from './layout';

export interface LayoutWorkerLike {
	postMessage(msg: LayoutRequest, transfer: Transferable[]): void;
	terminate(): void;
	onmessage: ((e: MessageEvent<LayoutReply>) => void) | null;
	onerror: ((e: Event) => void) | null;
	onmessageerror?: ((e: MessageEvent) => void) | null;
}

export const createLayoutWorker = (): LayoutWorkerLike =>
	new Worker(new URL('../layout.worker.ts', import.meta.url), {
		type: 'module'
	}) as unknown as LayoutWorkerLike;

/** 版面的拓撲輸入：只用 id 與 from／to */
export type Topology = {
	ids: readonly string[];
	edges: readonly { from: string; to: string }[];
	neighbors(id: string): Iterable<string>;
};

export type LayoutPhase = 'seed' | 'running' | 'done' | 'stopped' | 'error';
export type LayoutStatus = {
	/** seed＝初始座標、尚未整理；done＝達計算預算後凍結（不保證收斂） */
	phase: LayoutPhase;
	tick: number;
	budget: number;
	generation: number;
	/** 拓撲在上次整理之後改過（版面尚未重整） */
	stale: boolean;
	/** stopped 的原因：使用者停止、資料變更、畫面卸載 */
	reason?: 'user' | 'topology' | 'detached';
	message?: string;
};

/** 座標快照：每次變更換新物件與新 array，舊的不被改寫 */
export type Snapshot = {
	ids: readonly string[];
	index: ReadonlyMap<string, number>;
	positions: Float32Array;
	topologyRevision: number;
	version: number;
};

type XYZ = { x: number; y: number; z: number };
export type CameraPose = { position: XYZ; target: XYZ };
/** renderer 提供的相機操作 */
export interface CameraDriver {
	/** ids 空＝全部可見節點；ms＝動畫時間 */
	fit(ids: readonly string[], ms: number): void;
	restore(pose: CameraPose): void;
	pose(): CameraPose;
}

const FLY_MS = 600;

/**
 * 相機狀態：renderer 未就緒前的請求只留最後一次；卸載時保存、重掛時恢復。
 * 初始整體入鏡之後，若使用者沒動過相機也沒有明確請求，初始整理完成時再補一次入鏡。
 */
export class CameraState {
	saved: CameraPose | null = null;
	#driver: CameraDriver | null = null;
	#pending: readonly string[] | null = null;
	#autoFit = true;

	attach(d: CameraDriver) {
		this.#driver = d;
		if (this.saved) d.restore(this.saved);
		else d.fit([], 0);
		const p = this.#pending;
		this.#pending = null;
		if (p) this.request(p);
	}

	detach() {
		if (!this.#driver) return;
		this.saved = this.#driver.pose();
		this.#driver = null;
		this.#autoFit = false;
	}

	/** 定位／全景；未就緒時排隊（只留最後一次） */
	request(ids: readonly string[]) {
		this.#autoFit = false;
		if (this.#driver) this.#driver.fit(ids, FLY_MS);
		else this.#pending = ids;
	}

	/** 使用者拖曳／縮放：取消之後的自動入鏡 */
	interacted() {
		this.#autoFit = false;
	}

	/** 初始整理完成 */
	settled() {
		if (!this.#autoFit || !this.#driver) return;
		this.#autoFit = false;
		this.#driver.fit([], FLY_MS);
	}
}

type Job = { generation: number; worker: LayoutWorkerLike; initial: boolean };
type Event_ = 'positions' | 'status';

export class UniverseRuntime {
	readonly camera = new CameraState();
	/** 這個 session 啟動過幾次 layout Worker（測試／量測用） */
	workerStarts = 0;
	/** 量測探針（只有 /measure 設定） */
	mark: ((name: string, detail?: Record<string, unknown>) => void) | null = null;

	#create: () => LayoutWorkerLike;
	#budget: number;
	#topology: Topology = { ids: [], edges: [], neighbors: () => [] };
	#key = idsKey([]);
	#snap: Snapshot = {
		ids: [],
		index: new Map(),
		positions: new Float32Array(0),
		topologyRevision: -1,
		version: 0
	};
	#generation = 0;
	#job: Job | null = null;
	#initialStarted = false;
	#status: LayoutStatus;
	#listeners = new Set<(e: Event_) => void>();

	constructor(opts: { createWorker?: () => LayoutWorkerLike; budget?: number } = {}) {
		this.#create = opts.createWorker ?? createLayoutWorker;
		this.#budget = opts.budget ?? LAYOUT_BUDGET;
		this.#status = { phase: 'seed', tick: 0, budget: this.#budget, generation: 0, stale: false };
	}

	get status(): LayoutStatus {
		return this.#status;
	}

	snapshot(): Snapshot {
		return this.#snap;
	}

	position(id: string): Position3 | undefined {
		const i = this.#snap.index.get(id);
		if (i === undefined) return undefined;
		const p = this.#snap.positions;
		return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
	}

	/** ID→xyz（複本） */
	positions(): Map<string, Position3> {
		return unpack(this.#snap.ids, this.#snap.positions);
	}

	subscribe(fn: (e: Event_) => void) {
		this.#listeners.add(fn);
		return () => void this.#listeners.delete(fn);
	}

	#emit(e: Event_) {
		for (const fn of this.#listeners) fn(e);
	}

	#setStatus(s: Partial<LayoutStatus>) {
		this.#status = { ...this.#status, ...s };
		this.#emit('status');
	}

	#setPositions(ids: readonly string[], positions: Float32Array, topologyRevision: number) {
		const index = ids === this.#snap.ids ? this.#snap.index : new Map(ids.map((id, i) => [id, i]));
		this.#snap = { ids, index, positions, topologyRevision, version: this.#snap.version + 1 };
		this.#emit('positions');
	}

	/**
	 * 拓撲改變（topologyRevision 前進）才做事：既有座標保留、新點放鄰居旁；
	 * 進行中的整理因輸入已過期而取消，但不自動重新整理。
	 */
	sync(t: Topology, topologyRevision: number) {
		if (topologyRevision === this.#snap.topologyRevision) return;
		const first = this.#snap.topologyRevision < 0;
		const prev = first ? seedPositions(t.ids) : this.positions();
		const r = reconcile(prev, t.ids, (id) => t.neighbors(id));
		const ids = [...t.ids];
		this.#topology = t;
		this.#key = idsKey(ids);
		if (this.#job) this.#cancel();
		this.#setPositions(ids, pack(ids, r.positions), topologyRevision);
		if (!first) {
			const stopped = this.#status.phase === 'running';
			this.#setStatus({
				stale: true,
				...(stopped ? { phase: 'stopped' as const, reason: 'topology' as const } : {})
			});
		}
	}

	/** 第一次顯示宇宙時啟動一次；之後只能由明確的「重新整理版面」啟動 */
	startInitial(): boolean {
		if (this.#initialStarted) return false;
		this.#initialStarted = true;
		return this.#start(true);
	}

	/** 明確的重新整理版面：從目前座標出發 */
	start(): boolean {
		this.#initialStarted = true;
		return this.#start(false);
	}

	#start(initial: boolean): boolean {
		if (this.#job) this.#cancel();
		const generation = ++this.#generation;
		const { ids, index, positions, topologyRevision } = this.#snap;
		let worker: LayoutWorkerLike;
		try {
			worker = this.#create();
		} catch (e) {
			this.#fail(generation, e);
			return false;
		}
		const job: Job = { generation, worker, initial };
		this.#job = job;
		worker.onmessage = (e) => this.#receive(job, e.data);
		worker.onerror = (e) =>
			this.#job === job && this.#fail(generation, (e as ErrorEvent).message || 'Worker 錯誤');
		worker.onmessageerror = () => this.#job === job && this.#fail(generation, '訊息無法解讀');
		const links = new Uint32Array(this.#topology.edges.length * 2);
		this.#topology.edges.forEach((e, i) => {
			links[i * 2] = index.get(e.from)!;
			links[i * 2 + 1] = index.get(e.to)!;
		});
		// 送出複本：renderer 正在用的 positions 不會被 transfer detach
		const copy = positions.slice();
		this.workerStarts++;
		this.#setStatus({
			phase: 'running',
			tick: 0,
			generation,
			stale: false,
			reason: undefined,
			message: undefined
		});
		this.mark?.('layout:start', {
			nodes: ids.length,
			edges: this.#topology.edges.length,
			generation
		});
		try {
			worker.postMessage(
				{
					type: 'start',
					generation,
					topologyRevision,
					ids: [...ids],
					positions: copy,
					links,
					budget: this.#budget
				},
				[copy.buffer, links.buffer]
			);
		} catch (e) {
			this.#fail(generation, e);
			return false;
		}
		return true;
	}

	#receive(job: Job, msg: LayoutReply) {
		// 只接受目前 job、目前拓撲、同一組有序 ID 的回覆
		if (
			this.#job !== job ||
			msg.generation !== job.generation ||
			msg.topologyRevision !== this.#snap.topologyRevision ||
			msg.idsKey !== this.#key
		)
			return;
		if (msg.type === 'error') return this.#fail(job.generation, msg.message);
		const p = msg.positions;
		if (!(p instanceof Float32Array) || p.length !== this.#snap.ids.length * 3) return;
		for (let i = 0; i < p.length; i++)
			if (!Number.isFinite(p[i])) return this.#fail(job.generation, '版面計算出現非有限座標');
		this.#setPositions(this.#snap.ids, p, this.#snap.topologyRevision);
		if (msg.type === 'done') {
			this.#job = null;
			job.worker.terminate();
			this.#setStatus({ phase: 'done', tick: msg.tick });
		} else this.#setStatus({ tick: msg.tick });
		this.mark?.(msg.type === 'done' ? 'layout:worker-done' : 'layout:progress', {
			generation: job.generation,
			tick: msg.tick,
			tickMs: msg.tickMs
		});
		if (msg.type === 'done' && job.initial) this.camera.settled();
	}

	/** 停止：結束 Worker、保留目前座標 */
	stop(reason: 'user' | 'detached' = 'user') {
		if (!this.#job) return;
		this.#cancel();
		this.#setStatus({ phase: 'stopped', reason });
	}

	/** 舊 job 的遲到回覆由 #receive 依 job／generation 丟棄 */
	#cancel() {
		const job = this.#job!;
		this.#job = null;
		try {
			// 分段邊界結束；terminate 確保不再佔 CPU
			job.worker.postMessage({ type: 'stop', generation: job.generation }, []);
			job.worker.terminate();
		} catch (e) {
			console.warn('版面 Worker 結束失敗', e);
		}
	}

	#fail(generation: number, e: unknown) {
		const job = this.#job;
		if (job) {
			this.#job = null;
			try {
				job.worker.terminate();
			} catch (err) {
				console.warn('版面 Worker 結束失敗', err);
			}
		}
		const message = e instanceof Error ? e.message : String(e);
		this.#setStatus({ phase: 'error', generation, message });
		this.mark?.('layout:error', { generation, message });
	}
}
