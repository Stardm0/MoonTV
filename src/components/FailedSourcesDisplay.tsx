import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface FailedSource {
  name: string;
  key: string;
  error: string;
}

interface FailedSourcesDisplayProps {
  failedSources: FailedSource[];
}

export default function FailedSourcesDisplay({
  failedSources,
}: FailedSourcesDisplayProps) {
  const [showDetails, setShowDetails] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 错误颜色映射
  const getErrorColor = (error: string) => {
    switch (error) {
      case '结果被过滤':
        return 'text-green-600 dark:text-green-400';
      case '无搜索结果':
        return 'text-red-600 dark:text-red-400';
      case '请求超时':
        return 'text-orange-600 dark:text-orange-400';
      case '请求失败':
      case '网络错误':
        return 'text-purple-600 dark:text-purple-400';
      case '未知的错误':
        return 'text-gray-600 dark:text-gray-400';
      default:
        return 'text-amber-700 dark:text-amber-300';
    }
  };

  // 点击外部关闭详情
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setShowDetails(false);
      }
    };

    if (showDetails) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showDetails]);

  if (failedSources.length === 0) return null;

  return (
    <div className='relative' ref={containerRef}>
      <button
        className='flex items-center gap-2 hover:bg-amber-50 dark:hover:bg-amber-900/20 px-2 py-1 rounded transition-colors'
        onClick={() => setShowDetails(!showDetails)}
      >
        <AlertTriangle className='w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0' />
        <span className='text-sm text-amber-700 dark:text-amber-300 whitespace-nowrap'>
          失败源 ({failedSources.length})
        </span>
        {showDetails ? (
          <ChevronUp className='w-3 h-3 text-amber-600 dark:text-amber-400' />
        ) : (
          <ChevronDown className='w-3 h-3 text-amber-600 dark:text-amber-400' />
        )}
      </button>

      {showDetails && (
        <div className='absolute top-full left-1/2 transform -translate-x-1/2 mt-2 z-10 min-w-[190px] max-w-[300px] bg-white dark:bg-gray-800 border border-amber-200 dark:border-amber-700/30 rounded-lg shadow-lg p-4'>
          <h3 className='text-sm font-medium text-amber-800 dark:text-amber-200 mb-3'>
            搜索失败的数据源详情
          </h3>
          <div className='space-y-2 max-h-60 overflow-y-auto'>
            {failedSources.map((source, index) => (
              <div
                key={`${source.key}-${index}`}
                className='p-3 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-100 dark:border-amber-800/30'
              >
                <div className='flex items-center gap-2 mb-1'>
                  <span className='font-medium text-amber-800 dark:text-amber-200 text-sm'>
                    {source.name}
                  </span>
                  <span className='text-xs text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-800/50 px-2 py-0.5 rounded'>
                    {source.key}
                  </span>
                </div>
                <p
                  className={`text-xs break-words ${getErrorColor(
                    source.error
                  )}`}
                >
                  错误信息: {source.error}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
