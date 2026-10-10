import { describe, expect, it } from 'vitest';
import {
	applyCommand,
	initialGraphState,
	type GraphCommand,
	type GraphState
} from './graph-change';
import { buildGraphIndex } from './graph-index';
import { graphMock, idcMock } from './mock';
import type { Graph } from './types';

const full = (): Graph => {
	const a = graphMock();
	const b = idcMock();
	return { nodes: [...a.nodes, ...b.nodes], edges: [...a.edges, ...b.edges] };
};

const AHU = '空調箱 AHU-2F-1';
const LINK = '連線:Core Switch-1>匯聚 Switch AGG-A';
const HOST = '主機 H-01';
const IDC_EDGE = '包含:機櫃 A-01>機框 A-01-F1';

/** 成功時回傳新狀態；失敗直接讓測試失敗 */
const run = (s: GraphState, cmd: GraphCommand) => {
	const r = applyCommand(s, cmd);
	if (!r.ok) throw new Error(r.message);
	return r.value;
};
const reject = (s: GraphState, cmd: GraphCommand) => {
	const r = applyCommand(s, cmd);
	expect(r.ok).toBe(false);
	return r.ok ? '' : r.message;
};
/** 索引要和整張重建的一致 */
const consistent = (s: GraphState) => expect(s.index).toEqual(buildGraphIndex(s.graph));

describe('revision 分類', () => {
	it('改名／屬性只增 revision，不動 topologyRevision', () => {
		const before = initialGraphState(full());
		const { state: afterRename, change } = run(before, {
			kind: 'updateNode',
			id: AHU,
			patch: { name: '空調箱 AHU-2F-01', props: { 型號: 'X' } }
		});
		expect(afterRename.topologyRevision).toBe(before.topologyRevision);
		expect(afterRename.revision).toBe(before.revision + 1);
		expect(change.upsertNodes.map((n) => n.id)).toEqual([AHU]);
		expect(change.removeNodeIds).toEqual([]);
		expect(change.upsertEdges).toEqual([]);
		expect(afterRename.index.nodeById.get(AHU)!.name).toBe('空調箱 AHU-2F-01');
		// 鄰接只記 ID，名稱變更不需重建
		expect(afterRename.index.incident).toBe(before.index.incident);
		consistent(afterRename);
	});

	it('邊方向改變是拓撲變更；只改屬性不是', () => {
		const s0 = initialGraphState(full());
		const s1 = run(s0, { kind: 'updateEdge', id: LINK, patch: { bidirectional: true } }).state;
		expect(s1.topologyRevision).toBe(s0.topologyRevision + 1);
		expect(s1.revision).toBe(s0.revision + 1);
		const s2 = run(s1, {
			kind: 'updateEdge',
			id: LINK,
			patch: { bidirectional: true, props: { 確認狀態: '推定' } }
		}).state;
		expect(s2.topologyRevision).toBe(s1.topologyRevision);
		expect(s2.revision).toBe(s1.revision + 1);
		consistent(s2);
	});

	it('節點／邊增刪是拓撲變更，索引維持一致', () => {
		const s0 = initialGraphState(full());
		const s1 = run(s0, {
			kind: 'addNode',
			node: { id: 'n-x', type: '攝影機', name: '攝影機 X', props: {} }
		}).state;
		expect(s1.topologyRevision).toBe(s0.topologyRevision + 1);
		expect(s1.index.incident.get('n-x')).toEqual([]);
		const { state: s2, change } = run(s1, {
			kind: 'addEdge',
			edge: {
				id: 'e-x',
				type: '監測',
				from: 'n-x',
				to: '2F',
				bidirectional: false,
				props: { 確認狀態: '推定' }
			}
		});
		expect(change.upsertEdges.map((e) => e.id)).toEqual(['e-x']);
		expect(s2.index.outgoing.get('n-x')).toEqual(['e-x']);
		consistent(s2);
		const s3 = run(s2, { kind: 'deleteEdge', id: 'e-x' }).state;
		expect(s3.index.edgeById.has('e-x')).toBe(false);
		consistent(s3);
	});

	it('刪節點同時刪相連邊，索引移除該節點', () => {
		const s0 = initialGraphState(full());
		const deletedId = AHU;
		const incident = s0.index.incident.get(deletedId)!;
		expect(incident.length).toBeGreaterThan(0);
		const { state: after, change } = run(s0, { kind: 'deleteNode', id: deletedId });
		const afterDeleteIndex = after.index;
		expect(afterDeleteIndex.incident.has(deletedId)).toBe(false);
		expect(afterDeleteIndex.nodeById.has(deletedId)).toBe(false);
		for (const id of incident) expect(afterDeleteIndex.edgeById.has(id)).toBe(false);
		expect(change.removeNodeIds).toEqual([deletedId]);
		expect([...change.removeEdgeIds].sort()).toEqual([...incident].sort());
		expect(after.topologyRevision).toBe(s0.topologyRevision + 1);
		consistent(after);
	});
});

describe('命令守門：失敗時不改任何狀態', () => {
	const s0 = initialGraphState(full());
	const unchanged = (cmd: GraphCommand) => {
		const msg = reject(s0, cmd);
		expect(s0.revision).toBe(0);
		expect(s0.index).toEqual(buildGraphIndex(s0.graph));
		return msg;
	};

	it('IDC 唯讀節點／邊不可改、不可刪', () => {
		expect(unchanged({ kind: 'updateNode', id: HOST, patch: { name: 'x' } })).toBe(
			'由 IDC機櫃配置管理維護'
		);
		expect(unchanged({ kind: 'deleteNode', id: HOST })).toBe('由 IDC機櫃配置管理維護');
		expect(unchanged({ kind: 'updateEdge', id: IDC_EDGE, patch: { bidirectional: true } })).toBe(
			'由 IDC機櫃配置管理維護'
		);
		expect(unchanged({ kind: 'deleteEdge', id: IDC_EDGE })).toBe('由 IDC機櫃配置管理維護');
	});

	it('根節點不可刪；機櫃有 IDC 資料不可刪', () => {
		expect(unchanged({ kind: 'deleteNode', id: 'TPKC 大樓' })).toBe('根節點不可刪除');
		expect(unchanged({ kind: 'deleteNode', id: '機櫃 A-01' })).toContain('IDC 資料');
	});

	it('不存在的節點／邊明確拒絕', () => {
		expect(unchanged({ kind: 'updateNode', id: 'nope', patch: { name: 'x' } })).toBe(
			'節點不存在：nope'
		);
		expect(unchanged({ kind: 'updateEdge', id: 'nope', patch: {} })).toBe('邊不存在：nope');
		expect(unchanged({ kind: 'deleteNode', id: 'nope' })).toBe('節點不存在：nope');
		expect(unchanged({ kind: 'deleteEdge', id: 'nope' })).toBe('邊不存在：nope');
		expect(
			unchanged({
				kind: 'addEdge',
				edge: { id: 'e', type: '監測', from: 'nope', to: AHU, bidirectional: false, props: {} }
			})
		).toBe('節點不存在：nope');
	});

	it('草稿基準已過期時拒絕', () => {
		const base = s0.index.nodeById.get(AHU)!;
		const s1 = run(s0, { kind: 'updateNode', id: AHU, patch: { name: '別人改的' } }).state;
		const r = applyCommand(s1, { kind: 'updateNode', id: AHU, base, patch: { name: '我改的' } });
		expect(r).toEqual({ ok: false, message: '「別人改的」已被其他操作變更，請重新編輯' });
	});

	it('所有欄位先驗證：任一欄不合法就整筆不寫入', () => {
		expect(
			unchanged({
				kind: 'updateEdge',
				id: LINK,
				patch: { bidirectional: true, props: { 確認狀態: '亂填' } }
			})
		).toBe('確認狀態只能是：已確認、推定');
		expect(
			unchanged({ kind: 'updateNode', id: AHU, patch: { name: '新名', props: { ' ': 'x' } } })
		).toBe('屬性名稱不可空白');
		expect(unchanged({ kind: 'updateNode', id: AHU, patch: { name: '  ' } })).toBe('名稱不可空白');
	});

	it('新增邊仍走連接限制與 IDC 檢查；ID 重複拒絕', () => {
		expect(
			unchanged({
				kind: 'addEdge',
				edge: {
					id: 'e',
					type: '服務',
					from: '機框 A-01-F1',
					to: '客戶甲',
					bidirectional: false,
					props: {}
				}
			})
		).toBe('由 IDC機櫃配置管理維護');
		expect(
			unchanged({ kind: 'addNode', node: { id: AHU, type: '攝影機', name: 'x', props: {} } })
		).toBe(`節點已存在：${AHU}`);
		expect(
			unchanged({ kind: 'addNode', node: { id: 'n', type: '客戶', name: 'x', props: {} } })
		).toBe('由 IDC機櫃配置管理維護');
	});
});
