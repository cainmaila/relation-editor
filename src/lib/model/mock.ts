// 示意資料，非 PM 提供：2F 全棟機櫃（排別與台數取自 3D 模型）。節點 id 即初始名稱。
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

/** 排別與機櫃數取自 3D 模型（PRD §5）；其餘設備、客戶皆為示意 */
const ROWS = Object.entries({
	A: 22,
	B: 22,
	C: 22,
	D: 18,
	E: 22,
	F: 22,
	G: 22,
	H: 18,
	I: 20,
	J: 20,
	K: 20,
	L: 18,
	M: 21,
	N: 20,
	O: 20,
	P: 20
});
const pad = (i: number) => String(i).padStart(2, '0');
/** 全棟機櫃，依 A→P、櫃序排列：編號「A-01」 */
const CABS = ROWS.flatMap(([r, count]) =>
	Array.from({ length: count }, (_, i) => ({ row: r, id: `${r}-${pad(i + 1)}` }))
);
const OK = '已確認';
const EST = '推定';
const G = '2F A 排監視與偵測範圍';

/** 圖的 mock：2F 全棟機櫃，2,066 個節點 */
export function graphMock(): Graph {
	const nodes = [
		n('大樓', 'TPKC 大樓'),
		n('樓層', '2F'),
		...ROWS.map(([r]) => n('列', `${r} 排`)),
		...CABS.map((c) => n('機櫃', `機櫃 ${c.id}`, { '總 U 數': '42' })),
		n('台電市電', '台電市電'),
		n('UPS', 'UPS-1'),
		...ROWS.map(([r]) => n('樓層 PDU', `樓層 PDU 2F-${r}`)),
		...CABS.flatMap((c) =>
			['A', 'B'].map((l) => n('機櫃 PDU', `機櫃 PDU ${c.id}-${l}`, { 額定電流: '32A' }))
		),
		n('空調箱', '空調箱 AHU-2F-1'),
		n('Switch', 'Core Switch-1'),
		n('Switch', 'Core Switch-2'),
		...ROWS.map(([r]) => n('Switch', `匯聚 Switch AGG-${r}`)),
		...CABS.map((c) => n('Switch', `ToR Switch ${c.id}`)),
		n('偵測器', '偵測器 SD-01'),
		n('偵測器', '偵測器 SD-02'),
		n('攝影機', '攝影機 CAM-03'),
		n('通用節點', G)
	];
	const edges = [
		e('包含', 'TPKC 大樓', '2F', OK),
		...ROWS.map(([r]) => e('包含', '2F', `${r} 排`, OK)),
		...CABS.map((c) => e('包含', `${c.row} 排`, `機櫃 ${c.id}`, OK)),
		e('包含', '2F', 'Core Switch-1', OK),
		e('包含', '2F', 'Core Switch-2', OK),
		...ROWS.map(([r]) => e('包含', `${r} 排`, `匯聚 Switch AGG-${r}`, OK)),
		...CABS.map((c) => e('包含', `機櫃 ${c.id}`, `ToR Switch ${c.id}`, OK)),
		e('包含', G, '機櫃 A-01', EST),
		e('包含', G, '機櫃 A-02', EST),
		e('供電', '台電市電', 'UPS-1', EST),
		...ROWS.map(([r]) => e('供電', 'UPS-1', `樓層 PDU 2F-${r}`, EST)),
		...CABS.flatMap((c) =>
			['A', 'B'].flatMap((l) => [
				e('供電', `樓層 PDU 2F-${c.row}`, `機櫃 PDU ${c.id}-${l}`, EST),
				e('供電', `機櫃 PDU ${c.id}-${l}`, `機櫃 ${c.id}`, OK, { 路別: l })
			])
		),
		e('供電', 'UPS-1', '空調箱 AHU-2F-1', EST),
		e('冷卻', '空調箱 AHU-2F-1', '2F', EST),
		...ROWS.flatMap(([r]) =>
			['Core Switch-1', 'Core Switch-2'].map((core) => e('連線', core, `匯聚 Switch AGG-${r}`, OK))
		),
		...CABS.map((c) => e('連線', `匯聚 Switch AGG-${c.row}`, `ToR Switch ${c.id}`, OK)),
		...idcRows().map(([, c, h]) => e('連線', `ToR Switch ${c}`, `主機 ${h}`, EST)),
		e('監測', '偵測器 SD-01', G, EST),
		e('監測', '偵測器 SD-02', G, EST),
		e('監測', '攝影機 CAM-03', G, EST)
	];
	return { nodes, edges };
}

/** [機框, 所屬機櫃, 主機, 客戶]：A-01～A-04 維持情境錨點，其餘每櫃一框一機，客戶 01～40 輪流 */
function idcRows(): string[][] {
	const head = [
		['A-01-F1', 'A-01', 'H-01', '客戶甲'],
		['A-01-F2', 'A-01', 'H-02', '客戶乙'],
		['A-02-F1', 'A-02', 'H-03', '客戶乙'],
		['A-03-F1', 'A-03', 'H-04', '客戶甲'],
		['A-04-F1', 'A-04', 'H-05', '客戶丙']
	];
	const rest = CABS.slice(4).map((c, i) => [
		`${c.id}-F1`,
		c.id,
		`H-${String(i + 6).padStart(2, '0')}`,
		`客戶 ${pad((i % 40) + 1)}`
	]);
	return [...head, ...rest];
}

/** 機櫃與客戶關係 mock（IDC機櫃配置管理維護）：機框、主機、客戶與其關係，全部唯讀 */
export function idcMock(): Graph {
	const rows = idcRows();
	const nodes = [
		...rows.map(([f]) => n('機框', `機框 ${f}`)),
		...rows.map(([, , h]) => n('主機', `主機 ${h}`)),
		...[...new Set(rows.map((r) => r[3]))].map((c) => n('客戶', c))
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
