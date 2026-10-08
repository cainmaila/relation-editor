import { describe, expect, it } from 'vitest';
import {
	checkDeleteNode,
	findCustomers,
	layout,
	NODE_W,
	NODE_H,
	unprocessed,
	unreachable,
	validateEdge
} from './graph';
import { graphMock, idcMock } from './mock';
import { nodeType, type System } from './config';
import type { Graph } from './types';

const full = (): Graph => {
	const a = graphMock();
	const b = idcMock();
	return { nodes: [...a.nodes, ...b.nodes], edges: [...a.edges, ...b.edges] };
};

/** 只看勾選系統：節點在勾選系統或通用；邊兩端都在才顯示 */
const visible = (g: Graph, systems: System[]) => {
	const nodes = g.nodes.filter((n) => {
		const s = nodeType(n.type).system;
		return s === null || systems.includes(s);
	});
	const ids = new Set(nodes.map((n) => n.id));
	return { nodes, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
};

const removeEdge = (g: Graph, from: string, to: string) => {
	g.edges = g.edges.filter((e) => !(e.from === from && e.to === to));
};

describe('看圖', () => {
	it('情境 1：44 個節點，無未處理', () => {
		const g = full();
		expect(g.nodes).toHaveLength(44);
		expect(new Set(g.nodes.map((n) => n.id)).size).toBe(44);
		expect(unprocessed(g).size).toBe(0);
	});

	it('情境 2：只勾電力 11 節點 10 邊；只勾空間 8 節點 7 邊（不含通用）', () => {
		const p = visible(full(), ['電力']);
		expect(p.nodes.filter((n) => n.type !== '通用節點')).toHaveLength(11);
		expect(p.edges).toHaveLength(10);
		const s = visible(full(), ['空間']);
		expect(s.nodes.filter((n) => n.type !== '通用節點')).toHaveLength(8);
		expect(
			s.edges.filter((e) => e.type === '包含' && !e.from.startsWith('2F A 區監視'))
		).toHaveLength(7);
	});

	it('情境 3：空間＋電力多 8 條跨系統邊；加空調再多 2 條', () => {
		const cross = (v: Graph) =>
			v.edges.filter((e) => {
				const sys = (id: string) => nodeType(v.nodes.find((n) => n.id === id)!.type).system;
				return sys(e.from) !== sys(e.to) && sys(e.from) !== null && sys(e.to) !== null;
			});
		expect(cross(visible(full(), ['空間', '電力']))).toHaveLength(8);
		expect(cross(visible(full(), ['空間', '電力', '空調']))).toHaveLength(10);
	});

	it('情境 4：通用節點連入 3 監測、連出 2 包含', () => {
		const v = visible(full(), ['空間', '消防', 'CCTV']);
		const G = '2F A 區監視與偵測範圍';
		expect(v.edges.filter((e) => e.to === G && e.type === '監測')).toHaveLength(3);
		expect(v.edges.filter((e) => e.from === G && e.type === '包含')).toHaveLength(2);
	});

	it('情境 5：機櫃 A-01 直接相連 7 條邊', () => {
		const g = full();
		expect(g.edges.filter((e) => e.from === '機櫃 A-01' || e.to === '機櫃 A-01')).toHaveLength(7);
	});
});

describe('編輯', () => {
	it('情境 8/9：新節點未處理，連邊後解除', () => {
		const g = full();
		g.nodes.push({ id: 'x', type: '攝影機', name: '攝影機 CAM-04', props: {} });
		expect([...unprocessed(g)]).toEqual(['x']);
		expect(validateEdge(g, 'x', '2F A 區監視與偵測範圍', '監測')).toBeNull();
		g.edges.push({
			id: 'ex',
			type: '監測',
			from: 'x',
			to: '2F A 區監視與偵測範圍',
			bidirectional: false,
			props: {}
		});
		expect(unprocessed(g).size).toBe(0);
		expect(findCustomers(g, 'x').customers.sort()).toEqual(['客戶乙', '客戶甲']);
	});

	it('情境 10：連接限制', () => {
		const g = full();
		expect(validateEdge(g, '機櫃 A-01', 'UPS-1', '供電')).toBe('「供電」只能由電力設備連出');
		expect(validateEdge(g, '偵測器 SD-01', '客戶甲', '監測')).toBe(
			'「監測」只能連到空間或通用節點'
		);
	});

	it('情境 12：刪除與未處理', () => {
		const g = full();
		removeEdge(g, '空調箱 AHU-2F-1', '2F A 區');
		expect(unprocessed(g).size).toBe(0);
		removeEdge(g, '2F A 區', 'Core Switch-2');
		removeEdge(g, 'Core Switch-2', '匯聚 Switch AGG-A');
		expect([...unprocessed(g)]).toEqual(['Core Switch-2']);
		expect(checkDeleteNode(g, '機櫃 A-01')).toBe(
			'機櫃底下有 IDC 資料，請先在 IDC機櫃配置管理移除機框'
		);
		expect(checkDeleteNode(g, '偵測器 SD-02')).toBeNull();
	});

	it('情境 13：IDC 唯讀', () => {
		const g = full();
		expect(checkDeleteNode(g, '客戶甲')).toBe('由 IDC機櫃配置管理維護');
		expect(validateEdge(g, 'ToR Switch A-04', '主機 H-05', '連線')).toBeNull();
		expect(validateEdge(g, '機框 A-01-F1', '客戶乙', '服務')).toBe('由 IDC機櫃配置管理維護');
	});
});

describe('找客戶', () => {
	const cust = (g: Graph, id: string) => findCustomers(g, id).customers.sort();

	it('情境 15：台電市電 → 甲乙丙，含空調支線', () => {
		const r = findCustomers(full(), '台電市電');
		expect(r.customers.sort()).toEqual(['客戶丙', '客戶乙', '客戶甲']);
		for (const id of ['UPS-1', '空調箱 AHU-2F-1', '2F A 區', 'A 排', '機櫃 A-04', '機框 A-04-F1'])
			expect(r.nodes.has(id)).toBe(true);
		expect(r.nodes.has('偵測器 SD-01')).toBe(false);
	});

	it('情境 16：精確', () => {
		const g = full();
		expect(cust(g, '機櫃 PDU A-02-A')).toEqual(['客戶乙']);
		expect(cust(g, '偵測器 SD-01')).toEqual(['客戶乙', '客戶甲']);
		expect(cust(g, '主機 H-02')).toEqual(['客戶乙']);
		expect(cust(g, 'Core Switch-1')).toEqual(['客戶丙', '客戶乙', '客戶甲']);
		expect(cust(g, 'ToR Switch A-02')).toEqual(['客戶乙']);
	});

	it('情境 17：到不了客戶', () => {
		const g = full();
		expect(unreachable(g).size).toBe(0);
		g.nodes.push({ id: 'b', type: 'Switch', name: 'Switch B', props: {} });
		g.edges.push({
			id: 'e1',
			type: '連線',
			from: '匯聚 Switch AGG-A',
			to: 'b',
			bidirectional: false,
			props: {}
		});
		expect(unprocessed(g).size).toBe(0);
		expect([...unreachable(g)]).toEqual(['b']);
		g.edges.push({
			id: 'e2',
			type: '連線',
			from: 'b',
			to: '主機 H-03',
			bidirectional: false,
			props: {}
		});
		expect(unreachable(g).size).toBe(0);
		expect(cust(g, 'b')).toEqual(['客戶乙']);
	});

	it('情境 18：刪邊後 PDU 到不了客戶', () => {
		const g = full();
		removeEdge(g, '機櫃 PDU A-04-A', '機櫃 A-04');
		expect([...unreachable(g)]).toEqual(['機櫃 PDU A-04-A']);
	});

	it('雙向邊兩頭都能走', () => {
		const g = full();
		const e = g.edges.find((x) => x.from === 'Core Switch-1' && x.to === '匯聚 Switch AGG-A')!;
		e.bidirectional = true;
		expect(findCustomers(g, '匯聚 Switch AGG-A').nodes.has('Core Switch-1')).toBe(true);
	});
});

it('layout：每個節點都有位置，沿供電方向由左往右，客戶在最右欄', () => {
	const { pos } = layout(full());
	expect(pos.size).toBe(44);
	const x = (id: string) => pos.get(id)!.x;
	expect(x('台電市電')).toBeLessThan(x('UPS-1'));
	expect(x('UPS-1')).toBeLessThan(x('樓層 PDU 2F-A'));
	expect(x('樓層 PDU 2F-A')).toBeLessThan(x('機櫃 PDU A-04-B'));
	const maxX = Math.max(...[...pos.values()].map((p) => p.x));
	['客戶甲', '客戶乙', '客戶丙'].forEach((c) => expect(x(c)).toBe(maxX));
});

it('layout：平行的兄弟節點同一欄，卡片不重疊', () => {
	const { pos } = layout(full());
	const cabs = ['機櫃 A-01', '機櫃 A-02', '機櫃 A-03', '機櫃 A-04'].map((id) => pos.get(id)!);
	expect(new Set(cabs.map((p) => p.x)).size).toBe(1);
	expect(new Set(cabs.map((p) => p.y)).size).toBe(4);
	const all = [...pos.values()];
	all.forEach((a, i) =>
		all.slice(i + 1).forEach((b) => {
			expect(Math.abs(a.x - b.x) >= NODE_W || Math.abs(a.y - b.y) >= NODE_H).toBe(true);
		})
	);
});
