export type Props = Record<string, string>;

export interface GNode {
	id: string;
	type: string;
	name: string;
	props: Props;
	/** 來自 IDC mock，唯讀 */
	readonly?: boolean;
}

export interface GEdge {
	id: string;
	type: string;
	from: string;
	to: string;
	bidirectional: boolean;
	props: Props;
	/** 來自 IDC mock，唯讀 */
	readonly?: boolean;
}

export interface Graph {
	nodes: GNode[];
	edges: GEdge[];
}
