import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { Editor } from '#lib/editor.svelte.js';
import SearchPalette from './SearchPalette.svelte';

const pad = (i: number) => String(i).padStart(3, '0');
/** 60 機櫃（空間）＋60 UPS（電力）＋5 攝影機（CCTV）；名稱都含「甲」，偶數另含「乙」 */
const graph = () => ({
	nodes: [
		...Array.from({ length: 60 }, (_, i) => ({
			id: `rack-${pad(i)}`,
			type: '機櫃',
			name: `甲${i % 2 ? '' : '乙'} 櫃 ${pad(i)}`,
			props: {}
		})),
		...Array.from({ length: 60 }, (_, i) => ({
			id: `ups-${pad(i)}`,
			type: 'UPS',
			name: `甲${i % 2 ? '' : '乙'} UPS ${pad(i)}`,
			props: {}
		})),
		...Array.from({ length: 5 }, (_, i) => ({
			id: `cam-${pad(i)}`,
			type: '攝影機',
			name: `甲 攝影機 ${pad(i)}`,
			props: {}
		}))
	],
	edges: []
});

let editor: Editor;
afterEach(() => editor?.search.dispose());

const dialog = () => page.getByRole('dialog', { name: '搜尋節點' });
const system = () => dialog().getByRole('combobox', { name: '篩選系統' });
const type = () => dialog().getByRole('combobox', { name: '篩選類型' });
const total = (n: number) => expect.element(dialog().getByText(`共 ${n} 筆`)).toBeInTheDocument();

describe('SearchPalette 系統／類型篩選', () => {
	it('系統、類型與文字組合；改條件回第一頁；3D 隱藏的系統仍可查', async () => {
		editor = new Editor(graph());
		// 3D 只顯示空間：搜尋篩選與 3D 系統勾選無關
		editor.systems = ['空間'];
		render(SearchPalette, { editor });
		await total(125);

		await system().selectOptions('電力');
		await total(60);
		expect(editor.palette.systems).toEqual(['電力']);
		expect(editor.systems).toEqual(['空間']);
		await expect.element(dialog().getByText('第 1 / 2 頁')).toBeInTheDocument();
		await dialog().getByRole('button', { name: '下一頁' }).click();
		await expect.element(dialog().getByText('第 2 / 2 頁')).toBeInTheDocument();

		// 文字＋系統：回到第一頁
		await dialog().getByRole('textbox', { name: '搜尋節點' }).fill('乙');
		await total(30);
		expect(editor.palette.offset).toBe(0);
		await expect.element(dialog().getByText('第 2 / 2 頁')).not.toBeInTheDocument();

		// 類型選單只列該系統的類型
		await expect
			.element(type().getByRole('option', { name: '機櫃', exact: true }))
			.not.toBeInTheDocument();
		await type().selectOptions('UPS');
		await total(30);
		expect(editor.palette.types).toEqual(['UPS']);

		// 換系統：不屬於新系統的類型清掉
		await system().selectOptions('CCTV');
		expect(editor.palette.types).toEqual([]);
		await dialog().getByRole('textbox', { name: '搜尋節點' }).fill('');
		await total(5);

		// 只選類型（不限系統）
		await system().selectOptions('');
		await type().selectOptions('機櫃');
		await total(60);
		await dialog().getByRole('button', { name: '下一頁' }).click();
		await expect.element(dialog().getByText('第 2 / 2 頁')).toBeInTheDocument();
		await type().selectOptions('');
		await total(125);
		expect(editor.palette.offset).toBe(0);
		await expect.element(dialog().getByText('第 1 / 3 頁')).toBeInTheDocument();
	});

	it('重新打開時篩選回到全部', async () => {
		editor = new Editor(graph());
		editor.palette.set({ systems: ['電力'], types: ['UPS'] });
		render(SearchPalette, { editor });
		await total(125);
		await expect.element(system()).toHaveValue('');
		await expect.element(type()).toHaveValue('');
	});
});
