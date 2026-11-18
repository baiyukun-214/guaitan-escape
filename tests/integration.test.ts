import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.js";
import type { Credentials, View } from "../src/shared.js";
import { solution, guesses } from "./helpers.js";
async function serve(options: Parameters<typeof createApp>[0] = {}) {
  const app = createApp(options);
  await new Promise<void>((r) => app.http.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + (app.http.address() as AddressInfo).port;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { ...app, url, post };
}
async function connect(url: string, c: Credentials) {
  const s = io(url, {
    auth: { code: c.code, token: c.token },
    transports: ["websocket"],
    reconnection: false,
    autoConnect: false,
  });
  let latest: View;
  s.on("state", (v) => (latest = v));
  await new Promise<void>((res, rej) => {
    s.once("connect", () => res());
    s.once("connect_error", rej);
    s.connect();
  });
  await new Promise<void>((r) => {
    if (latest!) r();
    else s.once("state", () => r());
  });
  return { s, view: () => latest! };
}
async function waitView(
  client: { s: Socket; view: () => View },
  predicate: (v: View) => boolean,
) {
  if (predicate(client.view())) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.s.off("state", listener);
      reject(Error("state update timeout"));
    }, 2000);
    const listener = (v: View) => {
      if (predicate(v)) {
        clearTimeout(timer);
        client.s.off("state", listener);
        resolve();
      }
    };
    client.s.on("state", listener);
  });
}
const emit = (s: Socket, action: unknown, options: any = {}) =>
  s
    .timeout(3000)
    .emitWithAck("action", { id: randomUUID(), action, ...options });
async function good(s: Socket, action: unknown, options: any = {}) {
  const a = await emit(s, action, options);
  assert.equal(a.ok, true, a.error);
}

test("HTTP/Socket: three-user complete game, auth, reconnect, concurrent dedupe, privacy and exact role permissions", async (t) => {
  let time = Date.now();
  const app = await serve({ now: () => time });
  t.after(() => app.close());
  const sockets: Socket[] = [];
  t.after(() => sockets.forEach((s) => s.disconnect()));
  const a = (await app.post("/api/rooms", { name: "档案员" }))
    .body as Credentials;
  const b = (await app.post(`/api/rooms/${a.code}/join`, { name: "计时员" }))
    .body as Credentials;
  const c = (await app.post(`/api/rooms/${a.code}/join`, { name: "报时员" }))
    .body as Credentials;
  assert.equal(
    (await app.post(`/api/rooms/${a.code}/join`, { name: "第四人" })).status,
    400,
  );
  const clients = await Promise.all([a, b, c].map((x) => connect(app.url, x)));
  clients.forEach((x) => sockets.push(x.s));
  const [A, B, C] = clients;
  assert.match(
    (await fetch(app.url + "/api/health").then((r) => r.json())).aiMode,
    /非AI/,
  );
  assert.equal(
    (await emit(B.s, { type: "start", solo: a.playerId })).ok,
    false,
  );
  assert.equal(
    (await B.s.timeout(1000).emitWithAck("view", a.playerId)).ok,
    false,
  );
  assert.equal(
    (await emit(B.s, { type: "skill", skill: "medic" }, { actor: a.playerId }))
      .ok,
    false,
  );
  for (const x of clients) await good(x.s, { type: "skill", skill: "medic" });
  await good(A.s, { type: "start", solo: a.playerId });
  await good(B.s, { type: "hypotheses", guesses });
  await waitView(A, (v) => v.phase === "tasks");
  assert.equal(A.view().phase, "tasks");
  assert.equal(A.view().hypothesisCount, 5);
  const duplicate = {
    id: randomUUID(),
    action: { type: "search", answer: "直接摸电线" },
  };
  const ack = await Promise.all([
    A.s.timeout(1000).emitWithAck("action", duplicate),
    A.s.timeout(1000).emitWithAck("action", duplicate),
  ]);
  assert.ok(ack.every((x) => x.ok));
  assert.equal(A.view().players[0].hp, 4);
  assert.equal(
    (await emit(C.s, { type: "search", answer: "断开红色电源" })).ok,
    false,
  );
  await good(A.s, { type: "search", answer: "断开红色电源" });
  assert.equal(A.view().cards.length, 1);
  assert.equal(B.view().cards.length, 0);
  assert.equal(C.view().cards.length, 0);
  const unauthorized = JSON.stringify(B.view());
  assert.ok(!unauthorized.includes("封存的洪水报警单"));
  assert.ok(!unauthorized.includes("tokenHash"));
  assert.ok(!unauthorized.includes(a.token));
  assert.equal(B.view().reveal, undefined);
  // Reconnect using only original credentials; no new player created or clue lost.
  A.s.disconnect();
  const reconnected = await connect(app.url, a);
  sockets.push(reconnected.s);
  assert.equal(reconnected.view().cards[0].id, "S1");
  assert.equal(reconnected.view().players.length, 3);
  await good(reconnected.s, {
    type: "search",
    answer: "核对纸质签名和闸机日志",
  });
  await good(reconnected.s, { type: "search", answer: "上层检修梯手动绞盘" });
  for (let n = 0; n < 3; n++) {
    await good(B.s, { type: "hold" });
    time += 7400;
    await good(B.s, { type: "release" });
    await waitView(C, (v) => v.tasks.duo.ready);
    assert.equal(C.view().tasks.duo.hint, 7);
    assert.ok(!JSON.stringify(C.view()).includes("7400"));
    await good(C.s, { type: "guessTime", seconds: 7 });
  }
  assert.equal(C.view().phase, "deduction");
  for (const x of [reconnected, C])
    for (const card of x.view().cards)
      await good(x.s, { type: "publish", card: card.id });
  await good(B.s, { type: "combine", a: "S1", b: "D1" });
  assert.ok(B.view().shared.some((c) => c.id === "C1"));
  await good(C.s, { type: "truth", text: "大家都在睡觉，没有事故" });
  await waitView(B, (v) => !!v.penalty);
  assert.ok(B.view().penalty);
  assert.equal(C.view().players[2].hp, 5);
  await good(B.s, { type: "nominate", target: c.playerId });
  assert.equal((await emit(B.s, { type: "confirm", accept: true })).ok, false);
  const consent = {
    id: randomUUID(),
    action: { type: "confirm", accept: true },
  };
  await C.s.timeout(1000).emitWithAck("action", consent);
  await C.s.timeout(1000).emitWithAck("action", consent);
  assert.equal(C.view().players[2].hp, 4);
  await good(C.s, { type: "truth", text: solution });
  assert.equal(C.view().phase, "ended");
  assert.match(C.view().reveal!, /陈原/);
  assert.match(C.view().attempts.at(-1)!.grade, /一语中的/);
});

test("persistence: hashed identity and private state survive a real server restart; production sandbox disabled", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "night-call-"));
  let app = await serve({ dir, dev: true });
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  t.after(async () => {
    connection?.s.disconnect();
    await app.close();
  });
  const c = (await app.post("/api/rooms", { name: "单人测试", dev: true }))
    .body as Credentials;
  connection = await connect(app.url, c);
  const v = connection.view();
  assert.equal(v.mode, "dev");
  assert.equal(v.players.length, 3);
  assert.equal(
    (await app.post(`/api/rooms/${c.code}/join`, { name: "闯入者" })).status,
    400,
  );
  for (const p of v.players)
    await good(
      connection.s,
      { type: "skill", skill: "medic" },
      { actor: p.id },
    );
  await good(connection.s, { type: "start", solo: c.playerId });
  await good(connection.s, { type: "hypotheses", guesses });
  await good(connection.s, { type: "search", answer: "断红色电源" });
  const file = join(dir, c.code + ".json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, "utf8").includes(c.token));
  connection.s.disconnect();
  await app.close();
  app = await serve({ dir, dev: true });
  connection = await connect(app.url, c);
  assert.equal(connection.view().cards[0].id, "S1");
  connection.s.disconnect();
  await app.close();
  app = await serve({ dir, dev: false });
  assert.equal(
    (await app.post("/api/rooms", { name: "非法开发", dev: true })).status,
    403,
  );
  assert.equal(
    (await fetch(app.url + "/api/health").then((r) => r.json())).devAvailable,
    false,
  );
  await assert.rejects(connect(app.url, c), /身份验证失败/);
});

test("invalid auth, unexpected payloads, malicious origins cannot mutate state", async (t) => {
  const app = await serve();
  t.after(() => app.close());
  const c = (await app.post("/api/rooms", { name: "安全测试" })).body;
  const bad = io(app.url, {
    auth: { code: c.code, token: "f".repeat(64) },
    transports: ["websocket"],
    reconnection: false,
    autoConnect: false,
  });
  t.after(() => bad.disconnect());
  await assert.rejects(
    new Promise<void>((res, rej) => {
      bad.once("connect", res);
      bad.once("connect_error", rej);
      bad.connect();
    }),
    /身份验证失败/,
  );
  const cl = await connect(app.url, c);
  t.after(() => cl.s.disconnect());
  assert.equal(
    (await emit(cl.s, { type: "skill", skill: "medic", hp: 999 })).ok,
    false,
  );
  const res = await fetch(app.url + "/api/rooms", {
    method: "POST",
    headers: {
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "恶意站点" }),
  });
  assert.equal(res.status, 403);
  const malformed = await fetch(app.url + "/api/health", {
    headers: { Origin: "not-a-url" },
  });
  assert.equal(malformed.status, 403);
  assert.equal(app.game.rooms.size, 1);
});
