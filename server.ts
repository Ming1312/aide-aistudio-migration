import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { createApiRouter } from "./server/routes.ts";

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);

  const PORT = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === "production";

  app.use("/api", createApiRouter({ tasksFile: process.env.TASKS_FILE || "state/tasks.json" }));

  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), "dist");
    const publicDir = path.resolve(process.cwd(), "public");
    if (existsSync(distDir)) {
      app.use(express.static(distDir));
    } else if (existsSync(publicDir)) {
      app.use(express.static(publicDir));
    }
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api/") || req.path.startsWith("/data/")) {
        next();
        return;
      }
      const indexFile = path.join(distDir, "index.html");
      if (existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send("Build output not found. Run npm run build first.");
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`AIDE server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
