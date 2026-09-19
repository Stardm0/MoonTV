/**
 * 前向缓存"不设时间上限"语义的回归测试。
 *
 * 背景：预取默认值从 600s 改成"无限"后，`0` 成为哨兵值，
 * 任何把它当成"缓存 0 秒"的实现都会让功能静默失效（队列为空、
 * 暂停后不再往后铺），因此用测试把语义钉住。
 */

import { normalizeCacheSettings, UNLIMITED_HORIZON_SECONDS } from '../video-cache';
import { __testing__ } from '../video-prefetcher';

const { horizonEndTime } = __testing__;

describe('前向缓存时间上限', () => {
  it('默认不设上限', () => {
    expect(normalizeCacheSettings({}).horizonSeconds).toBe(
      UNLIMITED_HORIZON_SECONDS
    );
    expect(UNLIMITED_HORIZON_SECONDS).toBe(0);
  });

  it('显式传 0 保持"无限"，不会被抬成有限值', () => {
    expect(normalizeCacheSettings({ horizonSeconds: 0 }).horizonSeconds).toBe(0);
  });

  it('有限值低于 1 分钟时抬到 60s', () => {
    expect(normalizeCacheSettings({ horizonSeconds: 30 }).horizonSeconds).toBe(60);
    expect(normalizeCacheSettings({ horizonSeconds: 1800 }).horizonSeconds).toBe(1800);
  });

  it('无限模式的目标时间点是 +Infinity（队列铺到片尾）', () => {
    expect(horizonEndTime(120, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(horizonEndTime(0, UNLIMITED_HORIZON_SECONDS)).toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it('有限模式仍是"当前位置 + 视野"', () => {
    expect(horizonEndTime(120, 600)).toBe(720);
  });

  it('脏数据不会让上限失控', () => {
    expect(normalizeCacheSettings({ horizonSeconds: -5 }).horizonSeconds).toBe(0);
    expect(normalizeCacheSettings({ horizonSeconds: 99999 }).horizonSeconds).toBe(7200);
    expect(
      normalizeCacheSettings({ horizonSeconds: Number.NaN }).horizonSeconds
    ).toBe(0);
  });
});
