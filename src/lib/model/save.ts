import type { Editor } from '#lib/editor.svelte.js';
import { saveFiles } from './load';

let saving = false;

/** 存到資料夾（尚未選過就先問）；驗證不過或寫入失敗會顯示原因，寫入成功才記為已存 */
export async function saveEditor(editor: Editor) {
	// 第一次存檔會等資料夾對話框；連按 ⌘S 不能開出第二個對話框或並行寫入
	if (saving || !editor.unsaved) return;
	// 存檔期間使用者可能又改了：記下要寫出的那一刻，寫完只標記這一份為已存
	const snapshot = editor.snapshot;
	const files = editor.exportFiles();
	if (!files) return;
	saving = true;
	try {
		if (await saveFiles(files)) editor.markSaved(snapshot);
	} catch (e) {
		editor.message = `儲存失敗：${e instanceof Error ? e.message : e}`;
	} finally {
		saving = false;
	}
}
