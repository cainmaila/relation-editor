import { describe, expect, it } from 'vitest';
import { PAGE_SIZE, Pager } from './pager.svelte';

describe('Pager：完整清單每頁 50，不靜默截斷', () => {
	it('50 筆一頁、51 筆兩頁；最後一頁只剩 1 筆', () => {
		let total = $state(50);
		const p = new Pager(() => total);
		const xs = () => Array.from({ length: total }, (_, i) => i);
		expect(PAGE_SIZE).toBe(50);
		expect(p.pages).toBe(1);
		expect(p.slice(xs())).toHaveLength(50);
		total = 51;
		expect(p.pages).toBe(2);
		p.next();
		expect(p.page).toBe(1);
		expect(p.slice(xs())).toEqual([50]);
		p.next();
		expect(p.page).toBe(1);
	});

	it('總數縮小時頁碼限制在最後一頁，不出現空白末頁；空清單仍是第 1 頁', () => {
		let total = $state(120);
		const p = new Pager(() => total);
		p.next();
		p.next();
		expect(p.page).toBe(2);
		total = 60;
		expect(p.page).toBe(1);
		expect(p.start).toBe(50);
		// 之後的翻頁以限制後的頁碼為準
		p.prev();
		expect(p.page).toBe(0);
		total = 0;
		expect(p.pages).toBe(1);
		expect(p.page).toBe(0);
		expect(p.slice([])).toEqual([]);
	});

	it('clamp 把頁碼寫回：總數長回來仍停在限制後的頁', () => {
		let total = $state(120);
		const p = new Pager(() => total);
		p.next();
		p.next();
		total = 60;
		p.clamp();
		total = 120;
		expect(p.page).toBe(1);
	});

	it('reset 回第一頁', () => {
		const p = new Pager(() => 200);
		p.next();
		p.reset();
		expect(p.page).toBe(0);
	});
});
