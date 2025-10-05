'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

interface NavigationLoadingContextType {
  isLoading: boolean;
  startLoading: () => void;
  stopLoading: () => void;
}

const NavigationLoadingContext = createContext<NavigationLoadingContextType>({
  isLoading: false,
  startLoading: () => {
    // Default implementation
  },
  stopLoading: () => {
    // Default implementation
  },
});

export const useNavigationLoading = () => useContext(NavigationLoadingContext);

export function NavigationLoadingProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const startLoading = useCallback(() => {
    setIsLoading(true);
  }, []);

  const stopLoading = useCallback(() => {
    setIsLoading(false);
  }, []);

  // 监听路由变化，自动停止加载状态
  useEffect(() => {
    // 路由变化完成后，停止加载
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 300); // 给一个短暂延迟确保页面已经渲染

    return () => clearTimeout(timer);
  }, [pathname, searchParams]);

  return (
    <NavigationLoadingContext.Provider value={{ isLoading, startLoading, stopLoading }}>
      {children}
    </NavigationLoadingContext.Provider>
  );
}

