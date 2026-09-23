/**
 * 首页侧边栏（SideNav）底座测试。
 *
 * 两件容易出事的地方各锁一层：
 * 1. 首屏内联脚本必须挂 `documentElement`（`<head>` 阶段 body 还是 null，
 *    挂 body 会抛错被吞 → 折叠态刷新必跳；这是本项目在主题脚本上踩过的同款坑）。
 * 2. 宽度常量与脚本里的字面量必须一致，否则改宽度时漏改脚本会让首屏宽度闪一下。
 */

import {
  applySidenavCollapsed,
  normalizeSidenavCollapsed,
  SIDENAV_COLLAPSED_ATTR,
  SIDENAV_COLLAPSED_KEY,
  SIDENAV_INLINE_SCRIPT,
  SIDENAV_WIDTH_COLLAPSED,
  SIDENAV_WIDTH_EXPANDED,
  SIDENAV_WIDTH_VAR,
  sidenavWidth,
} from '../sidenav';

describe('normalizeSidenavCollapsed', () => {
  it('只认显式真值写法', () => {
    for (const truthy of ['true', 'TRUE', ' true ', '1', 'yes', 'on']) {
      expect(normalizeSidenavCollapsed(truthy)).toBe(true);
    }
  });

  it('其余一律落回展开（折叠是少数状态，猜错时保持展开更安全）', () => {
    for (const falsy of ['false', '', '  ', '0', 'no', 'off', 'collapsed', null, undefined]) {
      expect(normalizeSidenavCollapsed(falsy)).toBe(false);
    }
  });
});

describe('sidenavWidth', () => {
  it('折叠比展开窄，且都为正数', () => {
    expect(sidenavWidth(false)).toBe(SIDENAV_WIDTH_EXPANDED);
    expect(sidenavWidth(true)).toBe(SIDENAV_WIDTH_COLLAPSED);
    expect(SIDENAV_WIDTH_COLLAPSED).toBeGreaterThan(0);
    expect(SIDENAV_WIDTH_COLLAPSED).toBeLessThan(SIDENAV_WIDTH_EXPANDED);
  });
});

describe('applySidenavCollapsed', () => {
  it('折叠态同时写属性与 CSS 变量', () => {
    const root = document.createElement('div');

    applySidenavCollapsed(true, root);

    expect(root.getAttribute(SIDENAV_COLLAPSED_ATTR)).toBe('true');
    expect(root.style.getPropertyValue(SIDENAV_WIDTH_VAR)).toBe(
      `${SIDENAV_WIDTH_COLLAPSED}px`
    );
  });

  it('展开态写回 false 与展开宽度（可反复切换不回退）', () => {
    const root = document.createElement('div');

    applySidenavCollapsed(true, root);
    applySidenavCollapsed(false, root);

    expect(root.getAttribute(SIDENAV_COLLAPSED_ATTR)).toBe('false');
    expect(root.style.getPropertyValue(SIDENAV_WIDTH_VAR)).toBe(
      `${SIDENAV_WIDTH_EXPANDED}px`
    );
  });
});

describe('SIDENAV_INLINE_SCRIPT', () => {
  it('不引用 document.body（head 阶段它是 null）', () => {
    expect(SIDENAV_INLINE_SCRIPT).not.toContain('document.body');
    expect(SIDENAV_INLINE_SCRIPT).not.toMatch(/\bbody\b\s*\.\s*append/);
  });

  it('通过 document.documentElement 落状态', () => {
    expect(SIDENAV_INLINE_SCRIPT).toContain('document.documentElement');
  });

  it('把存储键、属性名与变量名编进脚本，不依赖运行时模块', () => {
    expect(SIDENAV_INLINE_SCRIPT).toContain(SIDENAV_COLLAPSED_KEY);
    expect(SIDENAV_INLINE_SCRIPT).toContain(SIDENAV_COLLAPSED_ATTR);
    expect(SIDENAV_INLINE_SCRIPT).toContain(SIDENAV_WIDTH_VAR);
  });

  it('两个宽度字面量都内联在脚本里', () => {
    expect(SIDENAV_INLINE_SCRIPT).toContain(String(SIDENAV_WIDTH_COLLAPSED));
    expect(SIDENAV_INLINE_SCRIPT).toContain(String(SIDENAV_WIDTH_EXPANDED));
  });

  it('脚本执行后：存 true 则折叠，未存则展开', () => {
    const run = (stored: string | null) => {
      const root = document.createElement('div');
      // 脚本内部用 document.documentElement，这里临时替换以便观察
      const original = Object.getOwnPropertyDescriptor(
        Document.prototype,
        'documentElement'
      );
      Object.defineProperty(document, 'documentElement', {
        configurable: true,
        get: () => root,
      });
      try {
        if (stored === null) {
          window.localStorage.removeItem(SIDENAV_COLLAPSED_KEY);
        } else {
          window.localStorage.setItem(SIDENAV_COLLAPSED_KEY, stored);
        }
        // eslint-disable-next-line no-new-func
        new Function(SIDENAV_INLINE_SCRIPT)();
      } finally {
        if (original) {
          Object.defineProperty(Document.prototype, 'documentElement', original);
        }
        window.localStorage.removeItem(SIDENAV_COLLAPSED_KEY);
      }
      return {
        attr: root.getAttribute(SIDENAV_COLLAPSED_ATTR),
        width: root.style.getPropertyValue(SIDENAV_WIDTH_VAR),
      };
    };

    expect(run('true')).toEqual({
      attr: 'true',
      width: `${SIDENAV_WIDTH_COLLAPSED}px`,
    });
    expect(run(null)).toEqual({
      attr: 'false',
      width: `${SIDENAV_WIDTH_EXPANDED}px`,
    });
  });
});
