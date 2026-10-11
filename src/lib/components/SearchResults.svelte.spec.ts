import { page } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { Editor } from '#lib/editor.svelte.js';
import SearchResults from './SearchResults.svelte';

const graph = () => ({
	nodes: Array.from({ length: 123 }, (_, i) => ({
		id: `r-${String(i).padStart(3, '0')}`,
		type: '機櫃',
		name: `機櫃 ${String(i).padStart(3, '0')}`,
		props: {}
	})),
	edges: []
});

let editor: Editor;
afterEach(() => editor?.search.dispose());

function setup(props: { selectable?: boolean } = {}) {
	editor = new Editor(graph());
	const onpick = vi.fn();
	render(SearchResults, {
		controller: editor.palette,
		node: editor.node,
		label: '結果',
		onpick,
		...props
	});
	editor.palette.set({ text: '機櫃' });
	return onpick;
}
const list = () => page.getByRole('list', { name: '結果' });
const rows = () => list().getByRole('listitem');

describe('SearchResults', () => {
	it('顯示完整總數、每頁 50 筆，可走到最後一頁再回來', async () => {
		setup();
		await expect.element(page.getByText('共 123 筆')).toBeInTheDocument();
		expect(rows().all()).toHaveLength(50);
		await expect.element(page.getByText('第 1 / 3 頁')).toBeInTheDocument();
		await page.getByRole('button', { name: '下一頁' }).click();
		await expect.element(page.getByText('51–100')).toBeInTheDocument();
		await expect.element(list().getByText('機櫃 050')).toBeInTheDocument();
		await page.getByRole('button', { name: '下一頁' }).click();
		await expect.element(page.getByText('第 3 / 3 頁')).toBeInTheDocument();
		expect(rows().all()).toHaveLength(23);
		await expect.element(list().getByText('機櫃 122')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: '下一頁' })).toBeDisabled();
		await page.getByRole('button', { name: '上一頁' }).click();
		await expect.element(page.getByText('51–100')).toBeInTheDocument();
	});

	it('點列＝主要動作（定位），不改勾選', async () => {
		const onpick = setup({ selectable: true });
		await page.getByRole('button', { name: '機櫃 003' }).click();
		expect(onpick).toHaveBeenCalledWith('r-003');
		expect(editor.palette.picked).toEqual([]);
	});

	it('跨頁勾選保留，主動清除才取消', async () => {
		setup({ selectable: true });
		await page.getByRole('checkbox', { name: '勾選 機櫃 001' }).click();
		await page.getByRole('button', { name: '下一頁' }).click();
		await page.getByRole('checkbox', { name: '勾選 機櫃 060' }).click();
		await expect.element(page.getByText('已選 2')).toBeInTheDocument();
		await page.getByRole('button', { name: '上一頁' }).click();
		await expect.element(page.getByRole('checkbox', { name: '勾選 機櫃 001' })).toBeChecked();
		editor.palette.set({ text: '不存在' });
		await expect.element(page.getByText('沒有符合的節點')).toBeInTheDocument();
		await expect.element(page.getByText('已選 2')).toBeInTheDocument();
		await page.getByRole('button', { name: '清除已選' }).click();
		expect(editor.palette.picked).toEqual([]);
	});

	it('資料變更後立即顯示更新中，新版本回來才顯示結果', async () => {
		setup();
		await expect.element(page.getByText('共 123 筆')).toBeInTheDocument();
		editor.execute({ kind: 'deleteNode', id: 'r-000' });
		await expect.element(page.getByText('更新中…')).toBeInTheDocument();
		await expect.element(page.getByText('共 122 筆')).toBeInTheDocument();
		await expect.element(list().getByText('機櫃 000')).not.toBeInTheDocument();
	});

	it('服務錯誤時顯示原因，可重試', async () => {
		editor = new Editor(graph(), {
			searchWorker: () => {
				const w = {
					onmessage: null,
					onerror: null as ((e: Event) => void) | null,
					postMessage: () =>
						setTimeout(() => w.onerror?.(new ErrorEvent('error', { message: '壞了' }))),
					terminate() {}
				};
				return w;
			}
		});
		render(SearchResults, {
			controller: editor.palette,
			node: editor.node,
			label: '結果',
			onpick: () => {}
		});
		editor.palette.set({ text: '' });
		await expect.element(page.getByRole('alert')).toHaveTextContent('搜尋失敗：壞了');
		await expect.element(page.getByRole('button', { name: '重試' })).toBeInTheDocument();
	});
});
