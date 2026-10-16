import { isTauri } from '@tauri-apps/api/core';

/** 有未存改動時確認要不要丟掉；Tauri 的 webview 不支援 window.confirm，改用原生對話框 */
export async function confirmDiscard(): Promise<boolean> {
	const msg = '有未儲存的改動，確定要捨棄？';
	if (!isTauri()) return confirm(msg);
	const { ask } = await import('@tauri-apps/plugin-dialog');
	return ask(msg, { kind: 'warning' });
}
