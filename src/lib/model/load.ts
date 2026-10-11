// 執行期讀 static/data：先抓 index.json 清單，再平行抓全部 CSV。部署後換檔、重新整理即生效。
import { asset } from '$app/paths';
import { buildGraph } from './csv';
import type { Graph } from './types';

export async function loadGraph(fetch: typeof globalThis.fetch): Promise<Graph> {
	const get = async (path: string) => {
		const res = await fetch(asset(`/data/${path}` as never));
		if (!res.ok) throw new Error(`讀不到 /data/${path}（HTTP ${res.status}）`);
		return res.text();
	};
	const index: string[] = JSON.parse(await get('index.json'));
	const texts = await Promise.all(index.map(get));
	return buildGraph(index.map((path, i) => [path, texts[i]]));
}
