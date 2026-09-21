/**
 * `screenshot-save` 单测。
 *
 * 这个模块的风险点在于「说了假话」：截图路径是浏览器不告诉页面的信息，
 * 一旦在降级路径上编造一个路径，用户会照着去找、找不到、再也不敢用。
 * 所以下面的用例分两类：
 *
 * 1. **纯函数**（文件名清洗、时间戳、dataURL → Blob）—— 直接断言取值。
 * 2. **防说谎的不变量** —— 断言「拿不到路径时文案里不出现具体路径」。
 */

import {
  type DirectoryHandleLike,
  buildScreenshotFilename,
  dataUrlToBlob,
  describeScreenshotDirectory,
  formatTimestampSegment,
  pickScreenshotDirectory,
  sanitizeFilenamePart,
  saveScreenshot,
  SCREENSHOT_FILENAME_PREFIX,
  supportsDirectorySave,
  writeBlobToDirectory,
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
    // 第 10 个字符是下划线的情况
    const withTrailing = sanitizeFilenamePart('abcde fghij klmno', 6);
    expect(withTrailing).toBe('abcde');
    expect(withTrailing.endsWith('_')).toBe(false);
  });

  it('全是非法字符时返回空串（调用方据此决定要不要拼进文件名）', () => {
    expect(sanitizeFilenamePart('///:::')).toBe('');
    expect(sanitizeFilenamePart('')).toBe('');
  });

  it('非字符串输入返回空串，不抛异常', () => {
    // @ts-expect-error 故意传错类型
    expect(sanitizeFilenamePart(null)).toBe('');
    // @ts-expect-error 故意传错类型
    expect(sanitizeFilenamePart(undefined)).toBe('');
  });
});

describe('buildScreenshotFilename', () => {
  const now = new Date(2026, 8, 19, 23, 13, 19); // 2026-09-19

  it('包含前缀、日期、时间戳', () => {
    const name = buildScreenshotFilename({ currentTime: 65, now });
    expect(name).toBe(`${SCREENSHOT_FILENAME_PREFIX}_20260919_00_01_05.png`);
  });

  it('有标题时把标题插在日期之后', () => {
    const name = buildScreenshotFilename({
      currentTime: 3661,
      title: '进击的巨人',
      now,
    });
    expect(name).toBe(
      `${SCREENSHOT_FILENAME_PREFIX}_20260919_进击的巨人_01_01_01.png`
    );
  });

  it('标题被清洗，非法字符不会漏进文件名', () => {
    const name = buildScreenshotFilename({
      currentTime: 1,
      title: 'A/B:C*D?',
      now,
    });
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
    expect(name).toContain('ABCD');
  });

  it('标题为空或全是非法字符时不留多余分隔符', () => {
    const a = buildScreenshotFilename({ currentTime: 1, title: '', now });
    const b = buildScreenshotFilename({ currentTime: 1, title: '///', now });
    expect(a).not.toContain('__');
    expect(a).toBe(b);
  });

  it('日期补零（1 月 1 日不能变成 101）', () => {
    const name = buildScreenshotFilename({
      currentTime: 0,
      now: new Date(2026, 0, 1, 0, 0, 0),
    });
    expect(name).toBe(`${SCREENSHOT_FILENAME_PREFIX}_20260101_00_00_00.png`);
  });

  it('始终以 .png 结尾', () => {
    expect(buildScreenshotFilename({ now }).endsWith('.png')).toBe(true);
  });
});

describe('supportsDirectorySave', () => {
  // 这里的桩函数只被 `typeof === 'function'` 检查，不会被调用
  const noop = () => undefined;

  it('只认 showDirectoryPicker', () => {
    expect(supportsDirectorySave({ showDirectoryPicker: noop })).toBe(true);
    // showSaveFilePicker 拿不到目录，不算支持
    expect(supportsDirectorySave({ showSaveFilePicker: noop })).toBe(false);
    expect(supportsDirectorySave({})).toBe(false);
    expect(supportsDirectorySave(null)).toBe(false);
    expect(supportsDirectorySave(undefined)).toBe(false);
  });
});

/** jsdom 的 Blob 没有 `.text()`，用 FileReader 读回来 */
function blobToText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('dataUrlToBlob', () => {
  it('解析 base64 dataURL 并保留 mime', async () => {
    // 'hi' 的 base64 是 aGk=
    const blob = dataUrlToBlob('data:image/png;base64,aGk=');
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/png');
    expect(blob!.size).toBe(2);
    expect(await blobToText(blob!)).toBe('hi');
  });

  it('支持非 base64 的 dataURL', async () => {
    const blob = dataUrlToBlob('data:image/svg+xml,<svg/>');
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/svg+xml');
    expect(await blobToText(blob!)).toBe('<svg/>');
  });

  it('非图片 dataURL 返回 null', () => {
    expect(dataUrlToBlob('data:text/plain;base64,aGk=')).toBeNull();
  });

  it('格式非法返回 null 而不是抛异常', () => {
    expect(dataUrlToBlob('')).toBeNull();
    expect(dataUrlToBlob('not-a-data-url')).toBeNull();
    expect(dataUrlToBlob('data:image/png;base64,@@@')).toBeNull();
  });
});

describe('writeBlobToDirectory', () => {
  function makeDir(
    options: { failCreate?: boolean; failClose?: boolean } = {}
  ) {
    const written: unknown[] = [];
    let closed = false;
    const dir: DirectoryHandleLike = {
      name: 'Shots',
      getFileHandle: async () => {
        if (options.failCreate) throw new Error('nope');
        return {
          createWritable: async () => ({
            write: async (data: unknown) => {
              written.push(data);
            },
            close: async () => {
              if (options.failClose) throw new Error('close failed');
              closed = true;
            },
          }),
        };
      },
    };
    return { dir, written, isClosed: () => closed };
  }

  it('写入并 close（不 close 文件是空的）', async () => {
    const { dir, written, isClosed } = makeDir();
    const blob = new Blob(['x'], { type: 'image/png' });
    expect(await writeBlobToDirectory(dir, 'a.png', blob)).toBe(true);
    expect(written).toEqual([blob]);
    expect(isClosed()).toBe(true);
  });

  it('getFileHandle 抛错时返回 false，不向外抛', async () => {
    const { dir } = makeDir({ failCreate: true });
    expect(await writeBlobToDirectory(dir, 'a.png', new Blob(['x']))).toBe(
      false
    );
  });

  it('close 失败也算失败（文件可能不完整）', async () => {
    const { dir } = makeDir({ failClose: true });
    expect(await writeBlobToDirectory(dir, 'a.png', new Blob(['x']))).toBe(
      false
    );
  });

  it('缺少 getFileHandle 时返回 false', async () => {
    expect(await writeBlobToDirectory({}, 'a.png', new Blob(['x']))).toBe(
      false
    );
  });
});

describe('saveScreenshot — 防说谎的不变量', () => {
  // jsdom 里没有 indexedDB（jest 环境未接假实现），loadDirectoryHandle
  // 会走 null 分支，于是 saveScreenshot 必然落在降级路径 A 上 ——
  // 这正好是我们要锁死的那条路径。
  it('降级路径不声称知道具体路径，只说「浏览器下载文件夹」', async () => {
    const result = await saveScreenshot(
      'data:image/png;base64,aGk=',
      'shot.png'
    );
    expect(result.mode).toBe('download');
    expect(result.filename).toBe('shot.png');
    expect(result.directoryName).toBeUndefined();
    expect(result.message).toContain('浏览器下载文件夹');
    // 绝不能出现盘符 / 绝对路径 —— 我们是真不知道
    expect(result.message).not.toMatch(/[A-Za-z]:\\/);
    expect(result.message).not.toMatch(/\/Users\/|\/home\//);
  });

  it('dataURL 无效时明确报「截图数据无效」，而不是假装成功', async () => {
    const result = await saveScreenshot('garbage', 'shot.png');
    expect(result.mode).toBe('download');
    expect(result.message).toBe('截图数据无效');
  });
});

describe('pickScreenshotDirectory', () => {
  it('环境不支持时直接返回 null，不调用任何 picker', async () => {
    const win = {
      showSaveFilePicker: () => {
        throw new Error('不该被调用：文件选择器拿不到目录');
      },
    };
    await expect(pickScreenshotDirectory(win)).resolves.toBeNull();
  });

  it('用户取消（抛 AbortError）返回 null', async () => {
    const win = {
      showDirectoryPicker: async () => {
        const err = new Error('user aborted');
        err.name = 'AbortError';
        throw err;
      },
    };
    expect(await pickScreenshotDirectory(win)).toBeNull();
  });

  it('拿不到 IndexedDB 时返回 null —— 不假装设置成功', async () => {
    // 能选到目录，但句柄存不下来（隐私模式），必须失败
    const win = {
      showDirectoryPicker: async () => ({ name: 'Shots' }),
    };
    expect(await pickScreenshotDirectory(win)).toBeNull();
  });
});

describe('describeScreenshotDirectory', () => {
  it('无已保存目录时目录名为 null，且不抛异常', async () => {
    const state = await describeScreenshotDirectory();
    expect(state.directoryName).toBeNull();
    expect(state.permission).toBe('unknown');
    expect(typeof state.supported).toBe('boolean');
  });
});
