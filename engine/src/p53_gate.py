"""
p53_gate.py — Phase 5.3：平台層的 Compatibility Gate 路由器

所有場域的分析請求（預測、風險、統計異常）在執行任何模型／偵測器之前，都必須先經過這裡：
  請求 → domain_registry.request_for_dataset（由實際資料推導欄位、單位、頻率、歷史長度）→ 逐張模型卡 check_compatibility → allow／degrade／refuse
不相容就拒絕或明確降級；絕不改用別的場域或別的任務的模型。每次檢查都留下紀錄（calls），測試用它證明 UI 沒有繞過 Gate。
Experimental 模型只有在呼叫端明確 opt-in（allow_experimental=True）時才可能被允許；opt-in 只影響這一次請求，不改變任何模型卡的狀態。
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import domain_registry as DR  # noqa: E402
import domain_schema as DS  # noqa: E402

MODE_TO_GATE = {"strict_backtest": "strict", "demonstration": "demonstration", "strict": "strict"}


@dataclass
class GateOutcome:
    stem: str
    site_id: str | None
    task_type: str
    target: str
    decision: str                                   # allow | degrade | refuse
    allowed_cards: list = field(default_factory=list)       # 允許執行的卡片（依 valid_from 新到舊）
    checked: list = field(default_factory=list)             # [(card_key, GateResult)]
    reasons: list = field(default_factory=list)
    experimental_used: bool = False
    opt_in: bool = False

    @property
    def allowed(self) -> bool:
        return self.decision in ("allow", "degrade") and bool(self.allowed_cards)

    @property
    def card(self):
        return self.allowed_cards[0] if self.allowed_cards else None


class GateRouter:
    def __init__(self, registry: DR.DomainModelRegistry | None = None, root: Path | str | None = None):
        self.registry = registry or DR.DomainModelRegistry()
        self.root = root
        self.calls: list[dict] = []

    def check(self, stem: str, task_type: str, target: str, *, horizon_h: int | None = None, as_of=None, replay_mode: str = "strict", quality_score: float | None = None,
              allow_experimental: bool = False, verify_artifacts: bool = True) -> GateOutcome:
        rec = {"stem": stem, "task_type": task_type, "target": target, "as_of": None if as_of is None else str(as_of), "replay_mode": replay_mode, "opt_in": bool(allow_experimental)}
        self.calls.append(rec)
        if stem not in DS.DOMAINS:
            rec["decision"] = "refuse"
            return GateOutcome(stem, None, task_type, target, "refuse", reasons=[f"未登記的場域 {stem!r}（已登記：{sorted(DS.DOMAINS)}）"], opt_in=allow_experimental)
        spec = DS.spec_for(stem)
        try:
            req = DR.request_for_dataset(stem, task_type, target, horizon_h, as_of=as_of, replay_mode=MODE_TO_GATE.get(replay_mode, replay_mode), quality_score=quality_score,
                                         root=self.root, allow_experimental=allow_experimental)
        except Exception as e:  # noqa: BLE001 — 讀不到資料也要拒絕，不能放行
            rec["decision"] = "refuse"
            return GateOutcome(stem, spec.site_id, task_type, target, "refuse", reasons=[f"無法由資料建立請求：{type(e).__name__}"], opt_in=allow_experimental)
        cands = [c for c in self.registry.cards if c.domain_id == req.domain_id and c.site_id == req.site_id and c.task_type == task_type and c.target_variable == target]
        if horizon_h is not None:
            cands = [c for c in cands if c.prediction_horizon_h in (None, horizon_h)]
        checked, ok = [], []
        for c in cands:
            r = DR.check_compatibility(c, req, root=self.root, verify_artifacts=verify_artifacts)
            checked.append((c.key, r))
            if r.allowed:
                ok.append((c, r))
        ok.sort(key=lambda cr: pd.Timestamp(cr[0].valid_from) if cr[0].valid_from else pd.Timestamp.min, reverse=True)
        if not cands:
            reasons = [f"此場域（{spec.site_id}）沒有任何登記的 {task_type} 模型卡片（目標 {target!r}）"]
            out = GateOutcome(stem, spec.site_id, task_type, target, "refuse", reasons=reasons, opt_in=allow_experimental)
        elif not ok:
            reasons = sorted({f"{c.name}: {c.detail}" for _, r in checked for c in r.blocking})
            out = GateOutcome(stem, spec.site_id, task_type, target, "refuse", checked=checked, reasons=reasons, opt_in=allow_experimental)
        else:
            degraded = any(r.decision == "degrade" for _, r in ok)
            reasons = sorted({f"{c.name}: {c.detail}" for _, r in ok for c in r.warnings})
            exp = any(c.model_status == DR.ST_EXPERIMENTAL for c, _ in ok)
            out = GateOutcome(stem, spec.site_id, task_type, target, "degrade" if degraded else "allow", allowed_cards=[c for c, _ in ok], checked=checked, reasons=reasons,
                              experimental_used=exp, opt_in=allow_experimental)
        rec["decision"] = out.decision
        return out

    def attempt_foreign(self, card_key: str, target_stem: str, task_type: str, target: str, *, as_of=None, replay_mode: str = "strict", allow_experimental: bool = True) -> GateOutcome:
        """示範用：明確拿『某張模型卡』去套用另一個資料集（例如羊舍 HGB 套到三爺宮溪）。Gate 必須拒絕，並說明原因。不執行任何模型。"""
        card = next((c for c in self.registry.cards if c.key == card_key), None)
        if card is None:
            raise KeyError(f"{card_key} 不在登錄表中")
        spec = DS.spec_for(target_stem)
        req = DR.request_for_dataset(target_stem, task_type, target, card.prediction_horizon_h, as_of=as_of, replay_mode=MODE_TO_GATE.get(replay_mode, replay_mode),
                                     root=self.root, allow_experimental=allow_experimental)
        r = DR.check_compatibility(card, req, root=self.root, verify_artifacts=True)
        self.calls.append({"stem": target_stem, "task_type": task_type, "target": target, "foreign_card": card_key, "decision": r.decision})
        return GateOutcome(target_stem, spec.site_id, task_type, target, r.decision, allowed_cards=[card] if r.allowed else [], checked=[(card.key, r)],
                           reasons=sorted(f"{c.name}: {c.detail}" for c in r.blocking), opt_in=allow_experimental)
