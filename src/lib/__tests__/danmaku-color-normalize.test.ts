/**
 * 非法 color 值在 DOM 中的实际行为验证。
 *
 * 背景：artplayer-plugin-danmuku 解析 B 站 XML 弹幕时用
 *   color: `#${Number(t[3]).toString(16)}`
 * 缺少补零，导致高 8 位为 0 的颜色产出不足 6 位的十六进制。
 *
 * 本测试固化「缺陷会造成什么后果」这一事实，防止后续改回。
 *
 * 跑法：npx jest src/lib/__tests__/danmaku-color-normalize.test.ts
 */

export {};

describe('非法 color 值在 DOM 中的破坏方式', () => {
  it('合法 6 位十六进制正常生效', () => {
    const el = document.createElement('div');
    el.style.color = '#0000ff';
    expect(el.style.color).toBe('rgb(0, 0, 255)');
  });

  it('#ff（纯蓝被截断）→ 空值，弹幕失去自身颜色', () => {
    const el = document.createElement('div');
    el.style.color = '#ff';
    expect(el.style.color).toBe('');
  });

  it('#8b（暗紫被截断）→ 空值', () => {
    const el = document.createElement('div');
    el.style.color = '#8b';
    expect(el.style.color).toBe('');
  });

  it('#ff00（纯绿被截断）→ 完全透明，弹幕隐形', () => {
    const el = document.createElement('div');
    el.style.color = '#ff00';
    // 关键：被解析成 4 位简写 + alpha=0
    expect(el.style.color).toBe('rgba(255, 255, 0, 0)');
  });

  it('#ffff（青色被截断）→ 静默变成白色，不报错', () => {
    const el = document.createElement('div');
    el.style.color = '#ffff';
    // 合法的 4 位简写，#ffff 等价于 #ffffff（jsdom 输出带 alpha）
    expect(el.style.color).toBe('rgba(255, 255, 255, 1)');
  });

  it('补零后全部产出正确颜色', () => {
    const cases: Array<[string, string]> = [
      ['#0000ff', 'rgb(0, 0, 255)'],
      ['#00ff00', 'rgb(0, 255, 0)'],
      ['#00ffff', 'rgb(0, 255, 255)'],
      ['#00008b', 'rgb(0, 0, 139)'],
      ['#ffffff', 'rgb(255, 255, 255)'],
    ];
    for (const [input, expected] of cases) {
      const el = document.createElement('div');
      el.style.color = input;
      expect(el.style.color).toBe(expected);
    }
  });
});
