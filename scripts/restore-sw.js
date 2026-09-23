/* eslint-disable no-console */

/**
 * 构建后还原 StreamSaver 的 Service Worker（P2-12）。
 *
 * ## 背景
 *
 * `next-pwa` 在 `NODE_ENV=production` 且非云平台时会启用，并把生成的
 * workbox SW 写到 `public/sw.js`——**直接覆盖项目自带的 StreamSaver SW**。
 *
 * 而 `ServiceWorkerRegistration.tsx` 注册的正是 `/sw.js`，它期待的是
 * StreamSaver 的消息协议（`postMessage` + `event.ports[0]`）。被换成
 * workbox SW 之后，`fetch('/sw.js', {method:'HEAD'})` 依然返回 200，
 * 注册"成功"，但边下边存（`AddDownloadModal` 的流式下载）会**静默失效**。
 *
 * 之前一直靠人工在构建后 `cp` 回去，Docker 构建路径上则完全没人处理
 * （`COPY --from=builder /app/public`），所以自托管部署的下载功能是坏的。
 *
 * ## 本脚本做的事
 *
 * 1. 用 `scripts/assets/streamsaver-sw.js` 覆盖 `public/sw.js`
 * 2. 清掉 next-pwa 的产物：`workbox-*.js`、`sw.js.map`、`worker-*.js`
 *
 * 于是 `pnpm build` 结束后的工作区是干净的，`git status` 不会出现噪声，
 * Docker 镜像里也是正确的 SW。
 *
 * > `scripts/assets/streamsaver-sw.js` 是**唯一真源**。要升级 StreamSaver
 * > 的 SW，改那个文件；`public/sw.js` 会在每次 `pnpm build` 后从它重建
 * > （`public/sw.js` 仍然入库，因为 Cloudflare / Vercel 构建不走 next-pwa）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, 'scripts', 'assets', 'streamsaver-sw.js');
const TARGET = path.join(ROOT, 'public', 'sw.js');
const PUBLIC_DIR = path.join(ROOT, 'public');

/** next-pwa 会写到 public/ 的产物，全部按文件名前缀清理 */
const GENERATED_PREFIXES = ['workbox-', 'worker-'];
const GENERATED_EXACT = ['sw.js.map'];

function removeGeneratedArtifacts() {
  let removed = 0;
  let entries = [];

  try {
    entries = fs.readdirSync(PUBLIC_DIR);
  } catch {
    return removed;
  }

  for (const name of entries) {
    const isGenerated =
      GENERATED_EXACT.includes(name) ||
      GENERATED_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (!isGenerated) continue;

    try {
      fs.rmSync(path.join(PUBLIC_DIR, name), { force: true });
      removed += 1;
    } catch (error) {
      console.warn(`⚠️  无法删除 ${name}: ${error.message}`);
    }
  }

  return removed;
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`❌ 找不到原始 Service Worker: ${SOURCE}`);
    process.exit(1);
  }

  const pristine = fs.readFileSync(SOURCE);

  // 内容一致时跳过写入，避免污染文件的 mtime（Next.js 的增量构建会看它）
  let alreadyCorrect = false;
  try {
    alreadyCorrect = fs.readFileSync(TARGET).equals(pristine);
  } catch {
    alreadyCorrect = false;
  }

  if (alreadyCorrect) {
    console.log('✅ public/sw.js 未被 next-pwa 覆盖，无需还原');
  } else {
    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    fs.writeFileSync(TARGET, pristine);
    console.log('✅ 已还原 public/sw.js（StreamSaver）');
  }

  const removed = removeGeneratedArtifacts();
  if (removed > 0) {
    console.log(`🧹 已清理 ${removed} 个 next-pwa 产物`);
  }
}

main();
