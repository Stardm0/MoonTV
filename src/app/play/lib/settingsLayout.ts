/**
 * 设置面板的「分组布局」纯函数层（4.2.6）。
 *
 * ## 为什么要有分组
 *
 * 播放页的设置面板原先是 12 项平铺在根面板上：画质、去广告、跳过片头片尾、
 * 设置片头、设置片尾、删除跳过配置、弹幕源、视频缓存、缓存管理、快捷键、
 * 恢复默认键位、弹幕屏蔽。面板宽 200px、行高 35px 时它已经顶到播放器高度
 * 上限，滚动才能看全 —— 用户报障「设置里面太拥挤」。
 *
 * 解法不是继续加宽（播放器宽度有限，再宽会盖住画面），而是**按用途收进
 * 二级面板**：根面板只留 6 个入口，相关的开关/动作折叠进各自的子面板。
 *
 * ## 为什么能这么做
 *
 * ArtPlayer 的 `Setting.createItem()` 对**任意层级**的面板项都走同一套渲染：
 * 只要 item 带 `selector` 就会渲染出「→」并展开子面板，子面板里的项同样
 * 支持 `switch` / `onClick` / 再嵌套 `selector`。所以分组不需要改 ArtPlayer，
 * 只需要把 option 树搭成两层。
 *
 * 另外两条与实现强相关的官方行为（改结构时必须知道）：
 * - `Setting.find(name)` 是**全树遍历**，所以子面板里的项照样能用
 *   `setSettingTooltip()` 按 name 直接改，代码不用改。
 * - `Setting.resize()` 的宽度取自 `active[0].$parent.width`，缺省才回落到
 *   `Artplayer.SETTING_WIDTH`，因此分组项可以单独声明更宽的子面板。
 */

import { formatTime } from '@/lib/formatTime';

/** 跳过片头片尾的配置形态（与 `SkipConfig` 结构一致，这里只取用到的三个字段） */
export interface SkipConfigLike {
  enable: boolean;
  intro_time: number;
  outro_time: number;
}

/** 「跳过片头片尾」分组在根面板上的状态摘要 */
export function describeSkipConfig(config: SkipConfigLike): string {
  const parts: string[] = [];

  if (config.intro_time > 0) {
    parts.push(`片头 ${formatTime(config.intro_time)}`);
  }
  // outro_time 以负数表示「距片尾多少秒」，0 表示未设置
  if (config.outro_time < 0) {
    parts.push(`片尾 -${formatTime(-config.outro_time)}`);
  }

  if (!config.enable) {
    // 关着但时间还留着：先把"关"说出来，否则用户会以为摘要是脏数据
    return parts.length ? `已关闭 · ${parts.join(' · ')}` : '已关闭';
  }

  return parts.length ? parts.join(' · ') : '未设置';
}

/** 「视频缓存」分组里开关项的文案（关掉时把进度文案盖掉，避免看起来还在跑） */
export function describeCacheSwitch(enabled: boolean): string {
  return enabled ? '开启' : '关闭';
}
