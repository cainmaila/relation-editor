import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { Editor } from './editor.svelte';
import { WORKSPACE_NODE_LIMIT } from './model/workspace';
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
	// 編輯頁只畫 working，這裡讓整張圖都在編輯頁（直接指定，繞過預算）；收疊是手動開啟的輔助
	const full = (e: Editor) => {
		e.working = e.graph.nodes.map((n) => n.id);
		e.stacking = true;
	};
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
		const id = e.addNode('機櫃 PDU')!;
		full(e);
		e.addEdge('樓層 PDU 2F-A', id, '供電');
		expect(e.stackOf(id)).toBe(key);
		expect(cards(e)).toContain(id);
		expect(e.closed.get(key)).toHaveLength(44);
	});
});

describe('編輯頁 working', () => {
	const ids = (e: Editor, n: number) => e.graph.nodes.slice(0, n).map((x) => x.id);
	/** 互不相連的節點（避免碰到邊預算） */
	const isolated = (e: Editor, n: number) => {
		const out: string[] = [];
		const taken = new Set<string>();
		for (const x of e.graph.nodes) {
			if (out.length === n) break;
			if (e.incidentEdges(x.id).some((y) => taken.has(y.from === x.id ? y.to : y.from))) continue;
			out.push(x.id);
			taken.add(x.id);
		}
		return out;
	};
	const snapshot = (e: Editor) => ({
		graph: e.graph,
		revision: e.revision,
		working: [...e.working]
	});

	it('加入、去重；不存在的節點整批拒絕', () => {
		const e = new Editor();
		const [a, b] = ids(e, 2);
		expect(e.addToWork([a, a])).toBe(true);
		expect(e.addToWork([a, b])).toBe(true);
		expect(e.working).toEqual([a, b]);
		expect(e.addToWork(['nope'])).toBe(false);
		expect(e.working).toEqual([a, b]);
	});

	it('剛好 200 可，201 整批擋下且 working 不變；訊息含需求與可用數', () => {
		const e = new Editor();
		const all = isolated(e, WORKSPACE_NODE_LIMIT + 1);
		expect(e.addToWork(all.slice(0, 150))).toBe(true);
		const before = snapshot(e);
		expect(e.addToWork(all.slice(100))).toBe(false);
		expect(snapshot(e)).toEqual(before);
		expect(e.message).toBe('工作區最多 200 個節點：要新增 51 個，只剩 50 個名額');
		expect(e.addToWork(all.slice(150, 200))).toBe(true);
		expect(e.working).toHaveLength(WORKSPACE_NODE_LIMIT);
	});

	it('已在畫面的節點重複加入不佔上限；成功訊息含實際新增與帶入的邊數', () => {
		const e = new Editor();
		const edge = e.graph.edges[0];
		expect(e.addToWork([edge.from, edge.to])).toBe(true);
		expect(e.message).toMatch(/^已加入編輯頁：新增 2 個節點、帶入 \d+ 條邊$/);
		expect(e.addToWork([edge.from])).toBe(true);
		expect(e.message).toBe('已加入編輯頁：新增 0 個節點、帶入 0 條邊');
	});

	it('editVisible 是索引取得的誘導子圖：只留兩端都在 working 的邊', () => {
		const e = new Editor();
		const edge = e.graph.edges[0];
		e.addToWork([edge.from]);
		expect(e.editVisible.edges).toHaveLength(0);
		e.addToWork([edge.to]);
		expect(e.editVisible.nodes.map((n) => n.id).sort()).toEqual([edge.from, edge.to].sort());
		expect(e.editVisible.edges.map((x) => x.id)).toContain(edge.id);
		const set = new Set(e.working);
		const expected = e.graph.edges.filter((x) => set.has(x.from) && set.has(x.to)).map((x) => x.id);
		expect(e.editVisible.edges.map((x) => x.id).sort()).toEqual(expected.sort());
		expect(e.workspaceEdgeCount).toBe(expected.length);
	});

	it('addNode 自動加入 working；deleteNode 同步移出', () => {
		const e = new Editor();
		const id = e.addNode('攝影機')!;
		expect(e.working).toEqual([id]);
		e.deleteNode(id);
		expect(e.working).toEqual([]);
	});

	it('working 已滿時 addNode 先拒絕：圖、revision、working 完全不變', () => {
		const e = new Editor();
		e.addToWork(isolated(e, WORKSPACE_NODE_LIMIT));
		const before = snapshot(e);
		expect(e.addNode('攝影機')).toBeNull();
		expect(snapshot(e)).toEqual(before);
		expect(e.message).toBe('工作區最多 200 個節點：要新增 1 個，只剩 0 個名額');
	});

	it('移出工作區只改 membership，不刪資料；清掉失效的選取與暫態', () => {
		const e = new Editor();
		const edge = e.graph.edges.find((x) => !x.readonly && x.from !== x.to)!;
		e.addToWork([edge.from, edge.to]);
		e.setPage('edit');
		e.select({ kind: 'edge', id: edge.id });
		e.connecting = edge.from;
		e.hoverNode = edge.from;
		e.fresh = edge.from;
		const before = e.graph;
		e.removeFromWork([edge.from]);
		expect(e.graph).toEqual(before);
		expect(e.graph).toBe(before);
		expect(e.revision).toBe(0);
		expect(e.working).toEqual([edge.to]);
		expect(e.selected).toBeNull();
		expect(e.connecting).toBeNull();
		expect(e.hoverNode).toBeNull();
		expect(e.fresh).toBeNull();
		// 還在的節點選取保留
		e.select({ kind: 'node', id: edge.to });
		e.removeFromWork([edge.from]);
		expect(e.selected).toEqual({ kind: 'node', id: edge.to });
		e.clearWorkspace();
		expect(e.working).toEqual([]);
		expect(e.selected).toBeNull();
		expect(e.graph).toBe(before);
	});

	it('跨工作區建邊：缺少的端點與新邊一起 admission，一次提交', () => {
		const e = new Editor();
		e.setPage('edit');
		const from = '偵測器 SD-01';
		const to = '機櫃 A-03';
		e.addToWork([from]);
		expect(e.addEdge(from, to, '監測')).toBe(true);
		expect(e.working).toEqual([from, to]);
		expect(e.editVisible.edges.some((x) => x.from === from && x.to === to)).toBe(true);
	});

	it('跨工作區建邊：滿額或連接規則不符時，圖與 working 都不變', () => {
		const e = new Editor();
		e.setPage('edit');
		const pool = isolated(e, WORKSPACE_NODE_LIMIT + 5).filter(
			(id) => id !== '偵測器 SD-01' && id !== '機櫃 A-03'
		);
		e.addToWork(['偵測器 SD-01', ...pool.slice(0, WORKSPACE_NODE_LIMIT - 1)]);
		const before = snapshot(e);
		expect(e.addEdge('偵測器 SD-01', '機櫃 A-03', '監測')).toBe(false);
		expect(snapshot(e)).toEqual(before);
		expect(e.message).toContain('工作區最多 200 個節點');
		e.clearWorkspace();
		e.addToWork(['偵測器 SD-01']);
		const before2 = snapshot(e);
		// 監測不能連到客戶以外…這裡用 IDC 才能建的類型：被拒時不把終點加入
		expect(e.addEdge('偵測器 SD-01', '機櫃 A-03', '服務')).toBe(false);
		expect(snapshot(e)).toEqual(before2);
	});

	it('拖到空白處：新節點＋邊原子提交；不合法或滿額時什麼都不建', () => {
		const e = new Editor();
		e.setPage('edit');
		const from = 'A 排';
		e.addToWork([from]);
		const before = snapshot(e);
		// 選單只列可建立的：A 排 包含 列 可以，供電不行；新節點還不存在
		expect(e.newEdgeErrors(from, '列').get('包含')).toBeNull();
		expect(e.newEdgeErrors(from, '列').get('供電')).toBeTruthy();
		expect(e.newEdgeErrors(from, '攝影機', true).get('監測')).toBeNull();
		expect(e.graph).toBe(before.graph);
		expect(e.addNodeWithEdge('列', from, '供電')).toBeNull();
		expect(snapshot(e)).toEqual(before);
		const id = e.addNodeWithEdge('列', from, '包含')!;
		expect(e.node(id)?.type).toBe('列');
		expect(e.working).toEqual([from, id]);
		expect(e.revision).toBe(2);
		expect(e.selected?.kind).toBe('edge');
		expect(e.edge(e.selected!.id)).toMatchObject({ from, to: id, type: '包含' });
		// 反向：新節點為起點
		const back = e.addNodeWithEdge('攝影機', '機櫃 A-01', '監測', true)!;
		expect(e.working.slice(-2)).toEqual(['機櫃 A-01', back]);
		expect(e.edge(e.selected!.id)).toMatchObject({ from: back, to: '機櫃 A-01', type: '監測' });
		// 滿額：新節點＋缺少的端點放不下時什麼都不建
		e.working = isolated(e, WORKSPACE_NODE_LIMIT)
			.filter((x) => x !== '機櫃 A-02')
			.slice(0, 199);
		const full = snapshot(e);
		expect(e.addNodeWithEdge('攝影機', '機櫃 A-02', '監測', true)).toBeNull();
		expect(snapshot(e)).toEqual(full);
		expect(e.message).toBe('工作區最多 200 個節點：要新增 2 個，只剩 1 個名額');
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

	it('收疊預設關閉；手動收疊時切頁來回選取仍是同一個節點（P0 回報）', () => {
		const e = new Editor();
		expect(e.stacking).toBe(false);
		const names = ['樓層 PDU 2F-A', '機櫃 PDU A-05-A', '機櫃 PDU A-06-A', '機櫃 PDU A-07-A'];
		for (const n of names) {
			e.locate(n);
			e.addToWorkspace([n]);
		}
		e.setPage('edit');
		e.stacking = true;
		expect(e.selected).toEqual({ kind: 'node', id: names[3] });
		expect(e.canvas.owner.get(names[3])).toBeTruthy();
		e.setPage('graph');
		e.setPage('edit');
		expect(e.selected).toEqual({ kind: 'node', id: names[3] });
	});
});

describe('編輯頁版面與視野', () => {
	it('增量加入不搬動既有卡片；改名不重排；位置與視野跨切頁保留', () => {
		const e = new Editor();
		e.addToWork(['機櫃 A-01', '機櫃 PDU A-01-A']);
		e.setPage('edit');
		const p1 = new Map(e.editPositions);
		e.addToWork(['ToR Switch A-01']);
		const p2 = e.editPositions;
		for (const [id, p] of p1) expect(p2.get(id)).toEqual(p);
		expect(p2.has('ToR Switch A-01')).toBe(true);
		const lay = e.editLayout;
		e.updateNode('機櫃 A-01', { name: '改名' });
		expect(e.editLayout).toBe(lay);
		e.canvasViewport = { x: 10, y: 20, zoom: 0.5 };
		e.setPage('graph');
		e.systems = ['電力'];
		e.setPage('edit');
		expect(e.canvasViewport).toEqual({ x: 10, y: 20, zoom: 0.5 });
		expect(e.editPositions.get('機櫃 A-01')).toEqual(p2.get('機櫃 A-01'));
	});

	it('畫面外的邊不能在編輯頁被改拓撲（刪除／改方向）', () => {
		const e = new Editor();
		const edge = e.graph.edges.find((x) => !x.readonly && x.from !== x.to)!;
		e.addToWork([edge.from]);
		e.setPage('edit');
		const before = e.graph;
		expect(e.deleteEdge(edge.id)).toBe(false);
		expect(e.updateEdge(edge.id, { bidirectional: !edge.bidirectional }, edge)).toBe(false);
		expect(e.graph).toBe(before);
		expect(e.message).toBe('邊的兩端都要在編輯頁才能修改');
	});

	it('外部鄰居數量完整（不受分頁）', () => {
		const e = new Editor();
		e.addToWork(['機櫃 A-01']);
		const all = new Set(
			e.incidentEdges('機櫃 A-01').map((x) => (x.from === '機櫃 A-01' ? x.to : x.from))
		);
		expect(e.outsideCount('機櫃 A-01')).toBe(all.size);
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
			instances: 0,
			/** 下一次建立 Worker 時同步丟例外（模擬無法啟動） */
			failCreate: false,
			/** 下一則這種訊息 postMessage 同步丟例外（模擬 structured clone 失敗） */
			throwOn: null as SearchRequest['kind'] | null,
			/** 送到已結束 Worker 的訊息數；應永遠是 0 */
			deadPosts: 0,
			/** terminate 丟例外（模擬已壞掉的 Worker 收不掉） */
			throwOnTerminate: false
		};
		const create = (): WorkerLike => {
			if (f.failCreate) {
				f.failCreate = false;
				throw new Error('Worker 無法啟動');
			}
			f.instances++;
			let dead = false;
			const w: WorkerLike = {
				onmessage: null,
				onerror: null,
				postMessage(m) {
					if (dead) {
						f.deadPosts++;
						return;
					}
					if (f.throwOn === m.kind) {
						f.throwOn = null;
						throw new DOMException('could not be cloned', 'DataCloneError');
					}
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
				terminate() {
					dead = true;
					if (f.throwOnTerminate) throw new Error('terminate 失敗');
				}
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

	it('壞掉的 Worker 收不掉時明確記錄，不吞掉；仍轉錯誤且可重試', async () => {
		const { f, create } = fakeWorker();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const e = new Editor(undefined, { searchWorker: create });
		f.crash = true;
		f.throwOnTerminate = true;
		e.palette.set({ text: 'UPS' });
		await expect.poll(() => e.palette.status).toBe('error');
		expect(e.search.error).toBe('boom');
		expect(log).toHaveBeenCalledWith('搜尋 Worker 結束失敗', expect.any(Error));
		log.mockRestore();
		f.crash = f.throwOnTerminate = false;
		e.palette.retry();
		await ready(e.palette);
		expect(e.palette.total).toBeGreaterThan(0);
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

	it('邊只改屬性、無變更命令也推進 Worker 版本；穿插節點改名；不重算拓撲', async () => {
		const { f, create } = fakeWorker();
		const e = new Editor(undefined, { searchWorker: create });
		const both = async () => {
			await ready(e.palette);
			await ready(e.outline);
			expect(e.palette.revision).toBe(e.revision);
			expect(e.outline.revision).toBe(e.revision);
			expect(e.search.acked).toBe(e.revision);
		};
		e.palette.set({ text: 'UPS' });
		e.outline.set({ text: 'Switch' });
		await both();
		const topo = e.topologyRevision;
		const link = e.graph.edges.find((x) => !x.readonly)!.id;
		// 邊只改屬性：沒有節點變更、topology=false
		expect(e.updateEdge(link, { props: { 備註: 'x' } })).toBe(true);
		expect(e.lastChange).toMatchObject({ topology: false, upsertNodes: [], removeNodeIds: [] });
		expect(e.palette.status).toBe('pending');
		await both();
		// 無變更命令（空 patch）仍成功並推進 revision
		expect(e.updateEdge(link, {})).toBe(true);
		await both();
		// 同一 tick：邊、節點改名、邊
		e.updateEdge(link, { props: { 備註: 'y' } });
		e.updateNode(AHU, { name: '冷氣 Z' });
		e.updateEdge(link, {});
		await both();
		// 下一 tick 又只有邊
		e.updateEdge(link, { props: { 備註: 'z' } });
		await both();
		e.palette.set({ text: '冷氣 Z' });
		await ready(e.palette);
		expect(e.palette.ids).toEqual([AHU]);
		expect(e.topologyRevision).toBe(topo);
		const patches = f.posted.filter((m) => m.kind === 'patch');
		expect(patches.map((m) => m.revision)).toEqual([1, 2, 5, 6]);
		expect(patches.every((m) => m.kind === 'patch' && !('issues' in m))).toBe(true);
		expect(patches.find((m) => m.revision === 5)).toMatchObject({ remove: [] });
		expect(f.posted.filter((m) => m.kind === 'init')).toHaveLength(1);
	});

	it('Worker 建立時同步丟例外：不外洩，所有作用中的查詢轉錯誤，重試恢復', async () => {
		const { f, create } = fakeWorker();
		const e = new Editor(undefined, { searchWorker: create });
		f.failCreate = true;
		expect(() => e.palette.set({ text: 'UPS' })).not.toThrow();
		expect(() => e.outline.set({ text: 'Switch' })).not.toThrow();
		await expect.poll(() => e.palette.status).toBe('error');
		await expect.poll(() => e.outline.status).toBe('error');
		expect(e.search.error).toBe('Worker 無法啟動');
		expect(e.palette.error).toBe('Worker 無法啟動');
		e.palette.retry();
		await ready(e.palette);
		await ready(e.outline);
		expect(e.palette.total).toBeGreaterThan(0);
		expect(f.instances).toBe(1);
		expect(f.deadPosts).toBe(0);
	});

	it('init 送出失敗（clone）：不把查詢送到已結束的 Worker，全部轉錯誤，重試恢復', async () => {
		const { f, create } = fakeWorker();
		const e = new Editor(undefined, { searchWorker: create });
		f.throwOn = 'init';
		expect(() => e.palette.set({ text: 'UPS' })).not.toThrow();
		await expect.poll(() => e.palette.status).toBe('error');
		expect(e.palette.error).toMatch(/cloned/);
		expect(f.posted.filter((m) => m.kind === 'query')).toHaveLength(0);
		expect(f.deadPosts).toBe(0);
		e.palette.retry();
		await ready(e.palette);
		expect(f.instances).toBe(2);
		expect(e.palette.revision).toBe(e.revision);
	});

	it('查詢送出失敗：不留等待中的請求；已就緒的其他區塊也標錯誤；重試恢復', async () => {
		const { f, create } = fakeWorker();
		const e = new Editor(undefined, { searchWorker: create });
		e.outline.set({ text: 'Switch' });
		await ready(e.outline);
		f.throwOn = 'query';
		expect(() => e.palette.set({ text: 'UPS' })).not.toThrow();
		await expect.poll(() => e.palette.status).toBe('error');
		await expect.poll(() => e.outline.status).toBe('error');
		expect(f.deadPosts).toBe(0);
		// 錯誤狀態下 mutation 不會卡在 pending
		e.updateNode(AHU, { name: '錯誤中改名' });
		await expect.poll(() => e.palette.status).toBe('error');
		e.outline.retry();
		await ready(e.palette);
		await ready(e.outline);
		expect(e.palette.revision).toBe(e.revision);
		expect(f.deadPosts).toBe(0);
	});

	it('真的 Worker：邊只改屬性後查詢回到最新版本', async () => {
		const e = new Editor();
		e.palette.set({ text: '機櫃 A-01' });
		await ready(e.palette);
		const link = e.graph.edges.find((x) => !x.readonly)!.id;
		expect(e.updateEdge(link, { props: { 備註: 'only edge' } })).toBe(true);
		expect(e.palette.status).toBe('pending');
		await ready(e.palette);
		expect(e.palette.revision).toBe(e.revision);
		expect(e.search.error).toBe('');
		e.search.dispose();
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

describe('編輯頁：工作區外的定位與修改', () => {
	const edgeOf = (e: Editor) => e.graph.edges.find((x) => !x.readonly && x.from !== x.to)!;

	it('定位工作區外的節點：不再無聲忽略，明確說明且不偷偷加入', () => {
		const e = new Editor();
		const edge = edgeOf(e);
		e.addToWork([edge.from]);
		e.setPage('edit');
		e.select({ kind: 'edge', id: edge.id });
		const view = e.view.seq;
		expect(e.locate(edge.to)).toBe(false);
		expect(e.message).toBe(`「${e.node(edge.to)!.name}」不在編輯頁：先將兩端加入編輯頁才能定位`);
		expect(e.working).toEqual([edge.from]);
		expect(e.selected).toEqual({ kind: 'edge', id: edge.id });
		expect(e.view.seq).toBe(view);
		expect(e.locate(edge.from)).toBe(true);
		expect(e.selected).toEqual({ kind: 'node', id: edge.from });
	});

	it('定位已不存在的節點：明確的過期選取錯誤', () => {
		const e = new Editor();
		expect(e.locate('nope')).toBe(false);
		expect(e.message).toBe('節點已不存在：nope（選取已過期，請重新選取）');
		e.setPage('edit');
		expect(e.locate('nope')).toBe(false);
		expect(e.message).toBe('節點已不存在：nope（選取已過期，請重新選取）');
	});

	it('將兩端加入編輯頁：原子加入、保留邊選取；滿額時整批擋下不變', () => {
		const e = new Editor();
		const edge = edgeOf(e);
		e.setPage('edit');
		e.select({ kind: 'edge', id: edge.id });
		expect(e.admitEdgeEnds(edge.id)).toBe(true);
		expect(e.working).toEqual([edge.from, edge.to]);
		expect(e.selected).toEqual({ kind: 'edge', id: edge.id });
		expect(e.message).toMatch(/^已加入編輯頁：新增 2 個節點/);
		// 只剩 1 個名額：兩端都缺時整批拒絕，一個都不加
		const taken = new Set([edge.from, edge.to]);
		const pool = e.graph.nodes.map((n) => n.id).filter((id) => !taken.has(id));
		e.working = pool.slice(0, WORKSPACE_NODE_LIMIT - 1);
		const before = [...e.working];
		expect(e.admitEdgeEnds(edge.id)).toBe(false);
		expect(e.working).toEqual(before);
		expect(e.message).toBe('工作區最多 200 個節點：要新增 2 個，只剩 1 個名額');
		expect(e.admitEdgeEnds('nope')).toBe(false);
		expect(e.message).toBe('邊已不存在：nope（選取已過期，請重新選取）');
	});

	it('工作區外的節點在編輯頁不能改名或刪除；工作區內節點有外部邊仍可刪除', () => {
		const e = new Editor();
		const edge = edgeOf(e);
		e.addToWork([edge.from]);
		e.setPage('edit');
		const out = e.node(edge.to)!;
		const before = e.graph;
		expect(e.updateNode(out.id, { name: 'x' }, out)).toBe(false);
		expect(e.message).toBe('節點不在編輯頁：先加入編輯頁才能修改');
		expect(e.deleteNode(out.id)).toBe(false);
		expect(e.message).toBe('節點不在編輯頁：先加入編輯頁才能修改');
		expect(e.graph).toBe(before);
		// 工作區內的節點：外部邊不阻擋刪除
		const inside = e.graph.nodes.find(
			(n) =>
				!n.readonly &&
				!e.deleteBlock(n.id) &&
				e.incidentEdges(n.id).length > 0 &&
				!e.working.includes(n.id)
		)!;
		e.addToWork([inside.id]);
		expect(e.incidentEdges(inside.id).some((x) => !e.inWork(x.from) || !e.inWork(x.to))).toBe(true);
		expect(e.deleteNode(inside.id)).toBe(true);
		expect(e.node(inside.id)).toBeUndefined();
	});
});
