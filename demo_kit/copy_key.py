#!/usr/bin/env python3
"""把 AIDE_API_KEY 放進剪貼簿（不顯示在螢幕），按 Enter 或 45 秒後自動清空。
只用系統已有的 python3-gi（GTK3）：不安裝任何東西、不留下背景行程、金鑰不經過命令列。
結束（含 Ctrl+C）時一律清空剪貼簿。"""
from __future__ import annotations

import os
import signal
import sys

TIMEOUT_S = 45


def read_key(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s.startswith("AIDE_API_KEY="):
                    return s.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return ""


def main() -> int:
    if len(sys.argv) != 2:
        print("用法：copy_key.py <env 檔>", file=sys.stderr)
        return 2
    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        print("沒有圖形桌面（DISPLAY／WAYLAND_DISPLAY），無法使用剪貼簿", file=sys.stderr)
        return 1
    key = read_key(sys.argv[1])
    if not key:
        print("讀不到 AIDE_API_KEY", file=sys.stderr)
        return 1
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk, GLib, Gtk
    if not Gtk.init_check()[0]:
        print("GTK 無法初始化", file=sys.stderr)
        return 1
    cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    cb.set_text(key, -1)           # 不呼叫 store()：不要求剪貼簿管理員另外保存一份
    key = ""
    done = {"v": False}

    def finish(*_a):
        if not done["v"]:
            done["v"] = True
            cb.set_text("", -1)
            cb.clear()
            Gtk.main_quit()
        return False

    GLib.timeout_add_seconds(TIMEOUT_S, finish)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, finish)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, finish)
    try:
        tty = open("/dev/tty")
        GLib.io_add_watch(tty.fileno(), GLib.IO_IN, lambda *_a: finish())
    except OSError:
        pass
    print(f"已放進剪貼簿（沒有顯示）。貼到 AI Studio 的 ENGINE_API_KEY 後，回到這裡按 Enter；{TIMEOUT_S} 秒後也會自動清空。")
    Gtk.main()
    print("剪貼簿已清空。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
