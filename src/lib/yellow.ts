/**
 * 搜索结果的「黄词」过滤表。
 *
 * 用途：`/api/search`、`/api/search/one`、`/api/search/ws` 会用这里的词
 * 匹配结果的 `type_name`，命中即丢弃（受 `SiteConfig.DisableYellowFilter` 开关控制）。
 *
 * 2026-10-12：按需求清空。空数组时 `yellowWords.some(...)` 恒为 false，
 * 即过滤逻辑变成空操作（等价于全站开启 DisableYellowFilter）。
 *
 * 说明：如果只是想关掉过滤，其实不必改本文件 —— 设环境变量
 * `NEXT_PUBLIC_DISABLE_YELLOW_FILTER=true`，或在后台「站点设置」里
 * 打开「禁用黄色内容过滤」开关即可，代码侧会自动跳过 `yellowWords.some()`。
 * 保留本文件与导出名，是为了让上述三处调用点无需改动。
 */
export const yellowWords: string[] = [];
