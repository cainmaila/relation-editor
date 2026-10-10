// 編輯器狀態：圖（mock 初始值，不存檔）、系統勾選、選取、找客戶追查。
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
	layout,
	pin,
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
	externalNeighbors,
	inducedSubgraph,
	planWorkspaceAdmission,
	type Proposed,
	type WorkspaceAdmission
} from './model/workspace';
import {
	SearchController,
	SearchService,
	createSearchWorker,
	type WorkerLike
} from './search/search-client.svelte';
import { UniverseRuntime, type LayoutWorkerLike, type Topology } from './universe/runtime';

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

/** 編輯頁畫布視野（平移與縮放） */
export type Viewport = { x: number; y: number; zoom: number };

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
	/**
	 * 找客戶追查：只記起點與開始時的拓撲版本。結果不另存，由完整標準圖算出（見 result），
	 * 選取其他節點／關係不清掉；只有「清除」、Esc、換起點或刪掉起點才結束
	 */
	trace = $state<{ source: string; topologyRevision: number } | null>(null);
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
	/** 同類兄弟節點收成一疊（關掉＝全部展開）；預設關閉，由使用者手動開啟 */
	stacking = $state(false);
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
	/**
	 * 3D 宇宙的 session runtime：ID→xyz、layout Worker、相機。與 GraphView 掛載分離，
	 * 只隨拓撲（topologyRevision）reconcile；改名、篩選、選取、切頁都不碰它
	 */
	readonly universe: UniverseRuntime;

	/** 預設＝正式 mock；只有量測入口會傳入其他圖。searchWorker／layoutWorker 只給測試替換 */
	constructor(
		graph: Graph = Editor.initial(),
		opts: { searchWorker?: () => WorkerLike; layoutWorker?: () => LayoutWorkerLike } = {}
	) {
		const s = initialGraphState(graph);
		this.graph = s.graph;
		this.index = s.index;
		this.universe = new UniverseRuntime({ createWorker: opts.layoutWorker });
		this.#syncUniverse();
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

	/**
	 * 找客戶結果：沿完整標準圖（不看工作區、系統勾選、LOD），只隨 topologyRevision 同步重算，
	 * 所以不會把舊拓撲的結果當成最新（10k／100k 實測遠低於 500 ms，不需 Worker）。
	 * 改名／屬性不重算；名稱由 UI 依 ID 即時讀取。編輯頁不顯示（PRD：找客戶只在全圖），追查暫停不丟
	 */
	result = $derived.by((): CustomerResult | null => {
		void this.topologyRevision;
		const t = this.trace;
		if (!t || this.page !== 'graph') return null;
		return untrack(() =>
			this.node(t.source) ? findCustomers(this.graph, t.source, this.index) : null
		);
	});
	/** 目前結果對應的拓撲版本（同步重算＝永遠是最新版本）；沒有結果為 null */
	traceRevision = $derived(this.result ? this.topologyRevision : null);
	/** 開始追查後拓撲已改變：結果已依最新資料重算，UI 要明講 */
	traceChanged = $derived(
		!!this.result && !!this.trace && this.trace.topologyRevision !== this.topologyRevision
	);

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
	 * 3D 繪製輸入（可見子圖）：只隨 topologyRevision 與系統勾選變。只讀 id／type／from／to，
	 * 名稱／屬性可能是舊的，不可拿來顯示。版面座標不在這裡算：篩選只換繪製子集合
	 */
	sceneGraph = $derived.by(() => {
		void this.topologyRevision;
		const systems = [...this.systems];
		return untrack(() => visibleIn(this.graph, systems));
	});

	/** 編輯頁的圖：working 的誘導子圖（索引取得，只留兩端都在 working 的真實邊） */
	editVisible = $derived(inducedSubgraph(this.index, this.working));
	/** 工作區的原始誘導邊數（收疊、合併呈現都不降低） */
	workspaceEdgeCount = $derived(this.editVisible.edges.length);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived 每次重建，不需響應
	#workSet = $derived(new Set(this.working));
	/** 不在工作區的直接鄰居數（完整，不受分頁） */
	outsideCount = (id: string) => externalNeighbors(this.index, id, this.#workSet).length;
	/** 是否在工作區 */
	inWork = (id: string) => this.#workSet.has(id);

	/** 加入前的 admission（純計算）；失敗時顯示原因，什麼都不改 */
	#admit(ids: string[], proposed?: Proposed): WorkspaceAdmission | null {
		const r = planWorkspaceAdmission(this.index, this.working, ids, proposed);
		if (r.ok) return r.value;
		this.fail(r.message);
		return null;
	}

	/** 加入編輯頁：整批 admission（存在、去重、200 節點／1,000 條邊預算），通過才一次提交 */
	addToWork(ids: string[]): boolean {
		const a = this.#admit(ids);
		if (!a) return false;
		this.working = a.ids;
		this.message = `已加入編輯頁：新增 ${a.addedIds.length} 個節點、帶入 ${a.addedEdgeCount} 條邊`;
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
		this.connecting = null;
		this.armDelete = null;
		this.menu = null;
		this.dialog = null;
		this.hoverEdge = this.hoverNode = null;
		// 問題篩選只在全圖
		if (page === 'edit') this.issue = null;
		// 視野不重設：編輯頁沿用上次的位置與縮放（第一次進入由畫布整張入鏡）
		if (!keep) this.selected = null;
	}

	/** 搜尋結果「加入編輯頁」：不換畫面、不改系統篩選與選取 */
	addToWorkspace(ids: string[]): boolean {
		return this.addToWork(ids);
	}

	/** 明確的「加入並定位」：先 admission 加入，成功才定位；失敗什麼都不改 */
	admitAndLocate(id: string): boolean {
		if (!this.addToWork([id])) return false;
		const msg = this.message;
		this.locate(id);
		this.message = msg;
		return true;
	}

	/**
	 * 搜尋結果「定位」：全圖選取並飛過去（系統隱藏也會勾回）；
	 * 編輯頁只定位工作區內的節點（不改系統篩選、不偷偷加入），工作區外的明確說明。
	 * 節點已不存在＝過期選取，明確報錯
	 */
	locate(id: string): boolean {
		const n = this.node(id);
		if (!n) return this.fail(`節點已不存在：${id}（選取已過期，請重新選取）`);
		if (this.page === 'graph') {
			this.reveal(id);
			return true;
		}
		if (!this.inWork(id)) return this.fail(`「${n.name}」不在編輯頁：先將兩端加入編輯頁才能定位`);
		this.select({ kind: 'node', id });
		this.fit([id]);
		return true;
	}

	/** 「將兩端加入編輯頁」：邊的兩端整批 admission（200／1,000 預算），保留邊選取；失敗什麼都不改 */
	admitEdgeEnds(id: string): boolean {
		const e = this.edge(id);
		if (!e) return this.fail(`邊已不存在：${id}（選取已過期，請重新選取）`);
		return this.addToWork([e.from, e.to]);
	}

	/** 移出工作區：只改 membership，不刪資料；清掉指向已移出節點的選取與暫態 */
	removeFromWork(ids: string[]) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 區域查表，不需響應
		const out = new Set(ids);
		this.working = this.working.filter((id) => !out.has(id));
		const gone = (id: string | null) => !!id && out.has(id);
		const s = this.selected;
		const e = s?.kind === 'edge' ? this.edge(s.id) : undefined;
		if (
			this.page === 'edit' &&
			(gone(s?.kind === 'node' ? s.id : null) || (e && (gone(e.from) || gone(e.to))))
		)
			this.select(null);
		if (gone(this.connecting)) this.connecting = null;
		if (gone(this.hoverNode)) this.hoverNode = null;
		if (gone(this.fresh)) this.fresh = null;
		if (gone(this.armDelete)) this.armDelete = null;
		if (this.menu?.kind === 'node' && gone(this.menu.id)) this.menu = null;
		this.loose = this.loose.filter((id) => !out.has(id));
	}

	/** 清空工作區（不刪任何資料） */
	clearWorkspace() {
		this.removeFromWork([...this.working]);
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

	/** 收疊形狀（字串比對）：改名／屬性重建 closed 時不讓版面失效 */
	#shape = $derived([...this.closed].map(([k, ids]) => `${k}:${ids.join(',')}`).join('|'));
	/**
	 * 編輯頁排版：只隨拓撲、工作區成員與收疊形狀變；改名／屬性不重排。
	 * 只讀 id／type／from／to。放在 Editor（不在 Canvas）：切到 3D 卸載畫布後回來仍沿用
	 */
	editLayout = $derived.by(() => {
		void [this.topologyRevision, this.working, this.#shape];
		return untrack(() => layout(this.canvas));
	});
	/** 檢視操作（收疊、展開、重新排版）才整張重排；系統勾選不影響編輯頁 */
	#viewKey = $derived(
		[
			// 疊卡消失時的過期 key 清除不算檢視操作
			this.expanded.filter((k) => this.stacks.has(k)).join(),
			this.stacking,
			this.relayout
		].join('/')
	);
	#lastPos: { key: string; pos: ReturnType<typeof layout>['pos'] } | undefined;
	/** 卡片位置：增量加入時既有卡片留在原位（刻意在 derived 內記住上次結果，非響應） */
	editPositions = $derived.by(() => {
		const lay = this.editLayout;
		const key = this.#viewKey;
		const last = this.#lastPos;
		const pos = last?.key === key ? pin(last.pos, lay.pos) : lay.pos;
		this.#lastPos = { key, pos };
		return pos;
	});
	/** 編輯頁視野；null＝還沒進過，畫布第一次掛載時整張入鏡 */
	canvasViewport = $state.raw<Viewport | null>(null);

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
		this.#showSystemOf(id);
		this.select({ kind: 'node', id });
		this.fit([id]);
	}

	/** 系統沒勾就順手勾上（定位、聚焦關係用） */
	#showSystemOf(id: string) {
		const s = nodeType(this.node(id)!.type).system;
		if (s && !this.systems.includes(s)) this.systems.push(s);
	}

	/**
	 * 追查清單點一條關係：保留追查，單獨選取並亮這條邊、鏡頭對準兩端；
	 * 端點所屬系統沒勾就勾回（畫面看得到才算定位）
	 */
	focusEdge(id: string): boolean {
		const e = this.edge(id);
		if (!e) return this.fail(`邊已不存在：${id}（選取已過期，請重新選取）`);
		this.#showSystemOf(e.from);
		this.#showSystemOf(e.to);
		this.select({ kind: 'edge', id });
		this.fit([e.from, e.to]);
		return true;
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

	/**
	 * 拖到空白處：other 與「type 類型的新節點」之間各邊類型的檢查結果（null＝可建立）。
	 * reverse＝新節點為起點。新節點還沒建立，用只含兩端的暫時索引驗證
	 */
	newEdgeErrors(other: string, type: string, reverse = false) {
		const NEW = '#new';
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 暫時驗證索引，不需響應
		const nodeById = new Map([[NEW, { id: NEW, type, name: '', props: {} } as GNode]]);
		const o = this.node(other);
		if (o) nodeById.set(other, o);
		const idx = { ...this.index, nodeById };
		const [from, to] = reverse ? [NEW, other] : [other, NEW];
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 每次呼叫重算，不需響應
		return new Map(
			CREATABLE_EDGE_TYPES.map((t) => [t.name, validateEdge(this.graph, from, to, t.name, idx)])
		);
	}

	deleteBlock = (id: string) => checkDeleteNode(this.graph, id, this.index);

	/**
	 * 唯一的標準圖寫入入口：依序純計算全部命令，全部通過才一次換新 graph／index／revision；
	 * 任一筆失敗時什麼都不改（多筆＝原子批次，例：新節點＋邊）
	 */
	execute(...cmds: GraphCommand[]): boolean {
		let state = {
			graph: this.graph,
			index: this.index,
			revision: this.revision,
			topologyRevision: this.topologyRevision
		};
		const changes: GraphChange[] = [];
		for (const cmd of cmds) {
			const r = applyCommand(state, cmd);
			if (!r.ok) return this.fail(r.message);
			state = r.value.state;
			changes.push(r.value.change);
		}
		this.#keepOut(() => {
			this.graph = state.graph;
			this.index = state.index;
			this.revision = state.revision;
			this.topologyRevision = state.topologyRevision;
			this.lastChange = changes.at(-1) ?? null;
		});
		// 逐筆送出：Worker 依版本連續套用
		for (const c of changes) this.search.publish(c);
		this.#syncUniverse();
		return true;
	}

	/** 拓撲變了才 reconcile 3D 座標（runtime 依 topologyRevision 自行略過相同版本） */
	#syncUniverse() {
		const g = this.graph;
		const idx = this.index;
		const t: Topology = {
			ids: g.nodes.map((n) => n.id),
			edges: g.edges,
			*neighbors(id) {
				for (const e of edgesOf(idx, idx.incident.get(id))) yield e.from === id ? e.to : e.from;
			}
		};
		this.universe.sync(t, this.topologyRevision);
	}

	/** 新節點草稿：名稱留空時用「類型 N」；類型不可建立時回傳 null 並顯示原因 */
	#draftNode(type: string, name = ''): GNode | null {
		const err = !type ? '請選擇類型' : nodeType(type).idc ? IDC_MESSAGE : '';
		if (err) {
			this.fail(err);
			return null;
		}
		let n = 1;
		while (!name.trim() && this.graph.nodes.some((x) => x.name === `${type} ${n}`)) n++;
		return { id: uid('n'), type, name: name.trim() || `${type} ${n}`, props: {} };
	}

	/** 編輯器手拉的邊沒有資料來源，依 PRD 定義為推定 */
	#draftEdge = (from: string, to: string, type: string): GEdge => ({
		id: uid('e'),
		type,
		from,
		to,
		bidirectional: false,
		props: { 確認狀態: '推定' }
	});

	/** 編輯頁只能改兩端都在工作區的邊（畫面外的拓撲不能被悄悄修改） */
	#guardEdge(id: string): boolean {
		const e = this.edge(id);
		if (this.page !== 'edit' || !e || (this.inWork(e.from) && this.inWork(e.to))) return true;
		return this.fail('邊的兩端都要在編輯頁才能修改');
	}

	/** 編輯頁只能改工作區內的節點（經其他路徑選到的工作區外節點唯讀，直到加入） */
	#guardNode(id: string): boolean {
		if (this.page !== 'edit' || !this.node(id) || this.inWork(id)) return true;
		return this.fail('節點不在編輯頁：先加入編輯頁才能修改');
	}

	/** 名稱留空時用「類型 N」；工作區 admission 通過才建立並加入，回傳新節點 id，失敗回傳 null */
	addNode(type: string, name = ''): string | null {
		const node = this.#draftNode(type, name);
		if (!node) return null;
		const a = this.#admit([], { newNodes: 1 });
		if (!a || !this.execute({ kind: 'addNode', node })) return null;
		this.working = [...a.ids, node.id];
		this.fresh = node.id;
		this.dialog = null;
		this.reveal(node.id);
		return node.id;
	}

	/**
	 * 拖到空白處：新節點＋一條邊原子提交（reverse＝新節點為起點）。
	 * 另一端不在工作區時一起 admission；連接規則、預算任一不符就什麼都不建
	 */
	addNodeWithEdge(type: string, other: string, edgeType: string, reverse = false): string | null {
		if (!edgeType) {
			this.fail('請選擇邊類型');
			return null;
		}
		const node = this.#draftNode(type);
		if (!node) return null;
		const a = this.#admit([other], { newNodes: 1, newEdges: 1 });
		if (!a) return null;
		const edge = reverse
			? this.#draftEdge(node.id, other, edgeType)
			: this.#draftEdge(other, node.id, edgeType);
		if (!this.execute({ kind: 'addNode', node }, { kind: 'addEdge', edge })) return null;
		this.working = [...a.ids, node.id];
		this.fresh = node.id;
		this.dialog = null;
		this.menu = null;
		this.select({ kind: 'edge', id: edge.id });
		return node.id;
	}

	startEdge(from: string, to: string) {
		const ok = [...this.edgeErrors(from, to)].filter(([, err]) => !err);
		this.draft = { from, to, type: ok.length === 1 ? ok[0][0] : '' };
		this.connecting = null;
		this.dialog = 'edge';
	}

	/** 編輯頁建邊：不在工作區的端點與新邊一起 admission，連接規則與預算都通過才一次提交 */
	addEdge(from: string, to: string, type: string): boolean {
		if (!from || !to || !type) return this.fail('請選擇起點、終點與邊類型');
		const err = validateEdge(this.graph, from, to, type, this.index);
		if (err) return this.fail(err);
		const a = this.page === 'edit' ? this.#admit([from, to], { newEdges: 1 }) : null;
		if (this.page === 'edit' && !a) return false;
		const edge = this.#draftEdge(from, to, type);
		if (!this.execute({ kind: 'addEdge', edge })) return false;
		if (a) this.working = a.ids;
		this.draft = { from: '', to: '', type: '' };
		this.dialog = null;
		this.select({ kind: 'edge', id: edge.id });
		return true;
	}

	/** 真正刪除資料（含所有相連邊，工作區外的也會刪）；與「移出工作區」不同 */
	deleteNode(id: string) {
		if (!this.#guardNode(id) || !this.execute({ kind: 'deleteNode', id })) return false;
		this.removeFromWork([id]);
		this.select(null);
		if (this.trace?.source === id) {
			this.trace = null;
			this.message = '追查起點已刪除，找客戶結果已清除';
		}
		return true;
	}

	deleteEdge(id: string) {
		if (!this.#guardEdge(id) || !this.execute({ kind: 'deleteEdge', id })) return false;
		this.select(null);
		return true;
	}

	/** 一次寫入節點草稿；base＝草稿開始時的節點，已被改過就拒絕 */
	updateNode(id: string, patch: NodePatch, base?: GNode): boolean {
		return this.#guardNode(id) && this.execute({ kind: 'updateNode', id, patch, base });
	}

	/** 一次寫入邊草稿；base＝草稿開始時的邊，已被改過就拒絕 */
	updateEdge(id: string, patch: EdgePatch, base?: GEdge): boolean {
		return this.#guardEdge(id) && this.execute({ kind: 'updateEdge', id, patch, base });
	}

	/** 全圖：選取起點並開始追查（換掉上一個追查），鏡頭對準完整結果 */
	findCustomers(id: string) {
		if (this.page !== 'graph' || !this.node(id)) return;
		this.select({ kind: 'node', id });
		this.trace = { source: id, topologyRevision: this.topologyRevision };
		this.fit([...this.result!.nodes]);
	}

	/** 結束追查（清除按鈕、Esc） */
	clearTrace() {
		this.trace = null;
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
