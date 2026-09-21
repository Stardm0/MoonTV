import {
  clearBindings,
  eventToKeyString,
  findConflicts,
  formatKeyString,
  loadBindings,
  matchesKeyString,
  parseKeyString,
  resolveBindings,
  SHORTCUT_ACTIONS,
  SHORTCUT_STORAGE_KEY,
  ShortcutActionId,
  saveBindings,
} from '../shortcuts';

/** 造一个最小可用的 KeyboardEvent 形状 */
function keyEvent(
  key: string,
  mods: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  }> = {}
) {
  return {
    key,
    altKey: mods.altKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    metaKey: mods.metaKey ?? false,
  };
}

describe('eventToKeyString 序列化', () => {
  it('普通键小写化', () => {
    expect(eventToKeyString(keyEvent('F'))).toBe('f');
    expect(eventToKeyString(keyEvent('a'))).toBe('a');
  });

  it('空格统一为 space', () => {
    expect(eventToKeyString(keyEvent(' '))).toBe('space');
  });

  it('方向键保留原名', () => {
    expect(eventToKeyString(keyEvent('ArrowLeft'))).toBe('arrowleft');
    expect(eventToKeyString(keyEvent('ArrowUp'))).toBe('arrowup');
  });

  it('修饰键顺序固定为 alt→ctrl→shift→meta', () => {
    // 无论传入顺序如何，输出顺序一致
    expect(
      eventToKeyString(keyEvent('a', { metaKey: true, shiftKey: true, altKey: true }))
    ).toBe('alt+shift+meta+a');

    expect(
      eventToKeyString(keyEvent('a', { ctrlKey: true, altKey: true }))
    ).toBe('alt+ctrl+a');
  });

  it('单独按修饰键返回空串（不构成有效绑定）', () => {
    expect(eventToKeyString(keyEvent('Alt', { altKey: true }))).toBe('');
    expect(eventToKeyString(keyEvent('Shift', { shiftKey: true }))).toBe('');
    expect(eventToKeyString(keyEvent('Control', { ctrlKey: true }))).toBe('');
    expect(eventToKeyString(keyEvent('Meta', { metaKey: true }))).toBe('');
  });

  it('空 key 返回空串', () => {
    expect(eventToKeyString(keyEvent(''))).toBe('');
  });
});

describe('parseKeyString 拆解', () => {
  it('无修饰键', () => {
    expect(parseKeyString('f')).toEqual({
      alt: false,
      ctrl: false,
      shift: false,
      meta: false,
      key: 'f',
    });
  });

  it('带修饰键', () => {
    expect(parseKeyString('alt+arrowleft')).toEqual({
      alt: true,
      ctrl: false,
      shift: false,
      meta: false,
      key: 'arrowleft',
    });
  });

  it('空串返回 null', () => {
    expect(parseKeyString('')).toBeNull();
  });
});

describe('matchesKeyString 精确匹配（关键行为）', () => {
  it('无修饰键时精确匹配', () => {
    expect(matchesKeyString(keyEvent('f'), 'f')).toBe(true);
    expect(matchesKeyString(keyEvent('F'), 'f')).toBe(true);
  });

  it('绑 f 时按 shift+f 不应触发', () => {
    expect(matchesKeyString(keyEvent('f', { shiftKey: true }), 'f')).toBe(false);
  });

  it('绑 f 时按 alt+f 不应触发', () => {
    expect(matchesKeyString(keyEvent('f', { altKey: true }), 'f')).toBe(false);
  });

  it('绑 alt+arrowleft 时只在按住 alt 时触发', () => {
    expect(matchesKeyString(keyEvent('ArrowLeft', { altKey: true }), 'alt+arrowleft')).toBe(true);
    expect(matchesKeyString(keyEvent('ArrowLeft'), 'alt+arrowleft')).toBe(false);
  });

  it('修饰键多余时也不匹配', () => {
    expect(
      matchesKeyString(keyEvent('ArrowLeft', { altKey: true, shiftKey: true }), 'alt+arrowleft')
    ).toBe(false);
  });

  it('主键不同不匹配', () => {
    expect(matchesKeyString(keyEvent('ArrowRight'), 'arrowleft')).toBe(false);
  });

  it('空绑定串不匹配任何键', () => {
    expect(matchesKeyString(keyEvent('f'), '')).toBe(false);
  });
});

describe('resolveBindings 合并覆盖', () => {
  it('无覆盖时全为默认值', () => {
    const bindings = resolveBindings();
    expect(bindings.togglePlay).toBe('space');
    expect(bindings.prevEpisode).toBe('alt+arrowleft');
  });

  it('覆盖生效', () => {
    const bindings = resolveBindings({ togglePlay: 'p' });
    expect(bindings.togglePlay).toBe('p');
    // 其它保持默认
    expect(bindings.toggleFullscreen).toBe('f');
  });

  it('空串覆盖被视为无效，回退默认', () => {
    const bindings = resolveBindings({ togglePlay: '' });
    expect(bindings.togglePlay).toBe('space');
  });

  it('注册表内每个动作都有绑定', () => {
    const bindings = resolveBindings();
    for (const action of SHORTCUT_ACTIONS) {
      expect(bindings[action.id]).toBeTruthy();
    }
  });

  it('默认键位互不冲突', () => {
    const bindings = resolveBindings();
    const used = new Set<string>();
    for (const id of Object.keys(bindings) as ShortcutActionId[]) {
      const key = bindings[id];
      expect(used.has(key)).toBe(false);
      used.add(key);
    }
  });
});

describe('findConflicts 冲突检测', () => {
  it('无冲突返回空数组', () => {
    const bindings = resolveBindings();
    expect(findConflicts(bindings, 'q')).toEqual([]);
  });

  it('能发现已占用的按键', () => {
    const bindings = resolveBindings();
    expect(findConflicts(bindings, 'space')).toEqual(['togglePlay']);
  });

  it('排除自身后不报自己', () => {
    const bindings = resolveBindings();
    expect(findConflicts(bindings, 'space', 'togglePlay')).toEqual([]);
  });

  it('能同时发现多个冲突', () => {
    const bindings = resolveBindings({ toggleMute: 'space' } as any);
    const conflicts = findConflicts(bindings, 'space');
    expect(conflicts).toContain('togglePlay');
    expect(conflicts).toContain('toggleMute');
  });

  it('空按键串无冲突', () => {
    expect(findConflicts(resolveBindings(), '')).toEqual([]);
  });
});

describe('formatKeyString 展示', () => {
  it('字母键大写展示', () => {
    expect(formatKeyString('f')).toBe('F');
  });

  it('空格显示为中文', () => {
    expect(formatKeyString('space')).toBe('空格');
  });

  it('方向键显示为箭头', () => {
    expect(formatKeyString('arrowleft')).toBe('←');
  });

  it('组合键拼接', () => {
    expect(formatKeyString('alt+arrowleft')).toBe('Alt + ←');
    expect(formatKeyString('shift+arrowright')).toBe('Shift + →');
  });

  it('空串显示未设置', () => {
    expect(formatKeyString('')).toBe('未设置');
  });
});

describe('持久化与脏数据清洗', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('保存后能读回', () => {
    saveBindings({ togglePlay: 'p' });
    expect(loadBindings()).toEqual({ togglePlay: 'p' });
  });

  it('空表不写入存储', () => {
    saveBindings({});
    expect(window.localStorage.getItem(SHORTCUT_STORAGE_KEY)).toBeNull();
  });

  it('清洗未知动作 id', () => {
    window.localStorage.setItem(
      SHORTCUT_STORAGE_KEY,
      JSON.stringify({ togglePlay: 'p', 不存在的动作: 'x' })
    );
    expect(loadBindings()).toEqual({ togglePlay: 'p' });
  });

  it('清洗非法按键串', () => {
    window.localStorage.setItem(
      SHORTCUT_STORAGE_KEY,
      JSON.stringify({ togglePlay: 123, toggleMute: '' })
    );
    expect(loadBindings()).toEqual({});
  });

  it('损坏的 JSON 回退空表', () => {
    window.localStorage.setItem(SHORTCUT_STORAGE_KEY, '{坏掉的 json');
    expect(loadBindings()).toEqual({});
  });

  it('数组形式的数据被拒绝', () => {
    window.localStorage.setItem(SHORTCUT_STORAGE_KEY, '["a"]');
    expect(loadBindings()).toEqual({});
  });

  it('clearBindings 恢复默认', () => {
    saveBindings({ togglePlay: 'p' });
    clearBindings();
    expect(loadBindings()).toEqual({});
    expect(resolveBindings(loadBindings()).togglePlay).toBe('space');
  });
});

/**
 * 改键流程的语义校验。
 *
 * 设置面板不是直接写这份逻辑，而是复用了这几个纯函数；
 * 这里把「接管冲突」「改回默认即清覆盖」的规则钉死，
 * 防止以后有人图省事在 UI 层另写一套判断。
 */
describe('改键流程语义', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  /** 模拟面板提交一次录制：返回落库后的覆盖表与全量绑定 */
  function applyRecording(
    overrides: Record<string, string>,
    actionId: ShortcutActionId,
    keyString: string
  ) {
    const bindings = resolveBindings(overrides as never);
    const conflicts = findConflicts(bindings, keyString, actionId);
    const next = { ...overrides };
    for (const id of conflicts) delete next[id];

    const action = SHORTCUT_ACTIONS.find((a) => a.id === actionId)!;
    if (keyString === action.defaultKeys) {
      delete next[actionId];
    } else {
      next[actionId] = keyString;
    }

    return { next, conflicts, resolved: resolveBindings(next as never) };
  }

  it('改到空闲键位不产生冲突', () => {
    const { next, conflicts, resolved } = applyRecording({}, 'screenshot', 'p');
    expect(conflicts).toEqual([]);
    expect(next).toEqual({ screenshot: 'p' });
    expect(resolved.screenshot).toBe('p');
  });

  it('改到已被占用的键位时接管，原动作恢复默认', () => {
    // m 默认是静音，把截图也绑到 m
    const { next, conflicts, resolved } = applyRecording({}, 'screenshot', 'm');
    expect(conflicts).toEqual(['toggleMute']);
    // 截图拿到 m，静音回落到默认 m…但默认正是 m，故覆盖表里不应留它
    expect(resolved.screenshot).toBe('m');
    expect(resolved.toggleMute).toBe('m');
  });

  it('接管后不会出现两个动作共享同一键位（除默认本身如此）', () => {
    const { resolved } = applyRecording({ toggleMute: 'k' }, 'screenshot', 'k');
    // 静音原本被自定义成 k，截图抢走后静音恢复默认 m，两者不再撞车
    expect(resolved.screenshot).toBe('k');
    expect(resolved.toggleMute).toBe('m');
  });

  it('改回默认值时不写覆盖表（保持存储干净）', () => {
    const { next, resolved } = applyRecording(
      { screenshot: 'p' },
      'screenshot',
      's'
    );
    expect(next).toEqual({});
    expect(resolved.screenshot).toBe('s');
  });

  it('改回默认值不会连带清掉其它自定义项', () => {
    const { next } = applyRecording(
      { screenshot: 'p', toggleMute: 'k' },
      'screenshot',
      's'
    );
    expect(next).toEqual({ toggleMute: 'k' });
  });

  it('改键后存储可往返', () => {
    const { next } = applyRecording({}, 'screenshot', 'p');
    saveBindings(next as never);
    expect(loadBindings()).toEqual({ screenshot: 'p' });
  });

  it('绑定的键位能真正匹配按键事件', () => {
    const { resolved } = applyRecording({}, 'nextEpisode', 'ctrl+arrowright');
    expect(
      matchesKeyString(
        keyEvent('ArrowRight', { ctrlKey: true }),
        resolved.nextEpisode
      )
    ).toBe(true);
    // 少按 ctrl 不应触发
    expect(
      matchesKeyString(keyEvent('ArrowRight'), resolved.nextEpisode)
    ).toBe(false);
  });
});
