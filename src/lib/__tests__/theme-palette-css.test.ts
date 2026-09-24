/**
 * 交叉校验：`theme-palette.ts` 的色阶清单必须与 `src/styles/colors.css`
 * 里的真实 CSS 类名完全一致。
 *
 * 为什么单写一个测试文件：这是整个第二层主题唯一"错了也不报错"的地方。
 * 拼错一个色阶名（比如 `violet` 写成 `voilet`），代码照常编译、页面照常
 * 渲染，只是那一套配色点了没反应 —— 靠人眼回归极容易漏。用这个测试钉死。
 *
 * ⚠️ **血泪修正**：本文件曾经断言的是裸类名 `.${palette}`，而同一时间
 * `theme-palette.ts` 运行时查的是 `.theme-${palette}`，两者对不上 ——
 * 于是"换色完全无效"这个严重缺陷**测试是绿的**。根因是断言与运行时
 * 各写一遍类名，且本文件那一版的 `it` 描述写的是"`.theme-<name>` 类"
 * 而正则用的是裸名，描述与实现不符也没人发现。
 * 现在一律通过 `paletteClassName()` 取类名，与运行时间源。
 */

import fs from 'fs';
import path from 'path';

import {
  paletteClassName,
  THEME_PALETTE_GROUPS,
  THEME_PALETTE_SHADES,
  THEME_PALETTES,
} from '../theme-palette';

const COLORS_CSS = path.resolve(__dirname, '../../styles/colors.css');

/**
 * 把 CSS 拆成 `.name { ... }` 块。
 *
 * 用 `\n\}\n?` 而不是 `\n\}\n` —— 文件最后一块可能没有末尾换行，
 * 少了这个 `?` 就会静默少匹配一块（实测丢的是最后一套 `.rose`）。
 */
function parseBlocks(css: string): Array<[string, string]> {
  return Array.from(
    css.matchAll(/^\.([a-z]+)\s*\{\r?\n([\s\S]*?)^\}\r?\n?/gm)
  ).map((m) => [m[1], m[2]] as [string, string]);
}

/** 取出某个类名对应的 CSS 块体 */
function blockBody(css: string, className: string): string | undefined {
  return parseBlocks(css).find(([name]) => name === className)?.[1];
}

describe('colors.css 与色阶清单一致性', () => {
  let css: string;

  beforeAll(() => {
    css = fs.readFileSync(COLORS_CSS, 'utf8');
  });

  it('colors.css 存在且非空', () => {
    expect(css.length).toBeGreaterThan(1000);
  });

  // 🔒 回归守卫：这条测试的存在意义是「运行时的类名必须能在 CSS 里找到原子」。
  //    它当初缺失，导致 theme-palette.ts 查 .theme-slate 而 CSS 只有 .slate
  //    的严重缺陷全程绿灯。**不要改成断言别的东西。**
  it('运行时用的类名（paletteClassName）在 CSS 里都能找到', () => {
    const missing = THEME_PALETTES.filter(
      (palette) =>
        blockBody(css, paletteClassName(palette)) === undefined
    );
    expect(missing).toEqual([]);
  });

  it('CSS 里没有清单之外的色阶类（防止源文件加了新色而 TS 忘同步）', () => {
    const declared = parseBlocks(css).map(([name]) => name);
    const extra = declared.filter(
      (name) => !(THEME_PALETTES as readonly string[]).includes(name)
    );
    expect(extra).toEqual([]);
  });

  it('每套色阶都声明了完整的 11 个 --theme-preview-* 变量', () => {
    const blocks = parseBlocks(css);
    expect(blocks.length).toBe(THEME_PALETTES.length);

    const problems: string[] = [];
    for (const palette of THEME_PALETTES) {
      const body = blockBody(css, paletteClassName(palette));
      if (!body) {
        problems.push(`${palette}: 找不到 CSS 块`);
        continue;
      }
      for (const shade of THEME_PALETTE_SHADES) {
        if (!new RegExp(`--theme-preview-${shade}:\\s*[\\d\\s]+;`).test(body)) {
          problems.push(`${palette} 缺 --theme-preview-${shade}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('每套色阶都声明了完整的 11 个 --tw-color-primary-* 变量', () => {
    const problems: string[] = [];
    for (const palette of THEME_PALETTES) {
      const body = blockBody(css, paletteClassName(palette));
      if (!body) continue;
      for (const shade of THEME_PALETTE_SHADES) {
        if (
          !new RegExp(`--tw-color-primary-${shade}:\\s*[\\d\\s]+;`).test(body)
        ) {
          problems.push(`${palette} 缺 --tw-color-primary-${shade}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('--theme-preview-* 与 --tw-color-primary-* 的值必须相同', () => {
    // 两者若不一致，设置面板的色卡会与实际生效的颜色对不上（"选了没变"）。
    const problems: string[] = [];
    for (const palette of THEME_PALETTES) {
      const body = blockBody(css, paletteClassName(palette));
      if (!body) continue;
      for (const shade of THEME_PALETTE_SHADES) {
        const preview = body.match(
          new RegExp(`--theme-preview-${shade}:\\s*([\\d\\s]+);`)
        );
        const actual = body.match(
          new RegExp(`--tw-color-primary-${shade}:\\s*([\\d\\s]+);`)
        );
        if (preview && actual && preview[1].trim() !== actual[1].trim()) {
          problems.push(
            `${palette}-${shade}: preview="${preview[1].trim()}" vs actual="${actual[1].trim()}"`
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('每个色阶的预览值都是合法的 "R G B" 三元组', () => {
    // rgbTripletToCss() 用正则 /^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/ 校验，
    // 值格式不对会被静默判为非法 → 返回 fallback → 色卡变透明/变灰。
    const problems: string[] = [];
    for (const palette of THEME_PALETTES) {
      const body = blockBody(css, paletteClassName(palette));
      if (!body) continue;
      for (const shade of THEME_PALETTE_SHADES) {
        const m = body.match(
          new RegExp(`--theme-preview-${shade}:\\s*([^;]+);`)
        );
        const value = m?.[1].trim() ?? '';
        if (!/^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/.test(value)) {
          problems.push(`${palette}-${shade}: "${value}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('设置面板分组完整性', () => {
  it('分组覆盖全部色阶，且无重复', () => {
    const grouped = THEME_PALETTE_GROUPS.flatMap((g) => [...g.palettes]);
    expect([...grouped].sort()).toEqual([...THEME_PALETTES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('分组非空且每组都有 label', () => {
    for (const group of THEME_PALETTE_GROUPS) {
      expect(group.palettes.length).toBeGreaterThan(0);
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.id.length).toBeGreaterThan(0);
    }
  });
});

describe('paletteClassName', () => {
  it('不返回空值，且每套色阶的类名互不相同', () => {
    const names = THEME_PALETTES.map((p) => paletteClassName(p));
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('类名是合法 CSS 标识符（只含小写字母）', () => {
    for (const palette of THEME_PALETTES) {
      expect(paletteClassName(palette)).toMatch(/^[a-z]+$/);
    }
  });
});
