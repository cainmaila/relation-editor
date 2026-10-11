import { describe, expect, it } from 'vitest';
import { StableById } from './stable.js';

describe('StableById（P8：改名只換一張卡片的物件）', () => {
	it('內容相同沿用上一次的物件（引用不變），內容變了才換新物件', () => {
		const s = new StableById<{ id: string; data: { name: string }; position: { x: number } }>();
		const a1 = s.take([
			{ id: 'a', data: { name: 'A' }, position: { x: 1 } },
			{ id: 'b', data: { name: 'B' }, position: { x: 2 } }
		]);
		const a2 = s.take([
			{ id: 'a', data: { name: 'A' }, position: { x: 1 } },
			{ id: 'b', data: { name: 'B2' }, position: { x: 2 } }
		]);
		expect(a2[0]).toBe(a1[0]);
		expect(a2[1]).not.toBe(a1[1]);
		expect(a2[1].data.name).toBe('B2');
	});

	it('移除的 id 不留在快取；同 id 再出現時是新物件', () => {
		const s = new StableById<{ id: string; v: number }>();
		const [a] = s.take([{ id: 'a', v: 1 }]);
		s.take([{ id: 'b', v: 1 }]);
		const [a2] = s.take([{ id: 'a', v: 1 }]);
		expect(a2).not.toBe(a);
		expect(s.size).toBe(1);
	});

	it('undefined 欄位與缺欄位視為相同；順序沿用輸入', () => {
		const s = new StableById<{ id: string; m?: number }>();
		const [x] = s.take([{ id: 'x', m: undefined }]);
		const out = s.take([{ id: 'y' }, { id: 'x' }]);
		expect(out.map((o) => o.id)).toEqual(['y', 'x']);
		expect(out[1]).toBe(x);
	});
});
