import {
  buildDanmakuFilter,
  clearDanmakuFilterConfig,
  createDanmakuFilterRule,
  createEmptyDanmakuFilterConfig,
  DANMAKU_FILTER_STORAGE_KEY,
  DanmakuFilterRule,
  isValidRegex,
  loadDanmakuFilterConfig,
  MAX_DANMAKU_FILTER_RULES,
  MAX_DANMAKU_KEYWORD_LENGTH,
  normalizeDanmakuFilterConfig,
  normalizeFilterRules,
  saveDanmakuFilterConfig,
  shouldBlockDanmaku,
} from '../danmaku-filter';

function rule(
  keyword: string,
  type: DanmakuFilterRule['type'] = 'normal',
  enabled = true,
  id = keyword
): DanmakuFilterRule {
  return { id, keyword, type, enabled };
}

describe('isValidRegex', () => {
  it('接受合法正则', () => {
    expect(isValidRegex('^哈+$')).toBe(true);
    expect(isValidRegex('\\d{3}')).toBe(true);
  });

  it('拒绝语法错误的正则', () => {
    // 用户在输入框里边打字边保存时，中途几乎必然是非法的
    expect(isValidRegex('(')).toBe(false);
    expect(isValidRegex('[')).toBe(false);
    expect(isValidRegex('a{2,1}')).toBe(false);
  });

  it('空串视为非法', () => {
    expect(isValidRegex('')).toBe(false);
  });
});

describe('shouldBlockDanmaku 普通模式', () => {
  it('子串命中即屏蔽', () => {
    expect(shouldBlockDanmaku('前面高能预警', [rule('高能')])).toBe(true);
  });

  it('未命中不屏蔽', () => {
    expect(shouldBlockDanmaku('哈哈哈哈', [rule('高能')])).toBe(false);
  });

  it('已禁用规则不生效', () => {
    expect(shouldBlockDanmaku('前面高能预警', [rule('高能', 'normal', false)])).toBe(
      false
    );
  });

  it('多条规则任一命中即屏蔽', () => {
    const rules = [rule('高能'), rule('剧透'), rule('广告')];
    expect(shouldBlockDanmaku('这是剧透内容', rules)).toBe(true);
  });

  it('空文本不屏蔽（不调用规则）', () => {
    expect(shouldBlockDanmaku('', [rule('')])).toBe(false);
  });
});

describe('shouldBlockDanmaku 正则模式', () => {
  it('正则命中即屏蔽', () => {
    expect(shouldBlockDanmaku('打卡123次', [rule('\\d+次', 'regex')])).toBe(true);
  });

  it('正则锚点生效', () => {
    expect(shouldBlockDanmaku('纯数字123', [rule('^\\d+$', 'regex')])).toBe(false);
    expect(shouldBlockDanmaku('123', [rule('^\\d+$', 'regex')])).toBe(true);
  });

  it('普通模式不做正则解释', () => {
    // '\\d' 在普通模式下应当按字面匹配，而不是数字
    expect(shouldBlockDanmaku('abc123', [rule('\\d')])).toBe(false);
  });

  it('传入未清洗的非法正则不会抛异常', () => {
    expect(() => shouldBlockDanmaku('任意', [rule('(', 'regex')])).not.toThrow();
    expect(shouldBlockDanmaku('任意', [rule('(', 'regex')])).toBe(false);
  });
});

describe('normalizeFilterRules 脏数据清洗', () => {
  it('非数组返回空', () => {
    expect(normalizeFilterRules(null)).toEqual([]);
    expect(normalizeFilterRules('x')).toEqual([]);
    expect(normalizeFilterRules({})).toEqual([]);
  });

  it('丢弃空关键字规则', () => {
    // 空关键字在普通模式下会匹配所有弹幕（等于全屏蔽）
    expect(normalizeFilterRules([{ keyword: '', type: 'normal' }])).toEqual([]);
    expect(normalizeFilterRules([{ keyword: '   ', type: 'normal' }])).toEqual([]);
  });

  it('丢弃非法正则规则', () => {
    const result = normalizeFilterRules([
      { keyword: '(', type: 'regex' },
      { keyword: '正常', type: 'normal' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].keyword).toBe('正常');
  });

  it('关键字做 trim', () => {
    const result = normalizeFilterRules([{ keyword: '  高能  ', type: 'normal' }]);
    expect(result[0].keyword).toBe('高能');
  });

  it('截断超长关键字', () => {
    const long = 'a'.repeat(MAX_DANMAKU_KEYWORD_LENGTH + 50);
    const result = normalizeFilterRules([{ keyword: long, type: 'normal' }]);
    expect(result[0].keyword).toHaveLength(MAX_DANMAKU_KEYWORD_LENGTH);
  });

  it('未知 type 回落 normal', () => {
    const result = normalizeFilterRules([{ keyword: 'x', type: '乱写' }]);
    expect(result[0].type).toBe('normal');
  });

  it('enabled 缺省为 true，显式 false 保留', () => {
    const result = normalizeFilterRules([
      { keyword: 'a' },
      { keyword: 'b', enabled: false },
    ]);
    expect(result[0].enabled).toBe(true);
    expect(result[1].enabled).toBe(false);
  });

  it('补齐缺失 id', () => {
    const result = normalizeFilterRules([{ keyword: 'x' }]);
    expect(result[0].id).toBeTruthy();
  });

  it('重复 id 会被替换，避免删一条删掉多条', () => {
    const result = normalizeFilterRules([
      { keyword: 'a', id: 'same' },
      { keyword: 'b', id: 'same' },
    ]);
    expect(result[0].id).not.toBe(result[1].id);
  });

  it('超过上限的规则被忽略', () => {
    const many = Array.from({ length: MAX_DANMAKU_FILTER_RULES + 20 }, (_, i) => ({
      keyword: `k${i}`,
    }));
    expect(normalizeFilterRules(many)).toHaveLength(MAX_DANMAKU_FILTER_RULES);
  });

  it('过滤数组中的非对象项', () => {
    expect(normalizeFilterRules(['x', null, 3, { keyword: 'ok' }])).toHaveLength(1);
  });
});

describe('normalizeDanmakuFilterConfig', () => {
  it('非法输入返回空配置', () => {
    expect(normalizeDanmakuFilterConfig(null)).toEqual({ rules: [] });
    expect(normalizeDanmakuFilterConfig(undefined)).toEqual({ rules: [] });
  });

  it('清洗内层 rules', () => {
    const result = normalizeDanmakuFilterConfig({
      rules: [{ keyword: '(' , type: 'regex' }, { keyword: 'ok' }],
    });
    expect(result.rules).toHaveLength(1);
  });

  it('createEmptyDanmakuFilterConfig 每次返回新对象', () => {
    expect(createEmptyDanmakuFilterConfig()).not.toBe(
      createEmptyDanmakuFilterConfig()
    );
  });
});

describe('buildDanmakuFilter 编译回调', () => {
  it('无规则时恒放行', () => {
    const filter = buildDanmakuFilter([]);
    expect(filter({ text: '任意弹幕' })).toBe(true);
  });

  it('全部规则禁用时恒放行', () => {
    const filter = buildDanmakuFilter([rule('高能', 'normal', false)]);
    expect(filter({ text: '高能预警' })).toBe(true);
  });

  it('命中规则返回 false', () => {
    const filter = buildDanmakuFilter([rule('高能')]);
    expect(filter({ text: '高能预警' })).toBe(false);
  });

  it('未命中返回 true', () => {
    const filter = buildDanmakuFilter([rule('高能')]);
    expect(filter({ text: '普通弹幕' })).toBe(true);
  });

  it('text 缺失或非字符串时放行', () => {
    const filter = buildDanmakuFilter([rule('高能')]);
    expect(filter({})).toBe(true);
    expect(filter({ text: undefined })).toBe(true);
    expect((filter as any)(null)).toBe(true);
  });

  it('返回的是闭包（不可序列化）', () => {
    const filter = buildDanmakuFilter([rule('高能')]);
    // 这解释了为什么规则要单独存 localStorage 而不能存 filter 本身
    expect(typeof filter).toBe('function');
    expect(JSON.stringify({ filter })).toBe('{}');
  });

  it('编译后修改原规则数组不影响已生成的过滤器', () => {
    const rules = [rule('高能')];
    const filter = buildDanmakuFilter(rules);
    rules.push(rule('剧透'));
    // 编译时已快照启用规则，避免运行中数组被改动导致行为漂移
    expect(filter({ text: '这是剧透' })).toBe(true);
  });
});

describe('持久化', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('保存后可读回', () => {
    saveDanmakuFilterConfig({ rules: [rule('高能', 'normal', true, 'a')] });
    const loaded = loadDanmakuFilterConfig();
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0].keyword).toBe('高能');
  });

  it('空规则不写入存储', () => {
    saveDanmakuFilterConfig({ rules: [] });
    expect(
      window.localStorage.getItem(DANMAKU_FILTER_STORAGE_KEY)
    ).toBeNull();
  });

  it('保存时清洗非法规则', () => {
    saveDanmakuFilterConfig({
      rules: [rule('(', 'regex'), rule('正常')],
    });
    expect(loadDanmakuFilterConfig().rules).toHaveLength(1);
  });

  it('损坏的 JSON 回退空配置', () => {
    window.localStorage.setItem(DANMAKU_FILTER_STORAGE_KEY, '{坏掉');
    expect(loadDanmakuFilterConfig()).toEqual({ rules: [] });
  });

  it('clear 后读回空配置', () => {
    saveDanmakuFilterConfig({ rules: [rule('高能')] });
    clearDanmakuFilterConfig();
    expect(loadDanmakuFilterConfig()).toEqual({ rules: [] });
  });

  it('往返后 buildDanmakuFilter 仍生效', () => {
    saveDanmakuFilterConfig({ rules: [rule('高能', 'normal', true, 'a')] });
    const filter = buildDanmakuFilter(loadDanmakuFilterConfig().rules);
    expect(filter({ text: '高能预警' })).toBe(false);
  });
});

describe('createDanmakuFilterRule', () => {
  it('普通模式创建成功', () => {
    const r = createDanmakuFilterRule('高能');
    expect(r).not.toBeNull();
    expect(r!.keyword).toBe('高能');
    expect(r!.enabled).toBe(true);
  });

  it('空关键字返回 null', () => {
    expect(createDanmakuFilterRule('   ')).toBeNull();
  });

  it('非法正则返回 null', () => {
    expect(createDanmakuFilterRule('(', 'regex')).toBeNull();
  });

  it('合法正则创建成功', () => {
    expect(createDanmakuFilterRule('\\d+', 'regex')).not.toBeNull();
  });

  it('每次生成的 id 不同', () => {
    const a = createDanmakuFilterRule('x');
    const b = createDanmakuFilterRule('x');
    expect(a!.id).not.toBe(b!.id);
  });
});
