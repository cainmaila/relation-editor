import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { Editor } from '#lib/editor.svelte.js';
import DetailPanel from './DetailPanel.svelte';

const graph = () => ({
	nodes: [
		{ id: 'a', type: '通用節點', name: '甲', props: {} },
		{ id: 'b', type: '通用節點', name: '乙', props: {} }
	],
	edges: [{ id: 'ab', type: '包含', from: 'a', to: 'b', bidirectional: false, props: {} }]
});

describe('DetailPanel：工作區外的詳情', () => {
	it('工作區外端點的連結點了會明確說明；「將兩端加入編輯頁」加入後可編輯', async () => {
		const e = new Editor(graph());
		e.addToWork(['a']);
		e.setPage('edit');
		e.select({ kind: 'edge', id: 'ab' });
		render(DetailPanel, { editor: e });
		await expect.element(page.getByRole('combobox', { name: '方向' })).toBeDisabled();
		await page.getByRole('button', { name: '終點：乙' }).click();
		expect(e.message).toBe('「乙」不在編輯頁：先將兩端加入編輯頁才能定位');
		expect(e.working).toEqual(['a']);
		await page.getByRole('button', { name: '將兩端加入編輯頁' }).click();
		expect(e.working).toEqual(['a', 'b']);
		expect(e.selected).toEqual({ kind: 'edge', id: 'ab' });
		await expect.element(page.getByRole('combobox', { name: '方向' })).toBeEnabled();
		await expect
			.element(page.getByRole('button', { name: '將兩端加入編輯頁' }))
			.not.toBeInTheDocument();
	});

	it('經其他路徑選到工作區外的節點：唯讀，只能先加入編輯頁', async () => {
		const e = new Editor(graph());
		e.addToWork(['a']);
		e.setPage('edit');
		e.select({ kind: 'node', id: 'b' });
		render(DetailPanel, { editor: e });
		await expect.element(page.getByRole('textbox', { name: '名稱', exact: true })).toBeDisabled();
		await expect.element(page.getByText('不在編輯頁：先加入編輯頁才能修改')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: '刪除節點' })).not.toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: '移出工作區' })).not.toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: '新增屬性' })).not.toBeInTheDocument();
		await page.getByRole('button', { name: '加入編輯頁', exact: true }).click();
		expect(e.working).toEqual(['a', 'b']);
		await expect.element(page.getByRole('textbox', { name: '名稱', exact: true })).toBeEnabled();
		await expect.element(page.getByRole('button', { name: '刪除節點' })).toBeInTheDocument();
	});
});

const pad = (i: number) => String(i).padStart(3, '0');
/** src 連到 n 位客戶（第 0、1 位同名）；另有 fill 個孤立節點用來吃工作區預算 */
const fan = (n: number, fill = 0) => ({
	nodes: [
		{ id: 'src', type: '通用節點', name: '起點', props: {} },
		...Array.from({ length: n }, (_, i) => ({
			id: `cu-${pad(i)}`,
			type: '客戶',
			name: i < 2 ? '同名客戶' : `客戶 ${pad(i)}`,
			props: {}
		})),
		...Array.from({ length: fill }, (_, i) => ({
			id: `x-${pad(i)}`,
			type: '通用節點',
			name: `孤立 ${pad(i)}`,
			props: {}
		}))
	],
	edges: Array.from({ length: n }, (_, i) => ({
		id: `s-${pad(i)}`,
		type: '包含',
		from: 'src',
		to: `cu-${pad(i)}`,
		bidirectional: false,
		props: {}
	}))
});

describe('DetailPanel P7：完整清單分頁與追查', () => {
	const trace = () => page.getByRole('region', { name: '找客戶結果' });
	const chips = () => trace().getByRole('list', { name: '客戶' }).getByRole('button');

	it('客戶 50 筆一頁不出翻頁；51 筆兩頁、末頁 1 筆；同名客戶依 ID 分開顯示', async () => {
		const e = new Editor(fan(50));
		e.findCustomers('src');
		const { unmount } = render(DetailPanel, { editor: e });
		await expect.element(trace().getByText('共 50 位客戶')).toBeInTheDocument();
		await expect.poll(() => chips().elements().length).toBe(50);
		await expect.element(trace().getByRole('button', { name: '下一頁' })).not.toBeInTheDocument();
		unmount();
		e.search.dispose();

		const f = new Editor(fan(51));
		f.findCustomers('src');
		render(DetailPanel, { editor: f });
		await expect.element(trace().getByText('共 51 位客戶')).toBeInTheDocument();
		const nav = trace().getByRole('navigation', { name: '客戶分頁' });
		await expect.element(nav.getByText('第 1 / 2 頁')).toBeInTheDocument();
		await expect.poll(() => chips().elements().length).toBe(50);
		await expect
			.element(trace().getByRole('button', { name: '同名客戶（cu-000）' }))
			.toBeInTheDocument();
		await expect
			.element(trace().getByRole('button', { name: '同名客戶（cu-001）' }))
			.toBeInTheDocument();
		await nav.getByRole('button', { name: '下一頁' }).click();
		await expect.poll(() => chips().elements().length).toBe(1);
		await expect.element(nav.getByText('第 2 / 2 頁')).toBeInTheDocument();
		f.search.dispose();
	});

	it('連出 51 條分頁；停在末頁時刪邊縮成 50 條，自動回到最後一頁不留空白', async () => {
		const e = new Editor(fan(51));
		e.addToWork(['src', ...Array.from({ length: 51 }, (_, i) => `cu-${pad(i)}`)]);
		e.setPage('edit');
		e.select({ kind: 'node', id: 'src' });
		render(DetailPanel, { editor: e });
		const out = page.getByRole('region', { name: '連出' });
		await expect.element(out.getByText('連出（51）')).toBeInTheDocument();
		await out.getByRole('button', { name: '下一頁' }).click();
		await expect.element(out.getByText('第 2 / 2 頁')).toBeInTheDocument();
		await expect.poll(() => out.getByRole('listitem').elements().length).toBe(1);
		// 走原子命令改拓撲、不動選取（例如另一處刪邊），清單總數縮小
		expect(e.execute({ kind: 'deleteEdge', id: 's-050' })).toBe(true);
		expect(e.selected).toEqual({ kind: 'node', id: 'src' });
		await expect.element(out.getByText('連出（50）')).toBeInTheDocument();
		await expect.poll(() => out.getByRole('listitem').elements().length).toBe(50);
		e.search.dispose();
	});

	it('追查結果文案是完整查詢總數，不宣稱全部已亮起；說明畫布繪製上限與系統篩選', async () => {
		const e = new Editor(fan(3));
		e.findCustomers('src');
		render(DetailPanel, { editor: e });
		await expect.element(trace().getByText('完整查詢：沿途 4 個節點、3 條邊')).toBeInTheDocument();
		await expect.element(trace().getByText(/畫布高亮最多畫 2,000 條/)).toBeInTheDocument();
		await expect.element(trace().getByText('沿途關係（3）')).toBeInTheDocument();
		await expect.element(trace().getByText(/已亮起/)).not.toBeInTheDocument();
		e.search.dispose();
	});

	it('點客戶 chip：客戶所屬系統（IDC）被隱藏也會勾回並選取，完整追查不變', async () => {
		const e = new Editor(fan(3));
		e.findCustomers('src');
		e.systems = e.systems.filter((s) => s !== 'IDC');
		expect(e.graphVisible.nodes.some((n) => n.id === 'cu-002')).toBe(false);
		const before = { ...e.result!, nodes: [...e.result!.nodes], edges: [...e.result!.edges] };
		render(DetailPanel, { editor: e });
		await trace().getByRole('button', { name: '客戶 002' }).click();
		expect(e.systems).toContain('IDC');
		expect(e.graphVisible.nodes.some((n) => n.id === 'cu-002')).toBe(true);
		expect(e.selected).toEqual({ kind: 'node', id: 'cu-002' });
		expect(e.trace?.source).toBe('src');
		expect([...e.result!.nodes]).toEqual(before.nodes);
		expect([...e.result!.edges]).toEqual(before.edges);
		expect(e.result!.customerIds).toEqual(before.customerIds);
		await expect.element(trace()).toBeInTheDocument();
		e.search.dispose();
	});

	it('連出 51 條停在第 2 頁 → 縮成 1 條（翻頁消失）→ 長回 51 條：停在第 1 頁，不跳回舊頁', async () => {
		// 可合法重建的邊：偵測器 →監測→ 通用節點
		const g = {
			nodes: [
				{ id: 'src', type: '偵測器', name: '偵測器', props: {} },
				...Array.from({ length: 51 }, (_, i) => ({
					id: `g-${pad(i)}`,
					type: '通用節點',
					name: `節點 ${pad(i)}`,
					props: {}
				}))
			],
			edges: Array.from({ length: 51 }, (_, i) => ({
				id: `m-${pad(i)}`,
				type: '監測',
				from: 'src',
				to: `g-${pad(i)}`,
				bidirectional: false,
				props: {}
			}))
		};
		const e = new Editor(g);
		e.addToWork(g.nodes.map((n) => n.id));
		e.setPage('edit');
		e.select({ kind: 'node', id: 'src' });
		render(DetailPanel, { editor: e });
		const out = page.getByRole('region', { name: '連出' });
		await out.getByRole('button', { name: '下一頁' }).click();
		await expect.element(out.getByText('第 2 / 2 頁')).toBeInTheDocument();
		for (const edge of g.edges.slice(1))
			expect(e.execute({ kind: 'deleteEdge', id: edge.id })).toBe(true);
		await expect.element(out.getByText('連出（1）')).toBeInTheDocument();
		await expect.element(out.getByRole('navigation')).not.toBeInTheDocument();
		for (const edge of g.edges.slice(1)) expect(e.execute({ kind: 'addEdge', edge })).toBe(true);
		await expect.element(out.getByText('連出（51）')).toBeInTheDocument();
		await expect.element(out.getByText('第 1 / 2 頁')).toBeInTheDocument();
		await expect.poll(() => out.getByRole('listitem').elements().length).toBe(50);
		e.search.dispose();
	});

	it('從追查點一條關係：單獨選取、追查保留；兩端加入受 200 預算限制，失敗什麼都不改', async () => {
		const e = new Editor(fan(3, 199));
		e.addToWork(Array.from({ length: 199 }, (_, i) => `x-${pad(i)}`));
		e.findCustomers('src');
		render(DetailPanel, { editor: e });
		await trace().getByText('沿途關係（3）').click();
		const rels = trace().getByRole('list', { name: '沿途關係' });
		await rels
			.getByRole('button', { name: /同名客戶/ })
			.first()
			.click();
		expect(e.selected).toEqual({ kind: 'edge', id: 's-000' });
		await expect.element(trace()).toBeInTheDocument();
		expect(e.result?.edges.size).toBe(3);
		await trace().getByRole('button', { name: '兩端加入編輯頁' }).click();
		expect(e.message).toBe('工作區最多 200 個節點：要新增 2 個，只剩 1 個名額');
		expect(e.working).toHaveLength(199);
		expect(e.selected).toEqual({ kind: 'edge', id: 's-000' });
		await expect.element(trace()).toBeInTheDocument();
		// 騰出名額後同一個按鈕成功，選取與追查都還在
		e.removeFromWork(['x-000']);
		await trace().getByRole('button', { name: '兩端加入編輯頁' }).click();
		expect(e.inWork('src') && e.inWork('cu-000')).toBe(true);
		await expect.element(trace().getByText('已在編輯頁')).toBeInTheDocument();
		expect(e.result?.customerIds).toHaveLength(3);
		e.search.dispose();
	});
});
