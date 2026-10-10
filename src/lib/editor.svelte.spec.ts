import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { Editor, WORK_LIMIT } from './editor.svelte';
import { handleSearchMessage, type SearchRequest } from './search/protocol';
import type { SearchController, WorkerLike } from './search/search-client.svelte';
import { SearchStore } from './search/search-index';

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

describe('Editor 搜尋服務（Worker 協定）', () => {
	const AHU = '空調箱 AHU-2F-1';
	type Reply = () => void;
	/** 同協定的假 Worker：訊息 structuredClone（驗證純資料），回覆可暫扣以模擬亂序 */
	function fakeWorker() {
		const store = new SearchStore();
		const f = {
			posted: [] as SearchRequest[],
			hold: false,
			held: [] as Reply[],
			crash: false,
			instances: 0
		};
		const create = (): WorkerLike => {
			f.instances++;
			const w: WorkerLike = {
				onmessage: null,
				onerror: null,
				postMessage(m) {
					const msg = structuredClone(m);
					f.posted.push(msg);
					// 真 Worker 依序處理：回覆內容在送出時就決定，只是延後送達
					const data = handleSearchMessage(store, msg);
					const reply = () => {
						if (f.crash) return w.onerror?.(new ErrorEvent('error', { message: 'boom' }));
						w.onmessage?.(new MessageEvent('message', { data }));
					};
					if (f.hold) f.held.push(reply);
					else setTimeout(reply);
				},
				terminate() {}
			};
			return w;
		};
		return { f, create };
	}
	const ready = (c: SearchController) => expect.poll(() => c.status).toBe('ready');

	it('同一 tick 兩筆命令都送進 Worker；結果反映兩筆', async () => {
		const { f, create } = fakeWorker();
		const e = new Editor(undefined, { searchWorker: create });
		const PDU = '機櫃 PDU A-01-A';
		const victim = '機櫃 PDU A-01-B';
		e.palette.set({ text: '機櫃 PDU' });
		await ready(e.palette);
		const before = e.palette.total;
		expect(e.palette.ids).toContain(victim);
		// 兩筆同步命令：lastChange 只剩最後一筆，服務仍須收到兩筆
		e.updateNode(PDU, { name: '改名冷氣' });
		e.execute({ kind: 'deleteNode', id: victim });
		expect(e.lastChange?.removeNodeIds).toEqual([victim]);
		expect(e.palette.status).toBe('pending');
		await ready(e.palette);
		expect(e.palette.revision).toBe(e.revision);
		// 改名後仍以類型命中；刪掉的不再出現
		expect(e.palette.total).toBe(before - 1);
		expect(e.palette.ids).not.toContain(victim);
		e.palette.set({ text: '改名冷氣' });
		await ready(e.palette);
		expect(e.palette.ids).toEqual([PDU]);
		const patches = f.posted.filter((m) => m.kind === 'patch');
		expect(patches).toHaveLength(1);
		expect(patches[0]).toMatchObject({ revision: 2, remove: [victim] });
		// 刪節點是拓撲變更：同一 patch 帶新的問題 ID sets
		expect(patches[0].kind === 'patch' && patches[0].issues).toBeTruthy();
	});

	it('改名只送 metadata，不帶問題 ID sets（不重算拓撲分析）', async () => {
		const { f, create } = fakeWorker();
		const e = new Editor(undefined, { searchWorker: create });
		e.palette.set({ text: AHU });
		await ready(e.palette);
		e.updateNode(AHU, { name: 'X', props: { 型號: 'Y' } });
		await ready(e.palette);
		const p = f.posted.find((m) => m.kind === 'patch')!;
		expect(p).toMatchObject({ kind: 'patch', revision: 1, remove: [] });
		expect('issues' in p).toBe(false);
	});

	it('過期回覆不覆蓋最新結果；各 UI 區塊的查詢互不覆蓋', async () => {
		const { f, create } = fakeWorker();
		const e = new Editor(undefined, { searchWorker: create });
		f.hold = true;
		e.palette.set({ text: 'UPS' });
		e.palette.set({ text: '攝影機' });
		e.outline.set({ text: 'Switch' });
		// 倒序放行：最舊的回覆最後到
		for (const r of f.held.reverse()) r();
		f.hold = false;
		await ready(e.palette);
		await ready(e.outline);
		expect(e.palette.text).toBe('攝影機');
		const hit = (id: string, re: RegExp) => re.test(`${e.node(id)!.name} ${e.node(id)!.type}`);
		expect(e.palette.ids.length).toBeGreaterThan(0);
		expect(e.palette.ids.every((id) => hit(id, /攝影機/))).toBe(true);
		expect(e.outline.ids.length).toBeGreaterThan(0);
		expect(e.outline.ids.every((id) => hit(id, /switch/i))).toBe(true);
	});

	it('資料版本變更後，舊版本的回覆不標成最新', async () => {
		const { f, create } = fakeWorker();
		const e = new Editor(undefined, { searchWorker: create });
		e.palette.set({ text: AHU });
		await ready(e.palette);
		f.hold = true;
		e.palette.goto(0);
		const old = f.held.splice(0);
		e.updateNode(AHU, { name: '新名稱' });
		old.forEach((r) => r());
		expect(e.palette.status).toBe('pending');
		f.hold = false;
		await Promise.resolve();
		f.held.splice(0).forEach((r) => r());
		await ready(e.palette);
		expect(e.palette.revision).toBe(1);
		e.palette.set({ text: '新名稱' });
		await ready(e.palette);
		expect(e.palette.ids).toEqual([AHU]);
	});

	it('版本不連續時整份重建', async () => {
		const { f, create } = fakeWorker();
		const e = new Editor(undefined, { searchWorker: create });
		e.palette.set({ text: '' });
		await ready(e.palette);
		e.search.publish({
			revision: e.revision + 5,
			topologyRevision: 0,
			topology: false,
			upsertNodes: [],
			removeNodeIds: [],
			upsertEdges: [],
			removeEdgeIds: []
		});
		await ready(e.palette);
		expect(f.posted.filter((m) => m.kind === 'init')).toHaveLength(2);
	});

	it('Worker 錯誤時顯示錯誤，重試後重建並恢復', async () => {
		const { f, create } = fakeWorker();
		const e = new Editor(undefined, { searchWorker: create });
		f.crash = true;
		e.palette.set({ text: 'UPS' });
		await expect.poll(() => e.palette.status).toBe('error');
		expect(e.search.error).toBe('boom');
		f.crash = false;
		e.palette.retry();
		await ready(e.palette);
		expect(e.palette.total).toBeGreaterThan(0);
		expect(f.instances).toBe(2);
	});

	it('跨頁勾選保留到主動清除；刪除節點時移出', async () => {
		const { create } = fakeWorker();
		const e = new Editor(undefined, { searchWorker: create });
		e.palette.set({ text: '' });
		await ready(e.palette);
		const a = e.palette.ids[0];
		e.palette.toggle(a);
		e.palette.goto(50);
		await ready(e.palette);
		const b = e.palette.ids[0];
		e.palette.toggle(b);
		e.palette.set({ text: 'zzz' });
		expect(e.palette.picked).toEqual([a, b]);
		const c = e.addNode('攝影機')!;
		e.palette.toggle(c);
		e.deleteNode(c);
		expect(e.palette.picked).toEqual([a, b]);
		e.palette.clearPicked();
		expect(e.palette.picked).toEqual([]);
	});

	it('加入工作區不改系統篩選、不換畫面', () => {
		const e = new Editor(undefined, { searchWorker: fakeWorker().create });
		e.systems = ['電力'];
		expect(e.addToWorkspace([AHU, '機櫃 A-01'])).toBe(true);
		expect(e.working).toEqual([AHU, '機櫃 A-01']);
		expect(e.systems).toEqual(['電力']);
		expect(e.page).toBe('graph');
		expect(e.selected).toBeNull();
	});

	it('定位可穿越系統隱藏', () => {
		const e = new Editor(undefined, { searchWorker: fakeWorker().create });
		e.systems = ['電力'];
		e.locate(AHU);
		expect(e.systems).toContain('空調');
		expect(e.selected).toEqual({ kind: 'node', id: AHU });
	});

	it('編輯頁大綱只查工作區，畫布淡化用全部命中（不只當頁）', async () => {
		const e = new Editor(undefined, { searchWorker: fakeWorker().create });
		const many = e.graph.nodes
			.filter((n) => n.type === '機櫃 PDU')
			.slice(0, 120)
			.map((n) => n.id);
		expect(e.addToWork([...many, AHU])).toBe(true);
		e.setPage('edit');
		e.outline.set({ text: 'PDU', within: e.working });
		await ready(e.outline);
		expect(many.length).toBeGreaterThan(50);
		expect(e.outline.ids).toHaveLength(50);
		expect(e.matched?.size).toBe(many.length);
		expect(e.matched?.has(AHU)).toBe(false);
	});

	it('真的 Worker：草稿 proxy 屬性也能送出，查得到改後內容', async () => {
		const e = new Editor();
		e.palette.set({ text: '機櫃 A-01' });
		await ready(e.palette);
		expect(e.palette.ids[0]).toBe('機櫃 A-01');
		const draft = $state({ 型號: '特殊型號 Q9' });
		e.updateNode('機櫃 A-01', { props: draft });
		e.palette.set({ text: '特殊型號' });
		await ready(e.palette);
		expect(e.palette.ids).toEqual(['機櫃 A-01']);
		expect(e.search.error).toBe('');
		e.search.dispose();
	});
});
