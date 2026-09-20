'use client';

import { Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { M3U8Task, parseM3U8, StreamSaverMode } from '@/lib/m3u8-downloader';

interface AddDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddTask: (config: {
    url: string;
    title: string;
    downloadType: 'TS' | 'MP4';
    concurrency: number;
    rangeMode: boolean;
    startSegment: number;
    endSegment: number;
    streamMode: StreamSaverMode;
    maxRetries: number; // 最大重试次数
    parsedTask: M3U8Task;
  }) => void;
  initialUrl?: string;
  initialTitle?: string;
  skipConfig?: {
    enable: boolean;
    intro_time: number;
    outro_time: number;
  };
}

import { formatTime } from '@/lib/formatTime';

const AddDownloadModal = ({ isOpen, onClose, onAddTask, initialUrl = '', initialTitle = '', skipConfig }: AddDownloadModalProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [task, setTask] = useState<M3U8Task | null>(null);
  const [downloadType, setDownloadType] = useState<'TS' | 'MP4'>('TS');
  const [rangeMode, setRangeMode] = useState(false);
  const [startSegment, setStartSegment] = useState(1);
  const [endSegment, setEndSegment] = useState(0);
  const [concurrency, setConcurrency] = useState(16);
  const [maxRetries, setMaxRetries] = useState(3); // 默认重试3次
  const [streamMode, setStreamMode] = useState<StreamSaverMode>('disabled');
  const [editableUrl, setEditableUrl] = useState('');
  const [editableTitle, setEditableTitle] = useState('');
  const [syncWithSkipConfig, setSyncWithSkipConfig] = useState(false);
  
  // 检测各种模式的支持情况
  const [modeSupport, setModeSupport] = useState({
    serviceWorker: false,
    fileSystem: false,
    blob: true, // Blob模式总是支持的
  });

  // 检测边下边存模式的支持情况
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // 动态导入，避免服务端渲染时执行
      Promise.all([
        import('@/lib/stream-saver-fallback'),
        import('@/lib/stream-saver')
      ]).then(([fallback, streamSaver]) => {
        const fileSystemSupported = fallback.supportsFileSystemAccess();
        const serviceWorkerSupported = streamSaver.isStreamSaverSupported();
        
        setModeSupport({
          serviceWorker: serviceWorkerSupported,
          fileSystem: fileSystemSupported,
          blob: true,
        });
      }).catch(err => {
        // eslint-disable-next-line no-console
        console.error('Failed to detect stream saver support:', err);
      });
    }
  }, []);

  // 从 localStorage 恢复用户配置
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedDownloadType = localStorage.getItem('downloadType') as 'TS' | 'MP4' | null;
      const savedConcurrency = localStorage.getItem('concurrency');
      const savedMaxRetries = localStorage.getItem('maxRetries');
      const savedStreamMode = localStorage.getItem('streamMode') as StreamSaverMode | null;
      
      if (savedDownloadType) setDownloadType(savedDownloadType);
      if (savedConcurrency) setConcurrency(parseInt(savedConcurrency, 10));
      if (savedMaxRetries) setMaxRetries(parseInt(savedMaxRetries, 10));
      if (savedStreamMode) setStreamMode(savedStreamMode);
    }
  }, []);

  // 保存用户配置到 localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('downloadType', downloadType);
      localStorage.setItem('concurrency', concurrency.toString());
      localStorage.setItem('maxRetries', String(maxRetries));
      localStorage.setItem('streamMode', streamMode);
    }
  }, [downloadType, concurrency, maxRetries, streamMode]);

  // 当模态框打开时，设置初始值
  useEffect(() => {
    if (isOpen) {
      setEditableUrl(initialUrl || '');
      setEditableTitle(initialTitle || '');
      setTask(null);
      setStartSegment(1);
      setEndSegment(0);
    }
  }, [isOpen, initialUrl, initialTitle]);

  // 监听 initialTitle 变化（例如切换剧集时）
  useEffect(() => {
    if (isOpen && initialTitle) {
      setEditableTitle(initialTitle);
      if (task) {
        setTask({ ...task, title: initialTitle });
      }
    }
  }, [isOpen, initialTitle]); // eslint-disable-line react-hooks/exhaustive-deps

  // 当添加窗口打开且有URL时，自动执行解析
  useEffect(() => {
    if (isOpen && editableUrl && !task && !isLoading) {
      handleParse();
    }
  }, [isOpen, editableUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // 当task解析完成且syncWithSkipConfig为true时，自动执行同步逻辑
  useEffect(() => {
    if (task && syncWithSkipConfig && skipConfig) {
      const segs = task.segmentDurations || [];
      // 计算起始片段（跳过片头）
      let introSegment = 1;
      if (skipConfig.intro_time > 0 && segs.length > 0) {
        let acc = 0;
        let lastIdx = 0;
        for (let i = 0; i < segs.length; i++) {
          if (acc + segs[i] <= skipConfig.intro_time) {
            acc += segs[i];
            lastIdx = i;
          } else {
            break;
          }
        }
        introSegment = Math.min(task.tsUrlList.length, lastIdx + 2); // 下一个片段开始
      }

      // 计算结束片段（跳过片尾）
      let outroSegment = task.tsUrlList.length;
      if (skipConfig.outro_time !== 0 && segs.length > 0) {
        let acc = 0;
        const targetTime = (task.durationSecond || 0) + skipConfig.outro_time;
        outroSegment = task.tsUrlList.length;
        for (let i = 0; i < segs.length; i++) {
          acc += segs[i];
          if (acc >= targetTime) {
            outroSegment = i + 1;
            break;
          }
        }
        outroSegment = Math.max(1, Math.min(task.tsUrlList.length, outroSegment));
      }

      setStartSegment(introSegment);
      setEndSegment(outroSegment);
    }
  }, [task, syncWithSkipConfig, skipConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  // 解析 M3U8
  const handleParse = async () => {
    if (!editableUrl) {
      return;
    }

    setIsLoading(true);
    try {
      const parsedTask = await parseM3U8(editableUrl);
      parsedTask.title = editableTitle || parsedTask.title;
      parsedTask.type = downloadType;
      setTask(parsedTask);
      setEndSegment(parsedTask.tsUrlList.length);
    } catch (error) {
      // 解析失败，静默处理
    } finally {
      setIsLoading(false);
    }
  };

  // 添加下载任务
  const handleAdd = () => {
    if (!task) return;

    onAddTask({
      url: editableUrl,
      title: task.title,
      downloadType,
      concurrency,
      rangeMode,
      startSegment,
      endSegment,
      streamMode,
      maxRetries,
      parsedTask: task,
    });

    // 关闭弹窗并重置状态
    onClose();
    setTask(null);
    setEditableUrl('');
    setEditableTitle('');
  };

  // 处理关闭
  const handleClose = () => {
    onClose();
    setTask(null);
    setEditableUrl('');
    setEditableTitle('');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10000] flex items-center justify-center p-4">
      <div className="relative w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800 max-h-[90vh] overflow-y-auto">
        {/* 关闭按钮 */}
        <button
          onClick={handleClose}
          className="absolute right-4 top-4 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-200"
        >
          <X className="h-6 w-6" />
        </button>

        {/* 标题 */}
        <h2 className="mb-6 text-2xl font-bold text-gray-900 dark:text-white">下载 M3U8 视频</h2>

        {/* 内容 */}
        <div className="space-y-4">
          {/* M3U8 URL */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              M3U8 地址
            </label>
            <input
              type="text"
              value={editableUrl}
              onChange={(e) => setEditableUrl(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              placeholder="请输入 M3U8 链接地址"
            />
          </div>

          {/* 视频标题 */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              保存标题
            </label>
            <input
              type="text"
              value={task ? task.title : editableTitle}
              onChange={(e) => {
                const newTitle = e.target.value;
                setEditableTitle(newTitle);
                if (task) {
                  setTask({ ...task, title: newTitle });
                }
              }}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              placeholder="请输入文件名"
            />
          </div>

          {/* 保存格式 */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              保存格式
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="format"
                  value="TS"
                  checked={downloadType === 'TS'}
                  onChange={() => setDownloadType('TS')}
                  className="w-4 h-4"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">TS 格式</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="format"
                  value="MP4"
                  checked={downloadType === 'MP4'}
                  onChange={() => setDownloadType('MP4')}
                  className="w-4 h-4"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">MP4 格式</span>
              </label>
            </div>
          </div>

          {/* 线程数 */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              下载线程数: {concurrency}
            </label>
            <input
              type="range"
              min="1"
              max="32"
              value={concurrency}
              onChange={(e) => setConcurrency(parseInt(e.target.value, 10))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
              <span>1 线程</span>
              <span>32 线程</span>
            </div>
          </div>
          {/* 重试次数 */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              失败重试次数: {maxRetries}
            </label>
            <input
              type="range"
              min="0"
              max="10"
              value={maxRetries}
              onChange={(e) => setMaxRetries(parseInt(e.target.value, 10))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
              <span>不重试</span>
              <span>10 次</span>
            </div>
          </div>
          {/* 边下边存模式 */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              下载模式
            </label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="streamMode"
                  value="disabled"
                  checked={streamMode === 'disabled'}
                  onChange={() => setStreamMode('disabled')}
                  className="w-4 h-4"
                />
                <div className="text-sm flex-1">
                  <div className="flex items-center gap-1">
                    <span className="text-green-500">✓</span>
                    <span className="text-gray-700 dark:text-gray-300 font-medium">
                      普通模式
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 ml-4">
                    内存下载，适合小文件（&lt;500MB）
                  </div>
                </div>
              </label>
              
              <label className={`flex items-center gap-2 ${!modeSupport.serviceWorker ? 'opacity-60' : 'cursor-pointer'}`}>
                <input
                  type="radio"
                  name="streamMode"
                  value="service-worker"
                  checked={streamMode === 'service-worker'}
                  onChange={() => setStreamMode('service-worker')}
                  disabled={!modeSupport.serviceWorker}
                  className="w-4 h-4 disabled:cursor-not-allowed"
                />
                <div className="text-sm flex-1">
                  <div className="flex items-center gap-1">
                    {modeSupport.serviceWorker ? (
                      <span className="text-green-500">✓</span>
                    ) : (
                      <span className="text-red-500">✗</span>
                    )}
                    <span className={`font-medium ${!modeSupport.serviceWorker ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300'}`}>
                      Service Worker 流式下载
                    </span>
                  </div>
                  <div className={`text-xs ml-4 ${!modeSupport.serviceWorker ? 'text-gray-400 dark:text-gray-500' : 'text-gray-500 dark:text-gray-400'}`}>
                    {modeSupport.serviceWorker ? (
                      '边下边存，无大小限制，适合超大文件'
                    ) : (
                      '不支持：需要HTTPS或本地环境'
                    )}
                  </div>
                </div>
              </label>
              
              <label className={`flex items-center gap-2 ${!modeSupport.fileSystem ? 'opacity-60' : 'cursor-pointer'}`}>
                <input
                  type="radio"
                  name="streamMode"
                  value="file-system"
                  checked={streamMode === 'file-system'}
                  onChange={() => setStreamMode('file-system')}
                  disabled={!modeSupport.fileSystem}
                  className="w-4 h-4 disabled:cursor-not-allowed"
                />
                <div className="text-sm flex-1">
                  <div className="flex items-center gap-1">
                    {modeSupport.fileSystem ? (
                      <span className="text-green-500">✓</span>
                    ) : (
                      <span className="text-red-500">✗</span>
                    )}
                    <span className={`font-medium ${!modeSupport.fileSystem ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300'}`}>
                      文件系统直写
                    </span>
                  </div>
                  <div className={`text-xs ml-4 ${!modeSupport.fileSystem ? 'text-gray-400 dark:text-gray-500' : 'text-gray-500 dark:text-gray-400'}`}>
                    {modeSupport.fileSystem ? (
                      '直接写入磁盘，无大小限制（推荐）'
                    ) : (
                      '不支持：需要Chrome/Edge浏览器'
                    )}
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* 解析信息 */}
          {isLoading && (
            <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>正在解析 M3U8...</span>
            </div>
          )}

          {task && (
            <div className="rounded-lg bg-gray-50 p-4 dark:bg-gray-700/50">
              <h3 className="mb-2 font-medium text-gray-900 dark:text-white">解析结果</h3>
              <div className="space-y-1 text-sm text-gray-600 dark:text-gray-300">
                <p>总时长: {formatTime(task.durationSecond || 0)}</p>
                <p>片段数: {task.tsUrlList.length}</p>
                {task.aesConf?.key && <p className="text-yellow-600 dark:text-yellow-400">🔒 已加密 (AES-128)</p>}
              </div>

              {/* 范围下载 */}
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rangeMode}
                      onChange={(e) => setRangeMode(e.target.checked)}
                      className="w-4 h-4"
                    />
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      范围下载
                    </span>
                  </label>
                  {rangeMode && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={syncWithSkipConfig}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSyncWithSkipConfig(checked);
                          if (checked && task) {
                            // 根据跳过配置计算起始和结束片段
                            const totalSegments = task.tsUrlList.length;
                            const segmentDuration = (task.durationSecond || 0) / totalSegments;
                            
                            if (segmentDuration > 0) {
                              // 计算起始片段（跳过片头）
                              let introSegment = 1;
                              if (skipConfig && skipConfig.intro_time > 0) {
                                // 片头时间对应的片段数 + 1（从下一个片段开始）
                                introSegment = Math.min(totalSegments, Math.ceil(skipConfig.intro_time / segmentDuration) + 1);
                              }
                              
                              // 计算结束片段（跳过片尾）
                              let outroSegment = totalSegments;
                              if (skipConfig && skipConfig.outro_time !== 0) {
                                // 实际结束时间 = 总时长 + 片尾时间
                                // 片尾时间通常是负数，表示在结束前多少秒停止
                                const actualEndTime = task.durationSecond + skipConfig.outro_time;
                                // 计算这个时间点对应的片段编号（向下取整，确保不超过这个时间）
                                outroSegment = Math.max(1, Math.min(totalSegments, Math.floor(actualEndTime / segmentDuration)));
                              }
                              
                              setStartSegment(introSegment);
                              setEndSegment(outroSegment);
                            }
                          }
                        }}
                        className="w-4 h-4"
                      />
                      <span className="text-xs text-gray-600 dark:text-gray-400">
                        同步跳过配置
                      </span>
                    </label>
                  )}
                </div>

                {rangeMode && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="block text-xs text-gray-600 dark:text-gray-400">起始片段:</span>
                        <input
                          type="number"
                          min={1}
                          max={task.tsUrlList.length}
                          value={startSegment}
                          onChange={(e) => {
                            let v = parseInt(e.target.value, 10);
                            if (isNaN(v)) v = 1;
                            v = Math.max(1, Math.min(task.tsUrlList.length, v));
                            setStartSegment(v);
                          }}
                          className="w-20 px-2 py-1 rounded text-sm bg-[#f5f5f5] dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none border-none focus:outline-none focus:border-none focus:ring-0 ml-1"
                        />
                      </div>
                      <input
                        type="range"
                        min="1"
                        max={task.tsUrlList.length}
                        value={startSegment}
                        onChange={(e) => setStartSegment(parseInt(e.target.value, 10))}
                        className="w-full"
                      />
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {formatTime(
                          task.segmentDurations
                            ? task.segmentDurations.slice(0, startSegment - 1).reduce((a, b) => a + b, 0)
                            : 0
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="block text-xs text-gray-600 dark:text-gray-400">结束片段:</span>
                        <input
                          type="number"
                          min={1}
                          max={task.tsUrlList.length}
                          value={endSegment}
                          onChange={(e) => {
                            let v = parseInt(e.target.value, 10);
                            if (isNaN(v)) v = 1;
                            v = Math.max(1, Math.min(task.tsUrlList.length, v));
                            setEndSegment(v);
                          }}
                          className="w-20 px-2 py-1 rounded text-sm bg-[#f5f5f5] dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none border-none focus:outline-none focus:border-none focus:ring-0 ml-1"
                        />
                      </div>
                      <input
                        type="range"
                        min="1"
                        max={task.tsUrlList.length}
                        value={endSegment}
                        onChange={(e) => setEndSegment(parseInt(e.target.value, 10))}
                        className="w-full"
                      />
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {formatTime(
                          task.segmentDurations
                            ? task.segmentDurations.slice(0, endSegment).reduce((a, b) => a + b, 0)
                            : 0
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 按钮 */}
          <div className="flex gap-3 pt-4">
            <button
              onClick={handleParse}
              disabled={!editableUrl || isLoading}
              className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded-lg transition-colors"
            >
              {isLoading ? '解析中...' : '解析'}
            </button>
            <button
              onClick={handleAdd}
              disabled={!task}
              className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white rounded-lg transition-colors"
            >
              添加下载
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AddDownloadModal;
