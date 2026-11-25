#!/usr/bin/env python3
"""啟動前守門：讀 `docker compose config --format json` 的輸出（stdin），驗證「真正會被啟動的設定」。
只印出判定與有問題的項目名稱，【不印任何值】（compose 會把 env 檔的內容展開進輸出，包含 API 金鑰，所以只能經管線進來）。
用法：compose ... config --format json | python3 compose_gate.py <caddy 映像（含 digest）>
結束碼：0 通過；1 有問題。"""
from __future__ import annotations

import json
import sys

FORBIDDEN_ENV = {"AIDE_ADMIN_KEY", "AIDE_ALLOW_SIM", "ENGINE_ADMIN_KEY", "GEMINI_API_KEY", "GEMINI_MODEL",
                 "GOOGLE_API_KEY", "AIDE_DATA_DIR", "AIDE_ALLOWED_ORIGINS"}
EXPECTED_VOLUMES = {("/var/lib/aide/live_store", "/app/data/live_store"), ("/var/backups/aide", "/backups")}


def check(cfg: dict, caddy_image: str) -> list[str]:
    bad: list[str] = []
    svcs = cfg.get("services") or {}
    if set(svcs) != {"engine", "caddy"}:
        bad.append(f"服務清單不是 engine+caddy：{sorted(svcs)}")
    eng, cad = svcs.get("engine") or {}, svcs.get("caddy") or {}
    if eng.get("ports"):
        bad.append("engine 有 ports（引擎 8080 不可發佈到主機）")
    cp = cad.get("ports") or []
    if not (len(cp) == 1 and cp[0].get("host_ip") == "127.0.0.1" and str(cp[0].get("published")) == "8088"
            and cp[0].get("target") == 80 and cp[0].get("protocol", "tcp") == "tcp"):
        bad.append("caddy 的 ports 不是『只有 127.0.0.1:8088->80』")
    env = eng.get("environment") or {}
    if isinstance(env, list):  # 保險：有些版本輸出 KEY=VALUE 清單
        env = dict(x.split("=", 1) if "=" in x else (x, None) for x in env)
    hit = sorted(FORBIDDEN_ENV & set(env))
    if hit:
        bad.append(f"engine 環境含不允許的名稱：{hit}")
    if env.get("AIDE_REQUIRE_KEY") != "1":
        bad.append("engine 的 AIDE_REQUIRE_KEY 不是 1")
    if env.get("AIDE_LIVE_ROOT") != "/app/data/live_store":
        bad.append("engine 的 AIDE_LIVE_ROOT 不是 /app/data/live_store")
    if not env.get("AIDE_API_KEY"):
        bad.append("engine 沒有 AIDE_API_KEY")
    vols = {(v.get("source"), v.get("target")) for v in (eng.get("volumes") or [])}
    if vols != EXPECTED_VOLUMES:
        bad.append("engine 的掛載不是預期的 live_store 與 backups 兩個 bind mount")
    for name, s in svcs.items():
        for k in ("privileged", "pid", "ipc", "cap_add", "devices", "security_opt", "extra_hosts"):
            if s.get(k):
                bad.append(f"{name} 使用了 {k}")
        if s.get("network_mode"):
            bad.append(f"{name} 使用了 network_mode={s.get('network_mode')}")
    if (cad.get("environment") or {}).get("AIDE_DOMAIN") != "http://:80":
        bad.append("caddy 的 AIDE_DOMAIN 不是 http://:80（不可申請憑證）")
    if caddy_image and cad.get("image") != caddy_image:
        bad.append("caddy 映像不是固定的 digest 版本")
    return bad


def main() -> int:
    try:
        cfg = json.load(sys.stdin)
    except Exception:  # noqa: BLE001
        print("無法解析 compose 設定（不是 JSON）")
        return 1
    bad = check(cfg, sys.argv[1] if len(sys.argv) > 1 else "")
    for b in bad:
        print("  ✗ " + b)
    print("compose 解析結果：" + ("通過" if not bad else f"{len(bad)} 項不符"))
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
