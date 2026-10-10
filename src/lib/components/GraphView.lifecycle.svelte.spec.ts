// GraphView 生命週期殘留情境（P8）：WebGL context 真的恢復（restoreContext）。
// 3D 模組載入失敗／卸載後才載入完成在 e2e（攔截真正的 chunk 請求）驗證。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { Editor } from '#lib/editor.svelte.js';
import GraphView from './GraphView.svelte';

type Hooks = {
	ready: boolean;
	lod(): { frames: number } | null;
	render(): void;
};
const hooks = () => (window as unknown as { __graphView?: Hooks }).__graphView;

const graph = () => ({
	nodes: Array.from({ length: 20 }, (_, i) => ({
		id: `n${i}`,
		type: '通用節點',
		name: `節點${i}`,
		props: {}
	})),
	edges: []
});

let host: HTMLDivElement | null = null;
afterEach(() => {
	host?.remove();
	host = null;
});
function mountHost() {
	host = document.createElement('div');
	host.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px';
	document.body.append(host);
	return host;
}

describe('GraphView 生命週期殘留情境', () => {
	it('WebGL context 遺失後真的恢復：錯誤消失、ready 回來、繼續出幀', async () => {
		const el = mountHost();
		render(GraphView, { target: el, props: { editor: new Editor(graph()) } });
		await vi.waitFor(() => expect(hooks()?.ready).toBe(true), { timeout: 20_000 });
		const canvas = el.querySelector('canvas')!;
		const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl'))!;
		const ext = gl.getExtension('WEBGL_lose_context')!;
		ext.loseContext();
		await vi.waitFor(() =>
			expect(el.querySelector('[role=alert]')?.textContent).toContain('WebGL context lost')
		);
		expect(hooks()?.ready).toBe(false);
		ext.restoreContext();
		await vi.waitFor(() => expect(el.querySelector('[role=alert]')).toBeNull());
		expect(hooks()?.ready).toBe(true);
		const before = hooks()!.lod()!.frames;
		await vi.waitFor(() => expect(hooks()!.lod()!.frames).toBeGreaterThan(before));
	});
});
