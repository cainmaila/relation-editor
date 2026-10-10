// 在 Worker 內跑 d3-force-3d，算完回傳位置（與每個 tick 的耗時），主執行緒不卡
import { runLayout, type LayoutIn } from './layout-sim';

self.onmessage = (e: MessageEvent<LayoutIn>) => {
	// 收到／算完的絕對時間（epoch ms），量測時可與主執行緒時間對齊
	const recvAt = performance.timeOrigin + performance.now();
	const out = runLayout(e.data);
	const doneAt = performance.timeOrigin + performance.now();
	postMessage({ ...out, recvAt, doneAt }, { transfer: [out.pos.buffer, out.tickMs.buffer] });
};
