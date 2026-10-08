// 效能實驗：CDP CPU profile 載入 10k，依 self time 彙總最熱的函式
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
const q = process.argv[2] ?? '?big=1';
const label = process.argv[3] ?? 'big';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
const cdp = await p.context().newCDPSession(p);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
await p.goto('http://localhost:5171/' + q, { waitUntil: 'commit' });
await cdp.send('Profiler.start');
const t0 = Date.now();
await p.waitForFunction(() => document.querySelectorAll('.svelte-flow__node').length > 0, null, { polling: 'raf', timeout: 400_000 });
const { profile } = await cdp.send('Profiler.stop');
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
mkdirSync('spike/results', { recursive: true });
writeFileSync(`spike/results/profile-${label}.cpuprofile`, JSON.stringify(profile));
// self time 彙總
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas;
const self = new Map();
profile.samples.forEach((id, i) => {
	const n = byId.get(id);
	const f = n.callFrame;
	const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
	self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
});
const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.table(top.map(([k, v]) => ({ selfMs: Math.round(v / 1000), fn: k })));
await b.close();
