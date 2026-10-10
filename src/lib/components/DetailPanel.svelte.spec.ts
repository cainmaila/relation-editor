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
