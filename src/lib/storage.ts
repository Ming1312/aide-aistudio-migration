// 只存「每位使用者自己的偏好」（門檻覆寫、匯入來源設定、決策紀錄）；讀寫失敗時安靜退回預設。
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 私人視窗或被封鎖：略過 */
  }
}
