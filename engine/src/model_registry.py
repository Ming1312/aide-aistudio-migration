"""
model_registry.py — Phase 3：模型版本登記與「時間合格」選擇（嚴格歷史回測的核心）

為什麼需要它？
  Phase 2.6 的正式模型用全部資料（到 2026-08-13 14:00）訓練。拿它去「回放」8 月 10 日，即使推論程式只讀
  as_of 以前的感測器資料，模型『權重』仍含有 8 月 10 日之後的資訊（因果洩漏，Non-Causal Replay）。
  所以要有一組「在過去某時點凍結」的模型，回放某個時間點時只能用「當時已經存在」的模型。

做法：
  - 凍結點（train_until = S）：訓練資料只包含標籤時間 < S 的樣本；風險校正（CQR 校正量、警報線）
    也只用 S 之前 5 天的內層 walk-forward 樣本外資料（與 Phase 2.5/2.6 的外層折做法完全相同）。
  - 每個凍結點存兩個檔：Phase 2.5 bundle（正式預測）＋ Phase 2.6 bundle（實驗性視窗風險）。
  - ModelRegistry.eligible(as_of)：只回傳「train_until ≤ as_of 且 最後一個訓練標籤時間 < as_of」的最新模型；
    沒有符合條件的模型 → 回傳 None，呼叫端必須跳過，**絕不自動改用全資料模型**。

重建（任何環境都可重新產生模型，不必依賴舊的 pickle）：
  python src/model_registry.py build        # 訓練 7 個嚴格折模型 + 登記全資料模型（約數分鐘）
  python src/model_registry.py verify       # 驗證 sha256 與時間欄位
  python src/model_registry.py list
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
REG_PATH = ROOT / "models" / "phase3" / "model_registry.json"
RAW = ROOT / "data" / "raw" / "羊舍.csv"
STRICT_STARTS = ["2026-07-22", "2026-07-25", "2026-07-28", "2026-07-31", "2026-08-03", "2026-08-06", "2026-08-09"]
NO_BACKTEST = {"source": "strict-mode bundle: 凍結當下不存在任何回測摘要（避免把未來績效寫進模型檔）"}


@dataclass
class ModelVersion:
    version: str                 # 例 "strict_until_20260722"
    kind: str                    # "strict_fold" | "full_data"
    train_until: str             # 凍結時間 S（此時間點以前的資料才可能被用到）
    data_cutoff: str             # 最後一個訓練標籤的時間（< train_until，除 full_data 外）
    phase25_path: str
    phase26_path: str
    phase25_sha256: str
    phase26_sha256: str
    n_train: int
    created: str


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _rel(p: Path) -> str:
    return str(Path(p).resolve().relative_to(ROOT))


# ------------------------------------------------------------------ 訓練（嚴格折）
def build_one(start: str) -> dict:
    import phase26_train as T26
    import train_phase25 as T25
    S = pd.Timestamp(start)
    tag = S.strftime("strict_%Y%m%d")
    out25 = ROOT / "models" / "phase25"
    out26 = ROOT / "models" / "phase26"
    p25 = out25 / f"thi_h3_phase25_{tag}.joblib"
    p26 = out26 / f"thi_h3_phase26_{tag}.joblib"
    b25 = T25.train(RAW, S, "linear_quantile", NO_BACKTEST)
    joblib.dump(b25, p25)
    b26 = T26.train(RAW, S, p25)
    joblib.dump(b26, p26)
    return asdict(ModelVersion(
        version=f"strict_until_{S:%Y%m%d}", kind="strict_fold", train_until=str(S), data_cutoff=b25["train_period"][1],
        phase25_path=_rel(p25), phase26_path=_rel(p26), phase25_sha256=_sha(p25), phase26_sha256=_sha(p26),
        n_train=int(b25["n_train"]), created=datetime.now().isoformat(timespec="seconds")))


def full_data_entry() -> dict:
    p25 = ROOT / "models" / "phase25" / "thi_h3_phase25.joblib"
    p26 = ROOT / "models" / "phase26" / "thi_h3_phase26.joblib"
    b = joblib.load(p25)
    end = b["train_period"][1]
    return asdict(ModelVersion(version="full_data_formal", kind="full_data", train_until=str(pd.Timestamp(end)), data_cutoff=end,
                               phase25_path=_rel(p25), phase26_path=_rel(p26), phase25_sha256=_sha(p25), phase26_sha256=_sha(p26),
                               n_train=int(b["n_train"]), created=str(b.get("created"))))


def build(n_jobs: int = 3) -> dict:
    from joblib import Parallel, delayed
    import sklearn
    import xgboost
    entries = Parallel(n_jobs=n_jobs)(delayed(build_one)(s) for s in STRICT_STARTS)
    reg = {"schema": 1, "created": datetime.now().isoformat(timespec="seconds"),
           "purpose": "嚴格歷史回測：每個預測時間點只能使用 train_until ≤ as_of 的模型；全資料模型只供 Demonstration Replay。",
           "environment": {"python": sys.version.split()[0], "pandas": pd.__version__, "numpy": np.__version__,
                           "sklearn": sklearn.__version__, "xgboost": xgboost.__version__},
           "retrain_cadence_note": "沿用 Phase 2.5/2.6 的 walk-forward 外層折：每 3 天凍結一次（最後一折延伸到資料末端）。",
           "models": sorted(entries, key=lambda e: e["train_until"]), "full_data_model": full_data_entry()}
    REG_PATH.parent.mkdir(parents=True, exist_ok=True)
    REG_PATH.write_text(json.dumps(reg, ensure_ascii=False, indent=1))
    return reg


# ------------------------------------------------------------------ 讀取與選擇
class ModelRegistry:
    def __init__(self, path: Path | str = REG_PATH, root: Path = ROOT):
        self.path, self.root = Path(path), Path(root)
        self.reg = json.loads(self.path.read_text())
        self.strict = [ModelVersion(**m) for m in self.reg["models"]]
        self.full = ModelVersion(**self.reg["full_data_model"])
        self._cache: dict = {}
        for m in self.strict:                                          # 結構檢查：凍結時間必須晚於最後訓練標籤
            if not pd.Timestamp(m.data_cutoff) < pd.Timestamp(m.train_until):
                raise ValueError(f"{m.version}: data_cutoff {m.data_cutoff} 不早於 train_until {m.train_until}（訓練資料碰到凍結時間 = 可能洩漏）")

    # --- 選擇規則
    def eligible(self, as_of) -> ModelVersion | None:
        """最新的『當時已存在』嚴格模型；沒有就 None（呼叫端必須跳過，不得改用全資料模型）。"""
        t = pd.Timestamp(as_of)
        ok = [m for m in self.strict if pd.Timestamp(m.train_until) <= t and pd.Timestamp(m.data_cutoff) < t]
        return max(ok, key=lambda m: pd.Timestamp(m.train_until)) if ok else None

    def first_eligible_time(self) -> pd.Timestamp:
        return min(pd.Timestamp(m.train_until) for m in self.strict)

    def is_in_sample(self, mv: ModelVersion, as_of) -> bool:
        """as_of 的『預測起點』資料是否落在該模型的訓練期間內（Demonstration Replay 用來顯示 In-Sample 警告）。"""
        return pd.Timestamp(as_of) <= pd.Timestamp(mv.data_cutoff)

    # --- 載入（含 sha256 與版本檢查）
    def load(self, mv: ModelVersion):
        if mv.version in self._cache:
            return self._cache[mv.version]
        import phase26_predict as P26
        for rel, sha in ((mv.phase25_path, mv.phase25_sha256), (mv.phase26_path, mv.phase26_sha256)):
            p = self.root / rel
            if not p.exists():
                raise FileNotFoundError(f"找不到模型檔 {p}；請執行 python src/model_registry.py build")
            if _sha(p) != sha:
                raise ValueError(f"{rel} 的 sha256 與登記不符（檔案被更換或環境重建後未更新 registry）")
        b = P26.load(self.root / mv.phase26_path)
        self._cache[mv.version] = b
        return b

    def verify(self) -> list[str]:
        problems = []
        for mv in self.strict + [self.full]:
            for rel, sha in ((mv.phase25_path, mv.phase25_sha256), (mv.phase26_path, mv.phase26_sha256)):
                p = self.root / rel
                if not p.exists():
                    problems.append(f"missing {rel}")
                elif _sha(p) != sha:
                    problems.append(f"sha256 mismatch {rel}")
        return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "verify", "list"])
    a = ap.parse_args()
    if a.cmd == "build":
        reg = build()
        print(f"已建立 {len(reg['models'])} 個嚴格折模型 + 全資料模型 → {REG_PATH}")
    r = ModelRegistry()
    if a.cmd == "verify":
        pr = r.verify()
        print("registry 驗證：", "OK" if not pr else pr)
        sys.exit(1 if pr else 0)
    for m in r.strict + [r.full]:
        print(f"{m.version:26s} {m.kind:12s} 凍結 {m.train_until}  最後訓練標籤 {m.data_cutoff}  n_train={m.n_train}")


if __name__ == "__main__":
    main()
