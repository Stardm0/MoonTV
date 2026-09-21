/**
 * ArtPlayer selector `onSelect` **返回语义**回归测试。
 *
 * ## 背景（真实缺陷，用户实际报障）
 *
 * `artplayer@5.3.0` 里 `onSelect` 的返回值**会被写回 DOM**，且写入位置不同：
 *
 * ```js
 * // ① 控制栏（controls.add({ selector })）—— dist 里约 64045 处
 * this.check(a), e.onSelect && (o.innerHTML = await e.onSelect.call(this.art, a, a.$control_item, t))
 * //    o = .art-selector-value，初始化时 append(o, e.html)
 * //    ⇒ 返回值覆盖【按钮图标】。返回 '' 图标点一次就没了。
 *
 * // ② 设置面板（setting.add({ selector })）—— dist 里约 146775 处
 * e.selector?.length
 *   ? this.render(e.selector)
 *   : (this.check(e), e.$parent.onSelect && (e.$parent.tooltip = await e.$parent.onSelect.call(...)))
 * //    ⇒ 返回值覆盖【父项 tooltip】。返回 '' 会把状态摘要清空。
 * ```
 *
 * 而同为设置项的 `onClick` 走的是另一条路：
 * `case "button": e.tooltip = await e.onClick.call(...)` —— 覆盖的是**它自己**
 * 的 tooltip（这些按钮本来就没有 tooltip，写空串无害；但**省略 return 会写入
 * `undefined`，被 append 进节点后渲染出字面量 "undefined"**，所以那里必须显式
 * `return ''`）。
 *
 * ## 结论（本文件锁死的不变量）
 *
 * - **`onSelect` 一律不得返回空串** —— 控制栏会丢图标，设置面板会丢 tooltip。
 * - `onClick` / `onSwitch` 允许返回空串，且那是刻意的。
 *
 * 这条约束没法靠运行时测试捕获（要起真 ArtPlayer 并模拟点击），所以这里读源码
 * 做静态断言：下次有人把 `onSelect` 改回 `return ''` 时立刻报警。
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'usePlayEngine.ts'), 'utf8');

type CallbackKind = 'onSelect' | 'onClick' | 'onSwitch';

interface Callback {
  kind: CallbackKind;
  body: string;
  /** 回调在源码中的起始下标 */
  index: number;
  /** 1-based 行号，断言失败时直接指到源码位置 */
  line: number;
}

/**
 * 按「回调起点 → 下一个回调起点」切出每个回调的文本。
 *
 * 故意不做花括号配对：这些回调里含对象字面量、模板字符串（`${...}` 里的花括号
 * 成对出现），自己写配对容易在边界上出错。而「下一个回调标记」这个界天然正确
 * ——每个回调体只可能落在自己到下一个标记之间。
 */
function extractCallbacks(source: string): Callback[] {
  const marker = /\b(onSelect|onClick|onSwitch):\s*function/g;
  const hits: { kind: CallbackKind; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = marker.exec(source)) !== null) {
    hits.push({ kind: m[1] as CallbackKind, index: m.index });
  }
  return hits.map((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : source.length;
    return {
      kind: h.kind,
      body: source.slice(h.index, end),
      index: h.index,
      line: source.slice(0, h.index).split('\n').length,
    };
  });
}

/** 找出「所在控件项」的名字，便于报错定位。 */
function ownerLabel(source: string, callbackIndex: number): string {
  const before = source.slice(Math.max(0, callbackIndex - 1200), callbackIndex);

  // 取最后一次匹配。用 exec 循环而非 `[...matchAll()]` —— 后者要求
  // downlevelIteration / target >= es2015，本项目 tsconfig 没开。
  const lastMatch = (pattern: RegExp): string | null => {
    const rx = new RegExp(pattern.source, 'g');
    let m: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((m = rx.exec(before)) !== null) last = m;
    return last ? last[1] : null;
  };

  const name = lastMatch(/name:\s*([^,\n]+),/);
  if (name) return name.trim();
  const html = lastMatch(/html:\s*'([^']+)'/);
  if (html) return `html='${html}'`;
  return '(未知控件)';
}

const CALLBACKS = extractCallbacks(SOURCE);

describe('onSelect 返回值不变量', () => {
  it('源码里确实有 onSelect 回调（防止提取器失效导致空跑）', () => {
    const selects = CALLBACKS.filter((c) => c.kind === 'onSelect');
    expect(selects.length).toBeGreaterThanOrEqual(4);
  });

  it('没有任何 onSelect 返回空串（返回空串会清空图标 / tooltip）', () => {
    // 报错信息带行号 + 归属控件名，直接能定位
    const offenders = CALLBACKS.filter(
      (c) => c.kind === 'onSelect' && /return\s+(''|""|``)\s*;/.test(c.body)
    ).map((c) => `L${c.line} (${ownerLabel(SOURCE, c.index)})`);

    expect(offenders).toEqual([]);
  });

  it('每个 onSelect 都有显式 return（不靠隐式 undefined）', () => {
    const selects = CALLBACKS.filter((c) => c.kind === 'onSelect');
    for (const c of selects) {
      expect(c.body).toMatch(/return\s+\S/);
    }
  });
});

describe('外部播放器控制栏按钮 —— 图标不可被点击清空', () => {
  const start = SOURCE.indexOf("name: 'external-player'");
  const block = SOURCE.slice(start, start + 1400);

  it('图标抽成了常量，html 用的是它', () => {
    expect(block).toMatch(/html:\s*EXTERNAL_PLAYER_CONTROL_ICON/);
  });

  it('onSelect 返回**同一个**图标常量（而不是空串或别的东西）', () => {
    expect(block).toMatch(/return\s+EXTERNAL_PLAYER_CONTROL_ICON;/);
    // 断言 html 与 onSelect 引用的常量一致 —— 这是"点一次图标不消失"的关键
    const htmlRef = block.match(/html:\s*(\w+)/)?.[1];
    const returnRef = block.match(/return\s+(\w+);/)?.[1];
    expect(htmlRef).toBe('EXTERNAL_PLAYER_CONTROL_ICON');
    expect(returnRef).toBe(htmlRef);
  });

  it('图标常量是一段真实 SVG', () => {
    const m = SOURCE.match(
      /const EXTERNAL_PLAYER_CONTROL_ICON =\s*\n?\s*'([^']+)'/
    );
    expect(m).not.toBeNull();
    const icon = m ? m[1] : '';
    expect(icon).toContain('<svg');
    expect(icon).toContain('</svg>');
  });
});

describe('设置面板 onClick 按钮 —— 空串是刻意的', () => {
  it('onClick 里的 return \'\' 被保留（省略会写入 undefined 并渲染成字面量）', () => {
    const buttons = CALLBACKS.filter((c) => c.kind === 'onClick');
    expect(buttons.length).toBeGreaterThan(0);
    // 至少要有一个显式空串，说明这个约定没被整体删掉
    const withEmpty = buttons.filter((c) => /return\s+''\s*;/.test(c.body));
    expect(withEmpty.length).toBeGreaterThan(0);
    // 且这些空串都带说明注释，避免后人误当成 bug 修掉
    for (const c of withEmpty) {
      expect(c.body).toMatch(/空串|undefined/);
    }
  });
});
