/**
 * 交叉校验：`theme-palette.ts` 的色阶清单必须与 `src/styles/colors.css`
 * 里的真实 CSS 类名完全一致。
 *
 * 为什么单写一个测试文件：这是整个第二层主题唯一"错了也不报错"的地方。
 * 拼错一个色阶名（比如 `violet` 写成 `voilet`），代码照常编译、页面照常
 * 渲染，只是那一套配色点了没反应 —— 靠人眼回归极容易漏。用这个测试钉死。
 */

import fs from 'fs';
import path from 'path';

import { THEME_PALETTES, THEME_PALETTE_SHADES } from '../theme-palette';

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

describe('colors.css 与色阶清单一致性', () => {
  let css: string;

  beforeAll(() => {
    css = fs.readFileSync(COLORS_CSS, 'utf8');
  });

  it('colors.css 存在且非空', () => {
    expect(css.length).toBeGreaterThan(1000);
  });

  it('每套色阶在 CSS 里都有对应的 .theme-<name> 类', () => {
    const missing = THEME_PALETTES.filter(
      (palette) => !new RegExp(`^\\.${palette}\\s*\\{`, 'm').test(css)
    );
    expect(missing).toEqual([]);
  });

  it('CSS 里没有清单之外的色阶类（防止源文件加了新色而 TS 忘同步）', () => {
    const declared = Array.from(css.matchAll(/^\.([a-z]+)\s*\{/gm)).map(
      (m) => m[1]
    );
    const extra = declared.filter(
      (name) => !(THEME_PALETTES as readonly string[]).includes(name)
    );
    expect(extra).toEqual([]);
  });

  it('每套色阶都声明了完整的 11 个 --theme-preview-* 变量', () => {
    const blocks = Array.from(css.matchAll(/^\.([a-z]+)\s*\{([\s\S]*?)^\}/gm));
    expect(blocks.length).toBe(THEME_PALETTES.length);

    const problems: string[] = [];
    for (const [, name, body] of blocks) {
      for (const shade of THEME_PALETTE_SHADES) {
        if (!new RegExp(`--theme-preview-${shade}:\\s*[\\d\\s]+;`).test(body)) {
          problems.push(`${name} 缺 --theme-preview-${shade}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('每套色阶都声明了完整的 11 个 --tw-color-primary-* 变量', () => {
    const blocks = Array.from(css.matchAll(/^\.([a-z]+)\s*\{([\s\S]*?)^\}/gm));
    const problems: string[] = [];
    for (const [, name, body] of blocks) {
      for (const shade of THEME_PALETTE_SHADES) {
        if (
          !new RegExp(`--tw-color-primary-${shade}:\\s*[\\d\\s]+;`).test(body)
        ) {
          problems.push(`${name} 缺 --tw-color-primary-${shade}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('--theme-preview-* 与 --tw-color-primary-* 的值必须相同', () => {
    // 两者若不一致，设置面板的色卡会与实际生效的颜色对不上（"选了没变"）。
    const blocks = Array.from(css.matchAll(/^\.([a-z]+)\s*\{([\s\S]*?)^\}/gm));
    const problems: string[] = [];
    for (const [, name, body] of blocks) {
      for (const shade of THEME_PALETTE_SHADES) {
        const preview = body.match(
          new RegExp(`--theme-preview-${shade}:\\s*([\\d\\s]+);`)
        );
        const actual = body.match(
          new RegExp(`--tw-color-primary-${shade}:\\s*([\\d\\s]+);`)
        );
        if (preview && actual && preview[1].trim() !== actual[1].trim()) {
          problems.push(
            `${name}-${shade}: preview="${preview[1].trim()}" vs actual="${actual[1].trim()}"`
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
