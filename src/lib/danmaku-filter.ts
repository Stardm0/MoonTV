/**
 * 弹幕关键词屏蔽。
 *
 * 设计要点：
 * 1) 规则是纯数据，判定是纯函数 —— 只有 `filter` 回调里那一次 `buildDanmakuFilter()`
 *    把它编译成闭包。这样规则能安全地存 localStorage（函数不能存）。
 * 2) 正则编译失败**不抛出**，而是让该条规则失效。用户手打的正则很容易写错，
 *    一次语法错误不应该让整个弹幕列表消失。
 * 3) 默认上限 100 条规则：规则是在每条弹幕上线性扫描的，一集几千条弹幕 ×
 *    无上限规则数会拖慢渲染。超出的直接忽略。
 */

/** 单条屏蔽规则 */
export interface DanmakuFilterRule {
  id: string;
  /** 匹配内容：普通模式下是子串，正则模式下是表达式 */
  keyword: string;
  type: 'normal' | 'regex';
  enabled: boolean;
}

/** 持久化的规则集合 */
export interface DanmakuFilterConfig {
  rules: DanmakuFilterRule[];
}

/** 本地存储键 */
export const DANMAKU_FILTER_STORAGE_KEY = 'moontv_danmaku_filter_rules';

/** 规则数量上限，防止线性扫描拖慢渲染 */
export const MAX_DANMAKU_FILTER_RULES = 100;

/** 单条规则关键字长度上限 */
export const MAX_DANMAKU_KEYWORD_LENGTH = 60;

/** 空白配置（每次调用返回新对象，避免共享引用） */
export function createEmptyDanmakuFilterConfig(): DanmakuFilterConfig {
  return { rules: [] };
}

/** 生成规则 id。用随机串而非自增，避免多条规则在同一毫秒创建时撞车 */
function createRuleId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 判断一个值是否是可用的正则。
 *
 * 单独抽出来是因为这里有个真实陷阱：`new RegExp()` 在语法错误时抛异常，
 * 而用户在输入框里边打字边保存时，中途状态几乎必然是非法的（比如刚敲完 `(`）。
 */
export function isValidRegex(pattern: string): boolean {
  if (!pattern) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** 把外部数据（localStorage / 旧版本）清洗成可用的规则列表 */
export function normalizeFilterRules(input: unknown): DanmakuFilterRule[] {
  if (!Array.isArray(input)) return [];

  const result: DanmakuFilterRule[] = [];
  const seenIds = new Set<string>();

  for (const raw of input) {
    if (result.length >= MAX_DANMAKU_FILTER_RULES) break;
    if (!raw || typeof raw !== 'object') continue;

    const item = raw as Record<string, unknown>;
    const keyword =
      typeof item.keyword === 'string'
        ? item.keyword.trim().slice(0, MAX_DANMAKU_KEYWORD_LENGTH)
        : '';
    // 空关键字不能作为规则：普通模式会匹配所有弹幕（全部屏蔽），
    // 正则模式下空表达式也匹配一切。这几乎肯定是用户误操作。
    if (!keyword) continue;

    const type: DanmakuFilterRule['type'] =
      item.type === 'regex' ? 'regex' : 'normal';

    // 非法正则直接丢弃，而不是留一条永远不生效的规则让用户困惑
    if (type === 'regex' && !isValidRegex(keyword)) continue;

    let id = typeof item.id === 'string' && item.id ? item.id : createRuleId();
    // 去重 id：重复 id 会让"删除某条"删掉多条
    if (seenIds.has(id)) id = createRuleId();
    seenIds.add(id);

    result.push({
      id,
      keyword,
      type,
      enabled: item.enabled !== false,
    });
  }

  return result;
}

/** 清洗整个配置对象 */
export function normalizeDanmakuFilterConfig(
  input: unknown
): DanmakuFilterConfig {
  if (!input || typeof input !== 'object') return createEmptyDanmakuFilterConfig();
  const raw = input as Record<string, unknown>;
  return { rules: normalizeFilterRules(raw.rules) };
}

/**
 * 判断一条弹幕文本是否应被屏蔽。
 *
 * 供 `buildDanmakuFilter()` 内部使用，也单独导出便于测试与复用
 * （例如设置面板里做"规则命中预览"）。
 */
export function shouldBlockDanmaku(
  text: string,
  rules: DanmakuFilterRule[]
): boolean {
  if (!text || !rules.length) return false;

  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.type === 'regex') {
      // 已由 normalize 保证合法；这里仍防御一次，避免调用方传入未清洗的规则
      try {
        if (new RegExp(rule.keyword).test(text)) return true;
      } catch {
        continue;
      }
    } else if (text.includes(rule.keyword)) {
      return true;
    }
  }

  return false;
}

/**
 * 编译成弹幕插件要的 `filter` 回调。
 *
 * 返回 `(danmu) => boolean`：true = 保留，false = 屏蔽。
 * 与插件的约定一致（见 `createDanmakuDefaultConfig` 里的默认 filter）。
 *
 * 注意：这个函数返回的是**闭包**，不能序列化。持久化规则请用
 * `saveDanmakuFilterRules()` 存规则数组本身。
 */
export function buildDanmakuFilter(
  rules: DanmakuFilterRule[]
): (danmu: { text?: string }) => boolean {
  const active = rules.filter((rule) => rule.enabled);

  // 没有启用规则时返回一个恒定放行的函数，省掉逐条弹幕的空循环
  if (!active.length) {
    return () => true;
  }

  return (danmu: { text?: string }) => {
    const text = typeof danmu?.text === 'string' ? danmu.text : '';
    if (!text) return true;
    return !shouldBlockDanmaku(text, active);
  };
}

// -----------------------------------------------------------------------------
// 持久化
// -----------------------------------------------------------------------------

/** 读取规则（含脏数据清洗）。服务端渲染或存储被禁用时返回空配置 */
export function loadDanmakuFilterConfig(): DanmakuFilterConfig {
  if (typeof window === 'undefined') return createEmptyDanmakuFilterConfig();

  try {
    const raw = window.localStorage.getItem(DANMAKU_FILTER_STORAGE_KEY);
    if (!raw) return createEmptyDanmakuFilterConfig();
    return normalizeDanmakuFilterConfig(JSON.parse(raw));
  } catch {
    return createEmptyDanmakuFilterConfig();
  }
}

/** 保存规则。空规则时移除存储项，避免留下无意义的空数组 */
export function saveDanmakuFilterConfig(config: DanmakuFilterConfig): void {
  if (typeof window === 'undefined') return;

  try {
    const rules = normalizeFilterRules(config?.rules);
    if (!rules.length) {
      window.localStorage.removeItem(DANMAKU_FILTER_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      DANMAKU_FILTER_STORAGE_KEY,
      JSON.stringify({ rules })
    );
  } catch {
    // 存储不可用（隐私模式 / 配额满）不应影响播放
  }
}

/** 清除全部屏蔽规则 */
export function clearDanmakuFilterConfig(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(DANMAKU_FILTER_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** 新建一条规则（已做规范化），供设置面板的"添加"使用 */
export function createDanmakuFilterRule(
  keyword: string,
  type: DanmakuFilterRule['type'] = 'normal'
): DanmakuFilterRule | null {
  const trimmed = keyword.trim().slice(0, MAX_DANMAKU_KEYWORD_LENGTH);
  if (!trimmed) return null;
  if (type === 'regex' && !isValidRegex(trimmed)) return null;

  return {
    id: createRuleId(),
    keyword: trimmed,
    type,
    enabled: true,
  };
}
