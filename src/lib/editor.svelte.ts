// 編輯器狀態：圖（mock 初始值，不存檔）、系統勾選、選取、找客戶結果。
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
import { graphMock, idcMock } from './model/mock';
import type { Graph } from './model/types';

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

export class Editor {
	graph = $state<Graph>(Editor.initial());
	systems = $state<System[]>([...SYSTEMS]);
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
	/** 大綱篩選文字 */
	query = $state('');
	/** 同類兄弟節點收成一疊（關掉＝全部展開） */
	stacking = $state(true);
	/** 手動展開的堆疊 key */
	expanded = $state<string[]>([]);
	/** 每加一就整張重新排版（編輯圖時既有節點不動） */
	relayout = $state(0);
	/** 編輯後才成為疊卡成員的節點：不收進疊卡，免得畫面上的卡片消失；重新排版時清掉 */
	loose = $state<string[]>([]);

	unprocessed = $derived(unprocessed(this.graph));
	unreachable = $derived(unreachable(this.graph));

	/** 大綱篩選命中的節點；沒在篩選或左欄收合時為 null（收合時看不到篩選，不淡化畫布） */
	/** 名稱是否符合搜尋文字（沒輸入＝符合） */
	byText = (name: string) => name.toLowerCase().includes(this.query.trim().toLowerCase());
	matched = $derived.by(() => {
		const k = this.query.trim().toLowerCase();
		const i = this.issue;
		if ((!k && !i) || !this.panels.left) return null;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived 每次重建，不需響應
		return new Set(
			this.graph.nodes
				.filter((n) => (!k || this.byText(n.name)) && (!i || this[i].has(n.id)))
				.map((n) => n.id)
		);
	});

	/** 勾選系統的節點＋通用節點；邊兩端都在畫面上才顯示 */
	visible = $derived.by(() => {
		const nodes = this.graph.nodes.filter((n) => {
			const s = nodeType(n.type).system;
			return s === null || this.systems.includes(s);
		});
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- 只在 derived 內查詢用，不需響應
		const ids = new Set(nodes.map((n) => n.id));
		return { nodes, edges: this.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
	});

	stacks = $derived(stacks(this.visible));
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
	canvas = $derived(collapse(this.visible, this.closed));

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

	node = (id: string) => this.graph.nodes.find((n) => n.id === id);
	edge = (id: string) => this.graph.edges.find((e) => e.id === id);

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
			CREATABLE_EDGE_TYPES.map((t) => [t.name, validateEdge(this.graph, from, to, t.name)])
		);
	}

	deleteBlock = (id: string) => checkDeleteNode(this.graph, id);

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
		this.#keepOut(() =>
			this.graph.nodes.push({ id, type, name: name.trim() || `${type} ${n}`, props: {} })
		);
		this.fresh = id;
		this.dialog = null;
		this.reveal(id);
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
		const err = validateEdge(this.graph, from, to, type);
		if (err) return this.fail(err);
		const id = uid('e');
		// 編輯器手拉的邊沒有資料來源，依 PRD 定義為推定
		this.#keepOut(() =>
			this.graph.edges.push({
				id,
				type,
				from,
				to,
				bidirectional: false,
				props: { 確認狀態: '推定' }
			})
		);
		this.draft = { from: '', to: '', type: '' };
		this.dialog = null;
		this.select({ kind: 'edge', id });
		return true;
	}

	deleteNode(id: string) {
		const err = checkDeleteNode(this.graph, id);
		if (err) return this.fail(err);
		this.#keepOut(() => {
			this.graph.edges = this.graph.edges.filter((e) => e.from !== id && e.to !== id);
			this.graph.nodes = this.graph.nodes.filter((n) => n.id !== id);
		});
		this.select(null);
	}

	deleteEdge(id: string) {
		if (this.edge(id)?.readonly) return this.fail(IDC_MESSAGE);
		this.#keepOut(() => (this.graph.edges = this.graph.edges.filter((e) => e.id !== id)));
		this.select(null);
	}

	findCustomers(id: string) {
		this.result = findCustomers(this.graph, id);
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
