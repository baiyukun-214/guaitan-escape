import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Game, type Room } from "./game.js";
import { HostAI, type AIConfig } from "./ai.js";
export type AppOptions = {
  dir?: string;
  dev?: boolean;
  ai?: AIConfig;
  now?: () => number;
  origins?: string[];
};
export function createApp(options: AppOptions = {}) {
  const app = express(),
    http = createServer(app);
  const allowed = options.origins ?? [];
  const originAllowed = (origin?: string) =>
    !origin ||
    allowed.includes(origin) ||
    (() => {
      try {
        const u = new URL(origin);
        return (
          allowed.length === 0 &&
          ["localhost", "127.0.0.1"].includes(u.hostname)
        );
      } catch {
        return false;
      }
    })();
  const sameHost = (origin: string | undefined, host: string | undefined) => {
    try {
      return !!origin && new URL(origin).host === host;
    } catch {
      return false;
    }
  };
  const io = new Server(http, {
    maxHttpBufferSize: 20000,
    allowRequest: (req, cb) => {
      const o = req.headers.origin;
      const host = req.headers.host;
      cb(null, !o || originAllowed(o) || sameHost(o, host));
    },
  });
  const ai = new HostAI(options.ai ?? { enabled: false, timeout: 10000 });
  const persist = (r: Room) => {
    if (!options.dir) return;
    const p = resolve(options.dir, r.code + ".json");
    writeFileSync(p + ".tmp", JSON.stringify(r), { mode: 0o600 });
    renameSync(p + ".tmp", p);
    chmodSync(p, 0o600);
  };
  const game = new Game(ai, persist, options.now);
  if (options.dir) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    chmodSync(options.dir, 0o700);
    for (const file of readdirSync(options.dir).filter((x) =>
      /^[A-Z2-9]{6}\.json$/.test(x),
    )) {
      try {
        const r = JSON.parse(
          readFileSync(resolve(options.dir, file), "utf8"),
        ) as Room;
        if (r.mode === "dev" && !options.dev) continue;
        if (
          r.code + ".json" !== file ||
          !Array.isArray(r.players) ||
          r.players.length > 3
        )
          continue;
        if (Date.now() - r.created > 7 * 86400000) continue;
        r.duo.start = undefined;
        if (r.penalty) {
          r.penalty.target = undefined;
          r.penalty.expires = undefined;
        }
        game.rooms.set(r.code, r);
      } catch {
        console.warn("一个存档无法读取，已跳过（未打印内容）");
      }
    }
  }
  const locks = new Map<string, Promise<unknown>>();
  const enqueue = <T>(code: string, fn: () => Promise<T> | T): Promise<T> => {
    const next = (locks.get(code) ?? Promise.resolve())
      .catch(() => {})
      .then(fn);
    locks.set(code, next);
    void next
      .finally(() => {
        if (locks.get(code) === next) locks.delete(code);
      })
      .catch(() => {});
    return next;
  };
  const socketsFor = (code: string) =>
    [...io.sockets.sockets.values()].filter((s) => s.data.code === code);
  const publish = (r: Room) => {
    const sockets = socketsFor(r.code),
      online = new Set(sockets.map((s) => s.data.playerId as string));
    for (const s of sockets)
      s.emit(
        "state",
        game.snapshot(r, s.data.viewId ?? s.data.playerId, online),
      );
  };
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20kb" }));
  app.use((req, res, next) => {
    const o = req.headers.origin;
    if (o && !originAllowed(o) && !sameHost(o, req.headers.host)) {
      res.status(403).json({ error: "来源不允许" });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  const ipBuckets = new Map<string, { count: number; at: number }>();
  app.use("/api", (req, res, next) => {
    const key = req.socket.remoteAddress ?? "local",
      old = ipBuckets.get(key),
      now = Date.now();
    const bucket = old && now - old.at < 60000 ? old : { count: 0, at: now };
    bucket.count++;
    ipBuckets.set(key, bucket);
    if (bucket.count > 120) {
      res.status(429).json({ error: "请求过快，请稍后再试" });
      return;
    }
    next();
  });
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, aiMode: ai.label, devAvailable: !!options.dev }),
  );
  const input = z.object({
    name: z.string().trim().min(1).max(16),
    dev: z.boolean().optional(),
  });
  app.post("/api/rooms", (req, res) => {
    try {
      const a = input.parse(req.body);
      if (a.dev && !options.dev) {
        res.status(403).json({ error: "开发试玩已关闭" });
        return;
      }
      res.json(game.create(a.name, !!a.dev));
    } catch {
      res.status(400).json({ error: "无法创建房间，请检查昵称或稍后重试" });
    }
  });
  app.post("/api/rooms/:code/join", (req, res) => {
    try {
      const a = input.parse(req.body);
      const code = z
        .string()
        .regex(/^[A-Z2-9]{6}$/)
        .parse(req.params.code);
      const credentials = game.join(code, a.name);
      res.json(credentials);
      publish(game.rooms.get(code)!);
    } catch (e) {
      res.status(400).json({
        error: e instanceof z.ZodError ? "输入格式错误" : (e as Error).message,
      });
    }
  });
  app.use(express.static(resolve("dist")));
  io.use((socket, next) => {
    try {
      const a = z
        .object({ code: z.string().length(6), token: z.string().length(64) })
        .parse(socket.handshake.auth);
      const { r, p } = game.auth(a.code, a.token);
      if (r.mode === "dev" && !options.dev) throw Error("开发试玩已关闭");
      socket.data.code = r.code;
      socket.data.playerId = p.id;
      next();
    } catch {
      next(Error("身份验证失败"));
    }
  });
  const narrating = new Set<string>();
  io.on("connection", (socket) => {
    const r = game.rooms.get(socket.data.code)!;
    publish(r);
    let rate = { at: Date.now(), count: 0 };
    socket.on("action", async (raw, ack) => {
      if (typeof ack !== "function") return;
      if (Date.now() - rate.at > 60000) rate = { at: Date.now(), count: 0 };
      if (++rate.count > 100) {
        ack({ ok: false, error: "操作太快，请稍后" });
        return;
      }
      try {
        await enqueue(r.code, async () => {
          await game.command(r, socket.data.playerId, raw);
          publish(r);
        });
        ack({ ok: true });
      } catch (e) {
        ack({
          ok: false,
          error:
            e instanceof z.ZodError ? "操作格式不正确" : (e as Error).message,
        });
      }
    });
    socket.on("view", (raw, ack) => {
      try {
        const playerId = z.string().parse(raw);
        if (r.mode !== "dev" || socket.data.playerId !== r.host || !options.dev)
          throw Error("真人房间不允许切换他人视角");
        if (!r.players.some((p) => p.id === playerId))
          throw Error("席位不存在");
        socket.data.viewId = playerId;
        publish(r);
        if (typeof ack === "function") ack({ ok: true });
      } catch (e) {
        if (typeof ack === "function")
          ack({ ok: false, error: (e as Error).message });
      }
    });
    socket.on("disconnect", () => publish(r));
    // The model only gets public earned cards for atmosphere, never private hands or the rubric.
    if (ai.configured && !narrating.has(r.code)) {
      narrating.add(r.code);
      void enqueue(r.code, async () => {
        await game.atmosphere(r);
        publish(r);
      });
    }
  });
  const timer = setInterval(() => {
    for (const r of game.rooms.values())
      void enqueue(r.code, () => {
        if (game.expire(r)) publish(r);
      });
  }, 1000);
  timer.unref();
  return {
    app,
    http,
    io,
    game,
    async close() {
      clearInterval(timer);
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}
