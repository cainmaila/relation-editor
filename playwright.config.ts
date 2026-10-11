import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: { command: 'pnpm build && pnpm preview', port: 4173 },
	testMatch: '**/*.e2e.{ts,js}',
	// 2,066 個節點的圖：載入與每次排版都比較慢
	fullyParallel: true,
	timeout: 90_000,
	expect: { timeout: 20_000 }
});
