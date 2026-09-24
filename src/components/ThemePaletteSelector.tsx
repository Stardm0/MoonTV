/* eslint-disable react-hooks/exhaustive-deps */

'use client';

import { Check, ChevronDown, Palette, RotateCcw } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import {
  applyThemePalette,
  DEFAULT_THEME_PALETTE,
  getAllPalettePreviews,
  loadThemePalette,
  paletteClassName,
  rgbTripletToCss,
  saveThemePalette,
  THEME_PALETTE_GROUPS,
  THEME_PALETTE_LABELS,
  THEME_PALETTE_SHADES,
  ThemePalette,
} from '@/lib/theme-palette';

/** 色卡主色带取哪几档。取 400/500/600 三档，主色最直观。 */
const PRIMARY_SWATCH_SHADES = [400, 500, 600];

/**
 * 第二层主题（主色）选择器。
 *
 * 只负责"选一套色阶"，不负责暗色/浅色切换 —— 后者由 `next-themes` 的
 * `ThemeToggle` 管。两者正交：主色是色相，明暗是亮度。
 *
 * 交互取舍：
 * - **默认折叠**。设置面板里已有十几个开关，22 个色卡常驻会把面板拉得很长。
 *   折叠后只占一行，点开展示；已选中的色卡在折叠态也能看到色带。
 * - **展开后分组**（中性 / 暖色 / 冷色）。分组让每组只有 4~5 行，
 *   配合 `max-h-64` 滚动可整块塞进一屏。
 */
const ThemePaletteSelector: React.FC = () => {
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [current, setCurrent] = useState<ThemePalette>(DEFAULT_THEME_PALETTE);
  const [previews, setPreviews] = useState<Record<string, string[]>>({});

  useEffect(() => {
    setMounted(true);
    setCurrent(loadThemePalette());
    setPreviews(getAllPalettePreviews());
  }, []);

  const handleSelect = (palette: ThemePalette) => {
    setCurrent(palette);
    applyThemePalette(palette);
    saveThemePalette(palette);
  };

  const handleReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleSelect(DEFAULT_THEME_PALETTE);
  };

  /** 取某套色阶在指定档位上的 CSS 颜色 */
  const shadeColor = (palette: ThemePalette, shade: number): string => {
    const shades = previews[palette];
    if (!shades || shades.length === 0) return 'transparent';
    const index = (THEME_PALETTE_SHADES as readonly number[]).indexOf(shade);
    return index >= 0 ? rgbTripletToCss(shades[index], 'transparent') : 'transparent';
  };

  /** 三档色带，用于折叠态摘要与色卡左侧 */
  const renderStrip = (palette: ThemePalette, width: string) => (
    <span className='flex flex-shrink-0 rounded overflow-hidden'>
      {PRIMARY_SWATCH_SHADES.map((shade) => (
        <span
          key={shade}
          className={`${width} h-5`}
          style={{ backgroundColor: shadeColor(palette, shade) }}
        />
      ))}
    </span>
  );

  const groups = useMemo(
    () =>
      THEME_PALETTE_GROUPS.map((group) => ({
        ...group,
        palettes: group.palettes,
      })),
    []
  );

  if (!mounted) {
    // 与 SSR 保持一致：主色存在 localStorage 里，首帧读不到。
    return <div className='h-10' />;
  }

  return (
    <div className='space-y-2'>
      {/* 折叠头：一行搞定，右侧直接显示当前色，不用展开也知道选了什么 */}
      <button
        type='button'
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className='w-full flex items-center gap-2 text-left group'
      >
        <Palette className='w-4 h-4 flex-shrink-0 text-gray-600 dark:text-gray-400' />
        <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
          主题配色
        </span>
        {renderStrip(current, 'w-3')}
        <span className='text-xs text-gray-500 dark:text-gray-400 truncate'>
          {THEME_PALETTE_LABELS[current]}
        </span>
        <ChevronDown
          className={`w-4 h-4 flex-shrink-0 ml-auto text-gray-400 transition-transform ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {expanded && (
        <div className='space-y-3 pl-6'>
          <div className='flex items-center justify-between gap-3'>
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              影响按钮、链接、选中态与页面背景
            </p>
            {current !== DEFAULT_THEME_PALETTE && (
              <button
                type='button'
                onClick={handleReset}
                className='flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 rounded transition-colors flex-shrink-0'
                title='恢复默认配色'
              >
                <RotateCcw className='w-3 h-3' />
                默认
              </button>
            )}
          </div>

          {/* 分组展示 + 限高滚动，避免 22 个色卡把面板拉出好几屏 */}
          <div className='max-h-64 overflow-y-auto pr-1 space-y-3'>
            {groups.map((group) => (
              <div key={group.id}>
                <div className='text-[11px] text-gray-400 dark:text-gray-500 mb-1.5'>
                  {group.label}
                </div>
                <div className='grid grid-cols-2 sm:grid-cols-3 gap-1.5'>
                  {group.palettes.map((palette) => {
                    const isActive = current === palette;
                    return (
                      <button
                        key={palette}
                        type='button'
                        onClick={() => handleSelect(palette)}
                        title={`使用「${THEME_PALETTE_LABELS[palette]}」配色`}
                        aria-pressed={isActive}
                        className={`flex items-center gap-1.5 px-1.5 py-1 rounded-md border transition-all ${
                          isActive
                            ? 'border-gray-400 dark:border-gray-500 ring-1 ring-gray-300 dark:ring-gray-600 bg-gray-50 dark:bg-gray-800'
                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                        }`}
                      >
                        {renderStrip(palette, 'w-2')}
                        <span
                          className={`text-xs truncate ${
                            isActive
                              ? 'text-gray-900 dark:text-gray-100 font-medium'
                              : 'text-gray-600 dark:text-gray-400'
                          }`}
                        >
                          {THEME_PALETTE_LABELS[palette]}
                        </span>
                        {isActive && (
                          <Check className='w-3 h-3 flex-shrink-0 ml-auto text-gray-700 dark:text-gray-300' />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/** 供测试用：确认组件依赖的类名与 CSS 真源一致 */
export const __paletteClassNameForTest = paletteClassName;

export default ThemePaletteSelector;
