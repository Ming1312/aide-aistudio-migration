"""
domain_registry.py — Phase 5.1：多場域模型登錄表（Multi-Domain Model Registry）與相容性閘門（Compatibility Gate）

與 Phase 3 的關係（不是平行的第二套登錄表）
  * models/phase3/model_registry.json 與 src/model_registry.ModelRegistry 仍是羊舍模型『唯一』的權威來源
    （檔案路徑、sha256、凍結時間、嚴格回測的『時間合格』規則）。本模組只是『讀取』它，為每個羊舍模型版本產生一張 ModelCard。
  * 其他場域沒有任何已訓練模型，所以它們的卡片來自 config/domain_model_catalog.yaml，狀態只可能是
    Candidate / Insufficient Data / Unavailable——沒有 artifact、不能被執行。
  * 這個模組不載入 joblib、不預測、不改變任何 Phase 3 行為。

Compatibility Gate（執行任何模型前必須通過）
  1 domain/site  2 task/target  3 input schema version  4 required features  5 units  6 sampling frequency
  7 model status/version/usage scope/artifact  8 training cutoff vs as_of  9 data quality / history
  結果 decision：allow / degrade（可執行但必須標示限制）/ refuse（不可執行）。
  不符合就拒絕或明確降級，**絕不**靜默地改用別的模型。
"""
from __future__ import annotations

import hashlib
import json
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

import domain_schema as DS  # noqa: E402

ROOT = DS.ROOT
CATALOG_PATH = ROOT / "config" / "domain_model_catalog.yaml"
PHASE3_REGISTRY = ROOT / "models" / "phase3" / "model_registry.json"
POLICY_PATH = ROOT / "config" / "decision_policy.yaml"
RESULTS_SUMMARY = ROOT / "outputs" / "phase3" / "results_summary.json"

ST_VALIDATED, ST_EXPERIMENTAL, ST_CANDIDATE, ST_INSUFFICIENT, ST_UNAVAILABLE = (
    "Existing / Validated", "Experimental", "Candidate", "Insufficient Data", "Unavailable")
MODEL_STATUSES = (ST_VALIDATED, ST_EXPERIMENTAL, ST_CANDIDATE, ST_INSUFFICIENT, ST_UNAVAILABLE)
SCOPES = ("strict_backtest", "demonstration_only", "any")
MODES = ("strict", "demonstration", "live")
SHEEP_INPUT_SCHEMA = "sheep-wide-hourly-v1"
# 羊舍正式模型（Phase 2.5/2.6 feature set B）需要的原始欄位：與 src/features.REQUIRED_COLUMNS["B"] 相同
SHEEP_REQUIRED_FEATURES = ("成羊區THI", "成羊區平均溫度", "成羊區平均濕度", "ID4-溫度", "ID4-濕度", "1小時雨量")


@dataclass(frozen=True)
class ModelCard:
    model_id: str
    model_version: str
    domain_id: str
    site_id: str
    task_type: str                         # forecast_risk | anomaly_statistical | predictive_maintenance | forecast
    target_variable: str
    prediction_horizon_h: int | None
    required_features: tuple
    required_units: tuple                  # ((feature, unit), ...)
    input_schema_version: str
    expected_freq_hours: float | None
    training_data_fingerprint: str | None
    training_data_basis: str
    model_artifact_fingerprint: str | None
    artifact_files: tuple                  # ((相對路徑, sha256), ...)
    training_cutoff: str | None            # 最後一個訓練標籤時間
    valid_from: str | None                 # 模型凍結時間（嚴格回放：as_of 必須 ≥ 它）
    evaluation_protocol: str
    evaluation_metrics: tuple              # ((name, value), ...)
    policy_id: str | None
    policy_version: str | None
    model_status: str
    usage_scope: str = "any"
    min_quality_score: float = 0.0
    min_history_hours: int = 0
    notes: str = ""
    # ---- Phase 5.2 新增（皆有預設值，Phase 5.1 的卡片與測試不受影響）：偵測器型模型的版本資訊
    detector_id: str | None = None
    detector_version: str | None = None
    threshold_version: str | None = None
    promotion_stage: str | None = None             # 例如 'Experimental (promotion gates NOT met)'；不是 Validated

    def __post_init__(self):
        if self.model_status not in MODEL_STATUSES:
            raise ValueError(f"{self.model_id}: 未知的 model_status {self.model_status!r}")
        if self.usage_scope not in SCOPES:
            raise ValueError(f"{self.model_id}: 未知的 usage_scope {self.usage_scope!r}")
        if self.model_status in (ST_CANDIDATE, ST_INSUFFICIENT, ST_UNAVAILABLE) and (self.artifact_files or self.model_artifact_fingerprint):
            raise ValueError(f"{self.model_id}: {self.model_status} 的卡片不可宣稱有 artifact（尚未訓練）")

    @property
    def units(self) -> dict:
        return dict(self.required_units)

    @property
    def key(self) -> str:
        return f"{self.model_id}@{self.model_version}"


@dataclass
class FeatureInfo:
    unit: str
    unit_status: str = "inferred_medium"


@dataclass
class InferenceRequest:
    domain_id: str
    site_id: str
    task_type: str
    target_variable: str
    features: dict                         # {欄名: FeatureInfo}
    freq_hours: float | None
    input_schema_version: str
    horizon_h: int | None = None
    as_of: Any = None
    replay_mode: str = "strict"
    quality_score: float | None = None
    n_history_hours: int | None = None
    allow_experimental: bool = False
    training_data_fingerprint_now: str | None = None


@dataclass
class GateCheck:
    name: str
    passed: bool
    severity: str                          # block | warn
    detail: str


@dataclass
class GateResult:
    decision: str                          # allow | degrade | refuse
    card_key: str
    checks: list = field(default_factory=list)

    @property
    def allowed(self) -> bool:
        return self.decision in ("allow", "degrade")

    @property
    def blocking(self) -> list:
        return [c for c in self.checks if not c.passed and c.severity == "block"]

    @property
    def warnings(self) -> list:
        return [c for c in self.checks if not c.passed and c.severity == "warn"]

    def summary(self) -> str:
        bad = [f"{c.name}: {c.detail}" for c in self.checks if not c.passed]
        return f"{self.decision.upper()} {self.card_key}" + (" — " + "; ".join(bad) if bad else "")


# ============================================================ 相容性閘門
def sha256_file(p: Path) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def check_compatibility(card: ModelCard, req: InferenceRequest, root: Path | str | None = None, verify_artifacts: bool = False) -> GateResult:
    ck: list[GateCheck] = []

    def add(name, passed, detail, severity="block"):
        ck.append(GateCheck(name, bool(passed), severity, detail))

    # 1. Domain / Site —— 未知場域與不同場域一律拒絕（羊舍 HGB 不能用在水質或空氣品質）
    known = req.domain_id in DS.domain_ids()
    add("domain_known", known, f"domain_id={req.domain_id!r} " + ("已登記" if known else f"未登記（已登記：{DS.domain_ids()}）"))
    add("domain_match", req.domain_id == card.domain_id, f"請求 {req.domain_id!r} vs 模型 {card.domain_id!r}")
    add("site_match", req.site_id == card.site_id, f"請求 {req.site_id!r} vs 模型 {card.site_id!r}；同名欄位（如溫度）在不同場域的量測定義不保證相同")
    # 2. Task / target / horizon
    add("task_match", req.task_type == card.task_type, f"請求 {req.task_type!r} vs 模型 {card.task_type!r}")
    add("target_match", req.target_variable == card.target_variable, f"請求 {req.target_variable!r} vs 模型 {card.target_variable!r}")
    if card.prediction_horizon_h is not None:
        add("horizon_match", req.horizon_h == card.prediction_horizon_h, f"請求 {req.horizon_h} h vs 模型 {card.prediction_horizon_h} h")
    # 3. Input schema version
    add("input_schema_version", req.input_schema_version == card.input_schema_version, f"請求 {req.input_schema_version!r} vs 模型 {card.input_schema_version!r}")
    # 4. Required features
    missing = [f for f in card.required_features if f not in req.features]
    add("required_features", not missing, "齊全" if not missing else f"缺少 {missing}")
    # 5. Units（單位不同 → 拒絕；單位未知 → 拒絕；單位只是低可信推測 → 降級）
    wrong, unknown, low = [], [], []
    for f, u in card.required_units:
        fi = req.features.get(f)
        if fi is None:
            continue
        if fi.unit_status == "unknown" or fi.unit in ("未知", "", None):
            unknown.append(f)
        elif fi.unit != u:
            wrong.append(f"{f}: {fi.unit!r}≠{u!r}")
        elif fi.unit_status == "inferred_low":
            low.append(f)
    add("units_compatible", not wrong, "一致" if not wrong else f"單位不相容 {wrong}")
    add("units_known", not unknown, "皆已知" if not unknown else f"單位未知 {unknown}（不自行假設或換算）")
    add("units_confidence", not low, "無低可信度單位" if not low else f"低可信度推測單位 {low}", "warn")
    # 6. Sampling frequency
    if card.expected_freq_hours is not None:
        add("sampling_frequency", req.freq_hours == card.expected_freq_hours, f"請求 {req.freq_hours} h vs 模型 {card.expected_freq_hours} h")
    # 7. Model status / version / scope / artifact
    runnable = card.model_status == ST_VALIDATED or (card.model_status == ST_EXPERIMENTAL and req.allow_experimental)
    add("model_status", runnable, f"狀態 {card.model_status!r}" + ("" if runnable else "：不可執行"))
    if card.model_status == ST_EXPERIMENTAL and req.allow_experimental:
        add("model_experimental", False, "實驗性模型：結果必須標示 Experimental", "warn")
    scope_ok = card.usage_scope == "any" or (card.usage_scope == "demonstration_only" and req.replay_mode == "demonstration") \
        or (card.usage_scope == "strict_backtest" and req.replay_mode in ("strict", "live"))
    add("usage_scope", scope_ok, f"模型用途 {card.usage_scope!r}，請求模式 {req.replay_mode!r}")
    add("has_artifact", bool(card.artifact_files), "有 artifact" if card.artifact_files else "沒有 artifact（尚未訓練）")
    if verify_artifacts and card.artifact_files:
        r = Path(root) if root else ROOT
        bad = [rel for rel, sha in card.artifact_files if not (r / rel).is_file() or sha256_file(r / rel) != sha]
        add("artifact_integrity", not bad, "sha256 與登記一致" if not bad else f"遺失或 sha256 不符：{bad}")
    if req.training_data_fingerprint_now and card.training_data_fingerprint:
        add("training_data_matches_current", req.training_data_fingerprint_now == card.training_data_fingerprint,
            "訓練資料指紋與目前資料一致" if req.training_data_fingerprint_now == card.training_data_fingerprint else "目前資料集內容與登記的訓練資料不同（資料可能已更新；模型沒有重訓）", "warn")
    # 8. Training cutoff vs as_of（不得用訓練截止之後才存在的模型去『回放』過去）
    if req.as_of is not None and card.valid_from:
        t = pd.Timestamp(req.as_of)
        exists = t >= pd.Timestamp(card.valid_from)
        if req.replay_mode == "strict":
            add("model_existed_at_as_of", exists and (card.training_cutoff is None or t > pd.Timestamp(card.training_cutoff)),
                f"as_of={t} ；模型凍結 {card.valid_from}、最後訓練標籤 {card.training_cutoff}（嚴格回測要求模型在當時已存在）")
        elif req.replay_mode == "demonstration" and card.training_cutoff and t <= pd.Timestamp(card.training_cutoff):
            add("in_sample", False, "as_of 落在模型訓練期間內：示範結果不得計分、不是績效", "warn")
    # 9. 資料品質與歷史長度
    if req.quality_score is not None and card.min_quality_score:
        add("data_quality", req.quality_score >= card.min_quality_score, f"品質分數 {req.quality_score:.1f} vs 最低 {card.min_quality_score:.1f}",
            "block" if req.quality_score < card.min_quality_score - 20 else "warn")
    if req.n_history_hours is not None and card.min_history_hours:
        add("history_length", req.n_history_hours >= card.min_history_hours, f"可用歷史 {req.n_history_hours} h vs 最少 {card.min_history_hours} h")
    blocked = any((not c.passed) and c.severity == "block" for c in ck)
    degraded = any((not c.passed) and c.severity == "warn" for c in ck)
    return GateResult("refuse" if blocked else ("degrade" if degraded else "allow"), card.key, ck)


# ============================================================ 登錄表
def _hash_df_prefix(df: pd.DataFrame, upto: str | None) -> str:
    d = df if upto is None else df[df["timestamp"] <= pd.Timestamp(upto)]
    return hashlib.sha256(d.to_csv(index=False, float_format="%.10g").encode("utf-8")).hexdigest()[:16]


def _policy_version(path: Path = POLICY_PATH) -> str | None:
    try:
        return str(yaml.safe_load(path.read_text(encoding="utf-8"))["policy_version"])
    except Exception:  # noqa: BLE001
        return None


def _sheep_metrics(path: Path = RESULTS_SUMMARY) -> tuple:
    try:
        p = json.loads(path.read_text())["prediction"]
        return tuple((k, float(p[k])) for k in ("n_scored", "MAE", "RMSE", "interval_coverage") if k in p)
    except Exception:  # noqa: BLE001
        return ()


def sheep_cards(root: Path | str = ROOT) -> list[ModelCard]:
    """由 Phase 3 的 model_registry.json 產生羊舍模型卡片（只讀，不載入模型）。"""
    root = Path(root)
    reg = json.loads((root / "models" / "phase3" / "model_registry.json").read_text())
    try:
        df, _ = DS.load_domain("羊舍", root)
    except Exception:  # noqa: BLE001
        df = None
    units = {}
    for f in SHEEP_REQUIRED_FEATURES:
        units[f] = DS.column_semantics(f)["unit"]
    pol, metrics = _policy_version(root / "config" / "decision_policy.yaml"), _sheep_metrics(root / "outputs" / "phase3" / "results_summary.json")
    proto = "Phase 3 嚴格歷史回測（543 個回放時間點，7 個凍結折）；探索性證據，不是獨立前瞻測試；門檻 THI=84 為研究候選值"
    cards = []
    for m in [*reg["models"], reg["full_data_model"]]:
        strict = m["kind"] == "strict_fold"
        af = ((m["phase25_path"], m["phase25_sha256"]), (m["phase26_path"], m["phase26_sha256"]))
        art = hashlib.sha256((m["phase25_sha256"] + m["phase26_sha256"]).encode()).hexdigest()[:16]
        cards.append(ModelCard(
            model_id="sheep_barn.thi_h3.hgb_cqr", model_version=m["version"], domain_id="livestock_barn", site_id="sheep_barn", task_type="forecast_risk",
            target_variable="成羊區THI", prediction_horizon_h=3, required_features=SHEEP_REQUIRED_FEATURES, required_units=tuple(units.items()),
            input_schema_version=SHEEP_INPUT_SCHEMA, expected_freq_hours=1.0,
            training_data_fingerprint=_hash_df_prefix(df, m["data_cutoff"]) if df is not None else None,
            training_data_basis=f"parsed rows with timestamp <= {m['data_cutoff']} (recomputed from the current CSV; not recorded at training time)",
            model_artifact_fingerprint=art, artifact_files=af, training_cutoff=str(m["data_cutoff"]), valid_from=str(m["train_until"]),
            evaluation_protocol=proto, evaluation_metrics=metrics if not strict else (), policy_id="sheep_barn.high_thi", policy_version=pol,
            model_status=ST_VALIDATED, usage_scope="strict_backtest" if strict else "demonstration_only",
            min_quality_score=60.0, min_history_hours=24,
            notes=("嚴格折：只能用於凍結時間之後的回放。" if strict else "全資料模型：只供 Demonstration Replay（in-sample），嚴格回測絕不使用。")
            + (" evaluation_metrics 為整體 strict 回測彙總，非單一折。" if not strict else " 整體回測彙總見 full_data_formal 卡片。")))
    return cards


def catalog_cards(path: Path = CATALOG_PATH) -> list[ModelCard]:
    """其他場域／任務的卡片（尚未訓練）。來自 config/domain_model_catalog.yaml。"""
    d = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    cards = []
    for e in d.get("models", []):
        cards.append(ModelCard(
            model_id=e["model_id"], model_version=str(e.get("model_version", "none")), domain_id=e["domain_id"], site_id=e["site_id"], task_type=e["task_type"],
            target_variable=e["target_variable"], prediction_horizon_h=e.get("prediction_horizon_h"), required_features=tuple(e.get("required_features", ())),
            required_units=tuple((k, v) for k, v in (e.get("required_units") or {}).items()), input_schema_version=e.get("input_schema_version", "none"),
            expected_freq_hours=e.get("expected_freq_hours"), training_data_fingerprint=None, training_data_basis="not trained",
            model_artifact_fingerprint=None, artifact_files=(), training_cutoff=None, valid_from=None,
            evaluation_protocol=e.get("evaluation_protocol", "not defined (Phase 5.2 will define before any run)"), evaluation_metrics=(),
            policy_id=None, policy_version=None, model_status=e["model_status"], usage_scope="any",
            min_quality_score=float(e.get("min_quality_score", 0)), min_history_hours=int(e.get("min_history_hours", 0)), notes=e.get("notes", "")))
    # ---- Phase 5.2：偵測器型卡片（可帶 artifact；狀態只能是 Experimental 或 Existing / Validated 之外的非驗證狀態——這裡不允許直接宣稱 Validated）
    for e in d.get("detector_models", []):
        if e["model_status"] not in (ST_EXPERIMENTAL, ST_CANDIDATE):
            raise ValueError(f"{e['model_id']}: detector_models 的狀態只能是 Experimental 或 Candidate（本階段沒有任何偵測器通過 Validated 的條件）")
        af = tuple((a["path"], a["sha256"]) for a in e.get("artifact_files", []))
        cards.append(ModelCard(
            model_id=e["model_id"], model_version=str(e["model_version"]), domain_id=e["domain_id"], site_id=e["site_id"], task_type=e["task_type"],
            target_variable=e["target_variable"], prediction_horizon_h=None, required_features=tuple(e.get("required_features", ())),
            required_units=tuple((k, v) for k, v in (e.get("required_units") or {}).items()), input_schema_version=e["input_schema_version"],
            expected_freq_hours=e.get("expected_freq_hours"), training_data_fingerprint=e.get("training_data_fingerprint"), training_data_basis=e.get("training_data_basis", ""),
            model_artifact_fingerprint=hashlib.sha256("".join(h for _, h in af).encode()).hexdigest()[:16] if af else None, artifact_files=af,
            training_cutoff=e.get("training_cutoff"), valid_from=e.get("valid_from"), evaluation_protocol=e.get("evaluation_protocol", ""),
            evaluation_metrics=tuple((k, float(v)) for k, v in (e.get("evaluation_metrics") or {}).items()), policy_id=None, policy_version=None,
            model_status=e["model_status"], usage_scope=e.get("usage_scope", "any"), min_quality_score=float(e.get("min_quality_score", 0)),
            min_history_hours=int(e.get("min_history_hours", 0)), notes=e.get("notes", ""), detector_id=e.get("detector_id"),
            detector_version=e.get("detector_version"), threshold_version=e.get("threshold_version"), promotion_stage=e.get("promotion_stage")))
    return cards


class DomainModelRegistry:
    def __init__(self, root: Path | str = ROOT, catalog_path: Path | str | None = None):
        self.root = Path(root)
        self.catalog_path = Path(catalog_path) if catalog_path else self.root / "config" / "domain_model_catalog.yaml"
        self.cards: list[ModelCard] = [*sheep_cards(self.root), *catalog_cards(self.catalog_path)]
        keys = [c.key for c in self.cards]
        if len(keys) != len(set(keys)):
            raise ValueError("model_id@model_version 重複")
        for c in self.cards:                                              # 每張卡的 domain/site 必須是已登記的
            if c.domain_id not in DS.domain_ids() or c.site_id not in {s.site_id for s in DS.DOMAINS.values()}:
                raise ValueError(f"{c.key}: 未登記的 domain/site ({c.domain_id}/{c.site_id})")

    # ---- 查詢
    def get(self, model_id: str, version: str) -> ModelCard:
        for c in self.cards:
            if c.model_id == model_id and c.model_version == version:
                return c
        raise KeyError(f"{model_id}@{version} 不在登錄表中")

    def list(self, domain_id: str | None = None, site_id: str | None = None, task_type: str | None = None, status: str | None = None) -> list[ModelCard]:
        return [c for c in self.cards if (domain_id is None or c.domain_id == domain_id) and (site_id is None or c.site_id == site_id)
                and (task_type is None or c.task_type == task_type) and (status is None or c.model_status == status)]

    def status_of(self, site_id: str, task_type: str) -> str:
        """某場域某任務目前的『最佳』狀態；找不到卡片 = Unavailable（不是 Candidate，也不是可用）。"""
        order = {s: i for i, s in enumerate(MODEL_STATUSES)}
        cs = self.list(site_id=site_id, task_type=task_type)
        return min((c.model_status for c in cs), key=lambda s: order[s]) if cs else ST_UNAVAILABLE

    # ---- 選擇：回傳（卡片, 閘門結果）；沒有任何可執行模型就回傳 (None, 各候選的拒絕結果)
    def select(self, req: InferenceRequest, verify_artifacts: bool = False):
        cands = [c for c in self.cards if c.domain_id == req.domain_id and c.site_id == req.site_id and c.task_type == req.task_type and c.target_variable == req.target_variable]
        results = [(c, check_compatibility(c, req, self.root, verify_artifacts)) for c in cands]
        ok = [(c, r) for c, r in results if r.allowed]
        if not ok:
            return None, [r for _, r in results] or [GateResult("refuse", f"{req.domain_id}/{req.site_id}/{req.task_type}", [
                GateCheck("model_exists", False, "block", "此場域／任務沒有任何登記的模型卡片")])]
        best = max(ok, key=lambda cr: pd.Timestamp(cr[0].valid_from) if cr[0].valid_from else pd.Timestamp.min)    # 與 ModelRegistry.eligible 相同：最新的已凍結版本
        return best

    # ---- 版本與指紋
    def fingerprint(self) -> str:
        """登錄表內容指紋：卡片內容（含狀態）＋ catalog 檔位元組。狀態或版本改變 → 指紋改變。"""
        blob = json.dumps([[str(v) for v in c.__dict__.values()] for c in self.cards], ensure_ascii=False, sort_keys=True)
        cat = self.catalog_path.read_bytes() if self.catalog_path.is_file() else b""
        return hashlib.sha256(blob.encode("utf-8") + cat).hexdigest()[:16]

    def table(self) -> pd.DataFrame:
        rows = []
        for c in self.cards:
            rows.append({"model_id": c.model_id, "model_version": c.model_version, "domain_id": c.domain_id, "site_id": c.site_id, "task_type": c.task_type,
                         "target_variable": c.target_variable, "horizon_h": c.prediction_horizon_h, "model_status": c.model_status, "usage_scope": c.usage_scope,
                         "training_cutoff": c.training_cutoff, "valid_from": c.valid_from, "has_artifact": bool(c.artifact_files),
                         "detector_id": c.detector_id, "detector_version": c.detector_version, "threshold_version": c.threshold_version, "promotion_stage": c.promotion_stage,
                         "policy_id": c.policy_id, "policy_version": c.policy_version, "n_required_features": len(c.required_features), "notes": c.notes})
        return pd.DataFrame(rows)


# ============================================================ 由實際資料建立請求
def request_for_dataset(stem: str, task_type: str, target: str, horizon_h: int | None, as_of=None, replay_mode: str = "strict",
                        quality_score: float | None = None, root: Path | str | None = None, allow_experimental: bool = False,
                        input_schema_version: str | None = None) -> InferenceRequest:
    """從登記的資料集推導請求：欄位、單位（來自 sensor_meta 的推測，含可信度）、取樣頻率、可用歷史長度。"""
    spec = DS.spec_for(stem)
    df, _ = DS.load_domain(stem, Path(root) if root else None)
    feats = {c: FeatureInfo(DS.column_semantics(c)["unit"], DS.column_semantics(c)["unit_status"]) for c in df.columns if c != "timestamp"}
    dt = df["timestamp"].diff().dropna()
    freq = float(dt.mode().iloc[0] / pd.Timedelta(hours=1)) if len(dt) else None
    hist = None
    if as_of is not None:
        t = pd.Timestamp(as_of)
        hist = int((df["timestamp"] <= t).sum())                  # as_of（含）以前可用的列數；不看 as_of 之後的資料
    default_schema = SHEEP_INPUT_SCHEMA if spec.site_id == "sheep_barn" else f"{spec.site_id}-wide-hourly-v1"
    return InferenceRequest(domain_id=spec.domain_id, site_id=spec.site_id, task_type=task_type, target_variable=target, features=feats, freq_hours=freq,
                            input_schema_version=input_schema_version or default_schema, horizon_h=horizon_h, as_of=as_of, replay_mode=replay_mode,
                            quality_score=quality_score, n_history_hours=hist, allow_experimental=allow_experimental,
                            training_data_fingerprint_now=None)


def main():
    r = DomainModelRegistry()
    t = r.table()
    print(t.drop(columns=["notes"]).to_string(index=False))
    print("registry fingerprint:", r.fingerprint())


if __name__ == "__main__":
    main()
