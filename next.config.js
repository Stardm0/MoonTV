/** @type {import('next').NextConfig} */
/* eslint-disable @typescript-eslint/no-var-requires */

const nextConfig = {
  output: 'standalone',
  eslint: {
    dirs: ['src'],
    ignoreDuringBuilds: true,
  },

  reactStrictMode: false,
  swcMinify: true,

  // Uncoment to add domain whitelist
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },

  webpack(config) {
    // Grab the existing rule that handles SVG imports
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg')
    );

    config.module.rules.push(
      // Reapply the existing rule, but only for svg imports ending in ?url
      {
        ...fileLoaderRule,
        test: /\.svg$/i,
        resourceQuery: /url/, // *.svg?url
      },
      // Convert all other *.svg imports to React components
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ }, // exclude if *.svg?url
        loader: '@svgr/webpack',
        options: {
          dimensions: false,
          titleProp: true,
        },
      }
    );

    // Modify the file loader rule to ignore *.svg, since we have it handled now.
    fileLoaderRule.exclude = /\.svg$/i;

    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };

    return config;
  },
};

// Setup Cloudflare Pages development platform in development mode
if (process.env.NODE_ENV === 'development') {
  const { setupDevPlatform } = require('@cloudflare/next-on-pages/next-dev');
  setupDevPlatform();
}

// 检测是否为云平台构建
const isCloudflarePages = process.env.CF_PAGES === '1' || 
  process.env.CLOUDFLARE_PAGES === '1' ||
  process.argv.includes('pages:build');

const isVercel = process.env.VERCEL === '1';
const isNetlify = process.env.NETLIFY === 'true';

// Dockerfile 在构建阶段显式设置了 DOCKER_ENV=true
const isDockerBuild = process.env.DOCKER_ENV === 'true';

/**
 * 在所有云平台 / Docker 构建里禁用 next-pwa。
 *
 * next-pwa 生成的 workbox SW 会**覆盖** `public/sw.js`，而项目自带的
 * StreamSaver SW 用的正是这个路径（`ServiceWorkerRegistration.tsx` 注册
 * 的就是 `/sw.js`）。被覆盖后 HEAD 检查依然 200、注册"成功"，但
 * `AddDownloadModal` 的边下边存会静默失效——Docker 镜像是
 * `COPY --from=builder /app/public`，所以自托管部署的下载功能一直是坏的。
 *
 * 本地 `next build` 仍会走 next-pwa，由 `postbuild: scripts/restore-sw.js`
 * 自动还原，无需人工 cp。
 */
const isCloudPlatform = isCloudflarePages || isVercel || isNetlify || isDockerBuild;

const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development' || isCloudPlatform,
  register: true,
  skipWaiting: true,
});

module.exports = withPWA(nextConfig);
