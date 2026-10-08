// 設定：系統、節點類型、邊類型。新增類型只改這裡，不改編輯器。

export const SYSTEMS = ['空間', '電力', '空調', '網路', '消防', 'CCTV', 'IDC'] as const;
export type System = (typeof SYSTEMS)[number];

export interface NodeType {
	name: string;
	/** null = 通用節點，不屬於任何系統 */
	system: System | null;
	/** 由 IDC機櫃配置管理維護，編輯器唯讀 */
	idc?: boolean;
}

export const NODE_TYPES: NodeType[] = [
	{ name: '大樓', system: '空間' },
	{ name: '樓層', system: '空間' },
	{ name: '區域', system: '空間' },
	{ name: '列', system: '空間' },
	{ name: '機櫃', system: '空間' },
	{ name: '台電市電', system: '電力' },
	{ name: 'UPS', system: '電力' },
	{ name: '樓層 PDU', system: '電力' },
	{ name: '機櫃 PDU', system: '電力' },
	{ name: '空調箱', system: '空調' },
	{ name: 'Switch', system: '網路' },
	{ name: '偵測器', system: '消防' },
	{ name: '攝影機', system: 'CCTV' },
	{ name: '機框', system: 'IDC', idc: true },
	{ name: '主機', system: 'IDC', idc: true },
	{ name: '客戶', system: 'IDC', idc: true },
	{ name: '通用節點', system: null }
];

export const nodeType = (name: string) => NODE_TYPES.find((t) => t.name === name)!;

export interface EdgeType {
	name: string;
	/** 可連出的節點類型或系統名；undefined = 不檢查 */
	from?: string[];
	fromLabel?: string;
	/** 可連到的節點類型或系統名；undefined = 不檢查 */
	to?: string[];
	toLabel?: string;
	/** 只由 IDC 資料產生，不能在編輯器新增 */
	idc?: boolean;
}

// 本 POC 所有邊類型預設方向皆為單向
export const EDGE_TYPES: EdgeType[] = [
	{
		name: '包含',
		from: ['空間', '通用節點', '機框'],
		fromLabel: '空間、通用節點、機櫃或機框',
		to: ['空間', 'Switch', '機框', '主機'],
		toLabel: '空間、網路設備、機框或主機'
	},
	{
		name: '供電',
		from: ['電力'],
		fromLabel: '電力設備',
		to: ['電力', '機櫃', '空調箱'],
		toLabel: '電力設備、機櫃或空調箱'
	},
	{ name: '冷卻', from: ['空調'], fromLabel: '空調設備', to: ['空間'], toLabel: '空間' },
	{
		name: '連線',
		from: ['Switch'],
		fromLabel: 'Switch',
		to: ['Switch', '主機'],
		toLabel: 'Switch 或主機'
	},
	{ name: '服務', from: ['機框'], fromLabel: '機框', to: ['客戶'], toLabel: '客戶', idc: true },
	{ name: '承載', from: ['主機'], fromLabel: '主機', to: ['機框'], toLabel: '機框', idc: true },
	{
		name: '監測',
		from: ['偵測器', '攝影機'],
		fromLabel: '偵測器或攝影機',
		to: ['空間', '通用節點'],
		toLabel: '空間或通用節點'
	}
];

export const edgeType = (name: string) => EDGE_TYPES.find((t) => t.name === name)!;

/** 邊屬性「確認狀態」的可選值 */
export const CONFIRM_STATES = ['已確認', '推定'];

export const ROOT_ID = 'TPKC 大樓';
export const CUSTOMER_TYPE = '客戶';
export const IDC_MESSAGE = '由 IDC機櫃配置管理維護';

/** 「沿方向走不到任何客戶」的顯示名稱；尚未與 PM 對齊，之後改這裡即可 */
export const UNREACHABLE_LABEL = '無客戶路徑';
