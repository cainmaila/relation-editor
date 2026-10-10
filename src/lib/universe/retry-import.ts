// 動態載入（import()）失敗後，瀏覽器會在同一份文件記住那個 module 的失敗（HTML module map），
// 再呼叫同一個 import() 會直接拿到同樣的錯誤、不會重新抓。重試時改用帶 retry 參數的 URL 才是真的重抓。
// 只換失敗的那一個入口模組；它依賴的共用 chunk 用同樣的絕對 URL，仍與主程式共用同一份實例。

const URL_IN_MESSAGE = /imported module:?\s+(\S+)/i;

/**
 * 包一個動態載入：第一次（及無法得知 URL 時）用原本的 loader；
 * 失敗且錯誤訊息帶有 module URL（Chrome、Firefox）時，之後改用「URL＋retry=n」載入。
 */
export function retryableImport<T>(
	loader: () => Promise<T>,
	byUrl: (url: string) => Promise<T> = (u) => import(/* @vite-ignore */ u)
): () => Promise<T> {
	let failedUrl: string | null = null;
	let attempt = 0;
	return async () => {
		try {
			if (!failedUrl) return await loader();
			const u = new URL(failedUrl);
			u.searchParams.set('retry', String(++attempt));
			return await byUrl(u.href);
		} catch (e) {
			if (!failedUrl) {
				const m = URL_IN_MESSAGE.exec(e instanceof Error ? e.message : String(e));
				if (m) failedUrl = m[1];
			}
			throw e;
		}
	};
}
