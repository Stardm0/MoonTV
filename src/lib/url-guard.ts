/**
 * 外部媒体地址安全校验。
 *
 * `/api/m3u8` 是一个把用户传入的 URL 直接回源的代理接口，若不校验就等于开放
 * SSRF 通道（`?url=http://169.254.169.254/...` 可直取云元数据）。这里做三层防护：
 *
 *  1. 协议白名单：仅允许 http / https
 *  2. 内网网段黑名单：loopback / 私有段 / 链路本地 / 云元数据地址
 *  3. 可选主机白名单：通过环境变量 `M3U8_PROXY_ALLOW_HOSTS` 配置（逗号分隔，
 *     支持 `*.example.com` 通配）。未配置时不做主机限制，保持向后兼容。
 *
 * 纯函数、无运行时依赖，可用于 edge runtime。
 */

/** loopback / 私有 / 链路本地 / 保留网段 */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./, // 含 169.254.169.254 云元数据地址
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 运营商级 NAT (100.64/10)
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^\[::1\]$/,
];

/** 十进制 / 十六进制混淆写法（如 2130706433 表示 127.0.0.1） */
function isDecimalIpv4(hostname: string): boolean {
  return /^\d{1,10}$/.test(hostname);
}

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  if (isDecimalIpv4(host)) return true;
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function readAllowHosts(): string[] {
  const raw =
    typeof process !== 'undefined'
      ? process.env?.M3U8_PROXY_ALLOW_HOSTS || ''
      : '';
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function matchesAllowList(hostname: string, allowHosts: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowHosts.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // 保留前导点，避免 evil-example.com 误判
      return host.endsWith(suffix);
    }
    return host === pattern;
  });
}

export interface UrlGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * 校验一个待代理的媒体地址是否允许访问。
 *
 * @param raw 用户传入的原始地址
 * @param extraAllowHosts 额外允许的主机（如从站点配置读取的源站域名）
 */
export function validateMediaUrl(
  raw: unknown,
  extraAllowHosts?: Iterable<string>
): UrlGuardResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: '缺少 URL 参数' };
  }
  if (raw.length > 4096) {
    return { ok: false, reason: 'URL 过长' };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL 格式非法' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '仅支持 http/https 协议' };
  }

  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, reason: '不允许访问该地址' };
  }

  const allowHosts = readAllowHosts();
  const extra = extraAllowHosts ? Array.from(extraAllowHosts) : [];
  const effectiveAllow = allowHosts.concat(
    extra.map((item) => item.trim().toLowerCase()).filter(Boolean)
  );

  if (effectiveAllow.length > 0 && !matchesAllowList(parsed.hostname, effectiveAllow)) {
    return { ok: false, reason: '该域名不在允许列表中' };
  }

  return { ok: true };
}
