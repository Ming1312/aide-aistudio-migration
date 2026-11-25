# AIDE Python 引擎（預設唯讀；設定 AIDE_ADMIN_KEY 才開啟即時管線的寫入端點）。私有部署：映像內含模型與（真實）資料，不要推到公開 registry。
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=2
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd -r -u 10001 aide && mkdir -p /app/data/live_store && chown -R aide /app
# 即時管線的版本庫：部署時請把這個路徑掛載成『持久化磁碟』（不是物件儲存掛載、不是暫存空間）；固定單一執行個體
VOLUME ["/app/data/live_store"]
USER aide
EXPOSE 8080
# AIDE_API_KEY 必填（由部署平台的 Secret 注入）；沒設定時引擎會拒絕啟動（見 main.py 的 REQUIRE_KEY）
ENV AIDE_REQUIRE_KEY=1 AIDE_DOCS=0
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
