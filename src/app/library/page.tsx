import { Suspense } from 'react';

import OpenListBrowser from '@/components/OpenListBrowser';

/**
 * 私人影库（OpenList / AList / 小雅同族）浏览页。
 *
 * 与 /douban、/search 一样给侧边栏让位（`moontv-sidenav-content` +
 * Tailwind 任意值 padding；globals.css 里手写 padding 会被 utilities 覆盖）。
 */
export default function LibraryPage() {
  return (
    <div className='moontv-sidenav-content px-4 py-4 sm:px-10 sm:py-8'>
      <Suspense
        fallback={
          <p className='py-10 text-center text-sm text-gray-500 dark:text-gray-400'>
            正在加载影库…
          </p>
        }
      >
        <OpenListBrowser />
      </Suspense>
    </div>
  );
}
