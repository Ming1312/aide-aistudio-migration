"""
產生管理者密碼的『雜湊』（PBKDF2-HMAC-SHA256、隨機鹽、200000 次；格式 pbkdf2$<次數>$<鹽hex>$<雜湊hex>，與 reference/adminAuth.ts 相容）。
在你自己的終端機執行（輸入時畫面不會顯示）：  python tools/make_admin_hash.py
只印出雜湊；密碼不會被儲存、不會寫檔、不會連網。把印出的那一行放進 AI Studio → Settings → Secrets 的 ADMIN_PASSPHRASE_HASH。
請用夠長的密碼（至少 12 個字元）。不要把密碼或雜湊貼進聊天或 Prompt。
"""
import getpass
import hashlib
import os
import sys


def main() -> int:
    a = getpass.getpass("管理者密碼（至少 12 個字元；輸入時不會顯示）：")
    if a != getpass.getpass("再輸入一次："):
        print("兩次輸入不同，已取消。")
        return 1
    if len(a) < 12:
        print("密碼太短（至少 12 個字元），已取消。")
        return 1
    salt = os.urandom(16)
    print("\nADMIN_PASSPHRASE_HASH=pbkdf2$200000$%s$%s" % (salt.hex(), hashlib.pbkdf2_hmac("sha256", a.encode("utf-8"), salt, 200000).hex()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
