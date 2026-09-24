/**
 * `screenshot-save` 单测。
 *
 * 这个模块的风险点在于「说了假话」：截图路径是浏览器不告诉页面的信息，
 * 一旦编造一个路径，用户会照着去找、找不到、再也不敢用。
 * 所以除了纯函数取值，还有一条**防说谎的不变量**：
 * 文案里绝不许出现盘符或绝对路径。
 *
 * 另注：本模块曾实现「用户可选保存目录」（File System Access + IndexedDB），
 * 因权限不跨会话保留、部分浏览器不支持而**整体移除**，相关用例一并删掉。
 * 现在只有「浏览器下载目录」这一条路径。
 */

import {
  buildScreenshotFilename,
  dataUrlToBlob,
  formatTimestampSegment,
  sanitizeFilenamePart,
  saveScreenshot,
  SCREENSHOT_FILENAME_PREFIX,
  triggerBrowserDownload,
} from '@/lib/screenshot-save';

describe('formatTimestampSegment', () => {
  it('按 HH_MM_SS 补零，且不含冒号（Windows 文件名不允许）', () => {
    expect(formatTimestampSegment(0)).toBe('00_00_00');
    expect(formatTimestampSegment(5)).toBe('00_00_05');
    expect(formatTimestampSegment(65)).toBe('00_01_05');
    expect(formatTimestampSegment(3661)).toBe('01_01_01');
    expect(formatTimestampSegment(3661)).not.toContain(':');
  });

  it('小时可以超过两位（长片不会截断）', () => {
    expect(formatTimestampSegment(36_000)).toBe('10_00_00');
  });

  it('小数向下取整', () => {
    expect(formatTimestampSegment(59.99)).toBe('00_00_59');
  });

  it('非法输入（NaN / 负数 / Infinity）一律当作 0，不产出 NaN 片段', () => {
    for (const bad of [Number.NaN, -1, -99.5, Number.POSITIVE_INFINITY]) {
      expect(formatTimestampSegment(bad)).toBe('00_00_00');
    }
  });
});

describe('sanitizeFilenamePart', () => {
  it('去掉 Windows 非法字符与路径分隔符', () => {
    expect(sanitizeFilenamePart('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  it('空白（含全角空格）压成单个下划线', () => {
    expect(sanitizeFilenamePart('进击  的   巨人')).toBe('进击_的_巨人');
    expect(sanitizeFilenamePart('a\u3000b')).toBe('a_b');
  });

  it('去掉控制字符', () => {
    expect(sanitizeFilenamePart('a\u0000b\u001fc\u007fd')).toBe('abcd');
  });

  it('去掉首尾下划线与点（Windows 不允许结尾点）', () => {
    expect(sanitizeFilenamePart('__a__')).toBe('a');
    expect(sanitizeFilenamePart('...a...')).toBe('a');
    expect(sanitizeFilenamePart('/a/')).toBe('a');
  });

  it('超长时截断，且截断后不留下结尾下划线', () => {
    const out = sanitizeFilenamePart('a'.repeat(60), 10);
    expect(out).toBe('a'.repeat(10));
    const withTrailing = sanitizeFilenamePart('abcde fghij klmno', 6);
    expect(withTrailing).toBe('abcde');
    expect(withTrailing.endsWith('_')).toBe(false);
  });

  it('全是非法字符时返回空串（调用方据此决定要不要拼进文件名）', () => {
    expect(sanitizeFilenamePart('///:::')).toBe('');
    expect(sanitizeFilenamePart('   ')).toBe('');
  });

  it('非字符串输入返回空串，不抛异常', () => {
    // 源站数据脏，这里必须兜住
    expect(
      sanitizeFilenamePart(undefined as unknown as string)
    ).toBe('');
    expect(sanitizeFilenamePart(null as unknown as string)).toBe('');
  });
});

describe('buildScreenshotFilename', () => {
  const now = new Date(2026, 8, 22, 10, 0, 0); // 2026-09-22

  it('包含前缀、日期、时间戳', () => {
    const name = buildScreenshotFilename({ currentTime: 65, now });
    expect(name.startsWith(SCREENSHOT_FILENAME_PREFIX)).toBe(true);
    expect(name).toContain('20260922');
    expect(name).toContain('00_01_05');
  });

  it('有标题时把标题插在日期之后', () => {
    const name = buildScreenshotFilename({
      currentTime: 0,
      title: '进击的巨人',
      now,
    });
    expect(name).toBe('artplayer_20260922_进击的巨人_00_00_00.png');
  });

  it('标题被清洗，非法字符不会漏进文件名', () => {
    const name = buildScreenshotFilename({
      currentTime: 0,
      title: 'a/b:c',
      now,
    });
    expect(name).not.toContain('/');
    expect(name).not.toContain(':');
    expect(name).toContain('abc');
  });

  it('标题为空或全是非法字符时不留多余分隔符', () => {
    for (const title of ['', '   ', '///']) {
      const name = buildScreenshotFilename({ currentTime: 0, title, now });
      expect(name).not.toContain('__');
      expect(name).toBe('artplayer_20260922_00_00_00.png');
    }
  });

  it('日期补零（1 月 1 日不能变成 101）', () => {
    const jan1 = new Date(2026, 0, 1);
    expect(buildScreenshotFilename({ currentTime: 0, now: jan1 })).toContain(
      '20260101'
    );
  });

  it('始终以 .png 结尾', () => {
    expect(buildScreenshotFilename({ currentTime: 1 })).toMatch(/\.png$/);
  });
});

describe('dataUrlToBlob', () => {
  it('解析 base64 dataURL 并保留 mime', () => {
    const blob = dataUrlToBlob('data:image/png;base64,aGk=');
    expect(blob).not.toBeNull();
    expect(blob ? blob.type : '').toBe('image/png');
  });

  it('支持非 base64 的 dataURL', () => {
    const blob = dataUrlToBlob('data:image/svg+xml,<svg/>');
    expect(blob).not.toBeNull();
    expect(blob ? blob.type : '').toBe('image/svg+xml');
  });

  it('非图片 dataURL 返回 null', () => {
    expect(dataUrlToBlob('data:text/plain;base64,aGk=')).toBeNull();
  });

  it('格式非法返回 null 而不是抛异常', () => {
    expect(dataUrlToBlob('garbage')).toBeNull();
    expect(dataUrlToBlob('')).toBeNull();
  });
});

describe('triggerBrowserDownload', () => {
  // jsdom **没有实现** URL.createObjectURL（只有真实浏览器才有），
  // 不补桩的话函数会走进 catch 返回 false，测试会误判成实现有问题。
  const originalCreateObjectURL = (URL as { createObjectURL?: unknown })
    .createObjectURL;

  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: jest.fn(() => 'blob:mock'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
  });

  afterEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: originalCreateObjectURL,
    });
  });

  it('创建并点击 <a download>，且用后从 DOM 移除', () => {
    const created: HTMLAnchorElement[] = [];
    const originalCreate = document.createElement.bind(document);
    const createSpy = jest
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string) => {
        const el = originalCreate(tag);
        if (tag === 'a') created.push(el as HTMLAnchorElement);
        return el;
      });
    const clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    const ok = triggerBrowserDownload(
      new Blob(['x'], { type: 'image/png' }),
      'shot.png'
    );

    expect(ok).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0].download).toBe('shot.png');
    expect(created[0].href).toContain('blob:mock');
    // 用完必须从文档里摘掉，否则每次截图都留一个隐藏节点
    expect(document.body.contains(created[0])).toBe(false);

    createSpy.mockRestore();
    clickSpy.mockRestore();
  });
});

describe('saveScreenshot — 防说谎的不变量', () => {
  it('降级路径不声称知道具体路径，只说「浏览器下载文件夹」', async () => {
    const result = await saveScreenshot('data:image/png;base64,aGk=', 'shot.png');

    expect(result.filename).toBe('shot.png');
    expect(result.message).toContain('浏览器下载文件夹');
    // 绝不能出现盘符 / 绝对路径 —— 我们是真不知道
    expect(result.message).not.toMatch(/[A-Za-z]:\\/);
    expect(result.message).not.toMatch(/\/Users\/|\/home\//);
  });

  it('dataURL 无效时明确报「截图数据无效」，而不是假装成功', async () => {
    const result = await saveScreenshot('garbage', 'shot.png');
    expect(result.message).toBe('截图数据无效');
  });

  it('结果里不再有「目录模式」这种字段（该能力已移除）', async () => {
    const result = await saveScreenshot('data:image/png;base64,aGk=', 'a.png');
    expect(Object.keys(result).sort()).toEqual(['filename', 'message']);
  });
});
