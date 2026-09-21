/**
 * 端到端验证：把 colors.css 真实注入 jsdom，确认 readPaletteShades()
 * 能读到色值、applyThemePalette() 能写进 :root。
 *
 * 这是"换色完全无效"那个缺陷的复现/防复发测试 —— 之前的单测只校验
 * 文件内容，从未真正跑过"读 CSS 变量"这条运行时路径。
 */
import fs from 'fs';
import path from 'path';

import {
  applyThemePalette,
  getAllPalettePreviews,
  paletteClassName,
  readPaletteShades,
  THEME_PALETTE_SHADES,
  THEME_PALETTES,
} from '../theme-palette';

const CSS = fs.readFileSync(
  path.resolve(__dirname, '../../styles/colors.css'),
  'utf8'
);

/** 从 colors.css 原文里解析出某套色阶的期望值，作为独立真源 */
function expectedShades(palette: string): string[] {
  const m = CSS.match(
    new RegExp(`^\\.${palette}\\s*\\{\\r?\\n([\\s\\S]*?)^\\}\\r?\\n?`, 'm')
  );
  if (!m) throw new Error(`colors.css 找不到 .${palette}`);
  return THEME_PALETTE_SHADES.map((shade) => {
    const v = m[1].match(
      new RegExp(`--theme-preview-${shade}:\\s*([\\d\\s]+);`)
    );
    if (!v) throw new Error(`${palette} 缺 ${shade}`);
    return v[1].trim().replace(/\s+/g, ' ');
  });
}

describe('主题色运行时读取（真实 CSS 注入）', () => {
  beforeAll(() => {
    // 把 colors.css 原文作为 <style> 注入，让 getComputedStyle 能解析到
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
  });

  it('readPaletteShades() 能读到全部 11 档（非空、且与 CSS 原文一致）', () => {
    const problems: string[] = [];
    for (const palette of THEME_PALETTES) {
      const actual = readPaletteShades(palette);
      const expected = expectedShades(palette);
      if (actual.length !== 11) {
        problems.push(`${palette}: 读到 ${actual.length} 档`);
        continue;
      }
      for (let i = 0; i < 11; i++) {
        if (actual[i] !== expected[i]) {
          problems.push(
            `${palette}[${i}]: 读到 "${actual[i]}" 期望 "${expected[i]}"`
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('paletteClassName 查到的类名确实存在于注入的 CSS 中', () => {
    for (const palette of THEME_PALETTES) {
      const el = document.createElement('div');
      el.className = paletteClassName(palette);
      document.body.appendChild(el);
      const v = window
        .getComputedStyle(el)
        .getPropertyValue('--theme-preview-500')
        .trim();
      document.body.removeChild(el);
      expect(v).not.toBe('');
    }
  });

  it('applyThemePalette() 真的把色值写进了 :root', () => {
    applyThemePalette('rose');
    const root = document.documentElement;
    const written = THEME_PALETTE_SHADES.map((s) =>
      root.style.getPropertyValue(`--tw-color-primary-${s}`).trim()
    );
    const expected = expectedShades('rose');
    expect(written).toEqual(expected);
    expect(written.some((v) => !v)).toBe(false);
  });

  it('不同色阶写入的值不同（证明"换色真的生效"）', () => {
    applyThemePalette('rose');
    const rose = document.documentElement.style.getPropertyValue(
      '--tw-color-primary-500'
    );
    applyThemePalette('emerald');
    const emerald = document.documentElement.style.getPropertyValue(
      '--tw-color-primary-500'
    );
    expect(rose).not.toBe(emerald);
    expect(rose.length).toBeGreaterThan(0);
    expect(emerald.length).toBeGreaterThan(0);
  });

  it('getAllPalettePreviews() 22 套全部读到色值，无一为空', () => {
    const previews = getAllPalettePreviews();
    expect(Object.keys(previews).length).toBe(THEME_PALETTES.length);
    const empty = Object.entries(previews)
      .filter(([, shades]) => shades.some((s) => !s))
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it('色卡三档在 22 套之间互不相同（否则 UI 上看不出区别）', () => {
    const previews = getAllPalettePreviews();
    const fingerprints = THEME_PALETTES.map((p) =>
      [400, 500, 600]
        .map(
          (s) => previews[p][(THEME_PALETTE_SHADES as readonly number[]).indexOf(s)]
        )
        .join('|')
    );
    // 任何两套色阶的主色带指纹都不该一致，否则色卡看起来一样
    expect(new Set(fingerprints).size).toBe(THEME_PALETTES.length);
  });
});
