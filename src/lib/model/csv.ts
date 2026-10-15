// CSV → Graph。純函式，不碰 fetch；檔案格式見 README「資料檔」。
import { EDGE_TYPES, NODE_TYPES, SYSTEMS, nodeType } from './config';
import type { GEdge, GNode, Graph, Props } from './types';

/** RFC 4180：引號（只在欄首開啟）、"" 跳脫、欄內換行；去 BOM、每格 trim；略過空白列；引號沒關就 throw */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	const s = text.replace(/^\uFEFF/, '');
	const flush = () => {
		row.push(cell);
		cell = '';
		row = row.map((x) => x.trim());
		if (row.some((x) => x !== '')) rows.push(row);
		row = [];
	};
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quoted) {
			if (c !== '"') cell += c;
			else if (s[i + 1] === '"') cell += s[++i];
			else quoted = false;
		} else if (c === '"' && cell === '') quoted = true;
		else if (c === ',') {
			row.push(cell);
			cell = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && s[i + 1] === '\n') i++;
			flush();
		} else cell += c;
	}
	if (quoted) throw new Error('引號沒有關閉');
	flush();
	return rows;
}

/** 系統檔的檔名：沒有系統的通用節點 */
const GENERIC_FILE = '通用';

const NODE_COLS = ['key', '名稱'];
const EDGE_COLS = ['起點', '終點', '雙向'];

const PATH = /^(idc\/)?(nodes|edges)\/(.+)\.csv$/;

const props = (header: string[], row: string[], from: number): Props => {
	const p: Props = {};
	for (let i = from; i < header.length; i++) if (row[i]) p[header[i]] = row[i];
	return p;
};

/**
 * files＝[相對路徑, 內容]，路徑形如 `nodes/空間.csv`、`edges/供電.csv`、`idc/nodes/主機.csv`：
 * 邊檔與 `idc/` 的節點檔，檔名＝類型名；其餘節點檔，檔名＝系統名（或「通用」），首欄多一欄「類型」。節點檔固定欄 `key,名稱`（名稱選填，空白＝顯示 key）。
 * `idc/` 底下全部唯讀。資料有誤就 throw，訊息帶檔名與列號。
 */
export function buildGraph(files: [path: string, text: string][]): Graph {
	const nodes: GNode[] = [];
	const edges: GEdge[] = [];
	const names = new Set<string>();
	const edgeIds = new Set<string>();
	const edgeRows: { path: string; line: number; edge: GEdge }[] = [];

	for (const [path, text] of files) {
		const m = PATH.exec(path);
		if (!m)
			throw new Error(`${path}：路徑須為 nodes/名稱.csv 或 edges/類型.csv（IDC 前面加 idc/）`);
		const [, idc, kind, file] = m;
		const readonly = idc ? true : undefined;
		// 系統檔：一檔多類型，每列自帶類型
		const system = !idc && kind === 'nodes' ? (file === GENERIC_FILE ? null : file) : undefined;
		if (
			system !== undefined
				? system !== null && !SYSTEMS.some((s) => s === system)
				: !(kind === 'nodes' ? NODE_TYPES : EDGE_TYPES).some((t) => t.name === file)
		)
			throw new Error(
				`${path}：未知的${system !== undefined ? '系統' : kind === 'nodes' ? '節點類型' : '邊類型'}「${file}」`
			);
		let table: string[][];
		try {
			table = parseCsv(text);
		} catch (e) {
			throw new Error(`${path}：${(e as Error).message}`, { cause: e });
		}
		const [header, ...rows] = table;
		if (!header) throw new Error(`${path}：缺表頭`);
		const fixed =
			kind === 'edges' ? EDGE_COLS : system !== undefined ? ['類型', ...NODE_COLS] : NODE_COLS;
		if (fixed.some((c, i) => header[i] !== c))
			throw new Error(`${path}：表頭須以「${fixed.join(',')}」開頭`);
		const dup = header.find((c, i) => header.indexOf(c) !== i);
		if (dup) throw new Error(`${path}：表頭欄位重複「${dup}」`);
		rows.forEach((row, i) => {
			const line = i + 2;
			if (row.length > header.length) throw new Error(`${path} 第 ${line} 列：欄數超過表頭`);
			if (kind === 'nodes') {
				const at = system !== undefined ? 1 : 0;
				const type = system !== undefined ? row[0] : file;
				if (system !== undefined && nodeType(type)?.system !== system)
					throw new Error(`${path} 第 ${line} 列：類型「${type}」不屬於${system ?? '通用'}`);
				const key = row[at];
				if (!key) throw new Error(`${path} 第 ${line} 列：key 空白`);
				if (names.has(key)) throw new Error(`${path} 第 ${line} 列：key 重複：${key}`);
				names.add(key);
				nodes.push({
					id: key,
					type,
					name: row[at + 1] || key,
					props: props(header, row, at + 2),
					...(readonly && { readonly })
				});
			} else {
				const [from, to, bi] = row;
				if (bi && bi !== '是') throw new Error(`${path} 第 ${line} 列：雙向只能填「是」或留空`);
				if (!from || !to) throw new Error(`${path} 第 ${line} 列：起點或終點空白`);
				const edge: GEdge = {
					id: `${file}:${from}>${to}`,
					type: file,
					from,
					to,
					bidirectional: bi === '是',
					props: props(header, row, 3),
					...(readonly && { readonly })
				};
				if (edgeIds.has(edge.id)) throw new Error(`${path} 第 ${line} 列：邊重複「${from}>${to}」`);
				edgeIds.add(edge.id);
				edgeRows.push({ path, line, edge });
			}
		});
	}
	// 邊檔可能排在節點檔前面，節點收齊才檢查端點
	for (const { path, line, edge } of edgeRows) {
		for (const end of [edge.from, edge.to])
			if (!names.has(end)) throw new Error(`${path} 第 ${line} 列：找不到節點「${end}」`);
		edges.push(edge);
	}
	return { nodes, edges };
}

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const table = (header: string[], rows: string[][]) =>
	[header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
const withProps = (fixed: string[], items: { props: Props }[], rows: string[][]) => {
	const keys = [...new Set(items.flatMap((x) => Object.keys(x.props)))];
	return table(
		[...fixed, ...keys],
		rows.map((r, i) => [...r, ...keys.map((k) => items[i].props[k] ?? '')])
	);
};

/**
 * Graph → 檔案清單（含 index.json），格式與 buildGraph 吃的相同，之後可直接覆蓋 static/data。
 * 可編輯的節點檔與邊檔一律輸出（空的留表頭）；idc/ 檔有資料才輸出。名稱等於 key 時寫空白。
 * shortcut: 屬性欄取各檔列的聯集，某欄整欄空白就不輸出；要保留空欄時需在圖裡記錄表頭
 */
export function toCsvFiles(g: Graph): [path: string, text: string][] {
	const files: [string, string][] = [];
	const nodeRow = (n: GNode) => [n.id, n.name === n.id ? '' : n.name];
	for (const system of [...SYSTEMS.filter((s) => s !== 'IDC'), GENERIC_FILE]) {
		const ns = g.nodes.filter(
			(n) => !n.readonly && (nodeType(n.type).system ?? GENERIC_FILE) === system
		);
		files.push([
			`nodes/${system}.csv`,
			withProps(
				['類型', ...NODE_COLS],
				ns,
				ns.map((n) => [n.type, ...nodeRow(n)])
			)
		]);
	}
	for (const t of EDGE_TYPES.filter((t) => !t.idc)) files.push(edgeFile(g, t.name, false));
	for (const t of NODE_TYPES.filter((t) => t.idc)) {
		const ns = g.nodes.filter((n) => n.readonly && n.type === t.name);
		if (ns.length)
			files.push([`idc/nodes/${t.name}.csv`, withProps(NODE_COLS, ns, ns.map(nodeRow))]);
	}
	for (const t of EDGE_TYPES)
		if (g.edges.some((e) => e.readonly && e.type === t.name)) files.push(edgeFile(g, t.name, true));
	files.push([
		'index.json',
		JSON.stringify(
			files.map(([p]) => p),
			null,
			'\t'
		) + '\n'
	]);
	return files;
}

function edgeFile(g: Graph, type: string, idc: boolean): [string, string] {
	const es = g.edges.filter((e) => !!e.readonly === idc && e.type === type);
	return [
		`${idc ? 'idc/' : ''}edges/${type}.csv`,
		withProps(
			[...EDGE_COLS],
			es,
			es.map((e) => [e.from, e.to, e.bidirectional ? '是' : ''])
		)
	];
}
