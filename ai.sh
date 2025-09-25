#!/bin/bash
set -e

# --------------------------
# Cloudflare Pages 部署脚本
# --------------------------

BUILD_DIR=".vercel/output"

echo "请选择操作："
echo "1) 更新部署（安装依赖 + 构建 + 生成 + 部署）"
echo "2) 重试部署（只执行部署）"
read -p "输入选项 (1/2): " OPTION

read -p "请输入 Cloudflare Pages 项目名称: " PROJECT_NAME

if [ "$OPTION" == "1" ]; then
  echo "🚀 开始【更新部署】Cloudflare Pages 项目: $PROJECT_NAME"

  # 1. 安装依赖
  echo "📦 安装依赖..."
  pnpm install

  # 2. 构建 Next.js
  echo "🔨 构建 Next.js 项目..."
  pnpm build

  # 3. 使用 next-on-pages 生成 Cloudflare Pages 格式
  echo "⚡️ 生成 Cloudflare Pages 输出目录..."
  pnpm dlx @cloudflare/next-on-pages

  # 4. 检查 wrangler.toml 是否存在，不存在就生成一个
  if [ ! -f "wrangler.toml" ]; then
    echo "📝 生成 wrangler.toml..."
    cat > wrangler.toml <<EOL
name = "$PROJECT_NAME"
main = "$BUILD_DIR/static/_worker.js/index.js"
compatibility_date = "$(date +%Y-%m-%d)"

[site]
bucket = "$BUILD_DIR/static"
EOL
  fi

  # 5. 部署
  echo "🌍 部署到 Cloudflare Pages..."
  npx wrangler pages deploy "$BUILD_DIR/static" --project-name="$PROJECT_NAME"

  echo "✅ 更新部署完成！"

elif [ "$OPTION" == "2" ]; then
  echo "🔄 开始【重试部署】Cloudflare Pages 项目: $PROJECT_NAME"

  # 只执行部署
  npx wrangler pages deploy "$BUILD_DIR/static" --project-name="$PROJECT_NAME"

  echo "✅ 重试部署完成！"

else
  echo "❌ 无效选项，请输入 1 或 2"
  exit 1
fi
