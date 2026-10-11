// CSV → Graph。純函式，不碰 fetch；檔案格式見 README「資料檔」。
import { EDGE_TYPES, NODE_TYPES, SYSTEMS, nodeType } from './config';
import type { GEdge, GNode, Graph, Props } from './types';

/** RFC 4180：引號、"" 跳脫、欄內換行；去 BOM；略過空白列 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	const s = text.replace(/^\uFEFF/, '');
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quoted) {
			if (c !== '"') cell += c;
			else if (s[i + 1] === '"') cell += s[++i];
			else quoted = false;
		} else if (c === '"') quoted = true;
		else if (c === ',') {
			row.push(cell);
			cell = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && s[i + 1] === '\n') i++;
			row.push(cell);
			cell = '';
			if (row.some((x) => x !== '')) rows.push(row);
			row = [];
		} else cell += c;
	}
	row.push(cell);
	if (row.some((x) => x !== '')) rows.push(row);
	return rows;
}

/** 系統檔的檔名：沒有系統的通用節點 */
const GENERIC_FILE = '通用';

const PATH = /^(idc\/)?(nodes|edges)\/(.+)\.csv$/;

const props = (header: string[], row: string[], from: number): Props => {
	const p: Props = {};
	for (let i = from; i < header.length; i++) if (row[i]) p[header[i]] = row[i];
	return p;
};

/**
 * files＝[相對路徑, 內容]，路徑形如 `nodes/空間.csv`、`edges/供電.csv`、`idc/nodes/主機.csv`：
 * 邊檔與 `idc/` 的節點檔，檔名＝類型名；其餘節點檔，檔名＝系統名（或「通用」），首欄多一欄「類型」。
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
		const [header, ...rows] = parseCsv(text);
		rows.forEach((row, i) => {
			const line = i + 2;
			if (kind === 'nodes') {
				const at = system !== undefined ? 1 : 0;
				const type = system !== undefined ? row[0] : file;
				if (system !== undefined && nodeType(type)?.system !== system)
					throw new Error(`${path} 第 ${line} 列：類型「${type}」不屬於${system ?? '通用'}`);
				const name = row[at];
				if (!name) throw new Error(`${path} 第 ${line} 列：名稱空白`);
				if (names.has(name)) throw new Error(`${path} 第 ${line} 列：節點名稱重複「${name}」`);
				names.add(name);
				nodes.push({
					id: name,
					type,
					name,
					props: props(header, row, at + 1),
					...(readonly && { readonly })
				});
			} else {
				const [from, to, bi] = row;
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
