// PRD §6 情境 1–18 驗收
import { expect, test, type Locator, type Page } from '@playwright/test';

const SYSTEMS = ['空間', '電力', '空調', '網路', '消防', 'CCTV', 'IDC'];
const G = '2F A 區監視與偵測範圍';

const node = (page: Page, name: string) =>
	page.locator('.svelte-flow__node-graph').filter({ has: page.getByText(name, { exact: true }) });
/** 節點卡上的狀態圖示（未處理、到不了客戶） */
const badge = (page: Page, name: string, b: string) =>
	node(page, name).getByRole('img', { name: b, exact: true });
const graphNodes = (page: Page) => page.locator('.svelte-flow__node-graph');
const graphEdges = (page: Page) => page.locator('.svelte-flow__edge');
const dimmed = (page: Page) => page.locator('.svelte-flow__node-graph .opacity-20');
const detail = (page: Page) => page.getByRole('complementary', { name: '詳情' });
/** 詳情的「欄位 值」 */
const field = (k: string, v: string) => new RegExp(`${k}\\s*${v}`);
const TOTAL_EDGES = 70; // 圖 50 條＋IDC 20 條
const status = (page: Page) => page.getByRole('status');
const outline = (page: Page) => page.getByRole('navigation', { name: '大綱' });
const unprocessedChip = (page: Page) => outline(page).getByRole('button', { name: '只列未處理' });
/** 大綱切到「只列未處理」後的節點列 */
async function unprocessedList(page: Page) {
	const chip = unprocessedChip(page);
	if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
	return outline(page).getByRole('listitem');
}

async function only(page: Page, systems: string[]) {
	for (const s of SYSTEMS)
		await page.getByRole('checkbox', { name: s }).setChecked(systems.includes(s));
}
/** 先全部顯示（新增、找客戶後視野會移動）再點 */
const fitAll = (page: Page) => page.locator('.svelte-flow__controls-fitview').click();
async function pick(page: Page, name: string) {
	await fitAll(page);
	await node(page, name).click();
}
const clickPane = (page: Page) =>
	page.locator('.svelte-flow__pane').click({ position: { x: 5, y: 5 } });

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
async function edgeForm(page: Page, from: string, to: string) {
	const f = await open(page, '新增邊', '新增邊');
	await f.getByLabel('起點').selectOption({ label: from });
	await f.getByLabel('終點').selectOption({ label: to });
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
async function findCustomers(page: Page, name: string) {
	await pick(page, name);
	await detail(page).getByRole('button', { name: '找客戶' }).click();
	return page.getByRole('region', { name: '找客戶結果' }).getByRole('listitem').allTextContents();
}

const stackToggle = (page: Page) => page.getByRole('button', { name: '收疊同類', exact: true });

// PRD 情境逐一數節點：先關掉收疊，全部 44 個攤開
test.beforeEach(async ({ page }) => {
	await page.goto('/');
	await expect(graphNodes(page)).toHaveCount(37);
	await stackToggle(page).click();
	await expect(graphNodes(page)).toHaveCount(44);
});

test.describe('看圖', () => {
	test('情境 1：一眼看懂整張圖', async ({ page }) => {
		// 系統不再分欄：每個系統有開關，節點以系統圖示＋色條區分
		for (const s of SYSTEMS) await expect(page.getByRole('checkbox', { name: s })).toBeVisible();
		await expect(node(page, '機櫃 A-01').locator('[title="空間"]')).toBeVisible();
		await expect(node(page, '機櫃 A-01')).toContainText('機櫃');
		await expect(node(page, G)).toBeVisible();
		await expect(unprocessedChip(page)).toHaveText(/未處理\s*0$/);
		await expect(graphNodes(page).getByRole('img', { name: '未處理', exact: true })).toHaveCount(0);
	});

	test('情境 2：系統內是二維', async ({ page }) => {
		await only(page, ['電力']);
		// 電力 11 個＋永遠顯示的通用節點
		await expect(graphNodes(page)).toHaveCount(12);
		await expect(graphEdges(page)).toHaveCount(10);
		// 沿邊方向由左往右
		const x = async (n: string) => (await node(page, n).boundingBox())!.x;
		expect(await x('台電市電')).toBeLessThan(await x('UPS-1'));
		expect(await x('UPS-1')).toBeLessThan(await x('樓層 PDU 2F-A'));
		expect(await x('樓層 PDU 2F-A')).toBeLessThan(await x('機櫃 PDU A-01-A'));
		await only(page, ['空間']);
		// 空間 8 個＋通用節點；7 條包含＋通用節點→機櫃 A-01、A-02
		await expect(graphNodes(page)).toHaveCount(9);
		await expect(graphEdges(page)).toHaveCount(9);
	});

	test('情境 3：系統相連就成為多維', async ({ page }) => {
		await only(page, ['空間', '電力']);
		await expect(graphEdges(page)).toHaveCount(9 + 10 + 8);
		await only(page, ['空間', '電力', '空調']);
		await expect(graphEdges(page)).toHaveCount(9 + 10 + 8 + 2);
	});

	test('情境 4：通用節點整理跨系統連線', async ({ page }) => {
		await only(page, ['空間', '消防', 'CCTV']);
		await pick(page, G);
		await expect(detail(page)).toContainText('連入（3）');
		await expect(detail(page)).toContainText('連出（2）');
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveValue(G);
		await expect(detail(page).getByText('通用節點', { exact: true })).toBeVisible(); // 類型欄
	});

	test('情境 5：聚焦一個節點', async ({ page }) => {
		await pick(page, '機櫃 A-01');
		await expect(dimmed(page)).toHaveCount(44 - 8);
		for (const n of [
			'A 排',
			'機櫃 PDU A-01-A',
			'機櫃 PDU A-01-B',
			G,
			'機框 A-01-F1',
			'機框 A-01-F2',
			'ToR Switch A-01'
		])
			await expect(node(page, n).locator('.opacity-20')).toHaveCount(0);
		await clickPane(page);
		await expect(dimmed(page)).toHaveCount(0);
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

	test('情境 7：看節點與邊的詳情', async ({ page }) => {
		await pick(page, '機櫃 PDU A-01-A');
		await expect(detail(page)).toContainText(field('類型', '機櫃 PDU'));
		await expect(detail(page)).toContainText(field('系統', '電力'));
		await expect(detail(page).getByLabel('額定電流')).toHaveValue('32A');
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
	});
});

test.describe('編輯', () => {
	test('情境 8：新增節點', async ({ page }) => {
		const f = await open(page, '新增節點', '新增節點');
		await f.getByRole('button', { name: '新增節點' }).click();
		await expect(status(page)).toHaveText('請選擇類型');
		await expect(graphNodes(page)).toHaveCount(44);
		await addNode(page, '攝影機', '攝影機 CAM-04');
		await expect(graphNodes(page)).toHaveCount(45);
		await expect(badge(page, '攝影機 CAM-04', '未處理')).toHaveCount(1);
		await expect(await unprocessedList(page)).toHaveText(['攝影機 CAM-04']);
		await expect(node(page, '攝影機 CAM-04').locator('[title="CCTV"]')).toBeVisible();
	});

	test('情境 9：新增邊', async ({ page }) => {
		await addNode(page, '攝影機', '攝影機 CAM-04');
		await addEdge(page, '攝影機 CAM-04', G, '監測');
		await expect(detail(page)).toContainText(field('起點', '攝影機 CAM-04'));
		await expect(detail(page).getByLabel('方向')).toHaveValue('單向');
		await pick(page, G);
		await expect(detail(page)).toContainText('連入（4）');
		await expect(badge(page, '攝影機 CAM-04', '未處理')).toHaveCount(0);
		await expect(unprocessedChip(page)).toHaveText(/未處理\s*0$/);
	});

	test('情境 9：拖曳卡片到另一張建立邊', async ({ page }) => {
		await addNode(page, '攝影機', '攝影機 CAM-04');
		await fitAll(page);
		await drag(page, node(page, '攝影機 CAM-04'), node(page, G));
		const m = page.getByRole('menu', { name: '建立邊' });
		await expect(m).toContainText(`攝影機 CAM-04 → ${G}`);
		await expect(m.getByRole('menuitem', { name: '供電' })).toBeDisabled();
		await expect(graphEdges(page)).toHaveCount(TOTAL_EDGES);
		await m.getByRole('menuitem', { name: '監測' }).click();
		await expect(graphEdges(page)).toHaveCount(TOTAL_EDGES + 1);
		await expect(badge(page, '攝影機 CAM-04', '未處理')).toHaveCount(0);
	});

	test('情境 8＋9：拖到空白處新增節點並連線', async ({ page }) => {
		await only(page, ['空間', 'CCTV']);
		const b = (await page.locator('.svelte-flow__pane').boundingBox())!;
		await drag(page, node(page, G), { x: b.x + b.width / 2, y: b.y + b.height - 30 });
		const m = page.getByRole('menu', { name: '新增節點並連線' });
		await m.getByRole('menuitem', { name: '空間' }).hover();
		await m.getByRole('menuitem', { name: '區域' }).click();
		await page
			.getByRole('menu', { name: '建立邊' })
			.getByRole('menuitem', { name: '包含' })
			.click();
		await expect(graphNodes(page)).toHaveCount(11);
		await expect(detail(page)).toContainText(field('終點', '區域 1'));
	});

	test('情境 10：違反連接限制時擋下', async ({ page }) => {
		// 不合法的類型事先停用並寫出原因
		let f = await edgeForm(page, '機櫃 A-01', 'UPS-1');
		await expect(f.getByRole('radio', { name: '供電' })).toBeDisabled();
		await expect(f).toContainText('「供電」只能由電力設備連出');
		f = await edgeForm(page, '偵測器 SD-01', '客戶甲');
		await expect(f.getByRole('radio', { name: '監測' })).toBeDisabled();
		await expect(f).toContainText('「監測」只能連到空間或通用節點');
		await page.keyboard.press('Escape');
		await expect(graphEdges(page)).toHaveCount(TOTAL_EDGES);

		// 例外：通用節點不受連接限制
		const G = '2F A 區監視與偵測範圍';
		await addEdge(page, '空調箱 AHU-2F-1', G, '冷卻');
		await addEdge(page, '2F A 區', G, '包含');
		await expect(graphEdges(page)).toHaveCount(TOTAL_EDGES + 2);
	});

	test('情境 11：修改節點與邊', async ({ page }) => {
		await pick(page, '機櫃 PDU A-01-B');
		await detail(page).getByLabel('額定電流').fill('16A');
		await detail(page).getByLabel('屬性名稱').fill('品牌');
		await detail(page).getByLabel('屬性值').fill('示意');
		await detail(page).getByRole('button', { name: '新增屬性' }).click();
		await expect(detail(page).getByLabel('額定電流')).toHaveValue('16A');
		await expect(detail(page).getByLabel('品牌')).toHaveValue('示意');

		await pick(page, 'Core Switch-1');
		await pickEdge(page, '連線：匯聚 Switch AGG-A');
		await detail(page).getByLabel('方向').selectOption('雙向');
		await expect(detail(page).getByLabel('方向')).toHaveValue('雙向');
		const edge = page
			.locator('.svelte-flow__edge[data-id="連線:Core Switch-1>匯聚 Switch AGG-A"] path')
			.first();
		await expect(edge).toHaveAttribute('marker-start', /.+/);

		await pick(page, '空調箱 AHU-2F-1');
		await detail(page).getByLabel('名稱', { exact: true }).fill('空調箱 AHU-2F-01');
		await expect(node(page, '空調箱 AHU-2F-01')).toBeVisible();
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveValue('空調箱 AHU-2F-01');
	});

	test('情境 12：刪除節點與邊', async ({ page }) => {
		await pick(page, '偵測器 SD-02');
		await detail(page).getByRole('button', { name: '刪除節點' }).click();
		await expect(detail(page)).toContainText('連同 1 條邊一起刪除？');
		await detail(page).getByRole('button', { name: '確認刪除' }).click();
		await expect(node(page, '偵測器 SD-02')).toHaveCount(0);
		await pick(page, G);
		await expect(detail(page)).toContainText('連入（2）');

		await pick(page, '空調箱 AHU-2F-1');
		await pickEdge(page, '冷卻：2F A 區');
		await detail(page).getByRole('button', { name: '刪除邊' }).click();
		await expect(badge(page, '空調箱 AHU-2F-1', '未處理')).toHaveCount(0);
		await expect(node(page, '2F A 區')).toBeVisible();

		await pick(page, 'Core Switch-2');
		await pickEdge(page, '包含：2F A 區');
		await detail(page).getByRole('button', { name: '刪除邊' }).click();
		await pick(page, 'Core Switch-2');
		await pickEdge(page, '連線：匯聚 Switch AGG-A');
		await detail(page).getByRole('button', { name: '刪除邊' }).click();
		await expect(await unprocessedList(page)).toHaveText(['Core Switch-2']);
		await expect(badge(page, '匯聚 Switch AGG-A', '未處理')).toHaveCount(0);

		await pick(page, '機櫃 A-01');
		await expect(detail(page).getByRole('button', { name: '刪除節點' })).toBeDisabled();
		await expect(detail(page)).toContainText('機櫃底下有 IDC 資料，請先在 IDC機櫃配置管理移除機框');
		await expect(node(page, '機櫃 A-01')).toBeVisible();
		await expect(graphEdges(page)).toHaveCount(TOTAL_EDGES - 4);
	});

	test('情境 13：IDC 維護的資料不能改', async ({ page }) => {
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
		await addNode(page, '攝影機', '攝影機 CAM-04');
		await expect(graphNodes(page)).toHaveCount(45);
		await page.reload();
		await expect(graphNodes(page)).toHaveCount(37);
		await stackToggle(page).click();
		await expect(graphNodes(page)).toHaveCount(44);
		await expect(node(page, '攝影機 CAM-04')).toHaveCount(0);
	});
});

test.describe('找客戶', () => {
	test('情境 15：從源頭找客戶', async ({ page }) => {
		expect((await findCustomers(page, '台電市電')).sort()).toEqual(['客戶丙', '客戶乙', '客戶甲']);
		for (const n of [
			'UPS-1',
			'樓層 PDU 2F-A',
			'機櫃 PDU A-04-B',
			'機櫃 A-04',
			'機框 A-04-F1',
			'空調箱 AHU-2F-1',
			'2F A 區',
			'A 排'
		])
			await expect(node(page, n).locator('.opacity-20')).toHaveCount(0);
		await expect(node(page, '偵測器 SD-01').locator('.opacity-20')).toHaveCount(1);
	});

	test('情境 16：找到的客戶是精確的', async ({ page }) => {
		expect(await findCustomers(page, '機櫃 PDU A-02-A')).toEqual(['客戶乙']);
		expect((await findCustomers(page, '偵測器 SD-01')).sort()).toEqual(['客戶乙', '客戶甲']);
		expect(await findCustomers(page, '主機 H-02')).toEqual(['客戶乙']);
		expect((await findCustomers(page, 'Core Switch-1')).sort()).toEqual([
			'客戶丙',
			'客戶乙',
			'客戶甲'
		]);
		expect(await findCustomers(page, 'ToR Switch A-02')).toEqual(['客戶乙']);
	});

	test('情境 17：標出到不了客戶的節點', async ({ page }) => {
		await expect(
			graphNodes(page).getByRole('img', { name: '到不了客戶', exact: true })
		).toHaveCount(0);
		await addNode(page, 'Switch', 'Switch B');
		await addEdge(page, '匯聚 Switch AGG-A', 'Switch B', '連線');
		await expect(badge(page, 'Switch B', '未處理')).toHaveCount(0);
		await expect(badge(page, 'Switch B', '到不了客戶')).toHaveCount(1);
		await addEdge(page, 'Switch B', '主機 H-03', '連線');
		await expect(badge(page, 'Switch B', '到不了客戶')).toHaveCount(0);
		expect(await findCustomers(page, 'Switch B')).toEqual(['客戶乙']);
	});

	test('情境 18：編輯後結果跟著變', async ({ page }) => {
		await pick(page, '機櫃 PDU A-04-A');
		await pickEdge(page, '供電：機櫃 A-04');
		await detail(page).getByRole('button', { name: '刪除邊' }).click();
		await expect(badge(page, '機櫃 PDU A-04-A', '到不了客戶')).toHaveCount(1);
		await addNode(page, '攝影機', '攝影機 CAM-04');
		await addEdge(page, '攝影機 CAM-04', G, '監測');
		expect((await findCustomers(page, '攝影機 CAM-04')).sort()).toEqual(['客戶乙', '客戶甲']);
	});
});

test.describe('編輯器操作', () => {
	test('面板可收合，畫布變寬', async ({ page }) => {
		const canvas = page.locator('.svelte-flow');
		const w0 = (await canvas.boundingBox())!.width;
		await page.keyboard.press('ControlOrMeta+b');
		await page.keyboard.press('ControlOrMeta+i');
		await expect(outline(page)).toHaveCount(0);
		await expect(detail(page)).toHaveCount(0);
		await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(w0 + 400);
		await page.getByRole('button', { name: '專注模式' }).click();
		await expect(outline(page)).toBeVisible();
		await expect(detail(page)).toBeVisible();
	});

	test('大綱篩選時畫布淡化不符合的節點', async ({ page }) => {
		await outline(page).getByRole('searchbox', { name: '篩選節點' }).fill('A-02');
		await expect(outline(page).getByRole('listitem')).toHaveCount(5);
		await expect(dimmed(page)).toHaveCount(44 - 5);
		await page.keyboard.press('ControlOrMeta+b');
		await expect(dimmed(page)).toHaveCount(0);
		await page.keyboard.press('ControlOrMeta+b');
		await outline(page).getByRole('searchbox', { name: '篩選節點' }).fill('');
		await expect(dimmed(page)).toHaveCount(0);
	});

	test('承載邊由左往右畫，不折回', async ({ page }) => {
		const paths = page.locator('.svelte-flow__edge[data-id^="承載:"] path.svelte-flow__edge-path');
		await expect(paths).not.toHaveCount(0);
		for (const d of await paths.evaluateAll((ps) => ps.map((p) => p.getAttribute('d')!))) {
			const xs = [...d.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((m) => +m[1]);
			expect(xs[0]).toBeLessThan(xs.at(-1)!);
		}
	});

	test('⌘K 搜尋節點並選取', async ({ page }) => {
		await only(page, ['電力']);
		await page.keyboard.press('ControlOrMeta+k');
		await page.getByRole('textbox', { name: '搜尋節點' }).fill('A-03');
		await page.keyboard.press('Enter');
		// 機櫃 A-03 屬空間，沒勾也會自動勾上
		await expect(page.getByRole('checkbox', { name: '空間' })).toBeChecked();
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveValue('機櫃 A-03');
	});

	test('Alt＋點系統只看該系統', async ({ page }) => {
		await page.getByRole('checkbox', { name: '網路' }).click({ modifiers: ['Alt'] });
		for (const s of SYSTEMS)
			await expect(page.getByRole('checkbox', { name: s })).toBeChecked({ checked: s === '網路' });
	});

	test('右鍵空白處新增節點：自動命名、可直接改名', async ({ page }) => {
		await page.locator('.svelte-flow__pane').click({ button: 'right', position: { x: 5, y: 5 } });
		await menu(page).getByRole('menuitem', { name: '新增節點' }).hover();
		await menu(page).getByRole('menuitem', { name: 'CCTV' }).hover();
		await menu(page).getByRole('menuitem', { name: '攝影機' }).click();
		await expect(graphNodes(page)).toHaveCount(45);
		await expect(badge(page, '攝影機 1', '未處理')).toHaveCount(1);
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveValue('攝影機 1');
	});

	test('右鍵空白處：子選單新增節點', async ({ page }) => {
		await clickPane(page);
		await page.locator('.svelte-flow__pane').click({ button: 'right', position: { x: 5, y: 5 } });
		await menu(page).getByRole('menuitem', { name: '新增節點' }).hover();
		await menu(page).getByRole('menuitem', { name: '消防' }).hover();
		await menu(page).getByRole('menuitem', { name: '偵測器' }).click();
		await expect(graphNodes(page)).toHaveCount(45);
		await expect(page.getByRole('menu')).toHaveCount(0);
	});

	test('右鍵節點：找客戶、不能刪的顯示原因', async ({ page }) => {
		await fitAll(page);
		await node(page, '台電市電').click({ button: 'right' });
		await menu(page).getByRole('menuitem', { name: '找客戶' }).click();
		await expect(page.getByRole('region', { name: '找客戶結果' })).toContainText('3');
		await fitAll(page);
		await node(page, '機櫃 A-01').click({ button: 'right' });
		await expect(menu(page).getByRole('menuitem', { name: /刪除節點/ })).toBeDisabled();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('menu')).toHaveCount(0);
	});

	test('同類兄弟節點收成一疊，點開展開、右鍵收回', async ({ page }) => {
		await stackToggle(page).click();
		await expect(graphNodes(page)).toHaveCount(37);
		const stack = node(page, '機櫃 PDU ×8');
		await expect(stack).toContainText('8 個同類');
		// 大綱點成員：自動展開並選取
		await outline(page).getByRole('button', { name: '機櫃 PDU A-02-A' }).click();
		await expect(graphNodes(page)).toHaveCount(44);
		await expect(detail(page).getByLabel('名稱', { exact: true })).toHaveValue('機櫃 PDU A-02-A');
		await fitAll(page);
		await node(page, '機櫃 PDU A-02-A').click({ button: 'right' });
		await menu(page).getByRole('menuitem', { name: '收疊同類（8）' }).click();
		await expect(graphNodes(page)).toHaveCount(37);
		await fitAll(page);
		await stack.click();
		await expect(graphNodes(page)).toHaveCount(44);
	});

	test('右鍵節點刪除需二次確認', async ({ page }) => {
		await fitAll(page);
		await node(page, '偵測器 SD-02').click({ button: 'right' });
		await menu(page).getByRole('menuitem', { name: '刪除節點' }).click();
		await expect(graphNodes(page)).toHaveCount(44);
		await menu(page)
			.getByRole('menuitem', { name: /確認刪除/ })
			.click();
		await expect(graphNodes(page)).toHaveCount(43);
	});
});
