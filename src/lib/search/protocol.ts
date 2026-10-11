// 搜尋 Worker 協定：init／patch 回 ack（帶 revision），query 回 requestId＋revision＋當頁 IDs＋總數。
// 訊息只含純資料（structured clone），不傳 Svelte proxy、不傳整份 Graph 給每次查詢。
import {
	SearchStore,
	type IssueIds,
	type NodeId,
	type NodeMeta,
	type SearchQuery
} from './search-index';

export type SearchRequest =
	| { kind: 'init'; revision: number; nodes: NodeMeta[]; issues: IssueIds }
	/** issues 只在拓撲改變時帶（與 nodes 同一 revision）；改名／屬性不重算拓撲分析 */
	| { kind: 'patch'; revision: number; upsert: NodeMeta[]; remove: NodeId[]; issues?: IssueIds }
	| { kind: 'query'; requestId: number; query: SearchQuery };

export interface SearchPage {
	requestId: number;
	revision: number;
	ids: NodeId[];
	total: number;
}

export type SearchResponse =
	| { kind: 'ack'; revision: number }
	| ({ kind: 'page'; matches?: NodeId[] } & SearchPage)
	/** requestId 為 null：init／patch 失敗，快取可能不一致，需重建 */
	| { kind: 'error'; requestId: number | null; revision: number; message: string };

export function handleSearchMessage(store: SearchStore, msg: SearchRequest): SearchResponse {
	try {
		switch (msg.kind) {
			case 'init':
				store.init(msg.revision, msg.nodes, msg.issues);
				return { kind: 'ack', revision: store.revision };
			case 'patch':
				store.patch(msg.revision, msg.upsert, msg.remove, msg.issues);
				return { kind: 'ack', revision: store.revision };
			case 'query':
				return {
					kind: 'page',
					requestId: msg.requestId,
					revision: store.revision,
					...store.query(msg.query)
				};
		}
	} catch (e) {
		return {
			kind: 'error',
			requestId: msg.kind === 'query' ? msg.requestId : null,
			revision: store.revision,
			message: e instanceof Error ? e.message : String(e)
		};
	}
}
