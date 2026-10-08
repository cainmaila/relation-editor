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
	findCustomers,
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

	unprocessed = $derived(unprocessed(this.graph));
	unreachable = $derived(unreachable(this.graph));

	/** 大綱篩選命中的節點；沒在篩選或左欄收合時為 null（收合時看不到篩選，不淡化畫布） */
	matched = $derived.by(() => {
		const k = this.query.trim().toLowerCase();
		const i = this.issue;
		if ((!k && !i) || !this.panels.left) return null;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived 每次重建，不需響應
		return new Set(
			this.graph.nodes
				.filter((n) => (!k || n.name.toLowerCase().includes(k)) && (!i || this[i].has(n.id)))
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
	}

	/** 縮放到指定節點；空陣列＝全部 */
	fit(ids: string[] = []) {
		this.view = { ids, seq: this.view.seq + 1 };
	}

	/** 選取並置中；節點所屬系統沒勾就順手勾上 */
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
		this.graph.nodes.push({ id, type, name: name.trim() || `${type} ${n}`, props: {} });
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
		this.graph.edges.push({ id, type, from, to, bidirectional: false, props: {} });
		this.draft = { from: '', to: '', type: '' };
		this.dialog = null;
		this.select({ kind: 'edge', id });
		return true;
	}

	deleteNode(id: string) {
		const err = checkDeleteNode(this.graph, id);
		if (err) return this.fail(err);
		this.graph.edges = this.graph.edges.filter((e) => e.from !== id && e.to !== id);
		this.graph.nodes = this.graph.nodes.filter((n) => n.id !== id);
		this.select(null);
	}

	deleteEdge(id: string) {
		if (this.edge(id)?.readonly) return this.fail(IDC_MESSAGE);
		this.graph.edges = this.graph.edges.filter((e) => e.id !== id);
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
