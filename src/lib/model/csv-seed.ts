// 測試與實驗用的同步資料來源：建置時把 static/data 讀進來，內容與正式頁面執行期 fetch 到的相同。
import { buildGraph } from './csv';
import index from '../../../static/data/index.json';

const raw = import.meta.glob('../../../static/data/**/*.csv', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

export const csvSeed = () =>
	buildGraph(
		(index as string[]).map((p) => [p, raw[`../../../static/data/${p}`]] as [string, string])
	);
