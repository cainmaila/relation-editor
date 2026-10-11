// 搜尋純邏輯：正規化文件、比對、穩定排序、分頁。Worker 與測試共用，不依賴 Svelte／DOM。
// 這是「預處理文件＋線性掃描」：每次查詢掃全部文件，但不截斷結果（總數永遠完整）。
import { nodeType } from '../model/config';
import type { GNode } from '../model/types';

export type NodeId = string;
export type IssueKind = 'unprocessed' | 'unreachable';
/** 沒有系統的節點（通用節點）在篩選與顯示上的系統名 */
export const GENERAL = '通用';
export const PAGE_SIZE = 50;

export interface SearchQuery {
	text: string;
	/** 空＝不限 */
	systems: readonly string[];
	types: readonly string[];
	/** 同時具有所有列出的問題 */
	issues: readonly IssueKind[];
	offset: number;
	limit: number;
	/** 只在這些 ID 內查（編輯頁大綱）；未給＝全部 */
	within?: readonly NodeId[] | null;
	/** 這些 ID 的命中排在最前面（新增邊選單：編輯頁已有的節點） */
	first?: readonly NodeId[] | null;
	/** 另回傳全部命中 ID（給畫布淡化；只該配 within 使用） */
	matches?: boolean;
}

/** 搜尋需要的節點欄位；跨 Worker 只傳這些 */
export type NodeMeta = Pick<GNode, 'id' | 'name' | 'type' | 'props'>;

export interface SearchDoc {
	id: NodeId;
	type: string;
	system: string;
	idN: string;
	nameN: string;
	/** 全部可查欄位，以換行分隔（查詢詞不含空白，不會跨欄位命中） */
	hay: string;
}

export interface IssueSets {
	unprocessed: ReadonlySet<NodeId>;
	unreachable: ReadonlySet<NodeId>;
}
export type IssueIds = { unprocessed: NodeId[]; unreachable: NodeId[] };

export interface SearchHits {
	ids: NodeId[];
	total: number;
	matches?: NodeId[];
}

/** NFKC（全形→半形）、小寫、空白收斂 */
export const normalize = (s: string) =>
	s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export function toSearchDoc(n: NodeMeta): SearchDoc {
	const system = nodeType(n.type)?.system ?? GENERAL;
	const idN = normalize(n.id);
	const nameN = normalize(n.name);
	const props = Object.entries(n.props ?? {}).flatMap(([k, v]) => [normalize(k), normalize(v)]);
	return {
		id: n.id,
		type: n.type,
		system,
		idN,
		nameN,
		hay: [idN, nameN, normalize(n.type), normalize(system), ...props].join('\n')
	};
}

/** 同一命中等級內的最終排序：只看 ID（code point，與語系、名稱無關） */
export const compareDocs = (a: SearchDoc, b: SearchDoc) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 建立並排序文件；querySearchIndex 依賴這個順序 */
export function buildSearchDocs(nodes: Iterable<NodeMeta>): SearchDoc[] {
	return [...nodes].map(toSearchDoc).sort(compareDocs);
}

const RANKS = 4;
/** 0 完全符合 ID／名稱、1 名稱前綴、2 名稱包含所有詞、3 其他欄位；-1 不符 */
function rank(d: SearchDoc, q: string, words: string[]): number {
	if (!q) return 3;
	if (!words.every((w) => d.hay.includes(w))) return -1;
	if (d.idN === q || d.nameN === q) return 0;
	if (d.nameN.startsWith(q)) return 1;
	if (words.every((w) => d.nameN.includes(w))) return 2;
	return 3;
}

/**
 * 純函式查詢。documents 必須是 buildSearchDocs 的順序（ID），
 * 結果依等級分桶後維持該順序：等級優先、同等級依 ID，與輸入次序無關。
 */
export function querySearchIndex(
	documents: readonly SearchDoc[],
	query: SearchQuery,
	issues?: IssueSets
): SearchHits {
	const q = normalize(query.text);
	const words = q ? q.split(' ') : [];
	const systems = query.systems.length ? new Set(query.systems) : null;
	const types = query.types.length ? new Set(query.types) : null;
	const within = query.within ? new Set(query.within) : null;
	const need = query.issues.map((k) => issues?.[k] ?? new Set<NodeId>());
	const buckets: NodeId[][] = Array.from({ length: RANKS }, () => []);
	for (const d of documents) {
		if (within && !within.has(d.id)) continue;
		if (systems && !systems.has(d.system)) continue;
		if (types && !types.has(d.type)) continue;
		if (need.some((s) => !s.has(d.id))) continue;
		const r = rank(d, q, words);
		if (r >= 0) buckets[r].push(d.id);
	}
	const flat = buckets.flat();
	const first = query.first?.length ? new Set(query.first) : null;
	const all = first
		? [...flat.filter((id) => first.has(id)), ...flat.filter((id) => !first.has(id))]
		: flat;
	const offset = Math.max(0, query.offset);
	return {
		ids: all.slice(offset, offset + Math.max(0, query.limit)),
		total: all.length,
		...(query.matches ? { matches: all } : {})
	};
}

/** Worker 端的文件快取：依 ID 保存正規化文件與同一版本的問題 ID sets */
export class SearchStore {
	revision = 0;
	#docs = new Map<NodeId, SearchDoc>();
	#sorted: SearchDoc[] | null = null;
	#issues: IssueSets = { unprocessed: new Set(), unreachable: new Set() };

	init(revision: number, nodes: Iterable<NodeMeta>, issues: IssueIds) {
		this.#docs = new Map([...nodes].map((n) => [n.id, toSearchDoc(n)]));
		this.#sorted = null;
		this.#setIssues(issues);
		this.revision = revision;
	}

	/** 先刪後加；沒帶 issues＝拓撲沒變，沿用上一版 */
	patch(revision: number, upsert: Iterable<NodeMeta>, remove: Iterable<NodeId>, issues?: IssueIds) {
		for (const id of remove) this.#docs.delete(id);
		for (const n of upsert) this.#docs.set(n.id, toSearchDoc(n));
		this.#sorted = null;
		if (issues) this.#setIssues(issues);
		this.revision = revision;
	}

	query(query: SearchQuery): SearchHits {
		this.#sorted ??= [...this.#docs.values()].sort(compareDocs);
		return querySearchIndex(this.#sorted, query, this.#issues);
	}

	#setIssues(i: IssueIds) {
		this.#issues = { unprocessed: new Set(i.unprocessed), unreachable: new Set(i.unreachable) };
	}
}
