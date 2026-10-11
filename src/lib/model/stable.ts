/**
 * 依 id 保留物件引用：內容（JSON 序列化）與上一次相同就沿用上一次的物件。
 * 畫布每次重算都會重建全部卡片／邊的物件；Svelte Flow 以物件引用判斷是否要重新採用、量測節點，
 * 改一張卡片的名稱若換掉 200 張卡片與 1,000 條邊的物件，提交回饋會被拖慢（P8 實測）。
 * 只用在可 JSON 序列化的純資料（函式、循環參照不適用）。
 */
export class StableById<T extends { id: string }> {
	#last = new Map<string, { key: string; value: T }>();

	get size() {
		return this.#last.size;
	}

	take(items: readonly T[]): T[] {
		const next = new Map<string, { key: string; value: T }>();
		const out = items.map((item) => {
			const key = JSON.stringify(item);
			const hit = this.#last.get(item.id);
			const value = hit && hit.key === key ? hit.value : item;
			next.set(item.id, { key, value });
			return value;
		});
		this.#last = next;
		return out;
	}
}
