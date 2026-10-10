// PRD v0.4 §6 情境 1–20 驗收
// 全圖（3D，WebGL）點不到 DOM：用大綱／詳情／頂列操作，用 window.__graphView 讀數量、選取、亮起的節點。
// 編輯頁（Svelte Flow）一開始是空的：每個情境先從全圖把節點加入編輯頁。
import { expect, test, type Locator, type Page } from '@playwright/test';

const SYSTEMS = ['空間', '電力', '空調', '網路', '消防', 'CCTV', 'IDC'];
const G = '2F A 排監視與偵測範圍';
/** PRD §5：全部節點數、邊數（含承載） */
const TOTAL = 2066;
const TOTAL_EDGES = 4020;
const ALL_CUSTOMERS = [
	...Array.from({ length: 40 }, (_, i) => `客戶 ${String(i + 1).padStart(2, '0')}`),
	'客戶丙',
	'客戶乙',
	'客戶甲'
];

type GraphViewHook = {
	ready: boolean;
	selected: () => string | null;
	highlighted: () => string[];
	nodeCount: () => number;
	edgeCount: () => number;
	search: (name: string) => string | null;
	highlightEdgeIds: () => string[];
	selectedEdge: () => string | null;
};
declare global {
	interface Window {
		__graphView?: GraphViewHook;
	}
}

const node = (page: Page, name: string) =>
	page.locator('.svelte-flow__node-graph').filter({ has: page.getByText(name, { exact: true }) });
/** 節點卡上的狀態圖示（未處理、無客戶路徑） */
const badge = (page: Page, name: string, b: string) =>
	node(page, name).getByRole('img', { name: b, exact: true });
const graphNodes = (page: Page) => page.locator('.svelte-flow__node-graph');
const graphEdges = (page: Page) => page.locator('.svelte-flow__edge');
const dimmed = (page: Page) => page.locator('.svelte-flow__node-graph .opacity-20');
const detail = (page: Page) => page.getByRole('complementary', { name: '詳情' });
/** 詳情的「欄位 值」 */
const field = (k: string, v: string) => new RegExp(`${k}\\s*${v}`);
const status = (page: Page) => page.getByRole('status');
const outline = (page: Page) => page.getByRole('navigation', { name: '大綱' });
const chip = (page: Page, name: string) => outline(page).getByRole('button', { name });
/** 大綱切到「只列未處理／無客戶路徑」後的節點列 */
async function issueList(page: Page, name: '只列未處理' | '只列無客戶路徑') {
	const c = chip(page, name);
	if ((await c.getAttribute('aria-pressed')) !== 'true') await c.click();
	return rows(page).getByRole('listitem');
}
/** 頂列的問題計數按鈕：未處理 N／無客戶路徑 N */
const issueCount = (page: Page, label: '未處理' | '無客戶路徑', n: number) =>
	expect(
		page.getByRole('banner').getByRole('button', { name: `${label} ${n}`, exact: true })
	).toBeVisible();

// ---- 全圖 ----
const graphReady = (page: Page) =>
	expect
		.poll(() => page.evaluate(() => window.__graphView?.ready ?? false), { timeout: 60_000 })
		.toBe(true);
/** 版面算好後的 [節點數, 邊數]；重算中為 null */
const expectCounts = (page: Page, nodes: number, edges: number) =>
	expect
		.poll(() =>
			page.evaluate(() =>
				window.__graphView?.ready
					? [window.__graphView!.nodeCount(), window.__graphView!.edgeCount()]
					: null
			)
		)
		.toEqual([nodes, edges]);
const counts = (page: Page) =>
	page.evaluate(
		() => [window.__graphView!.nodeCount(), window.__graphView!.edgeCount()] as [number, number]
	);
const lit = (page: Page) => page.evaluate(() => window.__graphView!.highlighted());
/** 亮起的節點（名稱即 mock id）剛好是這些 */
const expectLit = (page: Page, names: string[]) =>
	expect.poll(async () => (await lit(page)).sort()).toEqual([...names].sort());

async function only(page: Page, systems: string[]) {
	for (const s of SYSTEMS)
		await page.getByRole('checkbox', { name: s }).setChecked(systems.includes(s));
}
/** 大綱的分頁結果列（只畫當頁） */
const rows = (page: Page) => outline(page).getByRole('list', { name: '節點' });
/**
 * 從大綱點節點：選取並置中（全圖與編輯頁都用得到）。
 * 大綱只畫當頁結果，先用篩選框搜尋名稱，點完再還原原本的篩選文字。
 */
async function pick(page: Page, name: string) {
	const box = outline(page).getByRole('searchbox', { name: '篩選節點' });
	const before = await box.inputValue();
	await box.fill(name);
	await rows(page)
		.locator('button[data-id]')
		.filter({ has: page.getByText(name, { exact: true }) })
		.click();
	await box.fill(before);
	// 原本點完焦點在列上；還原篩選後離開輸入框，單鍵快捷鍵（F 等）才不會打進框裡
	await box.blur();
}
/** 點 3D 畫面左上角的空白處 */
const clickBlank = (page: Page) => page.locator('main canvas').click({ position: { x: 3, y: 3 } });
const pane = (page: Page) => page.locator('.svelte-flow__pane');
const clickPane = (page: Page) => pane(page).click({ position: { x: 5, y: 5 } });

// ---- 切換畫面、加入編輯頁 ----
const tab = (page: Page, p: 'graph' | 'edit') =>
	page
		.getByRole('group', { name: '畫面' })
		.getByRole('button', { name: p === 'graph' ? '全圖' : /^編輯頁/ });
async function toGraph(page: Page) {
	await tab(page, 'graph').click();
	await graphReady(page);
}
/** 在全圖選取節點，按詳情的「加入編輯頁」（不切畫面） */
async function addToEdit(page: Page, names: string[]) {
	for (const n of names) {
		await pick(page, n);
		await detail(page).getByRole('button', { name: '加入編輯頁', exact: true }).click();
	}
}
/** 全圖 → 加入編輯頁 → 切到編輯頁 */
async function toEdit(page: Page, names: string[] = []) {
	await addToEdit(page, names);
	await tab(page, 'edit').click();
	await expect(pane(page)).toBeVisible();
	await settle(page);
}
/** 等編輯頁視野動畫（入鏡／置中）停下，避免點擊、拖曳落在移動中的位置 */
async function settle(page: Page) {
	const viewport = page.locator('.svelte-flow__viewport');
	let prev: string | null = null;
	await expect
		.poll(
			async () => {
				const t = await viewport.getAttribute('style');
				const same = t === prev;
				prev = t;
				return same;
			},
			{ intervals: [300] }
		)
		.toBe(true);
}

// ---- 編輯頁操作 ----
/** 收疊預設關閉：手動打開（P4） */
async function stackOn(page: Page) {
	const t = page.getByRole('banner').getByRole('button', { name: '收疊同類' });
	await expect(t).toHaveAttribute('aria-pressed', 'false');
	await t.click();
	await expect(t).toHaveAttribute('aria-pressed', 'true');
	await settle(page);
}
/** 開對話框（先 Esc 關掉可能開著的） */
async function open(page: Page, button: string, form: string) {
	await page.keyboard.press('Escape');
	await page.getByRole('banner').getByRole('button', { name: button, exact: true }).click();
	return page.getByRole('form', { name: form });
}
async function addNode(page: Page, type: string, name: string) {
	const f = await open(page, '新增節點', '新增節點');
	await f.getByLabel('類型').selectOption(type);
	await f.getByLabel('名稱').fill(name);
	await f.getByRole('button', { name: '新增節點' }).click();
}
/** 新增邊對話框的端點：搜尋名稱，從候選清單點選 */
async function endpoint(f: Locator, label: '起點' | '終點', name: string) {
	const box = f.getByRole('searchbox', { name: label });
	if (!(await box.isVisible())) await f.getByRole('button', { name: `${label}：` }).click();
	await box.fill(name);
	await f
		.getByRole('listbox', { name: `${label}候選` })
		.locator('button[data-id]')
		.filter({ has: f.page().getByText(name, { exact: true }) })
		.click();
	await expect(f.getByRole('button', { name: `${label}：${name}（點擊更換）` })).toBeVisible();
}
async function edgeForm(page: Page, from: string, to: string) {
	const f = await open(page, '新增邊', '新增邊');
	await expect(f).toBeVisible();
	await endpoint(f, '起點', from);
	await endpoint(f, '終點', to);
	return f;
}
async function addEdge(page: Page, from: string, to: string, type: string) {
	const f = await edgeForm(page, from, to);
	await f.getByRole('radio', { name: type }).check();
	await f.getByRole('button', { name: '新增邊' }).click();
}
/** 用滑鼠把卡片拖到另一張卡片或畫布上某點 */
async function drag(page: Page, from: Locator, to: Locator | { x: number; y: number }) {
	const a = (await from.boundingBox())!;
	const b = 'x' in to ? { ...to, width: 0, height: 0 } : (await to.boundingBox())!;
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
	await page.mouse.up();
}
const menu = (page: Page) => page.getByRole('menu').first();
/** 從詳情的連入／連出清單點選一條邊 */
const pickEdge = (page: Page, label: string) =>
	detail(page).getByRole('button', { name: label, exact: true }).click();
/** 全圖：對節點找客戶，回傳客戶名稱 */
async function findCustomers(page: Page, name: string) {
	await pick(page, name);
	await detail(page).getByRole('button', { name: '找客戶' }).click();
	return page.getByRole('region', { name: '找客戶結果' }).getByRole('listitem').allTextContents();
}

test.beforeEach(async ({ page }) => {
	await page.goto('/');
	await graphReady(page);
});

test.describe('看圖（全圖）', () => {
	test('情境 1：一眼看懂整張圖', async ({ page }) => {
		// 3D 畫布、七個系統開關與各系統節點數
		await expect(page.locator('main canvas')).toBeVisible();
		const n = { 空間: 345, 電力: 672, 空調: 1, 網路: 345, 消防: 2, CCTV: 1, IDC: 699 };
		for (const s of SYSTEMS) {
			await expect(page.getByRole('checkbox', { name: s })).toBeChecked();
			await expect(page.locator(`label[title^="${s} ·"]`)).toHaveAttribute(
				'title',
				new RegExp(`· ${n[s as keyof typeof n]} 節點`)
			);
		}
		// 合計 2,066（含通用節點 1），沒有未處理、沒有無客戶路徑
		await expectCounts(page, TOTAL, TOTAL_EDGES);
		await issueCount(page, '未處理', 0);
		await issueCount(page, '無客戶路徑', 0);
		// 可搜尋；節點名稱與類型在大綱／詳情看得到
		expect(await page.evaluate(() => window.__graphView!.search('機櫃 A-01'))).toBe('機櫃 A-01');
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveValue('機櫃 A-01');
		await expect(detail(page)).toContainText(field('類型', '機櫃'));
		await outline(page).getByRole('searchbox', { name: '篩選節點' }).fill('機櫃 A-01');
		await expect(rows(page).locator('button[data-id="機櫃 A-01"]')).toHaveAttribute(
			'title',
			'機櫃'
		);
	});

	test('情境 2：系統內是二維', async ({ page }) => {
		await only(page, ['電力']);
		// 電力 672 個＋永遠顯示的通用節點 1；671 條供電邊（不含機櫃 PDU → 機櫃、UPS-1 → 空調箱）
		await expectCounts(page, 673, 671);
		await only(page, ['空間']);
		// 空間 345 個＋通用節點；344 條包含＋通用節點 → 機櫃 A-01、A-02 兩條
		await expectCounts(page, 346, 346);
	});

	test('情境 3：系統相連就成為多維', async ({ page }) => {
		await only(page, ['空間']);
		const [, space] = await counts(page);
		await only(page, ['電力']);
		const [, power] = await counts(page);
		await only(page, ['空間', '電力']);
		// 新出現的跨系統供電邊：每台機櫃 PDU 連到所屬機櫃，654 條
		await expectCounts(page, 345 + 672 + 1, space + power + 654);
		await only(page, ['空間', '電力', '空調']);
		// UPS-1 → 空調箱、空調箱 → 2F
		await expectCounts(page, 345 + 672 + 1 + 1, space + power + 654 + 2);
	});

	test('情境 4：通用節點整理跨系統連線', async ({ page }) => {
		await only(page, ['空間', '消防', 'CCTV']);
		await pick(page, G);
		await expect(detail(page)).toContainText('連入（3）');
		await expect(detail(page)).toContainText('連出（2）');
		await expect(detail(page).getByRole('button', { name: '監測：偵測器 SD-01' })).toBeVisible();
		await expect(detail(page).getByRole('button', { name: '監測：偵測器 SD-02' })).toBeVisible();
		await expect(detail(page).getByRole('button', { name: '監測：攝影機 CAM-03' })).toBeVisible();
		await expect(detail(page).getByRole('button', { name: '包含：機櫃 A-01' })).toBeVisible();
		await expect(detail(page).getByRole('button', { name: '包含：機櫃 A-02' })).toBeVisible();
		// 5 個相鄰節點連同自己亮起
		await expectLit(page, [
			G,
			'偵測器 SD-01',
			'偵測器 SD-02',
			'攝影機 CAM-03',
			'機櫃 A-01',
			'機櫃 A-02'
		]);
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveValue(G);
	});

	test('情境 5：聚焦一個節點', async ({ page }) => {
		await pick(page, '機櫃 A-01');
		// 7 個相鄰節點（連入 4、連出 3）加自己
		await expect(detail(page)).toContainText('連入（4）');
		await expect(detail(page)).toContainText('連出（3）');
		await expectLit(page, [
			'機櫃 A-01',
			'A 排',
			'機櫃 PDU A-01-A',
			'機櫃 PDU A-01-B',
			G,
			'機框 A-01-F1',
			'機框 A-01-F2',
			'ToR Switch A-01'
		]);
		// 其餘淡化但仍在畫面上
		await expectCounts(page, TOTAL, TOTAL_EDGES);
		// 點空白處恢復
		await clickBlank(page);
		await expect.poll(() => page.evaluate(() => window.__graphView!.selected())).toBeNull();
		await expectLit(page, []);
	});

	test('情境 6：一櫃多客戶', async ({ page }) => {
		await only(page, ['空間', 'IDC']);
		await pick(page, '機櫃 A-01');
		await expect(detail(page).getByRole('button', { name: '包含：機框 A-01-F1' })).toBeVisible();
		await expect(detail(page).getByRole('button', { name: '包含：機框 A-01-F2' })).toBeVisible();
		await pick(page, '機框 A-01-F1');
		await expect(detail(page).getByRole('button', { name: '包含：主機 H-01' })).toBeVisible();
		await expect(detail(page).getByRole('button', { name: '服務：客戶甲' })).toBeVisible();
		await pick(page, '機框 A-01-F2');
		await expect(detail(page).getByRole('button', { name: '包含：主機 H-02' })).toBeVisible();
		await expect(detail(page).getByRole('button', { name: '服務：客戶乙' })).toBeVisible();
	});

	test('情境 7：看節點與邊的詳情（全圖唯讀）', async ({ page }) => {
		await pick(page, '機櫃 PDU A-01-A');
		await expect(detail(page)).toContainText(field('類型', '機櫃 PDU'));
		await expect(detail(page)).toContainText(field('系統', '電力'));
		await expect(detail(page).getByLabel('額定電流')).toHaveValue('32A');
		await expect(detail(page).getByLabel('額定電流')).toBeDisabled();
		await pickEdge(page, '供電：機櫃 A-01');
		await expect(detail(page)).toContainText(field('類型', '供電'));
		await expect(detail(page)).toContainText(field('起點', '機櫃 PDU A-01-A'));
		await expect(detail(page)).toContainText(field('終點', '機櫃 A-01'));
		await expect(detail(page).getByLabel('方向')).toHaveValue('單向');
		await expect(detail(page).getByLabel('路別')).toHaveValue('A');
		await expect(detail(page).getByLabel('確認狀態')).toHaveValue('已確認');
		await pick(page, 'UPS-1');
		await pickEdge(page, '供電：樓層 PDU 2F-A');
		await expect(detail(page).getByLabel('確認狀態')).toHaveValue('推定');
		// 全圖不能編輯
		await expect(detail(page).getByLabel('確認狀態')).toBeDisabled();
		await expect(detail(page).getByRole('button', { name: '刪除邊' })).toHaveCount(0);
	});
});

test.describe('編輯（編輯頁）', () => {
	test('情境 8：新增節點', async ({ page }) => {
		await toEdit(page);
		const f = await open(page, '新增節點', '新增節點');
		await f.getByRole('button', { name: '新增節點' }).click();
		await expect(status(page)).toHaveText('請選擇類型');
		await expect(graphNodes(page)).toHaveCount(0);
		await addNode(page, '攝影機', '攝影機 CAM-04');
		await expect(graphNodes(page)).toHaveCount(1);
		await expect(badge(page, '攝影機 CAM-04', '未處理')).toHaveCount(1);
		await expect(node(page, '攝影機 CAM-04').locator('[title="CCTV"]')).toBeVisible();
		// 在全圖查看：未處理清單只有它
		await toGraph(page);
		await issueCount(page, '未處理', 1);
		await expect(await issueList(page, '只列未處理')).toHaveText(['攝影機 CAM-04']);
		await expectCounts(page, TOTAL + 1, TOTAL_EDGES);
	});

	test('情境 9：新增邊', async ({ page }) => {
		await toEdit(page);
		await addNode(page, '攝影機', '攝影機 CAM-04');
		// 編輯頁再加入 2F A 排監視與偵測範圍（編輯頁搜尋加入）
		await page.keyboard.press('Escape');
		await page.keyboard.press('ControlOrMeta+k');
		await page.getByRole('textbox', { name: '搜尋節點' }).fill(G);
		await page.keyboard.press('Enter');
		await expect(node(page, G)).toBeVisible();
		await addEdge(page, '攝影機 CAM-04', G, '監測');
		await expect(detail(page)).toContainText(field('起點', '攝影機 CAM-04'));
		await expect(detail(page)).toContainText(field('終點', G));
		await expect(detail(page).getByLabel('方向')).toHaveValue('單向');
		await pick(page, G);
		await expect(detail(page)).toContainText('連入（4）');
		await expect(badge(page, '攝影機 CAM-04', '未處理')).toHaveCount(0);
		await toGraph(page);
		await issueCount(page, '未處理', 0);
		await expect(await issueList(page, '只列未處理')).toHaveCount(0);
	});

	test('情境 9：拖曳卡片到另一張建立邊', async ({ page }) => {
		await toEdit(page, ['偵測器 SD-01', G]);
		await addNode(page, '攝影機', '攝影機 CAM-04');
		await expect(graphEdges(page)).toHaveCount(1);
		await settle(page); // 新節點會置中，等畫面停下再拖
		// 視野保留（P4）不再因新卡片自動整張入鏡；先手動入鏡，免得目標貼著邊緣觸發自動平移
		await page.getByRole('button', { name: 'Fit View' }).click();
		await settle(page);
		await drag(page, node(page, '攝影機 CAM-04'), node(page, G));
		const m = page.getByRole('menu', { name: '建立邊' });
		await expect(m).toContainText(`攝影機 CAM-04 → ${G}`);
		await expect(m.getByRole('menuitem', { name: '供電' })).toBeDisabled();
		await expect(graphEdges(page)).toHaveCount(1);
		await m.getByRole('menuitem', { name: '監測' }).click();
		await expect(graphEdges(page)).toHaveCount(2);
		await expect(badge(page, '攝影機 CAM-04', '未處理')).toHaveCount(0);
	});

	test('情境 8＋9：拖到空白處新增節點並連線', async ({ page }) => {
		await toEdit(page, [G]);
		const b = (await pane(page).boundingBox())!;
		await drag(page, node(page, G), { x: b.x + b.width / 2, y: b.y + b.height - 30 });
		const m = page.getByRole('menu', { name: '新增節點並連線' });
		await m.getByRole('menuitem', { name: '空間' }).hover();
		await m.getByRole('menuitem', { name: '區域', exact: true }).hover();
		// 選類型時還沒建任何東西：選完關係才把新節點＋邊一次建立
		await expect(graphNodes(page)).toHaveCount(1);
		await m.getByRole('menuitem', { name: `包含（${G} → 區域）` }).click();
		await expect(node(page, '區域 1')).toBeVisible();
		await expect(detail(page)).toContainText(field('終點', '區域 1'));
		await expect(tab(page, 'edit')).toHaveText('編輯頁 2/200');
	});

	test('情境 10：違反連接限制時擋下', async ({ page }) => {
		await toEdit(page, [
			'機櫃 A-01',
			'UPS-1',
			'偵測器 SD-01',
			'客戶甲',
			'空調箱 AHU-2F-1',
			'A 排',
			G
		]);
		const before = await graphEdges(page).count();
		// 不合法的類型事先停用並寫出原因
		let f = await edgeForm(page, '機櫃 A-01', 'UPS-1');
		await expect(f.getByRole('radio', { name: '供電' })).toBeDisabled();
		await expect(f).toContainText('「供電」只能由電力設備連出');
		f = await edgeForm(page, '偵測器 SD-01', '客戶甲');
		await expect(f.getByRole('radio', { name: '監測' })).toBeDisabled();
		await expect(f).toContainText('「監測」只能連到空間或通用節點');
		await page.keyboard.press('Escape');
		await expect(graphEdges(page)).toHaveCount(before);

		// 例外：通用節點不受連接限制
		await addEdge(page, '空調箱 AHU-2F-1', G, '冷卻');
		await addEdge(page, 'A 排', G, '包含');
		await expect(graphEdges(page)).toHaveCount(before + 2);
		// 起點端仍檢查：攝影機 → 通用節點，「包含」不能選
		f = await edgeForm(page, '攝影機 CAM-03', G);
		await expect(f.getByRole('radio', { name: '包含' })).toBeDisabled();
		await page.keyboard.press('Escape');
		// 對空調箱找客戶，多經過通用節點，仍是全部 43 位客戶
		await toGraph(page);
		expect((await findCustomers(page, '空調箱 AHU-2F-1')).sort()).toEqual(ALL_CUSTOMERS);
	});

	test('情境 11：修改節點與邊', async ({ page }) => {
		await toEdit(page, [
			'機櫃 PDU A-01-B',
			'Core Switch-1',
			'匯聚 Switch AGG-A',
			'空調箱 AHU-2F-1'
		]);
		await pick(page, '機櫃 PDU A-01-B');
		await detail(page).getByLabel('額定電流').fill('16A');
		await detail(page).getByLabel('屬性名稱').fill('品牌');
		await detail(page).getByLabel('屬性值').fill('示意');
		await detail(page).getByRole('button', { name: '新增屬性' }).click();
		await detail(page).getByRole('button', { name: '儲存' }).click();
		await expect(detail(page).getByRole('button', { name: '儲存' })).toBeDisabled();
		await expect(detail(page).getByLabel('額定電流')).toHaveValue('16A');
		await expect(detail(page).getByLabel('品牌')).toHaveValue('示意');

		await pick(page, 'Core Switch-1');
		await pickEdge(page, '連線：匯聚 Switch AGG-A');
		await detail(page).getByLabel('方向').selectOption('雙向');
		await detail(page).getByRole('button', { name: '儲存' }).click();
		await expect(detail(page).getByLabel('方向')).toHaveValue('雙向');
		const edge = page
			.locator('.svelte-flow__edge[data-id="連線:Core Switch-1>匯聚 Switch AGG-A"] path')
			.first();
		await expect(edge).toHaveAttribute('marker-start', /.+/);

		await pick(page, '空調箱 AHU-2F-1');
		await detail(page).getByLabel('名稱', { exact: true }).fill('空調箱 AHU-2F-01');
		await detail(page).getByRole('button', { name: '儲存' }).click();
		await expect(node(page, '空調箱 AHU-2F-01')).toBeVisible();
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveValue('空調箱 AHU-2F-01');
	});

	test('情境 12：刪除節點與邊', async ({ page }) => {
		await toEdit(page, ['偵測器 SD-02', G, '空調箱 AHU-2F-1', '2F', '攝影機 CAM-03', '機櫃 A-01']);
		await pick(page, '偵測器 SD-02');
		await detail(page).getByRole('button', { name: '刪除節點' }).click();
		await expect(detail(page)).toContainText('連同 1 條邊一起刪除？');
		await detail(page).getByRole('button', { name: '確認刪除' }).click();
		await expect(node(page, '偵測器 SD-02')).toHaveCount(0);
		await pick(page, G);
		await expect(detail(page)).toContainText('連入（2）');

		await pick(page, '空調箱 AHU-2F-1');
		await pickEdge(page, '冷卻：2F');
		await detail(page).getByRole('button', { name: '刪除邊' }).click();
		await expect(node(page, '空調箱 AHU-2F-1')).toBeVisible();
		await expect(node(page, '2F')).toBeVisible();

		await pick(page, '攝影機 CAM-03');
		await pickEdge(page, `監測：${G}`);
		await detail(page).getByRole('button', { name: '刪除邊' }).click();
		await expect(badge(page, '攝影機 CAM-03', '未處理')).toHaveCount(1);
		await expect(badge(page, '空調箱 AHU-2F-1', '未處理')).toHaveCount(0);

		await pick(page, '機櫃 A-01');
		await expect(detail(page).getByRole('button', { name: '刪除節點' })).toBeDisabled();
		await expect(detail(page)).toContainText('機櫃底下有 IDC 資料，請先在 IDC機櫃配置管理移除機框');
		await expect(node(page, '機櫃 A-01')).toBeVisible();

		// 回全圖：只有 CAM-03 未處理（空調箱仍經 UPS-1 連到大樓）；通用節點仍連著 SD-01
		await toGraph(page);
		await issueCount(page, '未處理', 1);
		await expect(await issueList(page, '只列未處理')).toHaveText(['攝影機 CAM-03']);
		await expectCounts(page, TOTAL - 1, TOTAL_EDGES - 3);
		await chip(page, '只列未處理').click();
		await pick(page, G);
		await expect(detail(page)).toContainText('連入（1）');
	});

	test('情境 13：IDC 維護的資料不能改', async ({ page }) => {
		await toEdit(page, [
			'機框 A-01-F1',
			'客戶甲',
			'機櫃 A-01',
			'主機 H-01',
			'ToR Switch A-04',
			'主機 H-05'
		]);
		await pick(page, '機框 A-01-F1');
		await pickEdge(page, '服務：客戶甲');
		await expect(detail(page).getByLabel('確認狀態')).toBeDisabled();
		await expect(detail(page).getByLabel('方向')).toBeDisabled();
		await expect(detail(page).getByRole('button', { name: '刪除邊' })).toBeDisabled();
		await expect(detail(page)).toContainText('由 IDC機櫃配置管理維護');
		await pick(page, '機櫃 A-01');
		await pickEdge(page, '包含：機框 A-01-F1');
		await expect(detail(page).getByRole('button', { name: '刪除邊' })).toBeDisabled();
		await expect(detail(page)).toContainText('由 IDC機櫃配置管理維護');

		for (const n of ['客戶甲', '主機 H-01']) {
			await pick(page, n);
			await expect(detail(page).getByLabel('名稱', { exact: true })).toBeDisabled();
			await expect(detail(page).getByRole('button', { name: '刪除節點' })).toBeDisabled();
			await expect(detail(page)).toContainText('由 IDC機櫃配置管理維護');
		}
		const types = (await open(page, '新增節點', '新增節點')).getByLabel('類型');
		for (const t of ['機框', '主機', '客戶'])
			await expect(types.locator(`option[value="${t}"]`)).toHaveCount(0);
		await page.keyboard.press('Escape');

		await pick(page, 'ToR Switch A-04');
		await pickEdge(page, '連線：主機 H-05');
		await detail(page).getByRole('button', { name: '刪除邊' }).click();
		await pick(page, 'ToR Switch A-04');
		await expect(detail(page).getByRole('button', { name: '連線：主機 H-05' })).toHaveCount(0);
		await addEdge(page, 'ToR Switch A-04', '主機 H-05', '連線');
		await expect(detail(page)).toContainText(field('終點', '主機 H-05'));
	});

	test('情境 14：不存檔', async ({ page }) => {
		await toEdit(page, ['機櫃 A-01']);
		await addNode(page, '攝影機', '攝影機 CAM-04');
		await expect(graphNodes(page)).toHaveCount(2);
		await page.reload();
		// 回到初始：全圖、編輯頁是空的、沒有 CAM-04
		await graphReady(page);
		await expectCounts(page, TOTAL, TOTAL_EDGES);
		await expect(tab(page, 'edit')).toHaveText('編輯頁 0/200');
		await issueCount(page, '未處理', 0);
		await tab(page, 'edit').click();
		await expect(graphNodes(page)).toHaveCount(0);
	});
});

test.describe('找客戶（全圖）', () => {
	test('情境 15：從源頭找客戶', async ({ page }) => {
		expect((await findCustomers(page, '台電市電')).sort()).toEqual(ALL_CUSTOMERS);
		await expect(page.getByRole('main')).toContainText('台電市電 → 43 位客戶');
		// 沿途全亮；只有大樓（上游）、偵測器／攝影機與通用節點走不到
		const off = ['TPKC 大樓', '偵測器 SD-01', '偵測器 SD-02', '攝影機 CAM-03', G];
		await expect.poll(async () => (await lit(page)).length).toBe(TOTAL - off.length);
		const on = new Set(await lit(page));
		for (const n of [
			'台電市電',
			'UPS-1',
			'樓層 PDU 2F-A',
			'機櫃 PDU A-04-B',
			'機櫃 A-04',
			'機框 A-04-F1',
			'空調箱 AHU-2F-1',
			'2F',
			'A 排',
			'Core Switch-1',
			'匯聚 Switch AGG-P',
			'ToR Switch A-04',
			'主機 H-05'
		])
			expect(on.has(n), n).toBe(true);
		for (const n of off) expect(on.has(n), n).toBe(false);
		// 沿途的邊：全部 4,020 條扣掉大樓 → 2F、三個感測點 → 通用節點、通用節點 → 機櫃 A-01／A-02
		// 完整查詢總數（不是「全部已亮起」：畫布高亮另有繪製上限與系統篩選）
		const result = detail(page).getByRole('region', { name: '找客戶結果' });
		await expect(result).toContainText(
			`完整查詢：沿途 ${TOTAL - off.length} 個節點、${TOTAL_EDGES - 6} 條邊`
		);
		await expect(result).not.toContainText('已亮起');
	});

	test('情境 16：找到的客戶是精確的', async ({ page }) => {
		expect(await findCustomers(page, '機櫃 PDU A-02-A')).toEqual(['客戶乙']);
		const names = new Set(await lit(page));
		for (const n of ['機櫃 PDU A-02-A', '機櫃 A-02', '機框 A-02-F1', '客戶乙'])
			expect(names.has(n), n).toBe(true);
		expect((await findCustomers(page, '偵測器 SD-01')).sort()).toEqual(['客戶乙', '客戶甲']);
		const sd = new Set(await lit(page));
		for (const n of [G, '機櫃 A-01', '機櫃 A-02']) expect(sd.has(n), n).toBe(true);
		expect(await findCustomers(page, '主機 H-02')).toEqual(['客戶乙']);
		const h = new Set(await lit(page));
		for (const n of ['機框 A-01-F2', '客戶乙']) expect(h.has(n), n).toBe(true);
		expect(h.has('客戶甲')).toBe(false); // 不會因為同櫃而帶出客戶甲
		expect((await findCustomers(page, 'Core Switch-1')).sort()).toEqual(ALL_CUSTOMERS);
		expect(await findCustomers(page, 'ToR Switch A-02')).toEqual(['客戶乙']);
		const t = new Set(await lit(page));
		for (const n of ['主機 H-03', '機框 A-02-F1', '客戶乙']) expect(t.has(n), n).toBe(true);
	});

	test('情境 17：標出無客戶路徑的節點', async ({ page }) => {
		await issueCount(page, '無客戶路徑', 0);
		// Switch B 連到大樓但沒有往下的邊
		await toEdit(page, ['匯聚 Switch AGG-A']);
		await addNode(page, 'Switch', 'Switch B');
		await addEdge(page, '匯聚 Switch AGG-A', 'Switch B', '連線');
		await toGraph(page);
		await issueCount(page, '未處理', 0);
		await issueCount(page, '無客戶路徑', 1);
		await expect(await issueList(page, '只列無客戶路徑')).toHaveText(['Switch B']);
		// 連到主機 H-03 後缺口消失
		await chip(page, '只列無客戶路徑').click();
		await addToEdit(page, ['主機 H-03']);
		await tab(page, 'edit').click();
		await addEdge(page, 'Switch B', '主機 H-03', '連線');
		await toGraph(page);
		await issueCount(page, '無客戶路徑', 0);
		expect(await findCustomers(page, 'Switch B')).toEqual(['客戶乙']);
	});

	test('情境 18：編輯後結果跟著變', async ({ page }) => {
		await toEdit(page, ['機櫃 PDU A-04-A', '機櫃 A-04']);
		await pick(page, '機櫃 PDU A-04-A');
		await pickEdge(page, '供電：機櫃 A-04');
		await detail(page).getByRole('button', { name: '刪除邊' }).click();
		await toGraph(page);
		await issueCount(page, '無客戶路徑', 1);
		await expect(await issueList(page, '只列無客戶路徑')).toHaveText(['機櫃 PDU A-04-A']);
		await chip(page, '只列無客戶路徑').click();
		// 完成情境 8、9 後，CAM-04 找客戶 = 客戶甲、乙
		await addToEdit(page, [G]);
		await tab(page, 'edit').click();
		await addNode(page, '攝影機', '攝影機 CAM-04');
		await addEdge(page, '攝影機 CAM-04', G, '監測');
		await toGraph(page);
		expect((await findCustomers(page, '攝影機 CAM-04')).sort()).toEqual(['客戶乙', '客戶甲']);
	});
});

test.describe('加入編輯頁', () => {
	/** ⌘K 搜尋並選取（全圖：選取；編輯頁：加入） */
	async function search(page: Page, name: string) {
		await page.keyboard.press('Escape');
		await page.keyboard.press('ControlOrMeta+k');
		await page.getByRole('textbox', { name: '搜尋節點' }).fill(name);
		await page.keyboard.press('Enter');
		// 結果由 Worker 回傳；Enter 在更新中會等新結果才執行，執行後關閉
		await expect(page.getByRole('dialog', { name: '搜尋節點' })).toHaveCount(0);
	}

	test('情境 19：把節點加入編輯頁', async ({ page }) => {
		// 操作 1：全圖搜尋，詳情加入
		await search(page, '機櫃 A-01');
		await detail(page).getByRole('button', { name: '加入編輯頁', exact: true }).click();
		await expect(status(page)).toHaveText('已加入編輯頁：新增 1 個節點、帶入 0 條邊');
		await search(page, '機櫃 PDU A-01-A');
		await detail(page).getByRole('button', { name: '加入編輯頁', exact: true }).click();
		await expect(tab(page, 'edit')).toHaveText('編輯頁 2/200');
		await tab(page, 'edit').click();
		// 只有這兩個節點與其間的邊；其他鄰居詳情看得到
		await expect(graphNodes(page)).toHaveCount(2);
		await expect(graphEdges(page)).toHaveCount(1);
		await pick(page, '機櫃 A-01');
		await expect(detail(page)).toContainText('連入（4）');
		await expect(detail(page)).toContainText('連出（3）');
		await expect(node(page, 'ToR Switch A-01')).toHaveCount(0);
		// 操作 2：編輯頁搜尋加入，與已在畫面的節點間的邊一併顯示
		await search(page, 'ToR Switch A-01');
		await expect(node(page, 'ToR Switch A-01')).toBeVisible();
		await expect(graphNodes(page)).toHaveCount(3);
		await expect(graphEdges(page)).toHaveCount(2);
		// 操作 3：新增節點直接出現
		await addNode(page, '攝影機', '攝影機 CAM-04');
		await expect(graphNodes(page)).toHaveCount(4);
		await expect(node(page, '攝影機 CAM-04')).toBeVisible();
	});

	test('情境 20：編輯頁超過 200 個節點', async ({ page }) => {
		test.setTimeout(300_000);
		// 全圖大綱翻頁取前 201 個節點（每頁 50），從編輯頁 ⌘K 逐一加入並定位
		const names: string[] = [];
		for (let p = 1; names.length < 201; p++) {
			await expect(outline(page)).toContainText(`第 ${p} / `);
			// 頁碼先換、結果由 Worker 回來前舊列表標 aria-busy（淡化）：等新頁結果到了才讀
			await expect(rows(page)).toHaveAttribute('aria-busy', 'false');
			await expect(rows(page).getByRole('listitem')).toHaveCount(50);
			names.push(
				...(await rows(page)
					.locator('button[data-id]')
					.evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.id!)))
			);
			await outline(page).getByRole('button', { name: '下一頁' }).click();
		}
		names.length = 201;
		expect(new Set(names).size).toBe(201);
		await tab(page, 'edit').click();
		const box = page.getByRole('textbox', { name: '搜尋節點' });
		for (const n of names.slice(0, 200)) {
			await page.keyboard.press('ControlOrMeta+k');
			await box.fill(n);
			await page.keyboard.press('Enter');
			await expect(box).toHaveCount(0);
		}
		await expect(tab(page, 'edit')).toHaveText('編輯頁 200/200');
		// 第 201 個整批擋下並提示需求與名額，已在畫面上的不變
		await page.keyboard.press('ControlOrMeta+k');
		await box.fill(names[200]);
		await page.keyboard.press('Enter');
		await expect(status(page)).toHaveText('工作區最多 200 個節點：要新增 1 個，只剩 0 個名額');
		await expect(tab(page, 'edit')).toHaveText('編輯頁 200/200');
		await expect(outline(page).locator(`button[data-id="${names[200]}"]`)).toHaveCount(0);
	});
});

test.describe('編輯器操作', () => {
	test('面板可收合，畫布變寬', async ({ page }) => {
		const main = page.locator('main');
		const w0 = (await main.boundingBox())!.width;
		await page.keyboard.press('ControlOrMeta+b');
		await page.keyboard.press('ControlOrMeta+i');
		await expect(outline(page)).toHaveCount(0);
		await expect(detail(page)).toHaveCount(0);
		await expect.poll(async () => (await main.boundingBox())!.width).toBeGreaterThan(w0 + 400);
		await page.getByRole('button', { name: '專注模式' }).click();
		await expect(outline(page)).toBeVisible();
		await expect(detail(page)).toBeVisible();
	});

	test('編輯頁：大綱篩選時畫布淡化不符合的節點', async ({ page }) => {
		// 原測試的全圖斷言：全部節點中 A-02 命中 5 個（3D 畫布無 DOM，只驗大綱）
		const search = outline(page).getByRole('searchbox', { name: '篩選節點' });
		await search.fill('A-02');
		await expect(rows(page).getByRole('listitem')).toHaveCount(5);
		await search.fill('');
		await toEdit(page, ['機櫃 A-01', '機櫃 A-02', '機櫃 PDU A-02-A', 'ToR Switch A-02']);
		// 加入時選了最後一個節點；先取消選取，只看篩選造成的淡化（原測試無選取）
		await clickPane(page);
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveCount(0);
		await outline(page).getByRole('searchbox', { name: '篩選節點' }).fill('A-02');
		await expect(rows(page).getByRole('listitem')).toHaveCount(3);
		await expect(dimmed(page)).toHaveCount(1);
		await page.keyboard.press('ControlOrMeta+b');
		await expect(dimmed(page)).toHaveCount(0);
		await page.keyboard.press('ControlOrMeta+b');
		await outline(page).getByRole('searchbox', { name: '篩選節點' }).fill('');
		await expect(dimmed(page)).toHaveCount(0);
	});

	test('主機與機框的包含、承載合併成一條雙向線（編輯頁）', async ({ page }) => {
		await toEdit(page, ['機框 A-01-F1', '主機 H-01', '機框 A-01-F2', '主機 H-02']);
		await expect(page.locator('.svelte-flow__edge[data-id^="承載:"]')).toHaveCount(0);
		const line = page.locator('.svelte-flow__edge[data-id^="包含:"] path.svelte-flow__edge-path');
		const both = await line.evaluateAll(
			(ps) =>
				ps.filter((p) => p.getAttribute('marker-start') && p.getAttribute('marker-end')).length
		);
		expect(both).toBe(2);
		// 資料仍是兩條邊，詳情分開列出
		await pick(page, '主機 H-01');
		await expect(detail(page).getByRole('button', { name: '承載：機框 A-01-F1' })).toBeVisible();
		await expect(detail(page).getByRole('button', { name: '包含：機框 A-01-F1' })).toBeVisible();
	});

	test('⌘K 搜尋節點並選取（全圖）', async ({ page }) => {
		await only(page, ['電力']);
		await page.keyboard.press('ControlOrMeta+k');
		// P3 排序：完全符合優先（只打 A-03 時同組依 ID 排，ToR Switch A-03 在前）
		await page.getByRole('textbox', { name: '搜尋節點' }).fill('機櫃 A-03');
		await page.keyboard.press('Enter');
		// 機櫃 A-03 屬空間，沒勾也會自動勾上
		await expect(page.getByRole('checkbox', { name: '空間' })).toBeChecked();
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveValue('機櫃 A-03');
		await graphReady(page);
		await expect.poll(() => page.evaluate(() => window.__graphView!.selected())).toBe('機櫃 A-03');
	});

	test('Alt＋點系統只看該系統', async ({ page }) => {
		await page.getByRole('checkbox', { name: '網路' }).click({ modifiers: ['Alt'] });
		for (const s of SYSTEMS)
			await expect(page.getByRole('checkbox', { name: s })).toBeChecked({ checked: s === '網路' });
		// 網路 345 個＋通用節點；連線 32 條（Core → 匯聚）＋327 條（匯聚 → ToR）
		await expectCounts(page, 346, 359);
	});

	test('系統開關、找客戶、未處理篩選只在全圖；編輯頁沒有', async ({ page }) => {
		await toEdit(page, ['台電市電']);
		await expect(page.getByRole('checkbox', { name: '空間' })).toHaveCount(0);
		await expect(chip(page, '只列未處理')).toHaveCount(0);
		await expect(detail(page).getByRole('button', { name: '找客戶' })).toHaveCount(0);
		await pick(page, '台電市電');
		await expect(detail(page).getByRole('button', { name: '找客戶' })).toHaveCount(0);
		await page.keyboard.press('f');
		await expect(page.getByRole('region', { name: '找客戶結果' })).toHaveCount(0);
		await toGraph(page);
		await expect(page.getByRole('checkbox', { name: '空間' })).toBeVisible();
		// 全圖不能編輯：沒有新增按鈕、快捷鍵無效、右鍵沒有選單
		await expect(page.getByRole('banner').getByRole('button', { name: '新增節點' })).toHaveCount(0);
		await page.keyboard.press('n');
		await expect(page.getByRole('form', { name: '新增節點' })).toHaveCount(0);
		await page.locator('main canvas').click({ button: 'right', position: { x: 300, y: 300 } });
		await expect(page.getByRole('menu')).toHaveCount(0);
	});

	test('全圖：F 對選取節點找客戶，Esc 清除', async ({ page }) => {
		await pick(page, '機櫃 PDU A-02-A');
		await page.keyboard.press('f');
		await expect(page.getByRole('region', { name: '找客戶結果' })).toContainText('客戶乙');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('region', { name: '找客戶結果' })).toHaveCount(0);
	});

	test('編輯頁右鍵空白處新增節點：自動命名、可直接改名', async ({ page }) => {
		await toEdit(page);
		await pane(page).click({ button: 'right', position: { x: 5, y: 5 } });
		await menu(page).getByRole('menuitem', { name: '新增節點' }).hover();
		await menu(page).getByRole('menuitem', { name: 'CCTV' }).hover();
		await menu(page).getByRole('menuitem', { name: '攝影機' }).click();
		await expect(graphNodes(page)).toHaveCount(1);
		await expect(badge(page, '攝影機 1', '未處理')).toHaveCount(1);
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveValue('攝影機 1');
	});

	test('編輯頁右鍵空白處：子選單新增節點', async ({ page }) => {
		await toEdit(page);
		await clickPane(page);
		await pane(page).click({ button: 'right', position: { x: 5, y: 5 } });
		await menu(page).getByRole('menuitem', { name: '新增節點' }).hover();
		await menu(page).getByRole('menuitem', { name: '消防' }).hover();
		await menu(page).getByRole('menuitem', { name: '偵測器' }).click();
		await expect(graphNodes(page)).toHaveCount(1);
		await expect(page.getByRole('menu')).toHaveCount(0);
	});

	test('編輯頁右鍵節點：沒有找客戶、不能刪的顯示原因', async ({ page }) => {
		await toEdit(page, ['台電市電', '機櫃 A-01']);
		await node(page, '台電市電').click({ button: 'right' });
		await expect(menu(page).getByRole('menuitem', { name: '連到…' })).toBeVisible();
		await expect(menu(page).getByRole('menuitem', { name: '找客戶' })).toHaveCount(0);
		await page.keyboard.press('Escape');
		// 同原測試：從大綱點選置中，滑鼠離開台電市電，其浮動工具列才不會擋住
		await pick(page, '機櫃 A-01');
		await node(page, '機櫃 A-01').click({ button: 'right' });
		await expect(menu(page).getByRole('menuitem', { name: /刪除節點/ })).toBeDisabled();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('menu')).toHaveCount(0);
	});

	test('編輯頁：同類兄弟節點收成一疊，點開展開、右鍵收回', async ({ page }) => {
		const pdus = ['A-05', 'A-06', 'A-07'].map((c) => `機櫃 PDU ${c}-A`);
		await toEdit(page, ['樓層 PDU 2F-A', ...pdus]);
		// 預設不收疊：四張卡都在
		await expect(graphNodes(page)).toHaveCount(4);
		await stackOn(page);
		const stack = node(page, '機櫃 PDU ×3');
		await expect(stack).toContainText('3 個同類');
		await expect(graphNodes(page)).toHaveCount(2);
		// 大綱點成員：選取但不展開（不重排），詳情顯示成員
		await outline(page).getByRole('button', { name: pdus[0] }).click();
		await expect(graphNodes(page)).toHaveCount(2);
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveValue(pdus[0]);
		await stack.click();
		await expect(graphNodes(page)).toHaveCount(4);
		await node(page, pdus[0]).click({ button: 'right' });
		await menu(page).getByRole('menuitem', { name: '收疊同類（3）' }).click();
		await expect(graphNodes(page)).toHaveCount(2);
	});

	test('編輯頁：雙擊疊卡只展開，不選到重排後的卡片', async ({ page }) => {
		await toEdit(page, ['樓層 PDU 2F-A', '機櫃 PDU A-05-A', '機櫃 PDU A-06-A', '機櫃 PDU A-07-A']);
		await stackOn(page);
		await clickPane(page); // 取消加入時的選取
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveCount(0);
		await node(page, '機櫃 PDU ×3').dblclick();
		await expect(graphNodes(page)).toHaveCount(4);
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveCount(0);
	});

	// P3：原「依系統分組全列、收合分組」改為分頁結果；選取的節點在當頁時標示並捲到該列
	test('全圖大綱分頁列出全部節點，選取的節點在結果中標示（全圖）', async ({ page }) => {
		await expect(outline(page)).toContainText(`共 ${TOTAL} 筆`);
		await expect(outline(page)).toContainText(`第 1 / ${Math.ceil(TOTAL / 50)} 頁`);
		await expect(rows(page).getByRole('listitem')).toHaveCount(50);
		const first = await rows(page).locator('button[data-id]').first().getAttribute('data-id');
		await outline(page).getByRole('button', { name: '下一頁' }).click();
		await expect(outline(page)).toContainText(`第 2 / ${Math.ceil(TOTAL / 50)} 頁`);
		await expect(rows(page).locator(`button[data-id="${first}"]`)).toHaveCount(0);
		await page.keyboard.press('ControlOrMeta+k');
		await page.getByRole('textbox', { name: '搜尋節點' }).fill('PDU A-01-A');
		await page.keyboard.press('Enter');
		await outline(page).getByRole('searchbox', { name: '篩選節點' }).fill('PDU A-01-A');
		await expect(rows(page).locator('button[data-id="機櫃 PDU A-01-A"]')).toHaveAttribute(
			'aria-current',
			'true'
		);
	});

	test('編輯頁右鍵節點刪除需二次確認', async ({ page }) => {
		await toEdit(page, ['偵測器 SD-02', G]);
		await node(page, '偵測器 SD-02').click({ button: 'right' });
		await menu(page).getByRole('menuitem', { name: '刪除節點' }).click();
		await expect(graphNodes(page)).toHaveCount(2);
		await menu(page)
			.getByRole('menuitem', { name: /確認刪除/ })
			.click();
		await expect(graphNodes(page)).toHaveCount(1);
	});
});

test.describe('手測回報', () => {
	// P0 回報：最後加入 A-07-A 再切到編輯頁，選取變成樓層 PDU 2F-A
	test('切到編輯頁、回全圖再回來，選取都還是原本的節點', async ({ page }) => {
		const names = ['樓層 PDU 2F-A', '機櫃 PDU A-05-A', '機櫃 PDU A-06-A', '機櫃 PDU A-07-A'];
		await toEdit(page, names);
		// 回報發生在收疊開啟時：選取的成員被收進疊卡
		await stackOn(page);
		await expect(graphNodes(page)).toHaveCount(2);
		const name = detail(page).getByLabel('名稱', { exact: true });
		await expect(name).toHaveValue('機櫃 PDU A-07-A');
		await toGraph(page);
		await expect.poll(() => page.evaluate(() => window.__graphView!.selected())).toBe(names[3]);
		await tab(page, 'edit').click();
		await settle(page);
		await expect(name).toHaveValue('機櫃 PDU A-07-A');
	});

	test('詳情欄點過的邊，選別的節點後不再亮著', async ({ page }) => {
		await toEdit(page, ['Core Switch-1', '匯聚 Switch AGG-A', '台電市電']);
		await pick(page, 'Core Switch-1');
		await detail(page).getByRole('button', { name: '連線：匯聚 Switch AGG-A' }).hover();
		await pickEdge(page, '連線：匯聚 Switch AGG-A');
		await pick(page, '台電市電');
		await expect(
			page
				.locator('.svelte-flow__edge[data-id="連線:Core Switch-1>匯聚 Switch AGG-A"] path')
				.first()
		).toHaveAttribute('style', /stroke-width: 1.25/);
	});

	test('選取疊卡成員、新增邊都不重排；右鍵「重新排版」才重排', async ({ page }) => {
		await toEdit(page, [
			'樓層 PDU 2F-A',
			'機櫃 PDU A-05-A',
			'機櫃 PDU A-06-A',
			'機櫃 PDU A-07-A',
			'偵測器 SD-01',
			'機櫃 A-03'
		]);
		await stackOn(page);
		await expect(graphNodes(page)).toHaveCount(4);
		const at = () =>
			graphNodes(page).evaluateAll((ns) =>
				Object.fromEntries(ns.map((n) => [n.dataset.id, (n as HTMLElement).style.transform]))
			);
		const before = await at();
		await outline(page).getByRole('button', { name: '機櫃 PDU A-05-A' }).click();
		expect(await at()).toEqual(before);
		await addEdge(page, '偵測器 SD-01', '機櫃 A-03', '監測');
		expect(await at()).toEqual(before);
		await page.keyboard.press('Escape');
		await pane(page).click({ button: 'right', position: { x: 5, y: 5 } });
		await menu(page).getByRole('menuitem', { name: '重新排版' }).click();
		expect(await at()).not.toEqual(before);
	});

	test('系統隱藏時從大綱點節點，自動勾回該系統並選取（全圖）', async ({ page }) => {
		await page.getByRole('checkbox', { name: '消防' }).setChecked(false);
		await expectCounts(page, TOTAL - 2, TOTAL_EDGES - 2);
		await outline(page).getByRole('searchbox', { name: '篩選節點' }).fill('SD-02');
		await outline(page).getByRole('button', { name: '偵測器 SD-02' }).click();
		await expect(page.getByRole('checkbox', { name: '消防' })).toBeChecked();
		await expectCounts(page, TOTAL, TOTAL_EDGES);
		await expect
			.poll(() => page.evaluate(() => window.__graphView!.selected()))
			.toBe('偵測器 SD-02');
	});

	test('文字與問題篩選疊加沒結果時，說明並可一鍵清除', async ({ page }) => {
		await outline(page).getByLabel('篩選節點').fill('Switch');
		await chip(page, '只列未處理').click();
		await expect(outline(page)).toContainText('「Switch」裡沒有未處理的節點');
		await outline(page).getByRole('button', { name: '清除未處理篩選' }).click();
		await expect(outline(page).getByRole('button', { name: 'Core Switch-1' })).toBeVisible();
	});

	test('文字本身沒命中時不怪問題篩選', async ({ page }) => {
		await outline(page).getByLabel('篩選節點').fill('zzz');
		await chip(page, '只列未處理').click();
		await expect(outline(page)).toContainText('沒有符合的節點');
		await expect(outline(page).getByRole('button', { name: '清除未處理篩選' })).toHaveCount(0);
	});

	test('新邊確認狀態預設推定（虛線），只能選已確認／推定', async ({ page }) => {
		await toEdit(page, ['偵測器 SD-01', '機櫃 A-03']);
		await addEdge(page, '偵測器 SD-01', '機櫃 A-03', '監測');
		const s = detail(page).getByLabel('確認狀態');
		await expect(s).toHaveValue('推定');
		await expect(s.locator('option')).toHaveText(['已確認', '推定']);
		const path = page.locator('.svelte-flow__edge[data-id^="e-"] path').first();
		await expect(path).toHaveAttribute('style', /stroke-dasharray/);
		await s.selectOption('已確認');
		await detail(page).getByRole('button', { name: '儲存' }).click();
		await expect(path).not.toHaveAttribute('style', /stroke-dasharray/);
	});

	test('詳情草稿：未儲存不改圖，取消還原，儲存一次寫回', async ({ page }) => {
		await toEdit(page, ['空調箱 AHU-2F-1']);
		await pick(page, '空調箱 AHU-2F-1');
		const name = detail(page).getByLabel('名稱', { exact: true });
		const save = detail(page).getByRole('button', { name: '儲存' });
		await expect(save).toBeDisabled();
		await name.fill('空調箱 草稿');
		await detail(page).getByLabel('屬性名稱').fill('品牌');
		await detail(page).getByLabel('屬性值').fill('示意');
		await detail(page).getByRole('button', { name: '新增屬性' }).click();
		// 草稿只在詳情欄，畫布仍是原名
		await expect(node(page, '空調箱 AHU-2F-1')).toBeVisible();
		await expect(detail(page)).toContainText('尚未儲存');
		await detail(page).getByRole('button', { name: '取消變更' }).click();
		await expect(name).toHaveValue('空調箱 AHU-2F-1');
		await expect(detail(page).getByLabel('品牌')).toHaveCount(0);
		await expect(save).toBeDisabled();

		await name.fill('空調箱 已存');
		await detail(page).getByLabel('屬性名稱').fill('品牌');
		await detail(page).getByLabel('屬性值').fill('示意');
		await detail(page).getByRole('button', { name: '新增屬性' }).click();
		await save.click();
		await expect(node(page, '空調箱 已存')).toBeVisible();
		await expect(detail(page).getByLabel('品牌')).toHaveValue('示意');
		await expect(save).toBeDisabled();

		// 不合法欄位整筆不寫入，畫布維持已儲存的名稱
		await name.fill('');
		await save.click();
		await expect(page.getByText('名稱不可空白')).toBeVisible();
		await expect(node(page, '空調箱 已存')).toBeVisible();
	});
});

test.describe('全量搜尋與分頁（P3）', () => {
	const palette = (page: Page) => page.getByRole('dialog', { name: '搜尋節點' });
	async function openPalette(page: Page, text: string) {
		await page.keyboard.press('Escape');
		await page.keyboard.press('ControlOrMeta+k');
		await page.getByRole('textbox', { name: '搜尋節點' }).fill(text);
	}

	test('⌘K 結果完整分頁，跨頁勾選後加入編輯頁不換畫面', async ({ page }) => {
		await openPalette(page, '機櫃 PDU');
		const p = palette(page);
		const list = p.getByRole('listbox', { name: '搜尋結果' });
		await expect(p).toContainText(/共 \d{3,} 筆/);
		await expect(list.getByRole('option')).toHaveCount(50);
		await p.getByRole('checkbox', { name: '勾選 機櫃 PDU A-01-A' }).check();
		await p.getByRole('button', { name: '下一頁' }).click();
		await expect(p).toContainText('第 2 / ');
		await expect(p.getByRole('checkbox', { name: '勾選 機櫃 PDU A-01-A' })).toHaveCount(0);
		await list.getByRole('checkbox').first().check();
		await expect(p).toContainText('已選 2');
		// 換關鍵字仍保留勾選
		await p.getByRole('textbox', { name: '搜尋節點' }).fill('UPS-1');
		await expect(p).toContainText('已選 2');
		await p.getByRole('button', { name: '加入編輯頁（2）' }).click();
		await expect(status(page)).toHaveText(/^已加入編輯頁：新增 2 個節點、帶入 \d+ 條邊$/);
		await expect(tab(page, 'edit')).toHaveText('編輯頁 2/200');
		// 不切畫面：仍在全圖，對話框還開著，可選擇前往
		await expect(tab(page, 'graph')).toHaveAttribute('aria-pressed', 'true');
		await expect(p.getByRole('button', { name: '前往編輯頁' })).toBeVisible();
		await p.getByRole('button', { name: '清除已選' }).click();
		await expect(p).not.toContainText('已選');
	});

	test('多字 AND、全形與大小寫正規化', async ({ page }) => {
		await openPalette(page, 'ｐｄｕ　a-01');
		const list = palette(page).getByRole('listbox', { name: '搜尋結果' });
		await expect(list.locator('button[data-id="機櫃 PDU A-01-A"]')).toBeVisible();
		await expect(list.locator('button[data-id="機櫃 A-01"]')).toHaveCount(0);
		await openPalette(page, 'zzz-沒有');
		await expect(palette(page)).toContainText('找不到「zzz-沒有」');
	});

	test('大綱勾選跨查詢保留，加入不換畫面；編輯頁大綱只查工作區', async ({ page }) => {
		const box = outline(page).getByRole('searchbox', { name: '篩選節點' });
		await box.fill('A-01');
		await outline(page).getByRole('checkbox', { name: '勾選 機櫃 A-01' }).check();
		await box.fill('SD-02');
		await outline(page).getByRole('checkbox', { name: '勾選 偵測器 SD-02' }).check();
		await expect(outline(page)).toContainText('已選 2');
		await outline(page).getByRole('button', { name: '加入編輯頁（2）' }).click();
		await expect(tab(page, 'edit')).toHaveText('編輯頁 2/200');
		await expect(tab(page, 'graph')).toHaveAttribute('aria-pressed', 'true');
		// 編輯頁大綱只查工作區
		await tab(page, 'edit').click();
		await box.fill('');
		await expect(outline(page)).toContainText('共 2 筆');
		await expect(rows(page).getByRole('listitem')).toHaveCount(2);
	});

	test('新增邊端點可搜尋到工作區外的節點', async ({ page }) => {
		await toEdit(page, ['偵測器 SD-01']);
		const f = await edgeForm(page, '偵測器 SD-01', '機櫃 A-03');
		await f.getByRole('radio', { name: '監測' }).check();
		await expect(f).toContainText('不在編輯頁的端點會和這條邊一起加入');
		await f.getByRole('button', { name: '新增邊' }).click();
		await expect(detail(page)).toContainText(field('終點', '機櫃 A-03'));
		// 工作區外的終點和邊一起加入，畫面上看得到
		await expect(tab(page, 'edit')).toHaveText('編輯頁 2/200');
		await expect(node(page, '機櫃 A-03')).toBeVisible();
	});
});

test.describe('局部工作區（P4）', () => {
	test('鄰居預覽：明確勾選前 20 個才整批加入', async ({ page }) => {
		await toEdit(page, ['樓層 PDU 2F-A']);
		const nb = detail(page).getByRole('region', { name: '鄰居預覽' });
		await expect(nb).toContainText(/工作區外 \d+ 個鄰居/);
		// 預設不勾選、不加入
		const add = nb.getByRole('button', { name: /^加入勾選的/ });
		await expect(add).toBeDisabled();
		await expect(tab(page, 'edit')).toHaveText('編輯頁 1/200');
		await nb.getByRole('button', { name: '勾選本頁前 20 個' }).click();
		await expect(nb).toContainText(/將新增 \d+ 個節點、帶入 \d+ 條邊/);
		await add.click();
		await expect(status(page)).toContainText('已加入編輯頁：新增');
		await expect(tab(page, 'edit')).not.toHaveText('編輯頁 1/200');
		await expect(nb).toContainText('已在編輯頁');
	});

	test('連工作區外端點：端點跟邊一起加入；移出與清空不刪資料', async ({ page }) => {
		await toEdit(page, ['偵測器 SD-01']);
		await addEdge(page, '偵測器 SD-01', '機櫃 A-03', '監測');
		await expect(tab(page, 'edit')).toHaveText('編輯頁 2/200');
		// 移出工作區：畫面少一張卡，資料還在
		await page.keyboard.press('Escape');
		await node(page, '機櫃 A-03').click();
		await detail(page).getByRole('button', { name: '移出工作區' }).click();
		await expect(tab(page, 'edit')).toHaveText('編輯頁 1/200');
		await expect(node(page, '機櫃 A-03')).toHaveCount(0);
		// 清空工作區
		await page.getByRole('banner').getByRole('button', { name: '清空工作區' }).click();
		await expect(tab(page, 'edit')).toHaveText('編輯頁 0/200');
		await toGraph(page);
		await pick(page, '機櫃 A-03');
		await expect(detail(page)).toContainText('偵測器 SD-01');
	});

	test('工作區外的邊：端點連結明確說明，「將兩端加入編輯頁」後才可修改', async ({ page }) => {
		await toEdit(page, ['樓層 PDU 2F-A']);
		// 詳情邊列中，另一端在工作區外的第一條邊
		const add = detail(page)
			.getByRole('button', { name: /^加入編輯頁：/ })
			.first();
		const other = (await add.getAttribute('aria-label'))!.replace('加入編輯頁：', '');
		await add.locator('xpath=preceding-sibling::button').click();
		const dir = detail(page).getByRole('combobox', { name: '方向' });
		await expect(dir).toBeDisabled();
		await detail(page)
			.getByRole('button', { name: new RegExp(`^(起點|終點)：${other}$`) })
			.click();
		await expect(status(page)).toHaveText(`「${other}」不在編輯頁：先將兩端加入編輯頁才能定位`);
		await expect(tab(page, 'edit')).toHaveText('編輯頁 1/200');
		await detail(page).getByRole('button', { name: '將兩端加入編輯頁' }).click();
		await expect(status(page)).toHaveText(/^已加入編輯頁：新增 1 個節點、帶入 \d+ 條邊$/);
		await expect(tab(page, 'edit')).toHaveText('編輯頁 2/200');
		await expect(dir).toBeEnabled();
		await detail(page)
			.getByRole('button', { name: new RegExp(`^(起點|終點)：${other}$`) })
			.click();
		await expect(detail(page).getByRole('textbox', { name: '名稱', exact: true })).toHaveValue(
			other
		);
	});

	test('2D 視野與位置在切到 3D 再回來後保留', async ({ page }) => {
		await toEdit(page, ['樓層 PDU 2F-A', '機櫃 PDU A-05-A']);
		await drag(page, node(page, '機櫃 PDU A-05-A'), { x: 700, y: 520 });
		await settle(page);
		const viewport = page.locator('.svelte-flow__viewport');
		const v0 = await viewport.getAttribute('style');
		const b0 = await node(page, '機櫃 PDU A-05-A').boundingBox();
		await toGraph(page);
		await tab(page, 'edit').click();
		await expect(pane(page)).toBeVisible();
		await settle(page);
		await expect(viewport).toHaveAttribute('style', v0!);
		const b1 = await node(page, '機櫃 PDU A-05-A').boundingBox();
		expect(b1!.x).toBeCloseTo(b0!.x, 0);
		expect(b1!.y).toBeCloseTo(b0!.y, 0);
	});
});

test.describe('全圖追查（P7）', () => {
	const trace = (page: Page) => page.getByRole('region', { name: '找客戶結果' });

	test('編輯拓撲後追查依最新資料重算，並標明分析版本', async ({ page }) => {
		expect(await findCustomers(page, '機櫃 PDU A-04-A')).toEqual(['客戶丙']);
		const version = trace(page).getByLabel('分析版本');
		await expect(version).toHaveText(/拓撲版本 \d+\s*$/);
		const before = await version.textContent();
		await toEdit(page, ['機櫃 PDU A-04-A', '機櫃 A-04']);
		await pick(page, '機櫃 PDU A-04-A');
		await pickEdge(page, '供電：機櫃 A-04');
		await detail(page).getByRole('button', { name: '刪除邊' }).click();
		await toGraph(page);
		// 追查仍在：結果依刪邊後的拓撲重算，明講已變更
		await expect(trace(page)).toContainText('走不到任何客戶');
		await expect(version).toContainText('拓撲已變更，已依最新資料重算');
		expect(await version.textContent()).not.toBe(before);
		await expect(page.getByRole('main')).toContainText('機櫃 PDU A-04-A → 0 位客戶');
		await trace(page).getByRole('button', { name: /清除/ }).click();
		await expect(trace(page)).toHaveCount(0);
	});

	test('完整結果分頁：沿途關係全數可翻；單選一條關係獨立亮起、追查保留、兩端可加入編輯頁', async ({
		page
	}) => {
		await findCustomers(page, '台電市電');
		await trace(page)
			.getByText(`沿途關係（${TOTAL_EDGES - 6}）`)
			.click();
		const nav = trace(page).getByRole('navigation', { name: '沿途關係分頁' });
		await expect(nav).toContainText(`共 ${TOTAL_EDGES - 6} 條`);
		const pages = Math.ceil((TOTAL_EDGES - 6) / 50);
		await expect(nav).toContainText(`第 1 / ${pages} 頁`);
		const rels = trace(page).getByRole('list', { name: '沿途關係' }).getByRole('listitem');
		await expect(rels).toHaveCount(50);
		await nav.getByRole('button', { name: '下一頁' }).click();
		await expect(nav).toContainText(`第 2 / ${pages} 頁`);
		await expect(rels).toHaveCount(50);
		await rels.first().getByRole('button').first().click();
		// 選了關係：詳情顯示邊、追查還在、這條排第一（選取色）
		await expect(detail(page).getByRole('button', { name: /^起點：/ })).toBeVisible();
		await expect(trace(page)).toContainText('43');
		const sel = await page.evaluate(() => window.__graphView!.selectedEdge());
		expect(sel).not.toBeNull();
		await expect
			.poll(() => page.evaluate(() => window.__graphView!.highlightEdgeIds()[0]))
			.toBe(sel);
		await trace(page).getByRole('button', { name: '兩端加入編輯頁' }).click();
		await expect(rels.first()).toContainText('已在編輯頁');
		await expect(nav).toContainText(`第 2 / ${pages} 頁`);
		// 沿途節點同樣完整分頁
		await trace(page)
			.getByText(`沿途節點（${TOTAL - 5}）`)
			.click();
		const nodeNav = trace(page).getByRole('navigation', { name: '沿途節點分頁' });
		await expect(nodeNav).toContainText(`共 ${TOTAL - 5} 個`);
		await expect(nodeNav).toContainText(`第 1 / ${Math.ceil((TOTAL - 5) / 50)} 頁`);
	});
});
