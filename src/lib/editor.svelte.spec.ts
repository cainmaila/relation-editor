import { describe, expect, it } from 'vitest';
import { Editor } from './editor.svelte';

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
	const cards = (e: Editor) => e.canvas.nodes.map((n) => n.id);

	it('編輯湊成新的一疊時，畫面上的卡片不收起；重新排版後才收', () => {
		const e = new Editor();
		const ids = [e.addNode('列')!, e.addNode('列')!, e.addNode('列')!];
		for (const id of ids) e.addEdge('A 排', id, '包含');
		expect(cards(e)).toEqual(expect.arrayContaining(ids));
		e.rearrange();
		expect(cards(e)).not.toEqual(expect.arrayContaining(ids));
	});

	it('新節點加入已收起的疊卡時留在外面', () => {
		const e = new Editor();
		const key = 'stack:機櫃 PDU:樓層 PDU 2F-A';
		const id = e.addNode('機櫃 PDU')!;
		e.addEdge('樓層 PDU 2F-A', id, '供電');
		expect(e.stackOf(id)).toBe(key);
		expect(cards(e)).toContain(id);
		expect(e.closed.get(key)).toHaveLength(44);
	});
});
