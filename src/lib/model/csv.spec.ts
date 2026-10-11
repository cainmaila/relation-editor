import { describe, expect, it } from 'vitest';
import { buildGraph, parseCsv } from './csv';

describe('parseCsv', () => {
	it('引號、逗號、"" 跳脫、欄內換行', () => {
		expect(parseCsv('a,"b,c","d""e","f\ng"\n')).toEqual([['a', 'b,c', 'd"e', 'f\ng']]);
	});
	it('BOM、CRLF、空白格子、空白列', () => {
		expect(parseCsv('﻿a,b,c\r\n1,,3\r\n\r\n')).toEqual([
			['a', 'b', 'c'],
			['1', '', '3']
		]);
	});
	it('結尾沒換行也讀到最後一列', () => {
		expect(parseCsv('a,b\n1,2')).toEqual([
			['a', 'b'],
			['1', '2']
		]);
	});
});

const files = (extra: [string, string][] = []): [string, string][] => [
	['nodes/空間.csv', '類型,名稱,總 U 數\n機櫃,機櫃 A-01,42\n機櫃,機櫃 A-02,\n排,A 排,'],
	['nodes/通用.csv', '類型,名稱\n通用節點,範圍 X'],
	['edges/包含.csv', '起點,終點,雙向,確認狀態\n機櫃 A-01,機櫃 A-02,是,已確認'],
	['idc/nodes/客戶.csv', '名稱\n客戶甲'],
	...extra
];

describe('buildGraph', () => {
	it('系統檔每列自帶類型；idc 檔名即類型且唯讀；空格子沒有該屬性', () => {
		const g = buildGraph(files());
		expect(g.nodes).toEqual([
			{ id: '機櫃 A-01', type: '機櫃', name: '機櫃 A-01', props: { '總 U 數': '42' } },
			{ id: '機櫃 A-02', type: '機櫃', name: '機櫃 A-02', props: {} },
			{ id: 'A 排', type: '排', name: 'A 排', props: {} },
			{ id: '範圍 X', type: '通用節點', name: '範圍 X', props: {} },
			{ id: '客戶甲', type: '客戶', name: '客戶甲', props: {}, readonly: true }
		]);
		expect(g.edges).toEqual([
			{
				id: '包含:機櫃 A-01>機櫃 A-02',
				type: '包含',
				from: '機櫃 A-01',
				to: '機櫃 A-02',
				bidirectional: true,
				props: { 確認狀態: '已確認' }
			}
		]);
	});
	it('邊檔排在節點檔前面也行', () => {
		expect(buildGraph(files().reverse()).edges).toHaveLength(1);
	});
	it('未知的系統、邊類型、idc 節點類型帶檔名', () => {
		expect(() => buildGraph([['nodes/火星.csv', '類型,名稱\nx,y']])).toThrow(
			'nodes/火星.csv：未知的系統「火星」'
		);
		expect(() => buildGraph([['edges/火星.csv', '起點,終點']])).toThrow(
			'edges/火星.csv：未知的邊類型「火星」'
		);
		expect(() => buildGraph([['idc/nodes/火星.csv', '名稱\nx']])).toThrow(
			'idc/nodes/火星.csv：未知的節點類型「火星」'
		);
	});
	it('類型不屬於該系統檔，帶檔名與列號', () => {
		expect(() => buildGraph([['nodes/空間.csv', '類型,名稱\n機櫃,a\nUPS,b']])).toThrow(
			'nodes/空間.csv 第 3 列：類型「UPS」不屬於空間'
		);
		expect(() => buildGraph([['nodes/通用.csv', '類型,名稱\n機櫃,a']])).toThrow(
			'nodes/通用.csv 第 2 列：類型「機櫃」不屬於通用'
		);
	});
	it('節點名稱重複帶檔名與列號', () => {
		expect(() => buildGraph(files([['nodes/電力.csv', '類型,名稱\nUPS,機櫃 A-01']]))).toThrow(
			'nodes/電力.csv 第 2 列：節點名稱重複「機櫃 A-01」'
		);
	});
	it('邊重複、起訖空白帶檔名與列號', () => {
		const dup = '起點,終點,雙向\n機櫃 A-01,機櫃 A-02,\n機櫃 A-01,機櫃 A-02,';
		expect(() => buildGraph(files([['edges/供電.csv', dup]]))).toThrow(
			'edges/供電.csv 第 3 列：邊重複「機櫃 A-01>機櫃 A-02」'
		);
		expect(() => buildGraph(files([['edges/供電.csv', '起點,終點,雙向\n機櫃 A-01']]))).toThrow(
			'edges/供電.csv 第 2 列：起點或終點空白'
		);
	});
	it('邊端點找不到帶檔名與列號', () => {
		expect(() => buildGraph(files([['edges/供電.csv', '起點,終點,雙向\n機櫃 A-01,鬼,']]))).toThrow(
			'edges/供電.csv 第 2 列：找不到節點「鬼」'
		);
	});
});
