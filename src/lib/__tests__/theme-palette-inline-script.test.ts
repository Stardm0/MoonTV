/**
 * `<head>` 内联主题脚本的回归测试。
 *
 * 背景（真实缺陷）：脚本挂在 `<head>` 里执行，那一刻 `document.body` 还是
 * `null`。原实现 `document.body.appendChild(el)` 直接抛 TypeError，被
 * `catch` 吞掉 → 整套逻辑静默失效 → **刷新页面主色必回默认天蓝**。
 *
 * 这个缺陷此前没有任何测试能发现：既有的 `theme-palette-dom.test.ts` 都在
 * jsdom 默认环境（`document.body` 已存在）里测的 `applyThemePalette()`，
 * 而 `THEME_PALETTE_INLINE_SCRIPT` 从来没被测过 —— 因为它只是字符串。
 *
 * 所以这里做两件事：
 * 1. 把脚本源码里对 `document.body` 的引用钉死（静态断言，最直接）。
 * 2. 在 `document.body === null` 的 jsdom 环境里**真跑一遍**，断言主色被写进
 *    `documentElement.style` —— 用行为而不是字符串来防回归。
 */

import {
  buildThemePaletteInlineScript,
  THEME_PALETTE_INLINE_SCRIPT,
  THEME_PALETTE_SHADES,
  THEME_PALETTE_STORAGE_KEY,
} from '../theme-palette';

/** 11 档假色值，够脚本写出变量即可。 */
const FAKE_SHADES = THEME_PALETTE_SHADES.map(
  (shade, index) => `${index + 1} ${index + 2} ${index + 3}`
);

/**
 * 在「`<head>` 阶段」跑一遍脚本：`document.body` 为 `null`。
 *
 * 模拟手法是把 `body` 移出文档树（`document.documentElement.removeChild`），
 * 这样 `document.body` 属性真的变成 `null` —— 比 `Object.defineProperty`
 * 打桩更接近浏览器真实状态。
 *
 * `--theme-preview-*` 由 `getComputedStyle` 读取，jsdom 不解 CSS 文件，
 * 所以这里把 `getComputedStyle` 换成返回假色值的实现；被测的关键行为是
 * **脚本往哪里挂探测元素、最终写没写 `:root` 变量**，不是取值本身。
 */
function runScriptInHeadPhase(script: string, palette: string): () => void {
  const html = document.documentElement;
  const body = document.body;

  html.removeChild(body);
  // jsdom 在 body 移除后仍可能保留 body 引用，显式打桩确保为 null。
  Object.defineProperty(document, 'body', {
    configurable: true,
    get: () => null,
  });

  window.localStorage.setItem(THEME_PALETTE_STORAGE_KEY, palette);

  const originalGetComputedStyle = window.getComputedStyle;
  window.getComputedStyle = ((el: Element) => {
    const styles = originalGetComputedStyle.call(window, el);
    return {
      ...styles,
      getPropertyValue: (name: string) => {
        const match = /^--theme-preview-(\d+)$/.exec(name);
        if (!match) return '';
        const index = (THEME_PALETTE_SHADES as readonly number[]).indexOf(
          Number(match[1])
        );
        return index >= 0 ? FAKE_SHADES[index] : '';
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }) as typeof window.getComputedStyle;

  // eslint-disable-next-line no-new-func
  new Function(script)();

  return () => {
    window.getComputedStyle = originalGetComputedStyle;
    Object.defineProperty(document, 'body', {
      configurable: true,
      writable: true,
      value: body,
    });
    html.appendChild(body);
  };
}

describe('THEME_PALETTE_INLINE_SCRIPT 源码约束', () => {
  it('不引用 document.body（head 阶段它是 null）', () => {
    expect(THEME_PALETTE_INLINE_SCRIPT).not.toContain('document.body');
    expect(THEME_PALETTE_INLINE_SCRIPT).not.toMatch(/\bbody\b\s*\.\s*append/);
  });

  it('通过 document.documentElement 挂探测元素', () => {
    expect(THEME_PALETTE_INLINE_SCRIPT).toContain('document.documentElement');
  });

  it('导出常量与构造函数产物一致', () => {
    expect(THEME_PALETTE_INLINE_SCRIPT).toBe(buildThemePaletteInlineScript());
  });

  it('把色阶清单与存储键编进脚本，不依赖运行时模块', () => {
    expect(THEME_PALETTE_INLINE_SCRIPT).toContain(THEME_PALETTE_STORAGE_KEY);
    expect(THEME_PALETTE_INLINE_SCRIPT).toContain('"sky"');
  });
});

describe('THEME_PALETTE_INLINE_SCRIPT 在 head 阶段的行为', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
    document.documentElement.removeAttribute('style');
    window.localStorage.clear();
  });

  it('body 为 null 时仍能把主色写进 :root（刷新不再回默认色）', () => {
    expect(document.body).not.toBeNull();

    restore = runScriptInHeadPhase(THEME_PALETTE_INLINE_SCRIPT, 'rose');

    const root = document.documentElement;
    expect(root.style.getPropertyValue('--tw-color-primary-500')).toBe('6 7 8');
    expect(root.style.getPropertyValue('--tw-color-primary-50')).toBe('1 2 3');
  });

  it('背景渐变三段色一并跟随主色', () => {
    restore = runScriptInHeadPhase(THEME_PALETTE_INLINE_SCRIPT, 'rose');

    const root = document.documentElement;
    // SURFACE_SHADE_MAP: from=100(index1) via=50(index0) to=200(index2)
    expect(root.style.getPropertyValue('--theme-surface-from')).toBe('2 3 4');
    expect(root.style.getPropertyValue('--theme-surface-via')).toBe('1 2 3');
    expect(root.style.getPropertyValue('--theme-surface-to')).toBe('3 4 5');
  });

  it('未设置 / 非法存储值时不写任何变量（保持默认天蓝）', () => {
    restore = runScriptInHeadPhase(THEME_PALETTE_INLINE_SCRIPT, 'not-a-palette');

    expect(
      document.documentElement.style.getPropertyValue('--tw-color-primary-500')
    ).toBe('');
  });

  it('全程不在文档里留下探测元素', () => {
    restore = runScriptInHeadPhase(THEME_PALETTE_INLINE_SCRIPT, 'rose');

    // 探测 div 必须被移除：既不能留在 <html> 下，也不能是孤立的残留节点。
    const strays = Array.from(document.documentElement.children).filter(
      (el) => el.tagName === 'DIV'
    );
    expect(strays).toHaveLength(0);
  });
});
