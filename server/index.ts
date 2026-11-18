import "dotenv/config";
import { createApp } from "./app.js";
const port = Number(process.env.PORT ?? 3001);
const app = createApp({
  dir: process.env.DATA_DIR ?? "./data",
  dev:
    process.env.NODE_ENV !== "production" && process.env.DEV_PLAY !== "false",
  origins: process.env.ALLOWED_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ai: {
    enabled: process.env.AI_ENABLED === "true",
    baseUrl: process.env.AI_BASE_URL,
    key: process.env.AI_API_KEY,
    model: process.env.AI_MODEL,
    timeout: Math.max(
      1000,
      Math.min(30000, Number(process.env.AI_TIMEOUT_MS) || 10000),
    ),
  },
});
app.http.listen(port, process.env.HOST ?? "0.0.0.0", () =>
  console.log(
    `夜班来电 server on :${port}; ${app.game.ai.label}; development sandbox ${process.env.NODE_ENV !== "production" && process.env.DEV_PLAY !== "false" ? "enabled" : "disabled"}`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
