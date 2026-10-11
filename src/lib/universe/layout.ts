// 3D 宇宙的座標：穩定 seed、拓撲變更後的 reconciliation、與 layout Worker 的訊息格式。
// 座標只代表暫時的版面，不代表地理位置或關係強度。

export type Position3 = [number, number, number];

/** 一次整理版面的計算預算（d3 tick 數）；達到即凍結，不保證收斂 */
export const LAYOUT_BUDGET = 100;
/** seed 球的基準半徑（同 d3-force-3d 的 phyllotaxis 起始點） */
const SEED_RADIUS = 10;
const ROLL = Math.PI * (3 - Math.sqrt(5));
const YAW = (Math.PI * 20) / (9 + Math.sqrt(221));
/** 新節點離鄰居重心的距離 */
const NEAR = 15;

/** FNV-1a 32-bit */
function fnv(s: string, h = 0x811c9dc5) {
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	return h >>> 0;
}

/** 有序 ID 清單的簽章（Worker 回覆比對用）；順序或成員不同就不同 */
export function idsKey(ids: readonly string[]): string {
	let h = 0x811c9dc5;
	for (const id of ids) h = Math.imul(fnv(id, h) ^ 0xffff, 0x01000193);
	return `${ids.length}:${(h >>> 0).toString(36)}`;
}

/**
 * 依 ID 排序後的名次放在 phyllotaxis 球上：同一組 ID 結果固定、與輸入順序無關；
 * 半徑隨名次嚴格遞增，所以任兩點不重合（Float32 精度下亦然，10 萬點內）。
 */
export function seedPositions(ids: readonly string[]): Map<string, Position3> {
	const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const out = new Map<string, Position3>();
	sorted.forEach((id, i) => {
		const r = SEED_RADIUS * Math.cbrt(0.5 + i);
		const roll = i * ROLL;
		const yaw = i * YAW;
		out.set(id, [
			r * Math.sin(roll) * Math.cos(yaw),
			r * Math.cos(roll),
			r * Math.sin(roll) * Math.sin(yaw)
		]);
	});
	return out;
}

/** 由 ID 決定的單位方向 */
function direction(id: string): Position3 {
	const u = fnv(id) / 2 ** 32;
	const v = fnv(id, 0x9e3779b9) / 2 ** 32;
	const z = 2 * u - 1;
	const s = Math.sqrt(1 - z * z);
	return [s * Math.cos(2 * Math.PI * v), s * Math.sin(2 * Math.PI * v), z];
}

export type Reconciled = { positions: Map<string, Position3>; added: string[]; removed: number };

/**
 * 拓撲改變後的座標：既有節點原封不動、刪除的移除；
 * 新節點放在已有座標的鄰居重心附近（鄰居也是新的就接在它旁邊），完全沒有鄰居的放在場外圍。
 * 決定性：同樣的輸入同樣的結果；第 k 個新點距離多 0.5k，彼此不重合。
 */
export function reconcile(
	prev: ReadonlyMap<string, Position3>,
	ids: readonly string[],
	neighbors: (id: string) => Iterable<string>
): Reconciled {
	const positions = new Map<string, Position3>();
	const pending: string[] = [];
	for (const id of ids) {
		const p = prev.get(id);
		if (p) positions.set(id, p);
		else pending.push(id);
	}
	const removed = prev.size - (ids.length - pending.length);
	const added = [...pending];
	let k = 0;
	const place = (id: string, c: Position3, base: number) => {
		const d = direction(id);
		const r = base + 0.5 * k++;
		positions.set(id, [c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r]);
	};
	// 鄰居有座標的先放；每輪至少放一個才繼續（新節點彼此相連時逐步接上）
	let rest = pending;
	while (rest.length) {
		const next: string[] = [];
		for (const id of rest) {
			const c: Position3 = [0, 0, 0];
			let n = 0;
			for (const o of neighbors(id)) {
				const q = o !== id ? positions.get(o) : undefined;
				if (!q) continue;
				c[0] += q[0];
				c[1] += q[1];
				c[2] += q[2];
				n++;
			}
			if (n) place(id, [c[0] / n, c[1] / n, c[2] / n], NEAR);
			else next.push(id);
		}
		if (next.length === rest.length) break;
		rest = next;
	}
	if (rest.length) {
		let outer = 0;
		for (const p of positions.values()) outer = Math.max(outer, Math.hypot(p[0], p[1], p[2]));
		for (const id of rest) place(id, [0, 0, 0], outer + 40);
	}
	return { positions, added, removed };
}

/** 依 ids 順序打包成 Float32Array（缺座標的 ID 是呼叫端錯誤） */
export function pack(ids: readonly string[], positions: ReadonlyMap<string, Position3>) {
	const out = new Float32Array(ids.length * 3);
	ids.forEach((id, i) => out.set(positions.get(id)!, i * 3));
	return out;
}

export function unpack(ids: readonly string[], arr: Float32Array): Map<string, Position3> {
	return new Map(
		ids.map((id, i) => [id, [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]] as Position3])
	);
}

// ---- Worker 協定 ----

/** 開始一次版面整理；positions／links 都是複本，會 transfer 給 Worker */
export type LayoutStart = {
	type: 'start';
	generation: number;
	topologyRevision: number;
	ids: string[];
	positions: Float32Array;
	/** 節點索引對（from, to, from, to, …） */
	links: Uint32Array;
	budget: number;
};
export type LayoutStop = { type: 'stop'; generation: number };
export type LayoutRequest = LayoutStart | LayoutStop;

type Stamp = { generation: number; topologyRevision: number; idsKey: string };
export type LayoutReply =
	| (Stamp & {
			type: 'progress' | 'done';
			tick: number;
			budget: number;
			positions: Float32Array;
			/** 此段每個 tick 的耗時（ms） */
			tickMs: number[];
	  })
	| (Stamp & { type: 'error'; message: string });
