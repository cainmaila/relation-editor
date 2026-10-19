// 資料來源：Tauri 下優先讀使用者選過的本機資料夾（結構同 static/data）；沒選過、或在瀏覽器／測試下，讀內建的 static/data。
import { asset } from '$app/paths';
import { isTauri } from '@tauri-apps/api/core';
import { buildGraph } from './csv';
import type { Graph } from './types';

const DIR_KEY = 'dataDir';

export const dataDir = () => (isTauri() ? localStorage.getItem(DIR_KEY) : null);

/** 以對話框選資料夾；選到的資料夾才會被授予讀寫範圍（見 capabilities/default.json） */
async function pickDir(): Promise<string | null> {
	const { open } = await import('@tauri-apps/plugin-dialog');
	const dir = await open({ directory: true });
	return typeof dir === 'string' ? dir : null;
}

async function readDir(dir: string): Promise<[string, string][]> {
	const { readTextFile } = await import('@tauri-apps/plugin-fs');
	const { join } = await import('@tauri-apps/api/path');
	const get = async (path: string) => {
		try {
			return await readTextFile(await join(dir, path));
		} catch (e) {
			throw new Error(`讀不到 ${dir} 內的 ${path}（${e}）`, { cause: e });
		}
	};
	const index: unknown = JSON.parse(await get('index.json'));
	// 只接受資料夾內的相對路徑
	if (
		!Array.isArray(index) ||
		!index.every((p) => typeof p === 'string' && !/^[/\\]|\.\.|\\/.test(p))
	)
		throw new Error('index.json 必須是資料夾內相對路徑的字串陣列');
	const texts = await Promise.all(index.map(get));
	return index.map((path, i) => [path, texts[i]]);
}

export async function loadGraph(fetch: typeof globalThis.fetch): Promise<Graph> {
	const dir = dataDir();
	if (dir) {
		try {
			return buildGraph(await readDir(dir));
		} catch (e) {
			// 壞資料夾不能卡死：忘掉它，下次開啟回到內建範例
			localStorage.removeItem(DIR_KEY);
			throw new Error(`${(e as Error).message}。已取消資料夾設定，重新開啟會改用內建範例`, {
				cause: e
			});
		}
	}
	const get = async (path: string) => {
		const res = await fetch(asset(`/data/${path}` as never));
		if (!res.ok) throw new Error(`讀不到 /data/${path}（HTTP ${res.status}）`);
		return res.text();
	};
	const index: string[] = JSON.parse(await get('index.json'));
	const texts = await Promise.all(index.map(get));
	return buildGraph(index.map((path, i) => [path, texts[i]]));
}

/** 寫入目前資料夾（尚未選過就先問）；成功回傳 true，使用者取消回傳 false，失敗丟錯 */
export async function saveFiles(files: [path: string, text: string][]): Promise<boolean> {
	const dir = dataDir() ?? (await pickDir());
	if (!dir) return false;
	const { writeTextFile, mkdir } = await import('@tauri-apps/plugin-fs');
	const { join, dirname } = await import('@tauri-apps/api/path');
	for (const [path, text] of files) {
		const file = await join(dir, path);
		await mkdir(await dirname(file), { recursive: true });
		await writeTextFile(file, text);
	}
	localStorage.setItem(DIR_KEY, dir);
	return true;
}

/** 選另一個資料夾並重新載入 */
export async function openFolder(): Promise<void> {
	const dir = await pickDir();
	if (!dir) return;
	localStorage.setItem(DIR_KEY, dir);
	location.reload();
}
