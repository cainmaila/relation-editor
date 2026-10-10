import { describe, expect, it, vi } from 'vitest';
import { retryableImport } from './retry-import';

const chromeError = (url: string) =>
	new TypeError(`Failed to fetch dynamically imported module: ${url}`);

describe('retryableImport（動態載入失敗後可真正重試）', () => {
	it('第一次用原本的 loader；成功就不碰 URL 載入', async () => {
		const byUrl = vi.fn();
		const load = retryableImport(async () => ({ ok: 1 }), byUrl);
		await expect(load()).resolves.toEqual({ ok: 1 });
		expect(byUrl).not.toHaveBeenCalled();
	});

	it('失敗後重試：瀏覽器記住了失敗的 module，所以換一個帶 retry 參數的 URL 再抓', async () => {
		const url = 'http://localhost:4173/_app/immutable/chunks/AqQsxjCL.js';
		const loader = vi.fn(async () => {
			throw chromeError(url);
		});
		const byUrl = vi.fn(async (u: string) => ({ from: u }));
		const load = retryableImport(loader, byUrl);
		await expect(load()).rejects.toThrow('Failed to fetch dynamically imported module');
		const r = (await load()) as { from: string };
		expect(loader).toHaveBeenCalledTimes(1);
		const u = new URL(r.from);
		expect(u.origin + u.pathname).toBe(url);
		expect(u.searchParams.get('retry')).toBe('1');
	});

	it('重試又失敗：下一次換新的 retry 值；保留原有 query（dev 的 ?v=）', async () => {
		const url = 'http://localhost:5173/node_modules/.vite/deps/3d-force-graph.js?v=abc';
		const byUrl = vi.fn(async (u: string): Promise<unknown> => {
			throw chromeError(u);
		});
		const load = retryableImport(async () => {
			throw chromeError(url);
		}, byUrl);
		await expect(load()).rejects.toThrow();
		await expect(load()).rejects.toThrow();
		byUrl.mockImplementationOnce(async (u: string) => ({ from: u }));
		const r = (await load()) as { from: string };
		const u = new URL(r.from);
		expect(u.searchParams.get('v')).toBe('abc');
		expect(u.searchParams.get('retry')).toBe('2');
	});

	it('錯誤訊息裡沒有 URL（例如 Safari）：只能照原本方式再試', async () => {
		let n = 0;
		const byUrl = vi.fn();
		const load = retryableImport(async () => {
			if (n++ === 0) throw new TypeError('Importing a module script failed.');
			return 'ok';
		}, byUrl);
		await expect(load()).rejects.toThrow();
		await expect(load()).resolves.toBe('ok');
		expect(byUrl).not.toHaveBeenCalled();
	});
});
