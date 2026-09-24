#!/usr/bin/env node
/**
 * 给 `src/styles/colors.css` 的每套色阶补上 `--theme-preview-<shade>` 变量。
 *
 * 为什么需要这一步：`theme-palette.ts` 在运行时**读 CSS 变量**拿色值
 * （而不是在 JS 里再抄一份 22 × 11 = 242 个常量），这样色值只有
 * `colors.css` 一个真源。为此 CSS 里必须有一组可被 `getPropertyValue()`
 * 读到的变量 —— 这就是 `--theme-preview-*` 存在的唯一理由。
 *
 * 幂等：会先剥掉旧的 `--theme-preview-*` 行再重写，反复跑结果一致。
 *
 * 只在**色板本身变更时**才需要跑，不必进 build（产物 colors.css 已入库）。
 *
 * 用法：node scripts/generate-theme-palette.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COLORS_CSS = path.join(ROOT, 'src/styles/colors.css');

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

function fail(msg) {
  console.error('[theme-palette] ' + msg);
  process.exit(1);
}

if (!fs.existsSync(COLORS_CSS)) {
  fail('找不到 ' + COLORS_CSS);
}

let raw = fs.readFileSync(COLORS_CSS, 'utf8').replace(/\r\n/g, '\n');

// 幂等：先剥掉旧的 --theme-preview-* 行，保证反复跑结果一致，
// 也避免"已补过"分支写出不自洽的内容。
raw = raw.replace(/^\s*--theme-preview-\d+:[^\n]*\n/gm, '');

/**
 * 匹配 `.name { ... }` 块，捕获类名与块体。
 *
 * ⚠️ 结尾的 `\n` 必须放在捕获组**之外**，且 replace 时要补回来。
 * 最初写成 `return \`.${name} {\n${preview}\n${body}}\`` 时漏了补换行，
 * 导致上一块的 `}` 与下一块类名粘连成 `}.lime {`，正则因此静默少匹配一块。
 */
const blockRe = /^\.([a-z]+)\s*\{\n([\s\S]*?)^\}\n/gm;
const palettes = {};

const css = raw.replace(blockRe, (whole, name, body) => {
  const lines = body.split('\n').filter((l) => l.trim().length > 0);
  const byShade = {};
  for (const line of lines) {
    const m = line.match(/^\s*--tw-color-primary-(\d+):\s*([\d\s]+);/);
    if (m) byShade[Number(m[1])] = m[2].trim().replace(/\s+/g, ' ');
  }
  if (Object.keys(byShade).length === 0) {
    fail(`色阶块 .${name} 里没有 --tw-color-primary-* 声明`);
  }
  palettes[name] = byShade;

  const preview = SHADES.filter((s) => byShade[s])
    .map((s) => `  --theme-preview-${s}: ${byShade[s]};`)
    .join('\n');

  return `.${name} {\n${preview}\n${body}}\n`;
});

const names = Object.keys(palettes);
if (names.length === 0) {
  fail('没从 colors.css 解析到任何色阶，正则可能失效了');
}

// 校验每套都是完整的 11 档，缺档说明源文件被改坏了
const incomplete = names.filter((n) =>
  SHADES.some((s) => !palettes[n][s])
);
if (incomplete.length > 0) {
  fail('色阶不完整（缺档）：' + incomplete.join(', '));
}

fs.writeFileSync(COLORS_CSS, css, 'utf8');

console.log(
  `[theme-palette] colors.css 已补 --theme-preview-*（${names.length} 套 × ${SHADES.length} 档 = ${names.length * SHADES.length} 个色值）`
);
