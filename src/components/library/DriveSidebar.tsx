'use client';

import { Layers } from 'lucide-react';

import type { OpenListItem } from '@/lib/openlist';
import { resolveDriveVisual } from '@/lib/openlist';

import { DriveIcon } from './driveVisuals';

/**
 * 影库左侧的网盘列。
 *
 * 挂载的网盘 = 浏览根路径下的顶层目录（小雅 / 阿里云盘 / 115 …）。
 * 选中某个网盘 = 把右侧内容切到那个目录；选「全部」回到根路径。
 *
 * ## 为什么常驻左侧而不是只在根目录显示
 *
 * 进到深层目录后想换网盘是最常见的动作，把它藏起来就得先退回根目录。
 * 所以这一列在各种层级都在，且**不随目录变化重排**。
 */
export interface DriveSidebarProps {
  /** 根路径下的目录项（即挂载的网盘） */
  drives: OpenListItem[];
  /** 当前所在网盘名，空串 = 根目录（「全部」） */
  currentDrive: string;
  onSelect: (driveName: string) => void;
}

const ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors';

const DriveSidebar = ({
  drives,
  currentDrive,
  onSelect,
}: DriveSidebarProps) => (
  <aside className='hidden w-44 flex-shrink-0 md:block lg:w-52'>
    <div className='rounded-xl border border-gray-200/70 bg-white/60 p-1.5 dark:border-gray-700/60 dark:bg-gray-900/40'>
      <h2 className='px-2 pb-1 pt-1 text-xs font-semibold text-gray-500 dark:text-gray-400'>
        网盘
      </h2>
      <ul className='space-y-0.5'>
        <li>
          <button
            type='button'
            onClick={() => onSelect('')}
            className={`${ITEM_CLASS} ${
              currentDrive === ''
                ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                : 'text-gray-600 hover:bg-gray-100/70 dark:text-gray-300 dark:hover:bg-gray-800/70'
            }`}
            title='全部文件（影库根目录）'
          >
            <Layers className='h-5 w-5 flex-shrink-0' />
            <span className='truncate'>全部</span>
          </button>
        </li>
        {drives.map((drive) => {
          const visual = resolveDriveVisual(drive.name);
          const active = currentDrive === drive.name;
          return (
            <li key={drive.name}>
              <button
                type='button'
                onClick={() => onSelect(drive.name)}
                className={`${ITEM_CLASS} ${
                  active
                    ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                    : 'text-gray-600 hover:bg-gray-100/70 dark:text-gray-300 dark:hover:bg-gray-800/70'
                }`}
                title={drive.name}
              >
                <DriveIcon
                  icon={visual.icon}
                  tone={visual.tone}
                  className='h-5 w-5'
                />
                <span className='truncate'>{drive.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  </aside>
);

export default DriveSidebar;
