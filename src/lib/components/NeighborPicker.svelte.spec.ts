import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { Editor } from '#lib/editor.svelte.js';
import { WORKSPACE_NODE_LIMIT } from '#lib/model/workspace.js';
import NeighborPicker from './NeighborPicker.svelte';

const pad = (i: number) => String(i).padStart(3, '0');
/** hub 連出 70 個機櫃（包含）、連入 3 支攝影機（監測）；機櫃彼此不相連，另有 200 個孤立節點 */
const graph = () => ({
	nodes: [
		{ id: 'hub', type: '通用節點', name: 'hub', props: {} },
		...Array.from({ length: 70 }, (_, i) => ({
			id: `rack-${pad(i)}`,
			type: '機櫃',
			name: `櫃 ${pad(i)}`,
			props: {}
		})),
		...Array.from({ length: 3 }, (_, i) => ({
			id: `cam-${i}`,
			type: '攝影機',
			name: `攝影機 ${i}`,
			props: {}
		})),
		...Array.from({ length: 200 }, (_, i) => ({
			id: `x-${pad(i)}`,
			type: '通用節點',
			name: `孤立 ${pad(i)}`,
			props: {}
		}))
	],
	edges: [
		...Array.from({ length: 70 }, (_, i) => ({
			id: `c-${i}`,
			type: '包含',
			from: 'hub',
			to: `rack-${pad(i)}`,
			bidirectional: false,
			props: {}
		})),
		...Array.from({ length: 3 }, (_, i) => ({
			id: `m-${i}`,
			type: '監測',
			from: `cam-${i}`,
			to: 'hub',
			bidirectional: false,
			props: {}
		}))
	]
});

let editor: Editor;
afterEach(() => editor?.search.dispose());

const box = () => page.getByRole('region', { name: '鄰居預覽' });
const rows = () => box().getByRole('checkbox');

describe('NeighborPicker 一跳鄰居預覽', () => {
	it('方向／邊類型篩選、每頁 50、完整外部數；預設不勾，不自動加入', async () => {
		editor = new Editor(graph());
		editor.addToWork(['hub']);
		render(NeighborPicker, { editor, id: 'hub' });
		await expect.element(box().getByText('編輯頁外 73 個鄰居')).toBeInTheDocument();
		await expect.element(box().getByText('共 73 個')).toBeInTheDocument();
		await expect.poll(() => rows().elements().length).toBe(50);
		for (const r of rows().all()) await expect.element(r).not.toBeChecked();
		expect(editor.working).toEqual(['hub']);

		await box().getByRole('button', { name: '下一頁' }).click();
		await expect.poll(() => rows().elements().length).toBe(23);

		await box().getByRole('combobox', { name: '方向' }).selectOptions('in');
		await expect.element(box().getByText('共 3 個')).toBeInTheDocument();
		await box().getByRole('combobox', { name: '方向' }).selectOptions('all');
		await box().getByRole('combobox', { name: '邊類型' }).selectOptions('監測');
		await expect.element(box().getByText('共 3 個')).toBeInTheDocument();
		expect(editor.working).toEqual(['hub']);
	});

	it('明確「勾選本頁前 20 個」後才預覽；按加入原子提交並顯示新增節點與邊數', async () => {
		editor = new Editor(graph());
		editor.addToWork(['hub']);
		render(NeighborPicker, { editor, id: 'hub' });
		await box().getByRole('button', { name: '勾選本頁前 20 個' }).click();
		expect(editor.working).toEqual(['hub']);
		await expect.element(box().getByText('將新增 20 個節點、帶入 20 條邊')).toBeInTheDocument();
		await box().getByRole('button', { name: '加入勾選的 20 個' }).click();
		expect(editor.working).toHaveLength(21);
		// 依 ID 排序：3 支攝影機在前
		expect(editor.working.slice(1)).toEqual([
			'cam-0',
			'cam-1',
			'cam-2',
			...Array.from({ length: 17 }, (_, i) => `rack-${pad(i)}`)
		]);
		await expect.element(box().getByText('編輯頁外 53 個鄰居')).toBeInTheDocument();
		// 已在工作區的鄰居不可再勾
		await expect.element(rows().first()).toBeDisabled();
	});

	it('超過預算時預覽顯示原因、加入停用；工作區不變', async () => {
		editor = new Editor(graph());
		const filler = Array.from({ length: WORKSPACE_NODE_LIMIT - 10 }, (_, i) => `x-${pad(i)}`);
		editor.addToWork(['hub', ...filler]);
		render(NeighborPicker, { editor, id: 'hub' });
		await box().getByRole('button', { name: '勾選本頁前 20 個' }).click();
		await expect
			.element(box().getByText('編輯頁最多 200 個節點：要新增 20 個，只剩 9 個名額'))
			.toBeInTheDocument();
		await expect.element(box().getByRole('button', { name: /^加入勾選/ })).toBeDisabled();
		expect(editor.working).toHaveLength(WORKSPACE_NODE_LIMIT - 9);
	});

	it('同一節點的鄰居縮減（拓撲編輯）：停在第 2 頁時頁碼限制回最後一頁，不出現空白頁', async () => {
		editor = new Editor(graph());
		editor.addToWork(['hub', ...Array.from({ length: 70 }, (_, i) => `rack-${pad(i)}`)]);
		editor.setPage('edit');
		render(NeighborPicker, { editor, id: 'hub' });
		await box().getByRole('button', { name: '下一頁' }).click();
		await expect.element(box().getByText('第 2 / 2 頁')).toBeInTheDocument();
		// 刪到只剩 50 個鄰居（3 支攝影機＋47 個機櫃）
		for (let i = 47; i < 70; i++) expect(editor.deleteEdge(`c-${i}`)).toBe(true);
		await expect.element(box().getByText('共 50 個')).toBeInTheDocument();
		await expect.poll(() => rows().elements().length).toBe(50);
		await expect.element(box().getByRole('button', { name: '下一頁' })).not.toBeInTheDocument();
		// 再加回一條：51 個，回到可翻頁，仍在第 1 頁
		expect(editor.addEdge('hub', 'rack-047', '包含')).toBe(true);
		await expect.element(box().getByText('第 1 / 2 頁')).toBeInTheDocument();
	});
});
