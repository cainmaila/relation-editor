// 用法：node spike/raw-bench.mjs <label>  （需先 pnpm preview --port 4173）
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const label = process.argv[2] ?? 'run';
const RUNS = Number(process.env.RUNS ?? 3);
const TIMEOUT = Number(process.env.TIMEOUT ?? 300_000);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const out = {};
for (const [name, q] of [
	['real', '/'],
	['big', '/?big=1']
]) {
	const runs = [];
	for (let i = 0; i < RUNS; i++) {
		const b = await chromium.launch({ executablePath: process.env.CHROME ?? undefined });
		const p = await b.newPage({ viewport: { width: 1600, height: 960 } });
		const t0 = Date.now();
		await p.goto(`http://localhost:4173${q}`, { waitUntil: 'commit', timeout: TIMEOUT });
		try {
			await p.waitForSelector('.svelte-flow__node', { timeout: TIMEOUT, state: 'attached' });
			const ms = Date.now() - t0;
			const count = await p.locator('.svelte-flow__node').count();
			runs.push({ ms, count });
		} catch {
			runs.push({ ms: 'timeout', count: null });
		}
		console.log(label, name, i, runs.at(-1));
		await b.close();
	}
	const ok = runs.filter((r) => r.ms !== 'timeout').map((r) => r.ms);
	out[name] = {
		runs,
		median: ok.length === runs.length ? median(ok) : 'timeout(' + (runs.length - ok.length) + ')'
	};
}
writeFileSync(`spike/results/raw-${label}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
