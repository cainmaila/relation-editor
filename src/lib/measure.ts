// 量測入口（/measure）專用的探針：只有該路由會建立並傳給 GraphView，正式頁面不帶。
import type { WebGLRenderer } from 'three';
import type { LayoutInit } from './layout-sim';

export type Mark = { name: string; t: number; detail?: Record<string, unknown> };

export interface GraphProbe {
	mark(name: string, detail?: Record<string, unknown>): void;
	renderer(r: WebGLRenderer): void;
}

type MarkSink = Pick<Performance, 'mark' | 'clearMarks'>;

/**
 * 量測 marker 紀錄。預設保留完整歷史（冷啟動與 P1–P8 量測都依賴 marks 陣列與 Performance 時間軸）。
 * 長時間穩定性量測可呼叫 setHistory(false)：之後同名 marker 只累加 counts，不再 push 進陣列，
 * 也不再寫進 Performance 時間軸；每個名稱第一次出現（冷啟動 marker）一律保留。
 * 關閉時會把已記錄的重複項壓掉（陣列原地縮短、時間軸以原時間戳重建），所以 marks 與時間軸
 * 的大小上限＝不同 marker 名稱的數量，counts 也只隨名稱數成長。
 */
export function createMarkLog(now: () => number = () => performance.now(), sink?: MarkSink) {
	const out = sink ?? (typeof performance === 'undefined' ? undefined : performance);
	const marks: Mark[] = [];
	const counts: Record<string, number> = {};
	let history = true;
	const write = (m: Mark) => out?.mark(m.name, { startTime: m.t, detail: m.detail });
	return {
		marks,
		counts,
		get history() {
			return history;
		},
		record(name: string, detail?: Record<string, unknown>) {
			counts[name] = (counts[name] ?? 0) + 1;
			if (!history && counts[name] > 1) return;
			const m = { name, t: now(), detail };
			marks.push(m);
			write(m);
		},
		setHistory(on: boolean) {
			history = on;
			if (on) return;
			const seen = new Set<string>();
			const cold = marks.filter((m) => !seen.has(m.name) && !!seen.add(m.name));
			if (cold.length === marks.length) return;
			marks.splice(0, marks.length, ...cold);
			for (const name of seen) out?.clearMarks(name);
			for (const m of cold) write(m);
		}
	};
}

/**
 * init 只標記 harness 的 layout 模式對照（zero／d3）；P5 起瀏覽器一律從 runtime 的
 * 決定性種子座標（seedPositions）出發，不再讀這個值。
 */
export function createProbe(init: LayoutInit) {
	const log = createMarkLog();
	let r: WebGLRenderer | null = null;
	return {
		init,
		marks: log.marks,
		/** 每個 marker 名稱累計觸發次數（history 關閉後仍持續計數） */
		markCounts: log.counts,
		/** 關閉＝只留冷啟動 marker＋計數（長時間穩定性量測用，避免量測本身無上限成長） */
		markHistory: (on: boolean) => log.setHistory(on),
		mark: (name: string, detail?: Record<string, unknown>) => log.record(name, detail),
		renderer(x: WebGLRenderer) {
			r = x;
		},
		/** 最近一幀的 draw calls／三角形與 GPU 物件數（唯讀） */
		renderInfo: () =>
			r && {
				...r.info.render,
				...r.info.memory,
				pixelRatio: r.getPixelRatio()
			},
		/** WebGL 實際使用的 GPU／軟體渲染器（例如 SwiftShader） */
		gpu: () => {
			const gl = r?.getContext();
			const ext = gl?.getExtension('WEBGL_debug_renderer_info');
			return gl && ext
				? {
						vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string,
						renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string
					}
				: null;
		}
	} satisfies GraphProbe & Record<string, unknown>;
}

/** /measure 的 init 參數：缺省為 zero；其他值明確拒絕，不靜默退回 */
export function parseInit(raw: string | null): LayoutInit {
	if (raw === null || raw === 'zero') return 'zero';
	if (raw === 'd3') return 'd3';
	throw new RangeError(`init must be "zero" or "d3", got "${raw}"`);
}
