// 技能的名詞文檔不可漏列 config.ts 的類型
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EDGE_TYPES, NODE_TYPES, SYSTEMS } from '../src/lib/model/config';

const doc = readFileSync('.claude/skills/tpkc-relation-data/references/types.md', 'utf8');

describe('types.md', () => {
	it.each([...SYSTEMS, ...NODE_TYPES.map((t) => t.name), ...EDGE_TYPES.map((t) => t.name)])(
		'列出「%s」',
		(name) => expect(doc).toContain(name)
	);
});
