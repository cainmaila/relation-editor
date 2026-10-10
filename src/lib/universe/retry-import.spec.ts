import { describe, expect, it, vi } from 'vitest';
import { ImportReloadRequired, retryableImport } from './retry-import';

const chromeError = (url: string) =>
	new TypeError(`Failed to fetch dynamically imported module: ${url}`);

type Mod = { default: () => void };
const isMod = (m: unknown): m is Mod => typeof (m as Mod | null)?.default === 'function';
const good: Mod = { default: () => {} };
const ORIGIN = 'http://localhost:4173';
const ENTRY = `${ORIGIN}/_app/immutable/chunks/AqQsxjCL.js`;
const asset = (u: URL) => u.origin === ORIGIN && u.pathname.startsWith('/_app/immutable/');

function failingOnce(url: string) {
	return vi.fn(async (): Promise<unknown> => {
		throw chromeError(url);
	});
}

describe('retryableImport（動態載入失敗後可真正重試）', () => {
	it('第一次用原本的 loader；成功就不碰 URL 載入', async () => {
		const byUrl = vi.fn();
		const load = retryableImport(async () => good, { accept: isMod, asset, byUrl });
		await expect(load()).resolves.toBe(good);
		expect(byUrl).not.toHaveBeenCalled();
	});

	it('原本的 loader 給了不是預期的模組：明確失敗，不把它當成 T', async () => {
		const load = retryableImport(async () => ({ nope: 1 }), { accept: isMod, asset });
		await expect(load()).rejects.toThrow(/不是預期的模組/);
	});

	it('入口本身失敗後重試：瀏覽器記住了失敗的 module，所以換一個帶 retry 參數的 URL 再抓', async () => {
		const byUrl = vi.fn(async (u: string) => ({ ...good, from: u }));
		const load = retryableImport(failingOnce(ENTRY), { accept: isMod, asset, byUrl });
		await expect(load()).rejects.toThrow('Failed to fetch dynamically imported module');
		const r = (await load()) as Mod & { from: string };
		const u = new URL(r.from);
		expect(u.origin + u.pathname).toBe(ENTRY);
		expect(u.searchParams.get('retry')).toBe('1');
	});

	it('重試又是網路失敗（入口本身抓不到）：下一次換新的 retry 值；保留原有 query（dev 的 ?v=）', async () => {
		const url = `${ORIGIN}/node_modules/.vite/deps/3d-force-graph.js?v=abc`;
		const byUrl = vi.fn(async (u: string): Promise<unknown> => {
			throw chromeError(u);
		});
		const probe = vi.fn<(url: string) => Promise<boolean>>(async () => false);
		const load = retryableImport(failingOnce(url), {
			accept: isMod,
			asset: (u) => u.origin === ORIGIN,
			byUrl,
			probe
		});
		await expect(load()).rejects.toThrow(chromeError(url).message);
		await expect(load()).rejects.toThrow('retry=1');
		byUrl.mockImplementationOnce(async (u: string) => ({ ...good, from: u }));
		const r = (await load()) as Mod & { from: string };
		const u = new URL(r.from);
		expect(u.searchParams.get('v')).toBe('abc');
		expect(u.searchParams.get('retry')).toBe('2');
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it('錯誤指向的是依賴的共用 chunk（拿到的不是入口）：不回傳錯的 namespace，改丟「需要重新整理」，之後不再抓', async () => {
		const shared = `${ORIGIN}/_app/immutable/chunks/CHVpAPmZ.js`;
		const byUrl = vi.fn(async () => ({ WebGLRenderer: class {} }));
		const load = retryableImport(failingOnce(shared), { accept: isMod, asset, byUrl });
		await expect(load()).rejects.toThrow();
		const e = await load().catch((x: unknown) => x);
		expect(e).toBeInstanceOf(ImportReloadRequired);
		expect((e as ImportReloadRequired).url).toBe(shared);
		await expect(load()).rejects.toBeInstanceOf(ImportReloadRequired);
		expect(byUrl).toHaveBeenCalledTimes(1);
	});

	it('入口重抓仍失敗但入口本身抓得到（Chrome：依賴的共用 chunk 失敗被記住）：改丟「需要重新整理」，之後不再抓', async () => {
		const byUrl = vi.fn(async (u: string): Promise<unknown> => {
			throw chromeError(u);
		});
		const probe = vi.fn<(url: string) => Promise<boolean>>(async () => true);
		const load = retryableImport(failingOnce(ENTRY), { accept: isMod, asset, byUrl, probe });
		await expect(load()).rejects.toThrow();
		await expect(load()).rejects.toBeInstanceOf(ImportReloadRequired);
		expect(probe.mock.calls[0][0]).toBe(`${ENTRY}?retry=1`);
		await expect(load()).rejects.toBeInstanceOf(ImportReloadRequired);
		expect(byUrl).toHaveBeenCalledTimes(1);
	});

	it('錯誤裡的 URL 不是同源的預期資產：不去載入它，直接要求重新整理', async () => {
		const byUrl = vi.fn();
		for (const bad of [
			'https://evil.example/_app/immutable/chunks/x.js',
			`${ORIGIN}/api/other.js`,
			'javascript:alert(1)'
		]) {
			const load = retryableImport(failingOnce(bad), { accept: isMod, asset, byUrl });
			await expect(load()).rejects.toThrow();
			await expect(load()).rejects.toBeInstanceOf(ImportReloadRequired);
		}
		expect(byUrl).not.toHaveBeenCalled();
	});

	it('錯誤訊息裡沒有 URL（例如 Safari）：只能照原本方式再試，結果一樣要驗證', async () => {
		let n = 0;
		const byUrl = vi.fn();
		const load = retryableImport(
			async () => {
				if (n++ === 0) throw new TypeError('Importing a module script failed.');
				return good;
			},
			{ accept: isMod, asset, byUrl }
		);
		await expect(load()).rejects.toThrow();
		await expect(load()).resolves.toBe(good);
		expect(byUrl).not.toHaveBeenCalled();
	});
});
