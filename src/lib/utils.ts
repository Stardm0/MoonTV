/* eslint-disable @typescript-eslint/no-explicit-any,no-console */
import he from 'he';
import Hls from 'hls.js';

function getDoubanImageProxyConfig(): {
  proxyType:
    | 'direct'
    | 'server'
    | 'img3'
    | 'cmliussss-cdn-tencent'
    | 'cmliussss-cdn-ali'
    | 'custom';
  proxyUrl: string;
} {
  const doubanImageProxyType =
    localStorage.getItem('doubanImageProxyType') ||
    (window as any).RUNTIME_CONFIG?.DOUBAN_IMAGE_PROXY_TYPE ||
    'direct';
  const doubanImageProxy =
    localStorage.getItem('doubanImageProxyUrl') ||
    (window as any).RUNTIME_CONFIG?.DOUBAN_IMAGE_PROXY ||
    '';
  return {
    proxyType: doubanImageProxyType,
    proxyUrl: doubanImageProxy,
  };
}

/**
 * 处理图片 URL，如果设置了图片代理则使用代理
 */
export function processImageUrl(originalUrl: string): string {
  if (!originalUrl) return originalUrl;

  const normalizedUrl = originalUrl.trim();

  // 已经是本地代理、内联资源或本地资源时，直接返回
  if (
    normalizedUrl.startsWith('/api/image-proxy?url=') ||
    normalizedUrl.startsWith('data:') ||
    normalizedUrl.startsWith('blob:') ||
    normalizedUrl.startsWith('/')
  ) {
    return normalizedUrl;
  }

  // HTTPS 页面下直接加载 http 图片会触发 Mixed Content，统一走服务端代理兜底
  if (normalizedUrl.startsWith('http://')) {
    return `/api/image-proxy?url=${encodeURIComponent(normalizedUrl)}`;
  }

  // 仅处理豆瓣图片代理
  if (!normalizedUrl.includes('doubanio.com')) {
    return normalizedUrl;
  }

  const { proxyType, proxyUrl } = getDoubanImageProxyConfig();
  switch (proxyType) {
    case 'server':
      return `/api/image-proxy?url=${encodeURIComponent(normalizedUrl)}`;
    case 'img3':
      return normalizedUrl.replace(/img\d+\.doubanio\.com/g, 'img3.doubanio.com');
    case 'cmliussss-cdn-tencent':
      return normalizedUrl.replace(
        /img\d+\.doubanio\.com/g,
        'img.doubanio.cmliussss.net'
      );
    case 'cmliussss-cdn-ali':
      return normalizedUrl.replace(
        /img\d+\.doubanio\.com/g,
        'img.doubanio.cmliussss.com'
      );
    case 'custom':
      return `${proxyUrl}${encodeURIComponent(normalizedUrl)}`;
    case 'direct':
    default:
      return normalizedUrl;
  }
}

/**
 * 从m3u8地址获取视频质量等级和网络信息
 * @param m3u8Url m3u8播放列表的URL
 * @returns Promise<{quality: string, loadSpeed: string, pingTime: number}> 视频质量等级和网络信息
 */
export async function getVideoResolutionFromM3u8(m3u8Url: string): Promise<{
  quality: string; // 如720p、1080p等
  loadSpeed: string; // 自动转换为KB/s或MB/s
  pingTime: number; // 网络延迟（毫秒）
}> {
  try {
    // 直接使用m3u8 URL作为视频源，避免CORS问题
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'metadata';

      // 测量网络延迟（ping时间） - 使用m3u8 URL而不是ts文件
      const pingStart = performance.now();
      let pingTime = 0;

      // 测量ping时间（使用m3u8 URL）
      fetch(m3u8Url, { method: 'HEAD', mode: 'no-cors' })
        .then(() => {
          pingTime = performance.now() - pingStart;
        })
        .catch(() => {
          pingTime = performance.now() - pingStart; // 记录到失败为止的时间
        });

      // 固定使用hls.js加载
      const hls = new Hls();

      // 设置超时处理
      const timeout = setTimeout(() => {
        hls.destroy();
        video.remove();
        reject(new Error('Timeout loading video metadata'));
      }, 4000);

      video.onerror = () => {
        clearTimeout(timeout);
        hls.destroy();
        video.remove();
        reject(new Error('Failed to load video metadata'));
      };

      let actualLoadSpeed = '未知';
      let hasSpeedCalculated = false;
      let hasMetadataLoaded = false;

      let fragmentStartTime = 0;

      // 检查是否可以返回结果
      const checkAndResolve = () => {
        if (
          hasMetadataLoaded &&
          (hasSpeedCalculated || actualLoadSpeed !== '未知')
        ) {
          clearTimeout(timeout);
          const width = video.videoWidth;
          const height = video.videoHeight;
          if ((width && width > 0) || (height && height > 0)) {
            hls.destroy();
            video.remove();

            // 优先按高度判定：采集站大量 1920x800 的裁边片，只看宽度会被
            // 误标成 1080p，实际只有 720p 级别；高度已知时不做宽度兜底，
            // 否则 1280x360 这类矮画幅会被抬成 720p。
            const quality =
              height > 0
                ? height >= 2160
                  ? '4K'
                  : height >= 1440
                  ? '2K'
                  : height >= 1080
                  ? '1080p'
                  : height >= 720
                  ? '720p'
                  : height >= 480
                  ? '480p'
                  : 'SD'
                : width >= 3840
                ? '4K'
                : width >= 2560
                ? '2K'
                : width >= 1920
                ? '1080p'
                : width >= 1280
                ? '720p'
                : width >= 854
                ? '480p'
                : 'SD';

            resolve({
              quality,
              loadSpeed: actualLoadSpeed,
              pingTime: Math.round(pingTime),
            });
          } else {
            // webkit 无法获取尺寸，直接返回
            resolve({
              quality: '未知',
              loadSpeed: actualLoadSpeed,
              pingTime: Math.round(pingTime),
            });
          }
        }
      };

      // 监听片段加载开始
      hls.on(Hls.Events.FRAG_LOADING, () => {
        fragmentStartTime = performance.now();
      });

      // 监听片段加载完成，只需首个分片即可计算速度
      hls.on(Hls.Events.FRAG_LOADED, (event: any, data: any) => {
        if (
          fragmentStartTime > 0 &&
          data &&
          data.payload &&
          !hasSpeedCalculated
        ) {
          const loadTime = performance.now() - fragmentStartTime;
          const size = data.payload.byteLength || 0;

          if (loadTime > 0 && size > 0) {
            const speedKBps = size / 1024 / (loadTime / 1000);

            // 立即计算速度，无需等待更多分片
            const avgSpeedKBps = speedKBps;

            if (avgSpeedKBps >= 1024) {
              actualLoadSpeed = `${(avgSpeedKBps / 1024).toFixed(1)} MB/s`;
            } else {
              actualLoadSpeed = `${avgSpeedKBps.toFixed(1)} KB/s`;
            }
            hasSpeedCalculated = true;
            checkAndResolve(); // 尝试返回结果
          }
        }
      });

      hls.loadSource(m3u8Url);
      hls.attachMedia(video);

      // 监听hls.js错误
      hls.on(Hls.Events.ERROR, (event: any, data: any) => {
        console.error('HLS错误:', data);
        if (data.fatal) {
          clearTimeout(timeout);
          hls.destroy();
          video.remove();
          reject(new Error(`HLS播放失败: ${data.type}`));
        }
      });

      // 监听视频元数据加载完成
      video.onloadedmetadata = () => {
        hasMetadataLoaded = true;
        checkAndResolve(); // 尝试返回结果
      };
    });
  } catch (error) {
    throw new Error(
      `Error getting video resolution: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function cleanHtmlTags(text: string): string {
  if (!text) return '';

  const cleanedText = text
    .replace(/<[^>]+>/g, '\n') // 将 HTML 标签替换为换行
    .replace(/\n+/g, '\n') // 将多个连续换行合并为一个
    .replace(/[ \t]+/g, ' ') // 将多个连续空格和制表符合并为一个空格，但保留换行符
    .replace(/^\n+|\n+$/g, '') // 去掉首尾换行
    .trim(); // 去掉首尾空格

  // 使用 he 库解码 HTML 实体
  return he.decode(cleanedText);
}

/**
 * 获取配置的超时时间（秒）
 * 从 localStorage 读取，如果不存在或无效则返回默认值3秒
 */
export function getRequestTimeout(): number {
  if (typeof window === 'undefined') {
    return 30; // 服务器端返回默认值
  }
  
  try {
    const savedTimeout = localStorage.getItem('requestTimeout');
    if (savedTimeout) {
      const timeoutSeconds = parseInt(savedTimeout, 10);
      if (!isNaN(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 60) {
        return timeoutSeconds;
      }
    }
  } catch (error) {
    console.warn('Failed to read timeout from localStorage:', error);
  }
  
  return 30; // 默认30秒
}
