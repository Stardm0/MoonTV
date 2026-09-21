import {
  buildExternalPlayerUrl,
  EXTERNAL_PLAYERS,
  ExternalPlayerId,
  isPlayerLikelySupported,
} from '../external-player';

const M3U8 = 'https://cdn.example.com/live/index.m3u8';
const PROXY = 'https://site.com/api/m3u8?url=https%3A%2F%2Fcdn.example.com%2Fa.m3u8';

describe('EXTERNAL_PLAYERS 清单', () => {
  it('包含 6 个播放器', () => {
    expect(EXTERNAL_PLAYERS).toHaveLength(6);
  });

  it('id 不重复', () => {
    const ids = EXTERNAL_PLAYERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每项都有 label 与 platform', () => {
    for (const p of EXTERNAL_PLAYERS) {
      expect(p.label).toBeTruthy();
      expect(['desktop', 'mobile', 'both']).toContain(p.platform);
    }
  });
});

describe('buildExternalPlayerUrl 直链拼接', () => {
  it('potplayer 直接前缀拼接', () => {
    expect(buildExternalPlayerUrl('potplayer', M3U8)).toBe(
      `potplayer://${M3U8}`
    );
  });

  it('vlc 直接前缀拼接', () => {
    expect(buildExternalPlayerUrl('vlc', M3U8)).toBe(`vlc://${M3U8}`);
  });

  it('mpv 直接前缀拼接', () => {
    expect(buildExternalPlayerUrl('mpv', M3U8)).toBe(`mpv://${M3U8}`);
  });

  it('这三种不能对地址做 encode', () => {
    // encode 后播放器拿到 %3A%2F%2F 无法识别 scheme 后的 URL
    const result = buildExternalPlayerUrl('potplayer', M3U8);
    expect(result).toContain('https://');
    expect(result).not.toContain('%3A%2F%2F');
  });

  it('nplayer 用连字符而非双斜杠', () => {
    expect(buildExternalPlayerUrl('nplayer', M3U8)).toBe(`nplayer-${M3U8}`);
  });
});

describe('buildExternalPlayerUrl iina', () => {
  it('地址必须 encode 成 query 参数', () => {
    const result = buildExternalPlayerUrl('iina', M3U8);
    expect(result).toBe(`iina://weblink?url=${encodeURIComponent(M3U8)}`);
  });

  it('encode 后含 %3A%2F%2F', () => {
    expect(buildExternalPlayerUrl('iina', M3U8)).toContain('%3A%2F%2F');
  });

  it('带 query 的代理地址能被正确 encode', () => {
    const result = buildExternalPlayerUrl('iina', PROXY);
    expect(result).toBe(`iina://weblink?url=${encodeURIComponent(PROXY)}`);
    // 双重 encode 会让播放器解出错误的地址
    expect(decodeURIComponent(result!.split('url=')[1])).toBe(PROXY);
  });
});

describe('buildExternalPlayerUrl mxplayer', () => {
  it('生成安卓 intent 语法', () => {
    const result = buildExternalPlayerUrl('mxplayer', M3U8, '测试剧集');
    expect(result).toContain('intent://');
    expect(result).toContain('package=com.mxtech.videoplayer.ad');
    expect(result).toContain('end');
  });

  it('标题被 encode', () => {
    const result = buildExternalPlayerUrl('mxplayer', M3U8, '中文标题');
    expect(result).toContain(`S.title=${encodeURIComponent('中文标题')}`);
  });

  it('无标题时不带 S.title 段', () => {
    const result = buildExternalPlayerUrl('mxplayer', M3U8);
    expect(result).not.toContain('S.title');
    expect(result).toContain('#Intent;package=');
  });

  it('标题里含分号不会破坏 intent 结构', () => {
    const result = buildExternalPlayerUrl('mxplayer', M3U8, 'a;b;c');
    // 分号必须被 encode，否则会被当成 intent 的分隔符
    expect(result).toContain(encodeURIComponent('a;b;c'));
    expect(result!.split('S.title=')[1].split(';end')[0]).not.toContain(';');
  });
});

describe('buildExternalPlayerUrl 参数校验', () => {
  it('空地址返回 null', () => {
    for (const p of EXTERNAL_PLAYERS) {
      expect(buildExternalPlayerUrl(p.id, '')).toBeNull();
    }
  });

  it('纯空白地址返回 null', () => {
    expect(buildExternalPlayerUrl('vlc', '   ')).toBeNull();
  });

  it('地址两端空白被 trim', () => {
    expect(buildExternalPlayerUrl('vlc', `  ${M3U8}  `)).toBe(`vlc://${M3U8}`);
  });

  it('未知播放器返回 null', () => {
    expect(
      buildExternalPlayerUrl('unknown' as ExternalPlayerId, M3U8)
    ).toBeNull();
  });

  it('非字符串地址返回 null', () => {
    expect(buildExternalPlayerUrl('vlc', null as any)).toBeNull();
    expect(buildExternalPlayerUrl('vlc', undefined as any)).toBeNull();
  });
});

describe('buildExternalPlayerUrl 代理地址', () => {
  it('代理地址对 vlc 原样拼接', () => {
    expect(buildExternalPlayerUrl('vlc', PROXY)).toBe(`vlc://${PROXY}`);
  });

  it('代理地址对 iina 双重安全（外层再 encode 一次）', () => {
    const result = buildExternalPlayerUrl('iina', PROXY);
    // PROXY 本身已含 %3A，外层 encode 会把它变成 %253A，这是正确的：
    // 播放器解码一次后拿到的才是原始的 PROXY 串
    expect(result).toContain('%253A');
    expect(decodeURIComponent(result!.split('url=')[1])).toBe(PROXY);
  });
});

describe('isPlayerLikelySupported 平台判断', () => {
  const UA = {
    win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605',
    android: 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Mobile',
  };

  it('桌面系统支持桌面播放器', () => {
    expect(isPlayerLikelySupported('potplayer', UA.win)).toBe(true);
    expect(isPlayerLikelySupported('mpv', UA.mac)).toBe(true);
  });

  it('桌面系统不支持移动播放器', () => {
    expect(isPlayerLikelySupported('mxplayer', UA.win)).toBe(false);
    expect(isPlayerLikelySupported('nplayer', UA.mac)).toBe(false);
  });

  it('移动系统支持移动播放器', () => {
    expect(isPlayerLikelySupported('mxplayer', UA.android)).toBe(true);
    expect(isPlayerLikelySupported('nplayer', UA.iphone)).toBe(true);
  });

  it('移动系统不支持桌面播放器', () => {
    expect(isPlayerLikelySupported('potplayer', UA.android)).toBe(false);
    expect(isPlayerLikelySupported('iina', UA.iphone)).toBe(false);
  });

  it('iPad 被识别为 iOS', () => {
    expect(isPlayerLikelySupported('nplayer', UA.ipad)).toBe(true);
  });

  it('VLC 标注 both，任何平台都支持', () => {
    expect(isPlayerLikelySupported('vlc', UA.win)).toBe(true);
    expect(isPlayerLikelySupported('vlc', UA.android)).toBe(true);
    expect(isPlayerLikelySupported('vlc', UA.iphone)).toBe(true);
  });

  it('空 UA 一律放行（不做误禁）', () => {
    expect(isPlayerLikelySupported('potplayer', '')).toBe(true);
    expect(isPlayerLikelySupported('mxplayer', '')).toBe(true);
  });

  it('未知播放器返回 false', () => {
    expect(isPlayerLikelySupported('unknown' as any, UA.win)).toBe(false);
  });
});
