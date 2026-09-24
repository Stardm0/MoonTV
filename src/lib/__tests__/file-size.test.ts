import { formatFileSize } from '@/lib/file-size';

describe('formatFileSize', () => {
  it('字节不给小数', () => {
    expect(formatFileSize(0)).toBe('-');
    expect(formatFileSize(1)).toBe('1 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('1024 进制逐级进位', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(1024 ** 3)).toBe('1.0 GB');
    expect(formatFileSize(1024 ** 4)).toBe('1.0 TB');
  });

  it('TB 封顶（再大也不再往上）', () => {
    expect(formatFileSize(1024 ** 5)).toBe('1024.0 TB');
  });

  it('目录与未统计大小的 -1 显示 -', () => {
    expect(formatFileSize(-1)).toBe('-');
    expect(formatFileSize(Number.NaN)).toBe('-');
  });
});
