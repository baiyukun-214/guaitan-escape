import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, build } from "vite";
import {
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";

test("Vite denies server story, private dossier, tests, save files, env and raw-source URLs", async (t) => {
  mkdirSync("data", { recursive: true, mode: 0o700 });
  const fixture = "data/SECURITY-" + randomUUID() + ".json";
  writeFileSync(fixture, "PRIVATE_CANARY_DO_NOT_SERVE", {
    flag: "wx",
    mode: 0o600,
  });
  t.after(() => unlinkSync(fixture));
  const server = await createServer({
    server: { port: 0, host: "127.0.0.1", strictPort: false },
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  t.after(async () => {
    if (server.httpServer && "closeAllConnections" in server.httpServer)
      server.httpServer.closeAllConnections();
    await server.close();
  });
  const url = server.resolvedUrls!.local[0];
  for (const path of [
    "server/story.ts",
    "server/story.ts?raw",
    "server/HOST.md?raw",
    "server/ai.ts",
    "tests/helpers.ts",
    fixture,
    ".env.example",
    "@fs/workspace/guaitan-escape/server/story.ts",
  ]) {
    const r = await fetch(url + path, { signal: AbortSignal.timeout(3000) });
    assert.ok(r.status === 403 || r.status === 404, `${path}: ${r.status}`);
    const text = await r.text();
    assert.ok(!text.includes("为免承担违规开放"));
    assert.ok(!text.includes("export const TRUTH"));
  }
  const frontend = await fetch(url + "src/main.tsx", {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(frontend.status, 200);
});

test("production frontend bundle never contains private host truth or unearned card content", async () => {
  await build({ logLevel: "silent" });
  const js = readdirSync("dist/assets")
    .filter((x) => x.endsWith(".js"))
    .map((x) => readFileSync("dist/assets/" + x, "utf8"))
    .join("\n");
  for (const text of [
    "为免承担违规开放",
    "被截断的后半句",
    "双轨具有完全相同的雨声缺口",
    "封存的洪水报警单",
    "tokenHash",
    "LOCAL_TEST_ONLY",
    "AI_API_KEY",
  ])
    assert.ok(!js.includes(text), text);
  assert.ok(js.includes("离线"));
});
