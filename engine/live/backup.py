"""
live/backup.py — 即時版本庫的備份與還原（營運用）

  python -m live.backup create  <版本庫資料夾> <輸出資料夾>
  python -m live.backup restore <備份檔.tar.gz> <還原到的資料夾> [--force]

* 備份＝版本庫資料夾的 tar.gz ＋ 旁邊的 .manifest.json（檔案數、位元組數、整包 sha256）。只備份 live_store（版本庫、稽核、預測紀錄、事件）；
  原始資料與模型本來就在映像裡，不需要備份。
* 備份前先取得每個場域的鎖，避免備份到寫到一半的版本（版本庫本身是原子提交，所以即使沒有鎖，也只會多一個不完整的 .tmp 目錄，會被排除）。
* 還原預設拒絕寫入非空資料夾；還原後逐場域執行 Store.verify()（雜湊鏈）才算成功，失敗就清掉剛還原的內容。
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tarfile
import time
from pathlib import Path

EXCLUDE_NAMES = {"lock", "journal.json"}


def _sha(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def create(root: str | Path, out_dir: str | Path) -> dict:
    root, out_dir = Path(root).resolve(), Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"aide-live-{time.strftime('%Y%m%d-%H%M%S')}.tar.gz"
    arc = out_dir / name
    n_files = n_bytes = 0
    with tarfile.open(arc, "w:gz") as tf:
        for p in sorted(root.rglob("*")):
            if not p.is_file():
                continue
            parts = p.relative_to(root).parts
            if any(part in EXCLUDE_NAMES or part.startswith(".tmp-") for part in parts):
                continue
            tf.add(p, arcname=str(p.relative_to(root)))
            n_files += 1
            n_bytes += p.stat().st_size
    man = {"archive": name, "files": n_files, "bytes": n_bytes, "sha256": _sha(arc), "created_at": time.strftime("%Y-%m-%d %H:%M:%S"), "format": "aide-live-backup-v1"}
    (out_dir / (name + ".manifest.json")).write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
    return man | {"path": str(arc)}


def restore(archive: str | Path, root: str | Path, catalog: dict | None = None, force: bool = False) -> dict:
    archive, root = Path(archive).resolve(), Path(root).resolve()
    mp = Path(str(archive) + ".manifest.json")
    if mp.is_file():
        man = json.loads(mp.read_text(encoding="utf-8"))
        if man["sha256"] != _sha(archive):
            raise RuntimeError("備份檔的雜湊與 manifest 不符：拒絕還原")
    if root.exists() and any(root.iterdir()) and not force:
        raise RuntimeError("還原目標資料夾不是空的（加 --force 才會覆寫）")
    root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tf:
        for m in tf.getmembers():
            if m.name.startswith("/") or ".." in Path(m.name).parts:
                raise RuntimeError(f"備份檔內含不安全的路徑：{m.name}")
        tf.extractall(root, filter="data")
    problems = []
    if catalog:
        import p586_store as ST
        for d in catalog["datasets"]:
            if (root / d["stem"] / "manifest.json").is_file():
                v = ST.Store(d["stem"], root=root).verify()
                if not v.get("ok"):
                    problems.append(f"{d['id']}: {v.get('problems')}")
    if problems:
        shutil.rmtree(root, ignore_errors=True)
        raise RuntimeError("還原後完整性檢查失敗，已清除：" + "；".join(problems)[:300])
    return {"restored_to": str(root), "ok": True}


if __name__ == "__main__":
    here = Path(__file__).resolve().parent.parent
    sys.path[:0] = [str(here / "src"), str(here)]
    a = sys.argv[1:]
    if len(a) >= 3 and a[0] == "create":
        print(json.dumps(create(a[1], a[2]), ensure_ascii=False, indent=1))
    elif len(a) >= 3 and a[0] == "restore":
        cat = json.loads((here / "catalog.json").read_text(encoding="utf-8"))
        print(json.dumps(restore(a[1], a[2], cat, "--force" in a), ensure_ascii=False, indent=1))
    else:
        print(__doc__)
        sys.exit(2)
