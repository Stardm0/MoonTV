/**
 * 弹幕解析层测试。
 *
 * 重点覆盖两类容易出错的点：
 * 1) `p` 字段的索引位置（8 段格式，颜色在索引 3 而非 2）
 * 2) 输出给插件的格式转换（color 为 #rrggbb、type 转 mode）
 *
 * 这些实现细节直接决定弹幕能否正确显示，值得固化。
 */

import { fetchPluginDanmaku } from '../danmaku.client';

/** 构造一条 8 段 p 属性的 XML 弹幕 */
function xmlWith(pFields: string, text = '测试弹幕') {
  return `<?xml version="1.0" ?><i><d p="${pFields}">${text}</d></i>`;
}

/** 模拟一个返回指定文本的 fetch */
function mockFetch(body: string, ok = true) {
  return jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    text: async () => body,
  });
}

describe('fetchPluginDanmaku XML 解析', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('按 8 段格式正确取到颜色（索引 3）', async () => {
    // 时间, 类型, 字号, 颜色, 时间戳, 池, 用户, ID
    global.fetch = mockFetch(
      xmlWith('5.0,5,25,16777215,1751533608,0,13190629936,84261947057') as any
    );
    const list = await fetchPluginDanmaku('/api/v2/comment/1?format=xml');
    expect(list).toHaveLength(1);
    // 白色
    expect(list[0].color).toBe('#ffffff');
  });

  it('深色系颜色被补零（这是本次修复的核心）', async () => {
    global.fetch = mockFetch(
      xmlWith('1.0,1,25,255,0,0,1,1', '蓝色弹幕') as any
    );
    const list = await fetchPluginDanmaku('/x');
    expect(list[0].color).toBe('#0000ff');
  });

  it('不会把字号当成颜色', async () => {
    // 字号 25、颜色 16711680（红）。若误取索引 2 会得到 #19
    global.fetch = mockFetch(
      xmlWith('1.0,1,25,16711680,0,0,1,1') as any
    );
    const list = await fetchPluginDanmaku('/x');
    expect(list[0].color).toBe('#ff0000');
  });

  it('type 正确映射为 mode', async () => {
    const xml = `<i>
      <d p="1,1,25,16777215,0,0,1,1">滚动</d>
      <d p="2,5,25,16777215,0,0,1,2">顶部</d>
      <d p="3,4,25,16777215,0,0,1,3">底部</d>
    </i>`;
    global.fetch = mockFetch(xml as any);
    const list = await fetchPluginDanmaku('/x');
    expect(list.map((i) => i.mode)).toEqual([0, 1, 2]);
  });

  it('字段不足 4 段的弹幕被丢弃', async () => {
    global.fetch = mockFetch(
      `<i><d p="1,1,25">坏数据</d><d p="1,1,25,16777215,0,0,1,2">好数据</d></i>` as any
    );
    const list = await fetchPluginDanmaku('/x');
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('好数据');
  });

  it('空文本弹幕被过滤', async () => {
    global.fetch = mockFetch(
      `<i><d p="1,1,25,16777215,0,0,1,1">   </d></i>` as any
    );
    const list = await fetchPluginDanmaku('/x');
    expect(list).toHaveLength(0);
  });

  it('HTTP 失败时抛错（调用方据此回退）', async () => {
    global.fetch = mockFetch('', false) as any;
    await expect(fetchPluginDanmaku('/x')).rejects.toThrow('500');
  });

  it('空地址抛错', async () => {
    await expect(fetchPluginDanmaku('')).rejects.toThrow();
  });
});

describe('fetchPluginDanmaku JSON 解析', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('解析 comments 数组并取索引 3 作颜色', async () => {
    global.fetch = mockFetch(
      JSON.stringify({
        count: 1,
        comments: [{ cid: 1, p: '1.0,1,25,65280,0,0,user,1', m: '绿弹幕' }],
      }) as any
    );
    const list = await fetchPluginDanmaku('/x');
    expect(list).toHaveLength(1);
    expect(list[0].color).toBe('#00ff00');
  });

  it('缺 t 字段时回退到 p 的第一段作为时间', async () => {
    global.fetch = mockFetch(
      JSON.stringify({
        comments: [{ cid: 1, p: '12.5,1,25,16777215,0,0,u,1', m: 'x' }],
      }) as any
    );
    const list = await fetchPluginDanmaku('/x');
    expect(list[0].time).toBe(12.5);
  });
});
