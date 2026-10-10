// 動態載入（import()）失敗後，瀏覽器會在同一份文件記住那個 module 的失敗（HTML module map），
// 再呼叫同一個 import() 會直接拿到同樣的錯誤、不會重新抓。重試時改用帶 retry 參數的 URL 才是真的重抓。
// 只換失敗的那一個入口模組；它依賴的共用 chunk 用同樣的絕對 URL，仍與主程式共用同一份實例。
//
// 限制（瀏覽器 module map，無法在頁面內繞過）：失敗的若是入口「依賴的共用 chunk」，
// 那個 chunk 的 URL 已被記成失敗，入口換 URL 重抓時靜態 import 它仍是同一個 URL → 必定再失敗。
// 這種情況只有重新整理頁面能恢復；這裡明確丟 ImportReloadRequired，由 UI 告知（不自動重整：編輯會遺失）。
// 錯誤訊息的 URL 可能是依賴而非入口（依瀏覽器而定），所以重抓的結果一定用 accept 驗證，絕不把錯的模組當 T。

const URL_IN_MESSAGE = /imported module:?\s+(\S+)/i;

/** 在這份文件內無法再載入：必須重新整理頁面 */
export class ImportReloadRequired extends Error {
	constructor(
		readonly url: string | null,
		reason: string
	) {
		super(`需要重新整理頁面才能載入（${reason}）`);
		this.name = 'ImportReloadRequired';
	}
}

export type RetryImportOptions<T> = {
	/** 型別守門：確認拿到的是預期入口的 namespace（例如 default 是建構子） */
	accept: (m: unknown) => m is T;
	/** 錯誤訊息裡的 URL 是否是可以重抓的本站資產（同源、預期路徑） */
	asset: (u: URL) => boolean;
	byUrl?: (url: string) => Promise<unknown>;
	/** 入口本身現在抓得到嗎（用來區分「網路仍斷」與「依賴的失敗被瀏覽器記住」） */
	probe?: (url: string) => Promise<boolean>;
};

const headOk = async (url: string) => {
	try {
		return (await fetch(url, { method: 'HEAD', cache: 'no-store' })).ok;
	} catch {
		return false;
	}
};

/**
 * 包一個動態載入：第一次（及無法得知 URL 時）用原本的 loader；
 * 失敗且錯誤訊息帶有 module URL（Chrome、Firefox）時，之後改用「URL＋retry=n」載入。
 */
export function retryableImport<T>(
	loader: () => Promise<unknown>,
	{
		accept,
		asset,
		byUrl = (u) => import(/* @vite-ignore */ u),
		probe = headOk
	}: RetryImportOptions<T>
): () => Promise<T> {
	let failedUrl: string | null = null;
	let attempt = 0;
	let dead: ImportReloadRequired | null = null;
	const check = (m: unknown, url: string | null): T => {
		if (accept(m)) return m;
		// 錯誤訊息的 URL 是依賴的 chunk（不是入口）：拿到的是別的模組
		throw (dead = new ImportReloadRequired(
			url,
			'載入的不是預期的模組，失敗的可能是它依賴的共用模組'
		));
	};
	return async () => {
		if (dead) throw dead;
		if (!failedUrl) {
			let m: unknown;
			try {
				m = await loader();
			} catch (e) {
				const hit = URL_IN_MESSAGE.exec(e instanceof Error ? e.message : String(e));
				if (hit) {
					let u: URL | null = null;
					try {
						u = new URL(hit[1]);
					} catch {
						/* 不是 URL：當作沒有 */
					}
					if (u && asset(u)) failedUrl = u.href;
					else dead = new ImportReloadRequired(hit[1], '失敗的模組不是本站預期的資產，不重抓');
				}
				throw e;
			}
			if (accept(m)) return m;
			throw new TypeError('動態載入的結果不是預期的模組');
		}
		const u = new URL(failedUrl);
		u.searchParams.set('retry', String(++attempt));
		let m: unknown;
		try {
			m = await byUrl(u.href);
		} catch (e) {
			// 入口本身抓得到卻仍失敗＝依賴的失敗被記住（或模組本身壞了）：再試也一樣
			if (await probe(u.href))
				throw (dead = new ImportReloadRequired(failedUrl, '依賴的共用模組失敗已被瀏覽器記住'));
			throw e;
		}
		return check(m, failedUrl);
	};
}

/**
 * 平行載入多個 retryableImport：等「全部」結束才回報。
 * Promise.all 會在第一個失敗時就回報，其他載入還在進行、尚未記下自己的失敗 URL；
 * 這時按重試，那個 loader 仍走原本的 import()（瀏覽器回傳同一個進行中／已失敗的 module）→ 重試被浪費成普通錯誤。
 * 多個都失敗時以 ImportReloadRequired 優先：無法恢復的原因不能被普通錯誤蓋掉（否則畫面又給一個不會成功的重試）。
 */
export async function importAll<const P extends readonly Promise<unknown>[]>(
	loads: P
): Promise<{ -readonly [K in keyof P]: Awaited<P[K]> }> {
	const rs = await Promise.allSettled(loads);
	const failed = rs.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
	if (failed.length) throw failed.find((e) => e instanceof ImportReloadRequired) ?? failed[0];
	return rs.map((r) => (r as PromiseFulfilledResult<unknown>).value) as {
		-readonly [K in keyof P]: Awaited<P[K]>;
	};
}
