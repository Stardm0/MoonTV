/* eslint-disable react-hooks/exhaustive-deps */

'use client';

import { Check, Palette, RotateCcw } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import {
  applyThemePalette,
  DEFAULT_THEME_PALETTE,
  getAllPalettePreviews,
  loadThemePalette,
  rgbTripletToCss,
  saveThemePalette,
  THEME_PALETTE_LABELS,
  THEME_PALETTES,
  ThemePalette,
} from '@/lib/theme-palette';

const SHADES_FOR_SWATCH = [100, 300, 500, 700, 900];

/**
 * 第二层主题（主色）选择器。
 *
 * 只负责"选一套色阶"，不负责暗色/浅色切换 —— 后者由 `next-themes` 的
 * `ThemeToggle` 管。两者正交：主色是色相，明暗是亮度。
 */
const ThemePaletteSelector: React.FC = () => {
  const [mounted, setMounted] = useState(false);
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

  const handleReset = () => {
    handleSelect(DEFAULT_THEME_PALETTE);
  };

  if (!mounted) {
    // 与 SSR 保持一致：主色存在 localStorage 里，首帧读不到。
    return <div className='h-40' />;
  }

  return (
    <div className='space-y-3'>
      <div className='flex items-start justify-between gap-3'>
        <div>
          <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5'>
            <Palette className='w-4 h-4' />
            主题配色
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            选择一套主色，影响按钮、链接、选中态与页面背景
          </p>
        </div>
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

      <div className='grid grid-cols-2 sm:grid-cols-3 gap-2'>
        {THEME_PALETTES.map((palette) => {
          const shades = previews[palette] || [];
          const isActive = current === palette;
          return (
            <button
              key={palette}
              type='button'
              onClick={() => handleSelect(palette)}
              className={`group relative flex items-center gap-2 p-2 rounded-lg border transition-all ${
                isActive
                  ? 'border-gray-400 dark:border-gray-500 ring-1 ring-gray-300 dark:ring-gray-600 bg-gray-50 dark:bg-gray-800'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800/50'
              }`}
              title={`使用「${THEME_PALETTE_LABELS[palette]}」配色`}
            >
              {/* 色带：取 100/300/500/700/900 五档，一眼能看出整体明暗走向 */}
              <span className='flex flex-shrink-0 rounded overflow-hidden'>
                {SHADES_FOR_SWATCH.map((shade) => {
                  const index = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].indexOf(shade);
                  return (
                    <span
                      key={shade}
                      className='w-2 h-6'
                      style={{
                        backgroundColor: rgbTripletToCss(
                          shades[index] || '',
                          '#d1d5db'
                        ),
                      }}
                    />
                  );
                })}
              </span>
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
                <Check className='w-3.5 h-3.5 text-gray-700 dark:text-gray-300 flex-shrink-0 ml-auto' />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ThemePaletteSelector;
