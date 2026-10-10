import { describe, expect, it } from 'vitest';
import type { GNode } from '../model/types';
import { nodeType } from '../model/config';
import { scaleFixture } from '../model/scale-fixture';
import { handleSearchMessage } from './protocol';
import {
	PAGE_SIZE,
	SearchStore,
	buildSearchDocs,
	normalize,
	querySearchIndex,
	type SearchQuery
} from './search-index';

const q = (text: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({
	text,
	systems: [],
	types: [],
	issues: [],
	offset: 0,
	limit: PAGE_SIZE,
	...extra
});
const n = (id: string, type: string, name = id, props: Record<string, string> = {}): GNode => ({
	id,
	type,
	name,
	props
});

const NODES = [
	n('rack-1', '機櫃', '機櫃 A-01', { 型號: 'R42' }),
	n('rack-2', '機櫃', '機櫃 A-02'),
	n('pdu-1', '機櫃 PDU', '機櫃 PDU A-01-A'),
	n('ups-1', 'UPS', 'UPS-1', { 廠牌: '台達電子' }),
	n('cam-1', '攝影機', '攝影機 CAM-01'),
	n('dup-b', '機櫃', '同名'),
	n('dup-a', '機櫃', '同名'),
	n('hub', '通用節點', '主幹 A-01')
];
const docs = buildSearchDocs(NODES);
const ids = (text: string, extra?: Partial<SearchQuery>) =>
	querySearchIndex(docs, q(text, extra)).ids;

describe('normalize', () => {
	it('NFKC＋大小寫＋空白收斂', () => {
		expect(normalize('  ＵＰＳ－１\u3000Ａ ')).toBe('ups-1 a');
	});
});

describe('querySearchIndex 比對', () => {
	it('中文連續字串包含', () => {
		expect(ids('攝影')).toEqual(['cam-1']);
		expect(ids('台達')).toEqual(['ups-1']);
	});

	it('ID 可查', () => {
		expect(ids('rack-2')).toEqual(['rack-2']);
	});

	it('全形、大小寫視同半形', () => {
		expect(ids('ｕｐｓ－１')).toEqual(['ups-1']);
	});

	it('屬性 key 與 value 都可查', () => {
		expect(ids('型號')).toEqual(['rack-1']);
		expect(ids('r42')).toEqual(['rack-1']);
	});

	it('類型與系統可查', () => {
		expect(ids('CCTV')).toEqual(['cam-1']);
		expect(ids('通用')).toEqual(['hub']);
	});

	it('多詞 AND，可跨欄位', () => {
		// 兩者名稱都含兩詞（同等級）：依 ID
		expect(ids('A-01 機櫃')).toEqual(['pdu-1', 'rack-1']);
		expect(ids('A-01 r42')).toEqual(['rack-1']);
		expect(ids('A-01 不存在')).toEqual([]);
	});

	it('空查詢列出全部節點', () => {
		const r = querySearchIndex(docs, q('  '));
		expect(r.total).toBe(NODES.length);
		expect(new Set(r.ids)).toEqual(new Set(NODES.map((x) => x.id)));
	});
});

describe('querySearchIndex 排序', () => {
	it('完全符合 → 名稱前綴 → 名稱包含 → 類型／屬性', () => {
		// 「機櫃 a-01」完全符合 rack-1；pdu-1 名稱只含兩詞
		expect(ids('機櫃 A-01')).toEqual(['rack-1', 'pdu-1']);
		// hub、rack-1、pdu-1 都是名稱包含 a-01：同組依 ID
		expect(ids('a-01')).toEqual(['hub', 'pdu-1', 'rack-1']);
		// 名稱前綴（rack、pdu）優先於只有類型符合的同名節點；同組依 ID
		expect(ids('機櫃')).toEqual(['pdu-1', 'rack-1', 'rack-2', 'dup-a', 'dup-b']);
	});

	it('同名依 ID 穩定排序，與輸入順序無關', () => {
		const rev = buildSearchDocs([...NODES].reverse());
		expect(querySearchIndex(rev, q('同名')).ids).toEqual(['dup-a', 'dup-b']);
		expect(ids('同名')).toEqual(['dup-a', 'dup-b']);
	});

	it('同組最後依 ID，不依名稱（名稱與 ID 順序刻意相反）', () => {
		const inv = [
			n('id-1', '機櫃', '名 C'),
			n('id-2', '機櫃', '名 B'),
			n('id-3', '機櫃', '名 A'),
			n('id-9', '機櫃', '名')
		];
		for (const docs of [buildSearchDocs(inv), buildSearchDocs([...inv].reverse())]) {
			// 等級優先：id-9 完全符合；其餘同為名稱前綴，依 ID 而非名稱（名 A < 名 B < 名 C）
			expect(querySearchIndex(docs, q('名')).ids).toEqual(['id-9', 'id-1', 'id-2', 'id-3']);
			expect(querySearchIndex(docs, q('')).ids).toEqual(['id-1', 'id-2', 'id-3', 'id-9']);
			expect(querySearchIndex(docs, q('機櫃')).ids).toEqual(['id-1', 'id-2', 'id-3', 'id-9']);
		}
		const store = new SearchStore();
		store.init(1, inv, { unprocessed: [], unreachable: [] });
		expect(store.query(q('名')).ids).toEqual(['id-9', 'id-1', 'id-2', 'id-3']);
	});
});

describe('querySearchIndex 篩選', () => {
	it('系統、類型、範圍', () => {
		expect(ids('', { systems: ['電力'] })).toEqual(['pdu-1', 'ups-1']);
		expect(ids('', { systems: ['通用'] })).toEqual(['hub']);
		expect(ids('', { types: ['攝影機'] })).toEqual(['cam-1']);
		expect(ids('a-0', { within: ['rack-2', 'cam-1'] })).toEqual(['rack-2']);
	});

	it('問題篩選依 issue ID sets', () => {
		const issues = { unprocessed: new Set(['cam-1', 'ups-1']), unreachable: new Set(['ups-1']) };
		expect(querySearchIndex(docs, q('', { issues: ['unprocessed'] }), issues).ids).toEqual([
			'cam-1',
			'ups-1'
		]);
		expect(
			querySearchIndex(docs, q('', { issues: ['unprocessed', 'unreachable'] }), issues).ids
		).toEqual(['ups-1']);
	});

	it('要求時回傳範圍內全部命中（不只當頁）', () => {
		const r = querySearchIndex(docs, q('', { limit: 1, matches: true }));
		expect(r.ids).toHaveLength(1);
		expect(r.matches).toHaveLength(NODES.length);
	});
});

describe('分頁：沒有無告知的截斷', () => {
	const many = Array.from({ length: 123 }, (_, i) =>
		n(`x-${String(i).padStart(3, '0')}`, '機櫃', `同類 ${i}`)
	);
	const big = buildSearchDocs([...many, ...NODES]);

	it('每頁 50 筆，跨頁不重複，可走完所有頁', () => {
		const firstPage = querySearchIndex(big, q('同類'));
		const secondPage = querySearchIndex(big, q('同類', { offset: 50 }));
		const lastPage = querySearchIndex(big, q('同類', { offset: 100 }));
		expect(secondPage.total).toBe(123);
		expect(secondPage.ids).toHaveLength(50);
		expect(new Set([...firstPage.ids, ...secondPage.ids]).size).toBe(100);
		expect(lastPage.ids).toHaveLength(23);
		expect(new Set([...firstPage.ids, ...secondPage.ids, ...lastPage.ids])).toEqual(
			new Set(many.map((x) => x.id))
		);
	});

	it('第九筆之後的結果也取得到', () => {
		const all = querySearchIndex(big, q('同類', { limit: 200 })).ids;
		expect(all).toHaveLength(123);
		expect(querySearchIndex(big, q('同類', { offset: 8, limit: 1 })).ids).toEqual([all[8]]);
	});
});

describe('SearchStore／protocol', () => {
	const init = (store = new SearchStore()) => {
		handleSearchMessage(store, {
			kind: 'init',
			revision: 3,
			nodes: NODES,
			issues: { unprocessed: ['cam-1'], unreachable: [] }
		});
		return store;
	};

	it('init／patch 回 ack 並帶 revision；查詢回 requestId／revision', () => {
		const store = new SearchStore();
		expect(
			handleSearchMessage(store, {
				kind: 'init',
				revision: 3,
				nodes: NODES,
				issues: { unprocessed: [], unreachable: [] }
			})
		).toEqual({ kind: 'ack', revision: 3 });
		const r = handleSearchMessage(store, { kind: 'query', requestId: 7, query: q('攝影') });
		expect(r).toMatchObject({ kind: 'page', requestId: 7, revision: 3, ids: ['cam-1'], total: 1 });
	});

	it('patch 改名、刪除、新增後結果跟著變；沒帶 issues 時保留上一版', () => {
		const store = init();
		const deletedId = 'rack-2';
		expect(
			handleSearchMessage(store, {
				kind: 'patch',
				revision: 4,
				upsert: [n('cam-1', '攝影機', '改名 CAM'), n('new-1', '機櫃', '機櫃 新')],
				remove: [deletedId]
			})
		).toEqual({ kind: 'ack', revision: 4 });
		const resultsAfterDelete = store.query(q('機櫃'));
		expect(resultsAfterDelete.ids).not.toContain(deletedId);
		expect(resultsAfterDelete.ids).toContain('new-1');
		expect(store.query(q('改名')).ids).toEqual(['cam-1']);
		expect(store.query(q('', { issues: ['unprocessed'] })).ids).toEqual(['cam-1']);
	});

	it('patch 帶 issues 時一起換新', () => {
		const store = init();
		handleSearchMessage(store, {
			kind: 'patch',
			revision: 4,
			upsert: [],
			remove: [],
			issues: { unprocessed: ['ups-1'], unreachable: [] }
		});
		expect(store.query(q('', { issues: ['unprocessed'] })).ids).toEqual(['ups-1']);
	});

	it('處理失敗回 error，不丟例外', () => {
		const store = init();
		const r = handleSearchMessage(store, {
			kind: 'query',
			requestId: 1,
			query: null as unknown as SearchQuery
		});
		expect(r).toMatchObject({ kind: 'error', requestId: 1, revision: 3 });
	});

	it('10k fixture：空查詢與文字查詢皆回完整總數', () => {
		const { graph } = scaleFixture({ seed: 1, nodes: 10_000, edges: 20_000 });
		const store = new SearchStore();
		store.init(1, graph.nodes, { unprocessed: [], unreachable: [] });
		expect(store.query(q('')).total).toBe(10_000);
		const r = store.query(q('a'));
		expect(r.ids.length).toBe(Math.min(PAGE_SIZE, r.total));
		const naive = graph.nodes.filter((x) =>
			[x.id, x.name, x.type, nodeType(x.type)?.system ?? '通用', ...Object.entries(x.props).flat()]
				.map(normalize)
				.some((s) => s.includes('a'))
		);
		expect(r.total).toBe(naive.length);
	});
});
