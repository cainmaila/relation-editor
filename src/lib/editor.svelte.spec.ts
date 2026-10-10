import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { Editor, WORK_LIMIT } from './editor.svelte';

describe('Editor.addNode', () => {
	it('名稱留空時用「類型 N」且不重複', () => {
		const e = new Editor();
		const a = e.addNode('攝影機')!;
		const b = e.addNode('攝影機')!;
		expect(e.node(a)!.name).toBe('攝影機 1');
		expect(e.node(b)!.name).toBe('攝影機 2');
		expect(e.selected).toEqual({ kind: 'node', id: b });
	});

	it('IDC 類型不能新增', () => {
		const e = new Editor();
		expect(e.addNode('客戶')).toBeNull();
		expect(e.message).toBe('由 IDC機櫃配置管理維護');
	});
});

describe('編輯後的收疊', () => {
	// 編輯頁只畫 working，這裡讓整張圖都在編輯頁（直接指定，繞過 500 上限）
	const full = (e: Editor) => (e.working = e.graph.nodes.map((n) => n.id));
	const cards = (e: Editor) => e.canvas.nodes.map((n) => n.id);

	it('編輯湊成新的一疊時，畫面上的卡片不收起；重新排版後才收', () => {
		const e = new Editor();
		const ids = [e.addNode('列')!, e.addNode('列')!, e.addNode('列')!];
		full(e);
		for (const id of ids) e.addEdge('A 排', id, '包含');
		expect(cards(e)).toEqual(expect.arrayContaining(ids));
		e.rearrange();
		expect(cards(e)).not.toEqual(expect.arrayContaining(ids));
	});

	it('新節點加入已收起的疊卡時留在外面', () => {
		const e = new Editor();
		const key = 'stack:機櫃 PDU:樓層 PDU 2F-A';
		full(e);
		const id = e.addNode('機櫃 PDU')!;
		e.working = [...e.working, id];
		e.addEdge('樓層 PDU 2F-A', id, '供電');
		expect(e.stackOf(id)).toBe(key);
		expect(cards(e)).toContain(id);
		expect(e.closed.get(key)).toHaveLength(44);
	});
});

describe('編輯頁 working', () => {
	const ids = (e: Editor, n: number) => e.graph.nodes.slice(0, n).map((x) => x.id);

	it('加入、去重、忽略不存在的節點', () => {
		const e = new Editor();
		const [a, b] = ids(e, 2);
		expect(e.addToWork([a, a, 'nope'])).toBe(true);
		expect(e.addToWork([a, b])).toBe(true);
		expect(e.working).toEqual([a, b]);
	});

	it('剛好 500 可，501 整批擋下且 working 不變', () => {
		const e = new Editor();
		const all = ids(e, WORK_LIMIT + 1);
		expect(e.addToWork(all.slice(0, WORK_LIMIT))).toBe(true);
		expect(e.working).toHaveLength(WORK_LIMIT);
		expect(e.addToWork(all.slice(WORK_LIMIT))).toBe(false);
		expect(e.working).toHaveLength(WORK_LIMIT);
		expect(e.message).toContain(String(WORK_LIMIT));
	});

	it('已在畫面的節點重複加入不佔上限', () => {
		const e = new Editor();
		const all = ids(e, WORK_LIMIT);
		e.addToWork(all);
		expect(e.addToWork(all)).toBe(true);
	});

	it('editVisible 的邊只留兩端都在 working 的', () => {
		const e = new Editor();
		const edge = e.graph.edges[0];
		e.addToWork([edge.from]);
		expect(e.editVisible.edges).toHaveLength(0);
		e.addToWork([edge.to]);
		expect(e.editVisible.nodes.map((n) => n.id).sort()).toEqual([edge.from, edge.to].sort());
		expect(e.editVisible.edges.map((x) => x.id)).toContain(edge.id);
		expect(
			e.editVisible.edges.every((x) => e.working.includes(x.from) && e.working.includes(x.to))
		).toBe(true);
	});

	it('addNode 自動加入 working；deleteNode 同步移出', () => {
		const e = new Editor();
		const id = e.addNode('攝影機')!;
		expect(e.working).toEqual([id]);
		e.deleteNode(id);
		expect(e.working).toEqual([]);
	});

	it('working 已滿時 addNode 仍建立節點，但不自動加入', () => {
		const e = new Editor();
		e.addToWork(ids(e, WORK_LIMIT));
		const id = e.addNode('攝影機')!;
		expect(e.node(id)).toBeTruthy();
		expect(e.working).not.toContain(id);
		expect(e.message).toContain(String(WORK_LIMIT));
	});
});

describe('Editor.setPage', () => {
	it('切頁保留仍存在的選取，清掉 result／connecting', () => {
		const e = new Editor();
		const id = e.graph.nodes[0].id;
		e.select({ kind: 'node', id });
		e.findCustomers(id);
		e.connecting = id;
		e.setPage('graph');
		expect(e.result).not.toBeNull();
		e.addToWork([id]);
		e.setPage('edit');
		expect(e.selected).toEqual({ kind: 'node', id });
		expect(e.result).toBeNull();
		expect(e.connecting).toBeNull();
	});

	it('編輯頁看不到的選取在切頁時清掉', () => {
		const e = new Editor();
		e.select({ kind: 'node', id: e.graph.nodes[0].id });
		e.setPage('edit');
		expect(e.selected).toBeNull();
	});
});

describe('Editor 初始圖', () => {
	it('預設是 mock；量測入口可傳入指定的圖', () => {
		expect(new Editor().graph.nodes.length).toBe(2066);
		const g = {
			nodes: [{ id: 'TPKC 大樓', type: '大樓', name: 'TPKC 大樓', props: {} }],
			edges: []
		};
		const e = new Editor(g);
		expect(e.graph).toBe(g);
		expect(e.unprocessed.size).toBe(0);
	});
});

describe('Editor 命令與 revision', () => {
	const AHU = '空調箱 AHU-2F-1';
	const LINK = '連線:Core Switch-1>匯聚 Switch AGG-A';

	it('節點查詢走共用索引', () => {
		const e = new Editor();
		expect(e.node(AHU)).toBe(e.index.nodeById.get(AHU));
		expect(e.edge(LINK)).toBe(e.index.edgeById.get(LINK));
	});

	it('updateNode 一次寫入名稱與屬性；只增 revision', () => {
		const e = new Editor();
		const base = e.node(AHU)!;
		const top = e.topologyRevision;
		expect(e.updateNode(AHU, { name: '空調箱 AHU-2F-01', props: { 型號: 'X' } }, base)).toBe(true);
		expect(e.node(AHU)).toMatchObject({ name: '空調箱 AHU-2F-01', props: { 型號: 'X' } });
		expect(e.revision).toBe(1);
		expect(e.topologyRevision).toBe(top);
		expect(e.lastChange?.upsertNodes.map((n) => n.id)).toEqual([AHU]);
	});

	it('任一欄位不合法時整筆不寫入，並顯示原因', () => {
		const e = new Editor();
		const before = e.graph;
		expect(e.updateEdge(LINK, { bidirectional: true, props: { 確認狀態: '亂填' } })).toBe(false);
		expect(e.graph).toBe(before);
		expect(e.revision).toBe(0);
		expect(e.message).toBe('確認狀態只能是：已確認、推定');
	});

	it('過期草稿拒絕寫入', () => {
		const e = new Editor();
		const base = e.node(AHU)!;
		e.updateNode(AHU, { name: 'A' }, base);
		expect(e.updateNode(AHU, { name: 'B' }, base)).toBe(false);
		expect(e.node(AHU)!.name).toBe('A');
	});

	it('改名不重算拓撲分析；改方向才重算', () => {
		const e = new Editor();
		const u = e.unprocessed;
		const r = e.unreachable;
		e.updateNode(AHU, { name: '改名' });
		expect(e.unprocessed).toBe(u);
		expect(e.unreachable).toBe(r);
		e.updateEdge(LINK, { bidirectional: true });
		expect(e.unprocessed).not.toBe(u);
	});

	it('改名／屬性不讓 3D 版面輸入失效（spy）', () => {
		const e = new Editor();
		const spy = vi.fn();
		const stop = $effect.root(() => {
			$effect(() => spy(e.layoutGraph));
		});
		flushSync();
		expect(spy).toHaveBeenCalledTimes(1);
		e.updateNode(AHU, { name: '改名', props: { 型號: 'X' } });
		e.updateEdge(LINK, { props: { 確認狀態: '推定' } });
		flushSync();
		expect(spy).toHaveBeenCalledTimes(1);
		// 版面輸入不帶舊名稱以外的影響；搜尋仍讀最新名稱
		expect(e.graphVisible.nodes.find((n) => n.id === AHU)!.name).toBe('改名');
		e.updateEdge(LINK, { bidirectional: true });
		flushSync();
		expect(spy).toHaveBeenCalledTimes(2);
		e.solo('電力');
		flushSync();
		expect(spy).toHaveBeenCalledTimes(3);
		stop();
	});
});
