// 簡繁轉換工具（最小依賴）
// 使用 chinese-conv 以在 Edge/瀏覽器/Node 環境皆可運作
import { sify } from 'chinese-conv';

/**
 * 將輸入字串轉為簡體（失敗時回傳原字串）
 */
export function toSimplified(input: string | null | undefined): string {
  if (!input) return '';
  try {
    return sify(input);
  } catch {
    return input;
  }
}

/**
 * 用於等值比對時的規範化：轉簡體並小寫
 */
export function normalizeForCompare(input: string | null | undefined): string {
  return toSimplified(input || '').toLowerCase();
}

