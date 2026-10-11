import { loadGraph } from '#lib/model/load.js';

export const load = async ({ fetch }) => ({ graph: await loadGraph(fetch) });
