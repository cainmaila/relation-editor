import { expect, test } from 'vitest';
import { bigMock } from './bigMock';
import { unprocessed } from './graph';

test('bigMock ≈ 10k nodes, ids unique, edges resolve', () => {
	const g = bigMock();
	const ids = new Set(g.nodes.map((n) => n.id));
	expect(ids.size).toBe(g.nodes.length);
	expect(g.nodes.length).toBeGreaterThan(10000);
	expect(g.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
});

// 歷史 spike fixture 的限制（P1 記錄）：5 份 2F mock 的 id 都加樓層前綴，沒有共同根 ROOT_ID，
// 所以全部節點都算「未處理」；邊數約 2×N、沒有千度 hub 與孤立節點。
// 效能量測請用 scale-fixture.ts 的 scaleFixture()，不要用 bigMock 的結果宣稱 10k 驗收。
test('bigMock limitation: no shared root, every node unprocessed', () => {
	const g = bigMock();
	expect(unprocessed(g).size).toBe(g.nodes.length);
	expect(g.edges.length).toBeLessThan(g.nodes.length * 2.5);
});
