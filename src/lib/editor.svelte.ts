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

	unprocessed = $derived(unprocessed(this.graph));
	unreachable = $derived(unreachable(this.graph));

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
		this.selected = sel;
		this.result = null;
		this.message = '';
	}

	addNode(type: string, name: string): boolean {
		if (!type || !name.trim()) return this.fail('請選擇類型並填寫名稱');
		if (nodeType(type).idc) return this.fail(IDC_MESSAGE);
		const id = uid('n');
		this.graph.nodes.push({ id, type, name: name.trim(), props: {} });
		this.select({ kind: 'node', id });
		return true;
	}

	startEdge(from: string, to: string) {
		this.draft = { from, to, type: '' };
		this.message = '拉線完成，請選擇邊類型';
	}

	addEdge(from: string, to: string, type: string): boolean {
		if (!from || !to || !type) return this.fail('請選擇起點、終點與邊類型');
		const err = validateEdge(this.graph, from, to, type);
		if (err) return this.fail(err);
		const id = uid('e');
		this.graph.edges.push({ id, type, from, to, bidirectional: false, props: {} });
		this.draft = { from: '', to: '', type: '' };
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
