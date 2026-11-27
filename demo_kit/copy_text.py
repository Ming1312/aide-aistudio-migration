#!/usr/bin/env python3
"""把一段「非機密」文字（例如 Tunnel 網址）放進剪貼簿；按 Enter 或 45 秒後自動清空。只用系統已有的 python3-gi（GTK3）。
金鑰請用 copy_key.sh（金鑰不經過命令列）。"""
from __future__ import annotations

import os
import signal
import sys

TIMEOUT_S = 45


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1].startswith("https://"):
        print("用法：copy_text.py <https 網址>", file=sys.stderr)
        return 2
    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        print("沒有圖形桌面，無法使用剪貼簿", file=sys.stderr)
        return 1
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk, GLib, Gtk
    if not Gtk.init_check()[0]:
        print("GTK 無法初始化", file=sys.stderr)
        return 1
    cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    cb.set_text(sys.argv[1], -1)
    done = {"v": False}

    def finish(*_a):
        if not done["v"]:
            done["v"] = True
            cb.set_text("", -1)
            Gtk.main_quit()

    signal.signal(signal.SIGINT, finish)
    signal.signal(signal.SIGTERM, finish)
    GLib.timeout_add_seconds(TIMEOUT_S, lambda: (finish(), False)[1])

    def on_stdin(*_a):
        sys.stdin.readline()
        finish()
        return False

    GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN, on_stdin)
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
