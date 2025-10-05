'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface SearchSuggestionsProps {
  query: string;
  isVisible: boolean;
  onSelect: (suggestion: string) => void;
  onClose: () => void;
}

interface SuggestionItem {
  text: string;
}

export default function SearchSuggestions({
  query,
  isVisible,
  onSelect,
  onClose,
}: SearchSuggestionsProps) {
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isEnabled, setIsEnabled] = useState<boolean>(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 流式获取建议
  const fetchSuggestionsFromAPI = useCallback(async (searchQuery: string) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
  
    try {
      const response = await fetch(
        `/api/search/suggestions?q=${encodeURIComponent(searchQuery)}`,
        { signal: controller.signal }
      );
  
      if (!response.body) return;
  
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;
  
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (done) break;
  
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
  
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.suggestions && Array.isArray(parsed.suggestions)) {
              setSuggestions((prev) => [
                ...prev,
                ...parsed.suggestions.map((s: any) => ({
                  text: s.text,
                })),
              ]);
            }
          } catch (err) {
            console.error('解析流式数据失败', err);
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setSuggestions([]);
      setSelectedIndex(-1);
    }
  }, []);
  

  // 加载搜索建议设置
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedEnableSearchSuggestions = localStorage.getItem('enableSearchSuggestions');
      if (savedEnableSearchSuggestions !== null) {
        setIsEnabled(savedEnableSearchSuggestions === 'true');
      }
      
      // 监听设置变化事件，实现实时更新
      const handleSettingsChange = (event: Event) => {
        const customEvent = event as CustomEvent<{ enableSearchSuggestions: boolean }>;
        if (customEvent.detail?.enableSearchSuggestions !== undefined) {
          setIsEnabled(customEvent.detail.enableSearchSuggestions);
        }
      };
      
      window.addEventListener('searchSettingsChanged', handleSettingsChange);
      
      return () => {
        window.removeEventListener('searchSettingsChanged', handleSettingsChange);
      };
    }
  }, []);

  // 防抖触发
  const debouncedFetchSuggestions = useCallback(
    (searchQuery: string) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        if (searchQuery.trim() && isVisible && isEnabled) {
          setSuggestions([]); // 新查询清空旧数据
          fetchSuggestionsFromAPI(searchQuery);
        } else {
          setSuggestions([]);
          setSelectedIndex(-1);
        }
      }, 300);
    },
    [isVisible, isEnabled, fetchSuggestionsFromAPI]
  );

  useEffect(() => {
    if (!query.trim() || !isVisible || !isEnabled) {
      setSuggestions([]);
      setSelectedIndex(-1);
      return;
    }
    debouncedFetchSuggestions(query);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, [query, isVisible, isEnabled, debouncedFetchSuggestions]);

  // 键盘导航
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isVisible || suggestions.length === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < suggestions.length - 1 ? prev + 1 : 0
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : suggestions.length - 1
          );
          break;
        case 'Enter':
          e.preventDefault();
          if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
            onSelect(suggestions[selectedIndex].text);
          } else {
            onSelect(query);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, query, suggestions, selectedIndex, onSelect, onClose]);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    if (isVisible) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isVisible, onClose]);

  if (!isVisible || !isEnabled || suggestions.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="absolute top-full left-0 right-0 z-50 mt-1 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 max-h-80 overflow-y-auto"
    >
      {suggestions.map((suggestion, index) => (
        <button
          key={`suggestion-${suggestion.text}-${index}`}
          onClick={() => onSelect(suggestion.text)}
          onMouseEnter={() => setSelectedIndex(index)}
          className={`w-full px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors duration-150 flex items-center gap-3 ${
            selectedIndex === index ? 'bg-gray-100 dark:bg-gray-700' : ''
          }`}
        >
          <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 truncate">
            {suggestion.text}
          </span>
        </button>
      ))}
    </div>
  );
}
