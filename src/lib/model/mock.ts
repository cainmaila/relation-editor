// 示意資料，非 PM 提供：2F A 區切片。節點 id 即初始名稱。
import type { GEdge, GNode, Graph, Props } from './types';

const n = (type: string, name: string, props: Props = {}): GNode => ({
	id: name,
	type,
	name,
	props
});
const e = (type: string, from: string, to: string, 確認狀態: string, props: Props = {}): GEdge => ({
	id: `${type}:${from}>${to}`,
	type,
	from,
	to,
	bidirectional: false,
	props: { ...props, 確認狀態 }
});

const CABS = ['A-01', 'A-02', 'A-03', 'A-04'];
const PDUS = CABS.flatMap((c) => [`${c}-A`, `${c}-B`]);
const OK = '已確認';
const EST = '推定';

/** 圖的 mock：31 個節點 */
export function graphMock(): Graph {
	const nodes = [
		n('大樓', 'TPKC 大樓'),
		n('樓層', '2F'),
		n('區域', '2F A 區'),
		n('列', 'A 排'),
		...CABS.map((c) => n('機櫃', `機櫃 ${c}`, { '總 U 數': '42' })),
		n('台電市電', '台電市電'),
		n('UPS', 'UPS-1'),
		n('樓層 PDU', '樓層 PDU 2F-A'),
		...PDUS.map((p) => n('機櫃 PDU', `機櫃 PDU ${p}`, { 額定電流: '32A' })),
		n('空調箱', '空調箱 AHU-2F-1'),
		n('Switch', 'Core Switch-1'),
		n('Switch', 'Core Switch-2'),
		n('Switch', '匯聚 Switch AGG-A'),
		...CABS.map((c) => n('Switch', `ToR Switch ${c}`)),
		n('偵測器', '偵測器 SD-01'),
		n('偵測器', '偵測器 SD-02'),
		n('攝影機', '攝影機 CAM-03'),
		n('通用節點', '2F A 區監視與偵測範圍')
	];
	const G = '2F A 區監視與偵測範圍';
	const edges = [
		e('包含', 'TPKC 大樓', '2F', OK),
		e('包含', '2F', '2F A 區', OK),
		e('包含', '2F A 區', 'A 排', OK),
		...CABS.map((c) => e('包含', 'A 排', `機櫃 ${c}`, OK)),
		e('包含', '2F A 區', 'Core Switch-1', OK),
		e('包含', '2F A 區', 'Core Switch-2', OK),
		e('包含', 'A 排', '匯聚 Switch AGG-A', OK),
		...CABS.map((c) => e('包含', `機櫃 ${c}`, `ToR Switch ${c}`, OK)),
		e('包含', G, '機櫃 A-01', EST),
		e('包含', G, '機櫃 A-02', EST),
		e('供電', '台電市電', 'UPS-1', EST),
		e('供電', 'UPS-1', '樓層 PDU 2F-A', EST),
		...PDUS.map((p) => e('供電', '樓層 PDU 2F-A', `機櫃 PDU ${p}`, EST)),
		...PDUS.map((p) =>
			e('供電', `機櫃 PDU ${p}`, `機櫃 ${p.slice(0, 4)}`, OK, { 路別: p.slice(-1) })
		),
		e('供電', 'UPS-1', '空調箱 AHU-2F-1', EST),
		e('冷卻', '空調箱 AHU-2F-1', '2F A 區', EST),
		e('連線', 'Core Switch-1', '匯聚 Switch AGG-A', OK),
		e('連線', 'Core Switch-2', '匯聚 Switch AGG-A', OK),
		...CABS.map((c) => e('連線', '匯聚 Switch AGG-A', `ToR Switch ${c}`, OK)),
		e('連線', 'ToR Switch A-01', '主機 H-01', EST),
		e('連線', 'ToR Switch A-01', '主機 H-02', EST),
		e('連線', 'ToR Switch A-02', '主機 H-03', EST),
		e('連線', 'ToR Switch A-03', '主機 H-04', EST),
		e('連線', 'ToR Switch A-04', '主機 H-05', EST),
		e('監測', '偵測器 SD-01', G, EST),
		e('監測', '偵測器 SD-02', G, EST),
		e('監測', '攝影機 CAM-03', G, EST)
	];
	return { nodes, edges };
}

/** 機櫃與客戶關係 mock（IDC機櫃配置管理維護）：機框、主機、客戶與其關係，全部唯讀 */
export function idcMock(): Graph {
	// [機框, 所屬機櫃, 主機, 客戶]
	const rows = [
		['A-01-F1', 'A-01', 'H-01', '客戶甲'],
		['A-01-F2', 'A-01', 'H-02', '客戶乙'],
		['A-02-F1', 'A-02', 'H-03', '客戶乙'],
		['A-03-F1', 'A-03', 'H-04', '客戶甲'],
		['A-04-F1', 'A-04', 'H-05', '客戶丙']
	];
	const nodes = [
		...rows.map(([f]) => n('機框', `機框 ${f}`)),
		...rows.map(([, , h]) => n('主機', `主機 ${h}`)),
		...['客戶甲', '客戶乙', '客戶丙'].map((c) => n('客戶', c))
	];
	const edges = rows.flatMap(([f, c, h, cust]) => [
		e('包含', `機櫃 ${c}`, `機框 ${f}`, OK),
		e('包含', `機框 ${f}`, `主機 ${h}`, OK),
		e('承載', `主機 ${h}`, `機框 ${f}`, OK),
		e('服務', `機框 ${f}`, cust, OK)
	]);
	const ro = <T>(x: T) => ({ ...x, readonly: true });
	return { nodes: nodes.map(ro), edges: edges.map(ro) };
}
