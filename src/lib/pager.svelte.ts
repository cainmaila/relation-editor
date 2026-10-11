// 完整清單的分頁狀態：每頁 50，總數由呼叫端提供（可響應）。
// 總數縮小（拓撲編輯、資料變動）時頁碼自動限制在最後一頁，不出現空白末頁。

export const PAGE_SIZE = 50;

export class Pager {
	#page = $state(0);
	readonly #total: () => number;
	readonly size: number;

	constructor(total: () => number, size = PAGE_SIZE) {
		this.#total = total;
		this.size = size;
	}

	get total() {
		return this.#total();
	}
	get pages() {
		return Math.max(1, Math.ceil(this.total / this.size));
	}
	/** 目前頁（0 起算），永遠在 [0, pages) */
	get page() {
		return Math.min(this.#page, this.pages - 1);
	}
	get start() {
		return this.page * this.size;
	}
	get end() {
		return Math.min(this.total, this.start + this.size);
	}

	slice<T>(xs: readonly T[]): T[] {
		return xs.slice(this.start, this.end);
	}
	next() {
		this.#page = Math.min(this.page + 1, this.pages - 1);
	}
	prev() {
		this.#page = Math.max(this.page - 1, 0);
	}
	/** 把超出的頁碼寫回最後一頁，之後總數再長回來也停在這頁（PageNav 自動呼叫） */
	clamp() {
		if (this.#page > this.pages - 1) this.#page = this.pages - 1;
	}
	reset() {
		this.#page = 0;
	}
}
