'use client';

import {
  type LucideIcon,
  Boxes,
  Cloud,
  CloudCog,
  CloudDownload,
  CloudLightning,
  FolderOpen,
  Globe,
  HardDrive,
  Server,
  Sparkles,
  Zap,
} from 'lucide-react';

import type {
  OpenListDriveIcon,
  OpenListDriveTone,
} from '@/lib/openlist';

/**
 * 网盘图标 / 配色的具体映射。
 *
 * ## 为什么不放进 `src/lib/openlist.ts`
 *
 * Tailwind 的 `content` 只扫 `src/components`、`src/app`、`src/pages`，
 * 不扫 `src/lib` —— 类名写在 lib 里 JIT 收不到，线上会掉样式。
 * 所以 lib 那只留抽象的 icon / tone key，真正的图标组件与类名映射放这里。
 *
 * ## 图标选择
 *
 * 各家网盘没有官方 lucide 图标，用「云 + 特征」的组合做区分：
 * 云=通用、闪电=天翼、下载=迅雷、齿轮云=OneDrive、盒子=PikPak、
 * 文件夹=本地、闪星=小雅。认不出的一律落到通用云，不会空白。
 */
const DRIVE_ICONS: Record<OpenListDriveIcon, LucideIcon> = {
  aliyun: Cloud,
  baidu: Globe,
  quark: Zap,
  tianyi: CloudLightning,
  xunlei: CloudDownload,
  drive115: HardDrive,
  onedrive: CloudCog,
  pikpak: Boxes,
  xiaoya: Sparkles,
  webdav: Server,
  local: FolderOpen,
  cloud: Cloud,
};

/** 图标色（亮/暗色都看得清的中亮度色阶） */
const TONE_TEXT: Record<OpenListDriveTone, string> = {
  sky: 'text-sky-500',
  indigo: 'text-indigo-500',
  cyan: 'text-cyan-500',
  orange: 'text-orange-500',
  amber: 'text-amber-500',
  blue: 'text-blue-500',
  purple: 'text-purple-500',
  teal: 'text-teal-500',
  slate: 'text-slate-500',
  emerald: 'text-emerald-500',
  gray: 'text-gray-400',
};

/** 图标底色（同色系 10% 透明，选中/悬停时用来托住图标） */
const TONE_BG: Record<OpenListDriveTone, string> = {
  sky: 'bg-sky-500/10',
  indigo: 'bg-indigo-500/10',
  cyan: 'bg-cyan-500/10',
  orange: 'bg-orange-500/10',
  amber: 'bg-amber-500/10',
  blue: 'bg-blue-500/10',
  purple: 'bg-purple-500/10',
  teal: 'bg-teal-500/10',
  slate: 'bg-slate-500/10',
  emerald: 'bg-emerald-500/10',
  gray: 'bg-gray-500/10',
};

export interface DriveIconProps {
  icon: OpenListDriveIcon;
  tone: OpenListDriveTone;
  /** 图标尺寸（Tailwind h-/w- 组合，如 `h-5 w-5`） */
  className?: string;
  /** 是否套一层同色系底色 */
  withBackground?: boolean;
}

export const DriveIcon = ({
  icon,
  tone,
  className = 'h-5 w-5',
  withBackground = false,
}: DriveIconProps) => {
  const Icon = DRIVE_ICONS[icon] ?? Cloud;
  return (
    <span
      className={`flex flex-shrink-0 items-center justify-center ${
        withBackground ? `rounded-lg p-1.5 ${TONE_BG[tone]}` : ''
      }`}
    >
      <Icon className={`${className} ${TONE_TEXT[tone]}`} />
    </span>
  );
};
