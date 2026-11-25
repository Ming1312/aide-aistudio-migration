"""
features.py — 羊舍 THI 預測的特徵（Feature）與標籤（Label）建構

【最重要的觀念】
  Feature（特徵）= 預測當下「已經知道」的資訊，是模型的輸入 X。
  Label（標籤）  = 我們想預測、但當下還不知道的答案 y；這裡是「3 小時後的 THI」。
  訓練時，模型看很多組 (X, y)，學出「X 長這樣時，y 通常是多少」。

【防止 Data Leakage（資料洩漏）的三條規則】
  1. 特徵只能用 index <= t 的資料（shift 只用正數，rolling 只用「往回看」的視窗）。
  2. 標籤用「時間戳記」對齊：y(t) = THI(t + H 小時)，不是靠 row 順序亂猜。
  3. 先把資料放到「完整的每小時格子（hourly grid）」，缺的小時填 NaN，
     這樣 shift(k) 才一定等於「k 小時前」。如果資料有缺漏卻直接 shift(3)，
     可能抓到 5 小時前或 1 天前的資料，卻以為是 3 小時前。

訓練（train_thi.py / evaluate_thi.py）與推論（predict_thi.py）都 import 這個檔案，
確保兩邊算特徵的方式完全一致（避免 train/serve skew）。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# ---------- 欄位名稱（羊舍.csv 去掉前綴後的名稱） ----------
TARGET = "成羊區THI"
TEMP = "成羊區平均溫度"
RH = "成羊區平均濕度"
ID4_T = "ID4-溫度"
ID4_RH = "ID4-濕度"
RAIN = "1小時雨量"
FANS = ["風扇-07", "風扇-08", "風扇-04", "風扇-03"]
CURTAIN = "南右帆布張 23/24"
SHADE = "南遮陽張 25/26"

LAGS = [1, 3, 6, 12, 24]
MIN_HISTORY_HOURS = 24  # 任何特徵最多往回看 24 小時：origin 之前至少要有 24 小時資料

FEATURE_SETS = {
    "A": "只用 THI 歷史 + 時間",
    "B": "A + 溫度/濕度/ID4 感測點/雨量",
    "C": "B + 風扇/捲簾/遮陽狀態（意義未經確認；僅供消融實驗）",
}
REQUIRED_COLUMNS = {
    "A": [TARGET],
    "B": [TARGET, TEMP, RH, ID4_T, ID4_RH, RAIN],
    "C": [TARGET, TEMP, RH, ID4_T, ID4_RH, RAIN, *FANS, CURTAIN, SHADE],
}


# ---------- 1. 放到完整的每小時格子 ----------
def to_hourly_grid(df: pd.DataFrame) -> pd.DataFrame:
    """
    輸入：load_sensor_csv() 的結果（有 timestamp 欄）。
    輸出：index = 完整的每小時時間軸（缺的小時是 NaN 列）。
    """
    d = df.sort_values("timestamp")
    d = d.drop_duplicates("timestamp", keep="last").set_index("timestamp")
    if not (d.index.minute == 0).all() or not (d.index.second == 0).all():
        raise ValueError("時間戳記不在整點上，無法放到每小時格子")
    full = pd.date_range(d.index.min(), d.index.max(), freq="h", name="timestamp")
    return d.reindex(full)


def fill_short_gaps(grid: pd.DataFrame, max_gap_hours: int = 2) -> pd.DataFrame:
    """
    只往「後」填補短缺口（forward fill，最多 max_gap_hours 小時）。
    只用過去的值補，所以不會引入未來資訊。
    訓練資料本來就沒有缺口（羊舍），所以這只在推論遇到缺值時才有作用。
    """
    return grid.ffill(limit=max_gap_hours)


# ---------- 2. 特徵 ----------
def build_features(grid: pd.DataFrame, horizon: int = 3, feature_set: str = "B") -> pd.DataFrame:
    """
    對每個時間 t 建一列特徵，只使用 index <= t 的資料。
    t 稱為 origin（預測的起點）；要預測的是 THI(t + horizon 小時)。
    """
    if feature_set not in FEATURE_SETS:
        raise ValueError(f"未知的 feature_set: {feature_set}")
    if not 1 <= horizon <= 24:
        raise ValueError("horizon 必須在 1..24 小時")
    missing = [c for c in REQUIRED_COLUMNS[feature_set] if c not in grid.columns]
    if missing:
        raise KeyError(f"輸入資料缺少欄位: {missing}")

    thi = grid[TARGET]
    f: dict[str, pd.Series] = {}

    # --- A：THI 本身的歷史 ---
    f["thi_now"] = thi
    for k in LAGS:
        f[f"thi_lag{k}"] = thi.shift(k)            # k 小時前的 THI
        f[f"thi_chg{k}"] = thi - thi.shift(k)      # 過去 k 小時的變化量
    for w in (3, 6, 24):
        f[f"thi_mean{w}"] = thi.rolling(w, min_periods=w).mean()   # 缺任何一筆就是 NaN
    f["thi_std6"] = thi.rolling(6, min_periods=6).std()
    f["thi_vs_mean24"] = thi - f["thi_mean24"]
    # 「昨天」的資訊：t+H-24 這個時刻在 t 的時候已經過去了，所以可以用
    f["thi_yday_at_target"] = thi.shift(24 - horizon)                    # = Seasonal Naive 的預測值
    f["thi_yday_delta"] = thi.shift(24 - horizon) - thi.shift(24)        # 昨天同一段時間的變化量
    # 時間特徵：用 sin/cos 讓 23 點與 0 點「很接近」
    hour = grid.index.hour.to_numpy()
    f["hour_sin"] = pd.Series(np.sin(2 * np.pi * hour / 24), index=grid.index)
    f["hour_cos"] = pd.Series(np.cos(2 * np.pi * hour / 24), index=grid.index)

    # --- B：其他感測器 ---
    if feature_set in ("B", "C"):
        t_, rh_ = grid[TEMP], grid[RH]
        f["temp_now"], f["rh_now"] = t_, rh_
        for k in (1, 3, 6):
            f[f"temp_chg{k}"] = t_ - t_.shift(k)
            f[f"rh_chg{k}"] = rh_ - rh_.shift(k)
        f["temp_mean6"] = t_.rolling(6, min_periods=6).mean()
        f["id4_temp"], f["id4_rh"] = grid[ID4_T], grid[ID4_RH]
        f["temp_sensor_gap"] = grid[ID4_T] - t_            # 兩個溫度感測點的差：一致性檢查
        f["rain_now"] = grid[RAIN]
        f["rain_max6"] = grid[RAIN].rolling(6, min_periods=6).max()

    # --- C：設備狀態（只用「現在」的狀態，絕不使用未來的控制行為） ---
    if feature_set == "C":
        fans = grid[FANS]
        f["fans_active"] = (fans > 0).sum(axis=1).where(fans.notna().all(axis=1))
        f["curtain_open"] = (grid[CURTAIN] > 0).astype(float).where(grid[CURTAIN].notna())
        f["shade_open"] = (grid[SHADE] > 0).astype(float).where(grid[SHADE].notna())

    # 四捨五入到 6 位小數：感測器精度只有 0.1，不損失資訊，但能消除浮點數雜訊。
    # 否則 rolling().std() 在「完整資料」與「只取最近 120 小時」兩種算法下會差約 1e-14，
    # 樹模型的切分點恰好落在這種極小值附近時，預測會差 0.03（train/serve skew，實測遇過）。
    return pd.DataFrame(f, index=grid.index).round(6)


def make_label(grid: pd.DataFrame, horizon: int = 3) -> pd.Series:
    """
    Label：y(t) = THI(t + horizon 小時)。
    用「時間戳記」查值（reindex），不是 shift：若 t+H 那個時間沒有資料，結果就是 NaN。
    """
    thi = grid[TARGET]
    target_times = grid.index + pd.Timedelta(hours=horizon)
    y = pd.Series(thi.reindex(target_times).to_numpy(), index=grid.index, name=f"thi_t_plus_{horizon}h")
    return y


def make_dataset(grid: pd.DataFrame, horizon: int = 3, feature_set: str = "B"):
    """回傳 (X, y)：只保留「所有特徵與標籤都有值」的 origin（complete-case）。"""
    X = build_features(grid, horizon, feature_set)
    y = make_label(grid, horizon)
    ok = X.notna().all(axis=1) & y.notna()
    return X[ok], y[ok]


# ---------- 3. 因果性（無未來資訊）檢查 ----------
def causality_violations(grid: pd.DataFrame, horizon: int, feature_set: str,
                         n_probe: int = 40, seed: int = 0, builder=None) -> dict:
    """
    隨機挑 n_probe 個時間 t，做兩種測試，特徵在 t 的值都必須與用完整資料算出的一致：
      (a) 截斷測試：把 t 之後的資料整個刪掉再算特徵
      (b) 污染測試：把 t 之後的資料全部改成 1e6 再算特徵
    只要有任何特徵用到 t 之後的資料，(a) 或 (b) 就會不一致。
    """
    build = builder or (lambda g: build_features(g, horizon, feature_set))
    full = build(grid)
    cand = full.dropna().index
    rng = np.random.default_rng(seed)
    probes = rng.choice(cand.to_numpy(), size=min(n_probe, len(cand)), replace=False)
    bad_trunc, bad_garble = [], []
    for t in probes:
        t = pd.Timestamp(t)
        ref = full.loc[t].to_numpy(dtype=float)
        trunc = build(grid.loc[:t]).loc[t].to_numpy(dtype=float)
        if not np.allclose(trunc, ref, equal_nan=True):
            bad_trunc.append(t)
        g = grid.copy()
        g.loc[g.index > t, :] = 1e6
        garb = build(g).loc[t].to_numpy(dtype=float)
        if not np.allclose(garb, ref, equal_nan=True):
            bad_garble.append(t)
    return {"n_probe": len(probes), "truncation_violations": bad_trunc, "garble_violations": bad_garble}
