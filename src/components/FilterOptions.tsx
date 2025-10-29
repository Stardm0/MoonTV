import { ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react';
import React, { useState } from 'react';

interface FilterOptionsProps {
  openFilter: string | null;
  setOpenFilter: React.Dispatch<React.SetStateAction<string | null>>;

  // 来源
  sourceOptions: string[];
  filterSources: string[];
  setFilterSources: (opts: string[]) => void;

  // 标题
  titleOptions: string[];
  selectedTitles: string[];
  setSelectedTitles: (opts: string[]) => void;

  // 年份
  yearOptions: string[];
  selectedYears: string[];
  setSelectedYears: (opts: string[]) => void;

  // 排序
  sortField: 'year' | 'sources' | 'episodes';
  onSortFieldChange: (field: 'year' | 'title' | 'source' | 'episodes') => void;
  sortOrder: 'asc' | 'desc';
  onSortOrderChange: (order: 'asc' | 'desc') => void;
  sortOptions: { value: string; label: string }[];
}

const FilterOptions: React.FC<FilterOptionsProps> = ({
  openFilter,
  setOpenFilter,
  sourceOptions,
  filterSources,
  setFilterSources,
  titleOptions,
  selectedTitles,
  setSelectedTitles,
  yearOptions,
  selectedYears,
  setSelectedYears,
  sortField,
  onSortFieldChange,
  sortOrder,
  onSortOrderChange,
  sortOptions,
}) => {
  const [collapsed, setCollapsed] = useState(true);
  const [activeTab, setActiveTab] = useState<'筛选' | '排序'>('筛选');

  const filterButtons = [
    { key: '来源', label: '来源' },
    { key: '标题', label: '标题' },
    { key: '年份', label: '年份' },
  ];

  const handleButtonClick = (key: string) => {
    setOpenFilter(openFilter === key ? null : key);
  };

  const handleOptionClick = (category: string, option: string) => {
    if (category === '来源') {
      setFilterSources(
        filterSources.includes(option)
          ? filterSources.filter((o) => o !== option)
          : [...filterSources, option]
      );
    } else if (category === '标题') {
      setSelectedTitles(
        selectedTitles.includes(option)
          ? selectedTitles.filter((o) => o !== option)
          : [...selectedTitles, option]
      );
    } else if (category === '年份') {
      setSelectedYears(
        selectedYears.includes(option)
          ? selectedYears.filter((o) => o !== option)
          : [...selectedYears, option]
      );
    }
  };

  const clearAllFilters = () => {
    setFilterSources([]);
    setSelectedTitles([]);
    setSelectedYears([]);
  };

  const renderFilterOptions = () => {
    if (collapsed) {
      if (
        !filterSources.length &&
        !selectedTitles.length &&
        !selectedYears.length
      ) {
        return <div className='text-gray-400'>请展开选择筛选条件</div>;
      }
      return (
        <div className='space-y-2 text-sm text-gray-500 dark:text-gray-400'>
          {filterSources.length > 0 && (
            <div>已选来源: {filterSources.join('、')}</div>
          )}
          {selectedTitles.length > 0 && (
            <div>已选标题: {selectedTitles.join('、')}</div>
          )}
          {selectedYears.length > 0 && (
            <div>已选年份: {selectedYears.join('、')}</div>
          )}
        </div>
      );
    }

    if (!openFilter) {
      return <div className='text-gray-400'>请选择一个筛选分类</div>;
    }

    switch (openFilter) {
      case '来源':
        return (
          <div className='grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4'>
            {sourceOptions.map((opt) => (
              <button
                key={opt}
                onClick={() => handleOptionClick('来源', opt)}
                className={`px-3 py-2 text-sm rounded-lg border transition-all duration-200 ${
                  filterSources.includes(opt)
                    ? 'bg-green-100 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-700'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100/80 dark:hover:bg-gray-700/80 border-transparent'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        );
      case '标题':
        return (
          <div className='grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4'>
            {titleOptions.map((opt) => (
              <button
                key={opt}
                onClick={() => handleOptionClick('标题', opt)}
                className={`px-3 py-2 text-sm rounded-lg border transition-all duration-200 ${
                  selectedTitles.includes(opt)
                    ? 'bg-green-100 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-700'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100/80 dark:hover:bg-gray-700/80 border-transparent'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        );
      case '年份':
        return (
          <div className='grid gap-2 grid-cols-3 sm:grid-cols-4 md:grid-cols-6'>
            {yearOptions.map((opt) => (
              <button
                key={opt}
                onClick={() => handleOptionClick('年份', opt)}
                className={`px-3 py-2 text-sm rounded-lg border transition-all duration-200 ${
                  selectedYears.includes(opt)
                    ? 'bg-green-100 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-700'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100/80 dark:hover:bg-gray-700/80 border-transparent'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        );
      default:
        return null;
    }
  };

  const renderSortOptions = () => (
    <div className='flex flex-wrap gap-2 items-center'>
      {sortOptions.map((opt) => (
        <button
          key={opt.value}
          onClick={() =>
            onSortFieldChange(
              opt.value as 'year' | 'title' | 'source' | 'episodes'
            )
          }
          className={`px-3 py-2 text-sm rounded-lg border transition-all duration-200 ${
            sortField === opt.value
              ? 'bg-green-100 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-700'
              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100/80 dark:hover:bg-gray-700/80 border-gray-300 dark:border-gray-600'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className='flex w-full border rounded-lg overflow-hidden shadow-sm dark:border-gray-700 flex-col'>
      {/* Tab 栏 + 排序按钮 */}
      <div className='flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800'>
        <div className='flex gap-4'>
          <button
            className={`px-3 py-1 font-semibold rounded ${
              activeTab === '筛选'
                ? 'bg-green-500 text-white'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
            onClick={() => setActiveTab('筛选')}
          >
            筛选
          </button>
          <button
            className={`px-3 py-1 font-semibold rounded ${
              activeTab === '排序'
                ? 'bg-green-500 text-white'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
            onClick={() => setActiveTab('排序')}
          >
            排序
          </button>
        </div>
        <div className='flex items-center gap-2'>
          {activeTab === '筛选' && (
            <>
              <button
                onClick={clearAllFilters}
                className='text-sm text-blue-600 hover:underline dark:text-blue-400'
              >
                清空筛选
              </button>
              <button
                onClick={() => setCollapsed(!collapsed)}
                className='p-1 border rounded hover:bg-gray-200 dark:hover:bg-gray-700'
              >
                {collapsed ? (
                  <ChevronDown className='w-4 h-4' />
                ) : (
                  <ChevronUp className='w-4 h-4' />
                )}
              </button>
            </>
          )}

          {activeTab === '排序' && (
            <button
              onClick={() =>
                onSortOrderChange(sortOrder === 'asc' ? 'desc' : 'asc')
              }
              className='px-3 py-2 text-sm flex items-center gap-1 border rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700'
            >
              <ArrowUpDown className='w-4 h-4' />
              {sortOrder === 'asc' ? '升序' : '降序'}
            </button>
          )}
        </div>
      </div>

      <div className='flex w-full'>
        {/* 左侧筛选分类按钮 */}
        {activeTab === '筛选' && !collapsed && (
          <div className='w-28 bg-gray-100 dark:bg-gray-800 flex flex-col'>
            {filterButtons.map((btn) => (
              <button
                key={btn.key}
                onClick={() => handleButtonClick(btn.key)}
                className={`px-4 py-3 text-left border-b border-gray-200 dark:border-gray-700 transition-colors ${
                  openFilter === btn.key
                    ? 'bg-green-500 text-white font-semibold'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        )}

        {/* 右侧内容 */}
        <div className='flex-1 max-h-[60vh] overflow-y-auto bg-white dark:bg-gray-900 p-4'>
          {activeTab === '筛选' ? renderFilterOptions() : renderSortOptions()}
        </div>
      </div>
    </div>
  );
};

export default FilterOptions;
