// 搜尋 Worker：持有正規化文件快取，主執行緒只拿總數與當頁 IDs
import { handleSearchMessage, type SearchRequest } from './protocol';
import { SearchStore } from './search-index';

const store = new SearchStore();

self.onmessage = (e: MessageEvent<SearchRequest>) => {
	postMessage(handleSearchMessage(store, e.data));
};
