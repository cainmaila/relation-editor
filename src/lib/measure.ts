// 量測入口（/measure）專用的探針：只有該路由會建立並傳給 GraphView，正式頁面不帶。
import type { WebGLRenderer } from 'three';
import type { LayoutInit } from './layout-sim';

export type Mark = { name: string; t: number; detail?: Record<string, unknown> };

export interface GraphProbe {
	mark(name: string, detail?: Record<string, unknown>): void;
	renderer(r: WebGLRenderer): void;
}

/**
 * init 只標記 harness 的 layout 模式對照（zero／d3）；P5 起瀏覽器一律從 runtime 的
 * 決定性種子座標（seedPositions）出發，不再讀這個值。
 */
export function createProbe(init: LayoutInit) {
	const marks: Mark[] = [];
	let r: WebGLRenderer | null = null;
	return {
		init,
		marks,
		mark(name: string, detail?: Record<string, unknown>) {
			marks.push({ name, t: performance.now(), detail });
			performance.mark(name, { detail });
		},
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
