import { describe, expect, it, test } from 'vitest';
import { runLayout, startLayoutJob } from './layout-sim';
import { ROOT_ID } from './model/config';
import { idsKey, pack, seedPositions, type LayoutReply, type LayoutStart } from './universe/layout';

const links: [number, number][] = [
	[0, 1],
	[1, 2],
	[2, 0],
	[2, 3]
];

test('zero init: every node starts coincident; d3 init: spread', () => {
	const zero = runLayout({ n: 5, links, ticks: 0, init: 'zero' });
	expect([...zero.pos].every((v) => v === 0)).toBe(true);
	const spread = runLayout({ n: 5, links, ticks: 0, init: 'd3' });
	expect(new Set([...spread.pos].map((v) => v.toFixed(3))).size).toBeGreaterThan(3);
});

test('deterministic per init, finite, one timing per tick', () => {
	for (const init of ['zero', 'd3'] as const) {
		const a = runLayout({ n: 5, links, ticks: 20, init });
		const b = runLayout({ n: 5, links, ticks: 20, init });
		expect([...a.pos]).toEqual([...b.pos]);
		expect(a.pos.length).toBe(15);
		expect([...a.pos].every(Number.isFinite)).toBe(true);
		expect(a.tickMs.length).toBe(20);
	}
});

describe('startLayoutJob（Worker 分段整理）', () => {
	const ids = ['a', 'b', 'c', 'd', 'e'];
	const req = (over: Partial<LayoutStart> = {}): LayoutStart => ({
		type: 'start',
		generation: 7,
		topologyRevision: 3,
		ids,
		positions: pack(ids, seedPositions(ids)),
		links: Uint32Array.from(links.flat()),
		budget: 6,
		...over
	});
	/** 同步排程：手動推進下一段 */
	function io(segmentMs = 0) {
		const posts: { reply: LayoutReply; transfer: Transferable[] }[] = [];
		const queue: (() => void)[] = [];
		return {
			posts,
			step: () => queue.shift()?.(),
			drain: () => {
				while (queue.length) queue.shift()!();
			},
			io: {
				post: (reply: LayoutReply, transfer: Transferable[]) => posts.push({ reply, transfer }),
				schedule: (f: () => void) => queue.push(f),
				now: () => 0,
				segmentMs
			}
		};
	}

	it('根節點固定在原點', () => {
		const t = io();
		const rids = ['a', ROOT_ID, 'c', 'd', 'e'];
		startLayoutJob(req({ ids: rids, positions: pack(rids, seedPositions(rids)) }), t.io);
		t.drain();
		const last = t.posts.at(-1)!.reply as { positions: Float32Array };
		expect([...last.positions.subarray(3, 6)]).toEqual([0, 0, 0]);
	});

	it('分段回報進度，達預算時 done；每段帶 generation／topologyRevision／idsKey 與新的 buffer', () => {
		const t = io();
		startLayoutJob(req(), t.io);
		t.drain();
		const replies = t.posts.map((p) => p.reply);
		expect(replies.map((r) => r.type)).toEqual([
			'progress',
			'progress',
			'progress',
			'progress',
			'progress',
			'done'
		]);
		for (const r of replies) {
			expect(r).toMatchObject({ generation: 7, topologyRevision: 3, idsKey: idsKey(ids) });
		}
		const last = replies.at(-1)!;
		if (last.type !== 'done') throw new Error('expected done');
		expect(last.tick).toBe(6);
		expect(last.budget).toBe(6);
		expect(last.positions.length).toBe(15);
		expect([...last.positions].every(Number.isFinite)).toBe(true);
		// 每段 transfer 自己新配置的 buffer，彼此不共用
		const bufs = t.posts.map((p) => p.transfer[0]);
		expect(new Set(bufs).size).toBe(bufs.length);
		expect(
			t.posts.every(
				(p, i) => p.transfer[0] === (replies[i] as { positions: Float32Array }).positions.buffer
			)
		).toBe(true);
	});

	it('從傳入座標出發（不是全零重來）', () => {
		const t = io();
		const r = req({ budget: 1 });
		const start = r.positions.slice();
		startLayoutJob(r, t.io);
		const done = t.posts[0].reply as { positions: Float32Array };
		let moved = 0;
		for (let i = 0; i < start.length; i++)
			moved = Math.max(moved, Math.abs(done.positions[i] - start[i]));
		expect(moved).toBeGreaterThan(0);
		expect(moved).toBeLessThan(30);
	});

	it('停止後在分段邊界結束，不再送任何回覆', () => {
		const t = io();
		const job = startLayoutJob(req(), t.io);
		expect(t.posts).toHaveLength(1);
		job.stop();
		t.drain();
		expect(t.posts).toHaveLength(1);
	});

	it('計算錯誤回報 error（帶 generation），不丟例外', () => {
		const t = io();
		startLayoutJob(req({ links: Uint32Array.from([0, 99]) }), t.io);
		expect(t.posts.map((p) => p.reply)).toEqual([
			expect.objectContaining({ type: 'error', generation: 7, topologyRevision: 3 })
		]);
	});
});
