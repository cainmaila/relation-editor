// 主執行緒端的搜尋服務：把每筆成功命令的變更送進 Worker，各 UI 區塊各自一個查詢控制器。
// 回覆的 requestId 不是該控制器最新一次、或 revision 不是最新資料版本時一律丟棄（不把舊結果當最新）。
import { untrack } from 'svelte';
import type { GraphChange } from '../model/graph-change';
import type { GNode } from '../model/types';
import type { SearchRequest, SearchResponse } from './protocol';
import {
	PAGE_SIZE,
	type IssueIds,
	type IssueKind,
	type NodeId,
	type NodeMeta,
	type SearchQuery
} from './search-index';

export interface WorkerLike {
	postMessage(msg: SearchRequest): void;
	terminate(): void;
	onmessage: ((e: MessageEvent<SearchResponse>) => void) | null;
	onerror: ((e: Event) => void) | null;
	onmessageerror?: ((e: MessageEvent) => void) | null;
}

/** 服務從 Editor 讀目前資料（只在初始化／重建時讀全部） */
export interface SearchSource {
	revision(): number;
	nodes(): readonly GNode[];
	issues(): IssueIds;
}

export const createSearchWorker = (): WorkerLike =>
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- Vite worker 入口，不需響應
	new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' }) as WorkerLike;

const reason = (e: unknown) =>
	(typeof e === 'object' && e && 'message' in e && String(e.message)) || String(e);

/** 純資料副本：props 可能來自草稿 $state proxy，不能直接 postMessage */
const meta = (n: GNode): NodeMeta => ({
	id: n.id,
	name: n.name,
	type: n.type,
	props: Object.fromEntries(Object.entries(n.props ?? {}).map(([k, v]) => [k, String(v)]))
});

export class SearchService {
	/** 已發布的最新資料版本；回覆不是這版就不採用 */
	revision = $state(0);
	/** Worker 已確認套用的版本 */
	acked = $state(-1);
	/** Worker 壞掉時的訊息；retry() 重建 */
	error = $state('');

	#source: SearchSource;
	#create: () => WorkerLike;
	#worker: WorkerLike | null = null;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 內部待送佇列，不需響應
	#upsert = new Map<NodeId, GNode>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 內部待送佇列，不需響應
	#remove = new Set<NodeId>();
	#topology = false;
	#resync = false;
	#scheduled = false;
	/** 目前 Worker 已收到（init／patch）的最新 revision；-1＝新 Worker 還沒 init */
	#sent = -1;
	#notifying = false;
	#seq = 0;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 內部登記，不需響應
	#controllers = new Set<SearchController>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 內部登記，不需響應
	#waiting = new Map<number, SearchController>();

	constructor(source: SearchSource, create: () => WorkerLike = createSearchWorker) {
		this.#source = source;
		this.#create = create;
		this.revision = source.revision();
	}

	/**
	 * 每筆成功命令都要呼叫（同一 tick 多筆也逐筆累積，不靠 reactive lastChange）。
	 * 版本不連續就整份重建。查詢立即轉 pending，microtask 後送 patch 並重查。
	 */
	publish(change: GraphChange) {
		if (change.revision !== this.revision + 1) this.#resync = true;
		for (const id of change.removeNodeIds) {
			this.#upsert.delete(id);
			this.#remove.add(id);
		}
		for (const n of change.upsertNodes) {
			this.#remove.delete(n.id);
			this.#upsert.set(n.id, n);
		}
		this.#topology ||= change.topology;
		this.revision = change.revision;
		for (const c of this.#controllers) c.stale(change.removeNodeIds);
		if (this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.#flush();
			for (const c of this.#controllers) c.run();
		});
	}

	/**
	 * 送出查詢；回傳 requestId。先把累積的變更送出，確保 Worker 依序先套用。
	 * 永不丟例外（可能在 effect 內被呼叫）：建立 Worker、送 init／patch／query 任何一步同步失敗，
	 * 都轉成服務錯誤，並在 requestId 交回呼叫端之後（microtask）才把作用中的查詢標成錯誤。
	 */
	request(c: SearchController, query: SearchQuery): number {
		this.#controllers.add(c);
		const requestId = ++this.#seq;
		if (!this.error) {
			try {
				const w = this.#ensure();
				this.#flush();
				// flush 失敗時 Worker 已被結束：不再送查詢
				if (this.#worker === w) {
					this.#waiting.set(requestId, c);
					w.postMessage({ kind: 'query', requestId, query });
				}
			} catch (e) {
				this.#waiting.delete(requestId);
				this.#fail(reason(e));
			}
		}
		if (this.error) this.#notify();
		return requestId;
	}

	release(c: SearchController) {
		this.#controllers.delete(c);
		for (const [id, x] of this.#waiting) if (x === c) this.#waiting.delete(id);
	}

	/** 重建 Worker（完整 init），重送所有作用中的查詢 */
	retry() {
		this.error = '';
		for (const c of this.#controllers) c.run();
	}

	dispose() {
		this.#worker?.terminate();
		this.#worker = null;
		this.#waiting.clear();
	}

	#ensure(): WorkerLike {
		if (this.#worker) return this.#worker;
		const w = this.#create();
		// 已被替換的舊 Worker 晚到的訊息一律忽略
		const live = () => this.#worker === w;
		w.onmessage = (e) => live() && this.#receive(e.data);
		w.onerror = (e) => {
			e.preventDefault?.();
			if (live()) this.#fail((e as ErrorEvent).message || '搜尋服務發生錯誤');
		};
		w.onmessageerror = () => live() && this.#fail('搜尋服務回覆無法讀取');
		this.#worker = w;
		this.#sent = -1;
		this.#resync = true;
		return w;
	}

	#flush() {
		const w = this.#worker;
		if (!w) {
			// 還沒有 Worker：之後 init 會取完整快照
			this.#clearBatch();
			return;
		}
		try {
			if (this.#resync || this.#sent < 0) {
				w.postMessage({
					kind: 'init',
					revision: this.revision,
					nodes: this.#source.nodes().map(meta),
					issues: this.#source.issues()
				});
				this.#sent = this.revision;
			} else if (this.#sent !== this.revision) {
				// 只改邊、或無變更的命令也會推進 revision：送空 patch 讓 Worker 版本跟上，
				// 否則查詢回覆永遠是舊版而被丟棄。沒有拓撲變更就不帶 issues（不重算）
				w.postMessage({
					kind: 'patch',
					revision: this.revision,
					upsert: [...this.#upsert.values()].map(meta),
					remove: [...this.#remove],
					...(this.#topology ? { issues: this.#source.issues() } : {})
				});
				this.#sent = this.revision;
			}
		} catch (e) {
			this.#fail(reason(e));
		}
		this.#clearBatch();
	}

	#clearBatch() {
		this.#upsert.clear();
		this.#remove.clear();
		this.#topology = false;
		this.#resync = false;
	}

	#receive(r: SearchResponse) {
		if (r.kind === 'ack') {
			this.acked = r.revision;
			return;
		}
		const id = r.requestId;
		if (id === null) return this.#fail(r.kind === 'error' ? r.message : '搜尋失敗');
		const c = this.#waiting.get(id);
		this.#waiting.delete(id);
		if (!c) return;
		if (r.kind === 'error') c.fail(id, r.message);
		else c.receive(r);
	}

	#fail(message: string) {
		this.error = message;
		const w = this.#worker;
		this.#worker = null;
		this.#clearBatch();
		this.#waiting.clear();
		try {
			w?.terminate();
		} catch (e) {
			// 已壞掉的 Worker 收不掉不影響轉錯誤與重試，但要留下記錄，不悄悄吞掉
			console.error('搜尋 Worker 結束失敗', e);
		}
		this.#notify();
	}

	/** 服務壞掉：microtask 後（requestId 已交回）把所有作用中的查詢標成錯誤；期間已重試就不標 */
	#notify() {
		if (this.#notifying) return;
		this.#notifying = true;
		queueMicrotask(() => {
			this.#notifying = false;
			if (!this.error) return;
			for (const c of this.#controllers) c.broken(this.error);
		});
	}
}

export type SearchStatus = 'idle' | 'pending' | 'ready' | 'error';
type Filters = Pick<SearchQuery, 'text' | 'systems' | 'types' | 'issues' | 'within' | 'first'>;

/** 一個 UI 區塊的查詢狀態：條件、當頁結果、跨頁勾選。區塊之間互不覆蓋 */
export class SearchController {
	text = $state('');
	systems = $state.raw<readonly string[]>([]);
	types = $state.raw<readonly string[]>([]);
	issues = $state.raw<readonly IssueKind[]>([]);
	within = $state.raw<readonly NodeId[] | null>(null);
	first = $state.raw<readonly NodeId[] | null>(null);
	offset = $state(0);
	readonly limit: number;

	ids = $state.raw<NodeId[]>([]);
	total = $state(0);
	/** 全部命中（只在要求 matches 時有） */
	matches = $state.raw<ReadonlySet<NodeId> | null>(null);
	status = $state<SearchStatus>('idle');
	error = $state('');
	/** 跨頁勾選；只有主動清除或節點被刪才移除 */
	picked = $state.raw<NodeId[]>([]);
	/** 結果的資料版本 */
	revision = $state(-1);

	#service: SearchService;
	#matches: boolean;
	#latest = 0;
	#active = false;

	constructor(service: SearchService, opts: { limit?: number; matches?: boolean } = {}) {
		this.#service = service;
		this.limit = opts.limit ?? PAGE_SIZE;
		this.#matches = !!opts.matches;
	}

	get query(): SearchQuery {
		return {
			text: this.text,
			systems: [...this.systems],
			types: [...this.types],
			issues: [...this.issues],
			within: this.within ? [...this.within] : null,
			first: this.first ? [...this.first] : null,
			offset: this.offset,
			limit: this.limit,
			matches: this.#matches && !!this.within
		};
	}

	/** 改條件：頁碼回第一頁並重查 */
	set(f: Partial<Filters>) {
		untrack(() => Object.assign(this, f));
		this.offset = 0;
		this.run();
	}

	goto(offset: number) {
		this.offset = Math.max(0, offset);
		this.run();
	}

	/** 可能在 effect 內被呼叫：不追蹤讀到的條件與資料 */
	run() {
		untrack(() => {
			this.#active = true;
			this.status = 'pending';
			this.error = '';
			this.#latest = this.#service.request(this, this.query);
		});
	}

	/** 資料版本變了：立即標成更新中，頁碼回第一頁；刪掉的節點移出勾選 */
	stale(removed: readonly NodeId[]) {
		if (removed.length && this.picked.some((id) => removed.includes(id)))
			this.picked = this.picked.filter((id) => !removed.includes(id));
		if (!this.#active) return;
		this.offset = 0;
		this.status = 'pending';
	}

	receive(r: SearchResponse & { kind: 'page' }) {
		if (r.requestId !== this.#latest || r.revision !== this.#service.revision) return;
		this.ids = r.ids;
		this.total = r.total;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 整個替換、不再修改
		this.matches = r.matches ? new Set(r.matches) : null;
		this.revision = r.revision;
		this.status = 'ready';
	}

	fail(requestId: number, message: string) {
		if (requestId !== this.#latest) return;
		this.status = 'error';
		this.error = message;
	}

	/** 服務整個壞掉（Worker 無法建立／送出失敗／崩潰）：不論等待哪個請求都標錯誤 */
	broken(message: string) {
		if (!this.#active) return;
		this.status = 'error';
		this.error = message;
	}

	/** 重建服務並重送所有作用中的查詢（含這個） */
	retry() {
		this.#service.retry();
	}

	toggle(id: NodeId) {
		this.picked = this.picked.includes(id)
			? this.picked.filter((x) => x !== id)
			: [...this.picked, id];
	}

	clearPicked() {
		this.picked = [];
	}

	dispose() {
		this.#active = false;
		this.#service.release(this);
	}
}
