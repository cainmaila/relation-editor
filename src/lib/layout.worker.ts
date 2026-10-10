// 在 Worker 內分段跑 d3-force-3d：每段回報一份新座標（transfer 新配置的 buffer），主執行緒不卡。
// 一個 Worker 同時只跑一個 generation；stop 或新的 start 都會讓舊的在分段邊界結束。
import { startLayoutJob } from './layout-sim';
import type { LayoutRequest } from './universe/layout';

/** 每段至少算這麼久才回報，避免進度訊息過密 */
const SEGMENT_MS = 200;
let job: { generation: number; stop(): void } | null = null;

self.onmessage = (e: MessageEvent<LayoutRequest>) => {
	const msg = e.data;
	if (msg.type === 'stop') {
		if (job?.generation === msg.generation) job.stop();
		return;
	}
	job?.stop();
	const j = startLayoutJob(msg, {
		post: (reply, transfer) => postMessage(reply, { transfer }),
		schedule: (f) => setTimeout(f, 0),
		now: () => performance.now(),
		segmentMs: SEGMENT_MS
	});
	job = { generation: msg.generation, stop: j.stop };
};
