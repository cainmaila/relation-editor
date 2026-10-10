// 編輯器狀態：圖（mock 初始值，不存檔）、系統勾選、選取、找客戶結果。
import { untrack } from 'svelte';
import {
	EDGE_TYPES,
	IDC_MESSAGE,
	NODE_TYPES,
	SYSTEMS,
	nodeType,
	type System
} from './model/config';
import {
	checkDeleteNode,
	collapse,
	findCustomers,
	STACK_MIN,
	stacks,
	unprocessed,
	unreachable,
	validateEdge,
	type CustomerResult
} from './model/graph';
import {
	applyCommand,
	initialGraphState,
	type EdgePatch,
	type GraphChange,
	type GraphCommand,
	type NodePatch
} from './model/graph-change';
import { buildGraphIndex, edgesOf, type GraphIndex } from './model/graph-index';
import { graphMock, idcMock } from './model/mock';
import type { GEdge, GNode, Graph } from './model/types';
import {
	SearchController,
	SearchService,
	createSearchWorker,
	type WorkerLike
} from './search/search-client.svelte';

/** 勾選系統的節點＋通用節點；邊兩端都在才留 */
function visibleIn(g: Graph, systems: readonly System[]): Graph {
	const nodes = g.nodes.filter((n) => {
		const s = nodeType(n.type).system;
		return s === null || systems.includes(s);
	});
	const ids = new Set(nodes.map((n) => n.id));
	return { nodes, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

export type Selection = { kind: 'node' | 'edge'; id: string } | null;
/** 游標處的浮動選單：右鍵物件／空白，或拖曳連線放開處 */
export type Menu = { x: number; y: number } & (
	| { kind: 'node'; id: string }
	| { kind: 'edge'; id: string }
	| { kind: 'pane' }
	| { kind: 'connect'; from: string; to: string }
	| { kind: 'drop'; from: string }
);

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

/** 編輯頁節點上限 */
export const WORK_LIMIT = 500;

export class Editor {
	// raw：10k 節點時深層 proxy 太貴。只由 execute() 換新物件，UI 不可直接改或 bind
	graph = $state.raw<Graph>({ nodes: [], edges: [] });
	/** 與 graph 同步的共用索引（ID 對應與鄰接） */
	index = $state.raw<GraphIndex>(buildGraphIndex(this.graph));
	/** 任何資料變更都加一（搜尋、標籤等 metadata 消費者看這個） */
	revision = $state(0);
	/** 節點／邊增刪或方向改變才加一（拓撲分析、版面看這個） */
	topologyRevision = $state(0);
	/** 最近一筆命令的變更集 */
	lastChange = $state.raw<GraphChange | null>(null);
	systems = $state<System[]>([...SYSTEMS]);
	/** 目前畫面：全圖（只讀）或編輯頁 */
	page = $state<'graph' | 'edit'>('graph');
	/** 編輯頁的節點 id */
	working = $state<string[]>([]);
	selected = $state<Selection>(null);
	result = $state<CustomerResult | null>(null);
	message = $state('');
	/** 新增邊表單（拉線時帶入起點終點） */
	draft = $state({ from: '', to: '', type: '' });
	/** 開著的對話框 */
	dialog = $state<'node' | 'edge' | 'search' | null>(null);
	/** 連線模式起點：之後點的節點即終點 */
	connecting = $state<string | null>(null);
	/** 等待確認刪除的節點 */
	armDelete = $state<string | null>(null);
	/** 檢視器清單滑過的邊，畫布上高亮 */
	hoverEdge = $state<string | null>(null);
	/** 滑過的節點，畫布上亮它的直接相連 */
	hoverNode = $state<string | null>(null);
	menu = $state<Menu | null>(null);
	/** 剛新增的節點，畫布上脈衝提示 */
	fresh = $state<string | null>(null);
	/** 畫布視野請求：Canvas 依 seq 變化縮放到 ids（空＝全部） */
	view = $state({ ids: [] as string[], seq: 0 });
	panels = $state({ left: true, right: true });
	/** 大綱只列有此問題的節點 */
	issue = $state<'unprocessed' | 'unreachable' | null>(null);
	/** 畫布角落的圖例卡 */
	legend = $state(false);
	/** 同類兄弟節點收成一疊（關掉＝全部展開） */
	stacking = $state(true);
	/** 手動展開的堆疊 key */
	expanded = $state<string[]>([]);
	/** 每加一就整張重新排版（編輯圖時既有節點不動） */
	relayout = $state(0);
	/** 編輯後才成為疊卡成員的節點：不收進疊卡，免得畫面上的卡片消失；重新排版時清掉 */
	loose = $state<string[]>([]);

	/** 全量搜尋：Worker 持有正規化快取；每筆成功命令都由 execute() 送進去 */
	readonly search: SearchService;
	/** 大綱的查詢（全圖＝全部節點；編輯頁＝只查工作區，另回全部命中給畫布淡化） */
	readonly outline: SearchController;
	/** ⌘K 快捷搜尋（永遠查全部節點）；跨頁勾選保留到主動清除 */
	readonly palette: SearchController;

	/** 預設＝正式 mock；只有量測入口會傳入其他圖。searchWorker 只給測試替換 */
	constructor(graph: Graph = Editor.initial(), opts: { searchWorker?: () => WorkerLike } = {}) {
		const s = initialGraphState(graph);
		this.graph = s.graph;
		this.index = s.index;
		this.search = new SearchService(
			{
				revision: () => this.revision,
				nodes: () => this.graph.nodes,
				issues: () => ({ unprocessed: [...this.unprocessed], unreachable: [...this.unreachable] })
			},
			opts.searchWorker ?? createSearchWorker
		);
		this.outline = new SearchController(this.search, { matches: true });
		this.palette = new SearchController(this.search);
	}

	// 拓撲分析只隨 topologyRevision 重算；改名／屬性不觸發
	unprocessed = $derived.by(() => {
		void this.topologyRevision;
		return untrack(() => unprocessed(this.graph, this.index));
	});
	unreachable = $derived.by(() => {
		void this.topologyRevision;
		return untrack(() => unreachable(this.graph, this.index));
	});

	/**
	 * 大綱篩選的全部命中（編輯頁工作區內，不只當頁）；沒在篩選、左欄收合或還沒有結果時為 null。
	 * 更新中沿用上一版命中，畫布不閃爍。
	 */
	matched = $derived.by(() => {
		const o = this.outline;
		if ((!o.text.trim() && !o.issues.length) || !this.panels.left) return null;
		return o.matches;
	});

	/** 勾選系統的節點＋通用節點；邊兩端都在畫面上才顯示（含最新名稱／屬性） */
	graphVisible = $derived(visibleIn(this.graph, this.systems));

	/**
	 * 3D 版面輸入：只隨 topologyRevision 與系統勾選變。只讀 id／type／from／to，
	 * 名稱／屬性可能是舊的，不可拿來顯示。
	 */
	layoutGraph = $derived.by(() => {
		void this.topologyRevision;
		const systems = [...this.systems];
		return untrack(() => visibleIn(this.graph, systems));
	});

	/** 編輯頁的圖：working 內的節點，邊兩端都在才留 */
	editVisible = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 只在 derived 內查詢用，不需響應
		const ids = new Set(this.working);
		return {
			nodes: this.graph.nodes.filter((n) => ids.has(n.id)),
			edges: this.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
		};
	});

	/** 加入編輯頁：只收存在的節點、去重；加完超過上限則整批擋下 */
	addToWork(ids: string[]): boolean {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 每次呼叫重算，不需響應
		const have = new Set(this.working);
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 只用來去重
		const add = [...new Set(ids)].filter((id) => this.index.nodeById.has(id) && !have.has(id));
		if (this.working.length + add.length > WORK_LIMIT)
			return this.fail(`編輯頁最多 ${WORK_LIMIT} 個節點，無法再加入 ${add.length} 個`);
		this.working = [...this.working, ...add];
		return true;
	}

	/** 切換畫面：保留仍看得到的選取，清掉只屬於上一個畫面的暫態 */
	setPage(page: 'graph' | 'edit') {
		if (page === this.page) return;
		const s = this.selected;
		const e = s?.kind === 'edge' ? this.edge(s.id) : undefined;
		const ids = s?.kind === 'edge' ? (e ? [e.from, e.to] : []) : s && this.node(s.id) ? [s.id] : [];
		// 編輯頁只留畫面上看得到的選取
		const keep =
			ids.length > 0 && (page === 'graph' || ids.every((id) => this.working.includes(id)));
		this.page = page;
		this.result = null;
		this.connecting = null;
		this.armDelete = null;
		this.menu = null;
		this.dialog = null;
		this.hoverEdge = this.hoverNode = null;
		// 問題篩選只在全圖
		if (page === 'edit') this.issue = null;
		if (!keep) this.selected = null;
		this.fit(keep && s?.kind === 'node' ? [s.id] : []);
	}

	/** 搜尋結果「加入編輯頁」：不換畫面、不改系統篩選與選取 */
	addToWorkspace(ids: string[]): boolean {
		if (!this.addToWork(ids)) return false;
		this.message = '已加入編輯頁';
		return true;
	}

	/**
	 * 搜尋結果「定位」：全圖選取並飛過去（系統隱藏也會勾回）；
	 * 編輯頁只定位工作區內的節點（不改系統篩選）
	 */
	locate(id: string) {
		if (!this.node(id)) return;
		if (this.page === 'graph') return this.reveal(id);
		if (!this.working.includes(id)) return;
		this.select({ kind: 'node', id });
		this.fit([id]);
	}

	removeFromWork(ids: string[]) {
		this.working = this.working.filter((id) => !ids.includes(id));
	}

	stacks = $derived(stacks(this.editVisible));
	/** 收起的堆疊（扣掉 loose 後仍 ≥3 個才收）：key → 收進去的成員 */
	closed = $derived(
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived 每次重建，不需響應
		new Map(
			this.stacking
				? [...this.stacks]
						.filter(([k]) => !this.expanded.includes(k))
						.map(([k, ids]) => [k, ids.filter((id) => !this.loose.includes(id))] as const)
						.filter(([, ids]) => ids.length >= STACK_MIN)
				: []
		)
	);
	/** 畫布實際畫的圖：收起的堆疊換成代表卡 */
	canvas = $derived(collapse(this.editVisible, this.closed));

	#stackKey = $derived(
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived 每次重建，不需響應
		new Map([...this.stacks].flatMap(([k, ids]) => ids.map((id) => [id, k] as const)))
	);

	/** 節點所在的堆疊 key */
	stackOf = (id: string) => this.#stackKey.get(id);

	/** 改圖；因此新進疊卡的節點留在外面 */
	#keepOut(edit: () => void) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 只做比對，不需響應
		const before = new Map(this.#stackKey);
		edit();
		for (const [id, k] of this.#stackKey) if (before.get(id) !== k) this.loose.push(id);
		// 已刪除的節點不留在 loose
		this.loose = this.loose.filter((id) => this.node(id));
	}

	/** 整張重新排版並入鏡 */
	rearrange() {
		this.loose = [];
		this.relayout++;
		this.fit();
	}

	expand(key: string) {
		if (!this.expanded.includes(key)) this.expanded.push(key);
		this.fit(this.stacks.get(key));
	}

	fold(key: string) {
		this.expanded = this.expanded.filter((k) => k !== key);
		this.select(null);
	}

	static initial(): Graph {
		const a = graphMock();
		const b = idcMock();
		return { nodes: [...a.nodes, ...b.nodes], edges: [...a.edges, ...b.edges] };
	}

	node = (id: string) => this.index.nodeById.get(id);
	edge = (id: string) => this.index.edgeById.get(id);
	/** 節點相連的邊（兩端任一） */
	incidentEdges = (id: string) => edgesOf(this.index, this.index.incident.get(id));
	incomingEdges = (id: string) => edgesOf(this.index, this.index.incoming.get(id));
	outgoingEdges = (id: string) => edgesOf(this.index, this.index.outgoing.get(id));

	select(sel: Selection) {
		this.menu = null;
		this.selected = sel;
		this.result = null;
		this.message = '';
		this.connecting = null;
		this.armDelete = null;
		// 詳情欄的邊列會在選取改變時卸載，收不到 mouseleave
		this.hoverEdge = null;
	}

	/** 縮放到指定節點；空陣列＝全部 */
	fit(ids: string[] = []) {
		this.view = { ids, seq: this.view.seq + 1 };
	}

	/** 選取並置中；節點所屬系統沒勾就順手勾上。收起的成員不展開（免得整張重排），改亮它的疊卡 */
	reveal(id: string) {
		const s = nodeType(this.node(id)!.type).system;
		if (s && !this.systems.includes(s)) this.systems.push(s);
		this.select({ kind: 'node', id });
		this.fit([id]);
	}

	/** 只看一個系統；已是唯一勾選時恢復全部 */
	solo(s: System) {
		this.systems = this.systems.length === 1 && this.systems[0] === s ? [...SYSTEMS] : [s];
	}

	/** 各邊類型對 from→to 的檢查結果（null＝可建立） */
	edgeErrors(from: string, to: string) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 每次呼叫重算，不需響應
		return new Map(
			CREATABLE_EDGE_TYPES.map((t) => [
				t.name,
				validateEdge(this.graph, from, to, t.name, this.index)
			])
		);
	}

	deleteBlock = (id: string) => checkDeleteNode(this.graph, id, this.index);

	/** 唯一的標準圖寫入入口：驗證全部欄位後一次換新 graph／index／revision；失敗時什麼都不改 */
	execute(cmd: GraphCommand): boolean {
		const r = applyCommand(
			{
				graph: this.graph,
				index: this.index,
				revision: this.revision,
				topologyRevision: this.topologyRevision
			},
			cmd
		);
		if (!r.ok) return this.fail(r.message);
		const { state, change } = r.value;
		this.#keepOut(() => {
			this.graph = state.graph;
			this.index = state.index;
			this.revision = state.revision;
			this.topologyRevision = state.topologyRevision;
			this.lastChange = change;
		});
		// 逐筆送出：同一 tick 多筆命令時 lastChange 只看得到最後一筆
		this.search.publish(change);
		return true;
	}

	/** 名稱留空時用「類型 N」；回傳新節點 id，失敗回傳 null */
	addNode(type: string, name = ''): string | null {
		const err = !type ? '請選擇類型' : nodeType(type).idc ? IDC_MESSAGE : '';
		if (err) {
			this.fail(err);
			return null;
		}
		let n = 1;
		while (!name.trim() && this.graph.nodes.some((x) => x.name === `${type} ${n}`)) n++;
		const id = uid('n');
		if (
			!this.execute({
				kind: 'addNode',
				node: { id, type, name: name.trim() || `${type} ${n}`, props: {} }
			})
		)
			return null;
		this.fresh = id;
		this.dialog = null;
		this.reveal(id);
		// 超過上限時節點照建（資料不丟），只是不自動進編輯頁；放在 reveal 後才不會被清掉提示
		this.addToWork([id]);
		return id;
	}

	startEdge(from: string, to: string) {
		const ok = [...this.edgeErrors(from, to)].filter(([, err]) => !err);
		this.draft = { from, to, type: ok.length === 1 ? ok[0][0] : '' };
		this.connecting = null;
		this.dialog = 'edge';
	}

	addEdge(from: string, to: string, type: string): boolean {
		if (!from || !to || !type) return this.fail('請選擇起點、終點與邊類型');
		const id = uid('e');
		// 編輯器手拉的邊沒有資料來源，依 PRD 定義為推定
		const edge = { id, type, from, to, bidirectional: false, props: { 確認狀態: '推定' } };
		if (!this.execute({ kind: 'addEdge', edge })) return false;
		this.draft = { from: '', to: '', type: '' };
		this.dialog = null;
		this.select({ kind: 'edge', id });
		return true;
	}

	deleteNode(id: string) {
		if (!this.execute({ kind: 'deleteNode', id })) return false;
		this.removeFromWork([id]);
		this.select(null);
	}

	deleteEdge(id: string) {
		if (!this.execute({ kind: 'deleteEdge', id })) return false;
		this.select(null);
	}

	/** 一次寫入節點草稿；base＝草稿開始時的節點，已被改過就拒絕 */
	updateNode(id: string, patch: NodePatch, base?: GNode): boolean {
		return this.execute({ kind: 'updateNode', id, patch, base });
	}

	/** 一次寫入邊草稿；base＝草稿開始時的邊，已被改過就拒絕 */
	updateEdge(id: string, patch: EdgePatch, base?: GEdge): boolean {
		return this.execute({ kind: 'updateEdge', id, patch, base });
	}

	findCustomers(id: string) {
		this.result = findCustomers(this.graph, id, this.index);
		this.fit([...this.result.nodes]);
	}

	private fail(msg: string) {
		this.message = msg;
		return false;
	}
}

/** 新增節點可選的類型：排除 IDC 維護的機框、主機、客戶 */
export const CREATABLE_NODE_TYPES = NODE_TYPES.filter((t) => !t.idc);
/** 新增邊可選的類型：排除只由 IDC 資料產生的服務、承載 */
export const CREATABLE_EDGE_TYPES = EDGE_TYPES.filter((t) => !t.idc);
