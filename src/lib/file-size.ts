/**
 * 文件大小格式化（网盘 / 影库列表用）。
 *
 * 用 1024 进制（与 OpenList 后台、系统文件管理器一致），单位到 TB 封顶。
 * 网盘目录项常见 `size: 0` 或 `-1`，这类统一显示 `-` 而不是「0 B」——
 * 目录和未统计大小的文件本来就没有大小可说。
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatFileSize(size: number): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return '-';
  }

  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // 字节不给小数（「1.0 B」很怪），其余保留一位
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${UNITS[unit]}`;
}
