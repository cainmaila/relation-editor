// renderer 建構中途失敗：已加進場景的物件、已建立的 GPU 資源、標籤 DOM、場景 hook 都要收回。
// （檔名帶 .svelte 只為了走 browser 專案：標籤池需要真的 DOM）
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { UniverseRuntime } from './runtime';
import { createUniverseLayers, type UniverseLayersOptions } from './renderer';

type Three = UniverseLayersOptions['THREE'];

function setup(three: Three, labelHost = document.createElement('div')) {
	const scene = new THREE.Scene();
	const hook = scene.onBeforeRender;
	const rt = new UniverseRuntime({
		createWorker: () => ({ postMessage() {}, terminate() {} }) as never
	});
	const opts: UniverseLayersOptions = {
		THREE: three,
		scene,
		camera: () => new THREE.PerspectiveCamera(),
		size: () => ({ width: 100, height: 100 }),
		pixelRatio: () => 1,
		labelHost,
		runtime: rt,
		name: (id) => id,
		nodeColor: () => '#fff',
		onStats: () => {}
	};
	return { scene, hook, labelHost, opts };
}

/** 記下每個 GPU 資源（geometry／material）是否被 dispose */
function tracked(failAt: { cls: 'InstancedMesh'; nth: number } | null) {
	const made: { disposed: boolean }[] = [];
	// TS mixin 規則：建構子必須是 (...a: any[])
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type Ctor = new (...a: any[]) => { dispose(): void };
	const track = <T extends Ctor>(C: T) =>
		class extends C {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			constructor(...a: any[]) {
				super(...a);
				const rec = { disposed: false };
				made.push(rec);
				const d = this.dispose.bind(this);
				this.dispose = () => {
					rec.disposed = true;
					d();
				};
			}
		};
	let instanced = 0;
	const Instanced = class extends THREE.InstancedMesh {
		constructor(...a: ConstructorParameters<typeof THREE.InstancedMesh>) {
			if (failAt && ++instanced === failAt.nth) throw new Error('InstancedMesh 建立失敗');
			super(...a);
		}
	};
	const three = {
		...THREE,
		BufferGeometry: track(THREE.BufferGeometry),
		SphereGeometry: track(THREE.SphereGeometry),
		ConeGeometry: track(THREE.ConeGeometry),
		ShaderMaterial: track(THREE.ShaderMaterial),
		MeshLambertMaterial: track(THREE.MeshLambertMaterial),
		MeshBasicMaterial: track(THREE.MeshBasicMaterial),
		LineBasicMaterial: track(THREE.LineBasicMaterial),
		InstancedMesh: Instanced
	} as unknown as Three;
	return { three, made };
}

describe('createUniverseLayers 建構失敗清理', () => {
	it('GPU 層建到一半失敗：場景沒有殘留、已建資源都 dispose、沒有掛 hook', () => {
		// 第 2 個 InstancedMesh＝方向箭頭：此時 Points、detail、兩組 LineSegments 已加入場景
		const { three, made } = tracked({ cls: 'InstancedMesh', nth: 2 });
		const { scene, hook, labelHost, opts } = setup(three);
		expect(() => createUniverseLayers(opts)).toThrow('InstancedMesh 建立失敗');
		expect(made.length).toBeGreaterThan(3);
		expect(made.filter((m) => !m.disposed)).toEqual([]);
		expect(scene.children).toEqual([]);
		expect(scene.onBeforeRender).toBe(hook);
		expect(labelHost.childElementCount).toBe(0);
	});

	it('標籤池建到一半失敗：已插入的標籤移除、GPU 資源與場景都收回', () => {
		const { three, made } = tracked(null);
		const host = document.createElement('div');
		const append = host.appendChild.bind(host);
		let n = 0;
		host.appendChild = <T extends Node>(el: T) => {
			if (++n === 10) throw new Error('標籤插入失敗');
			return append(el);
		};
		const { scene, hook, labelHost, opts } = setup(three, host);
		expect(() => createUniverseLayers(opts)).toThrow('標籤插入失敗');
		expect(labelHost.childElementCount).toBe(0);
		expect(made.filter((m) => !m.disposed)).toEqual([]);
		expect(scene.children).toEqual([]);
		expect(scene.onBeforeRender).toBe(hook);
	});

	it('成功建立後 dispose 一樣全部收回（對照）', () => {
		const { three, made } = tracked(null);
		const { scene, hook, labelHost, opts } = setup(three);
		const layers = createUniverseLayers(opts);
		expect(scene.children.length).toBe(5);
		expect(scene.onBeforeRender).not.toBe(hook);
		layers.dispose();
		expect(made.filter((m) => !m.disposed)).toEqual([]);
		expect(scene.children).toEqual([]);
		expect(scene.onBeforeRender).toBe(hook);
		expect(labelHost.childElementCount).toBe(0);
	});
});
