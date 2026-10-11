import { describe, expect, it } from 'vitest';
import { createMarkLog } from './measure';

/** 假時間軸：記錄 mark／clearMarks，驗證 history 關閉後時間軸也有上限 */
function fakeSink() {
	const entries: { name: string; startTime?: number }[] = [];
	return {
		entries,
		sink: {
			mark: (name: string, o?: PerformanceMarkOptions) => {
				entries.push({ name, startTime: o?.startTime });
				return undefined as unknown as PerformanceMark;
			},
			clearMarks: (name?: string) => {
				if (!name) throw new Error('must not clear marks it does not own');
				entries.splice(0, entries.length, ...entries.filter((e) => e.name !== name));
			}
		}
	};
}

describe('createMarkLog', () => {
	it('keeps full history by default (cold + repeated markers, timeline mirrored)', () => {
		let t = 0;
		const { entries, sink } = fakeSink();
		const log = createMarkLog(() => ++t, sink);
		for (const n of ['a', 'b', 'a', 'a']) log.record(n);
		expect(log.marks.map((m) => [m.name, m.t])).toEqual([
			['a', 1],
			['b', 2],
			['a', 3],
			['a', 4]
		]);
		expect(entries).toHaveLength(4);
		expect(log.counts).toEqual({ a: 3, b: 1 });
	});

	it('history off: compacts to first occurrence per name in place, rewrites timeline with original times, bounds growth', () => {
		let t = 0;
		const { entries, sink } = fakeSink();
		const log = createMarkLog(() => ++t, sink);
		const ref = log.marks;
		entries.push({ name: 'foreign', startTime: 0 });
		for (const n of ['cold', 'tick', 'tick', 'tick']) log.record(n);
		log.setHistory(false);
		expect(log.history).toBe(false);
		expect(log.marks).toBe(ref);
		expect(log.marks.map((m) => [m.name, m.t])).toEqual([
			['cold', 1],
			['tick', 2]
		]);
		// 別人寫的 mark 不受影響
		expect(entries).toEqual([
			{ name: 'foreign', startTime: 0 },
			{ name: 'cold', startTime: 1 },
			{ name: 'tick', startTime: 2 }
		]);
		for (let i = 0; i < 1000; i++) log.record('tick');
		// 新名稱第一次出現仍記錄（冷 marker），重複的只計數
		log.record('late');
		log.record('late');
		expect(log.marks.map((m) => m.name)).toEqual(['cold', 'tick', 'late']);
		expect(entries.map((e) => e.name)).toEqual(['foreign', 'cold', 'tick', 'late']);
		expect(log.counts).toEqual({ cold: 1, tick: 1003, late: 2 });
	});

	it('history back on resumes full recording', () => {
		const { sink } = fakeSink();
		const log = createMarkLog(() => 0, sink);
		log.record('x');
		log.setHistory(false);
		log.record('x');
		log.setHistory(true);
		log.record('x');
		expect(log.marks).toHaveLength(2);
		expect(log.counts.x).toBe(3);
	});
});
