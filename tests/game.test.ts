import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, solution, guesses } from "./helpers.js";
import { offlineFacts, TRUTH } from "../server/story.js";

test("phase machine: three people finish, combine evidence, reveal only at end", async () => {
  const x = setup();
  await x.tasks();
  assert.equal(x.r.hypothesisCount, 5);
  assert.equal(x.r.phase, "tasks");
  assert.equal(x.r.penalty, undefined);
  assert.equal(x.game.snapshot(x.r, x.creds[0].playerId).reveal, undefined);
  await x.solve();
  assert.equal(x.r.phase, "deduction");
  assert.equal(x.r.players[0].cards.length, 3);
  assert.equal(x.r.players[2].cards.length, 3);
  for (const n of [0, 2])
    for (const card of x.r.players[n].cards)
      await x.act(n, { type: "publish", card });
  for (let j = 1; j <= 3; j++)
    await x.act(1, { type: "combine", a: "S" + j, b: "D" + j });
  assert.equal(x.r.shared.length, 9);
  await x.act(2, { type: "truth", text: solution });
  assert.equal(x.r.phase, "ended");
  assert.match(x.r.outcome!, /信号留存/);
  assert.equal(x.game.snapshot(x.r, x.creds[1].playerId).reveal, TRUTH);
});

test("only host starts; no player impersonation, wrong task, out-of-phase submission, forged clock", async () => {
  const x = setup();
  await assert.rejects(
    x.act(1, { type: "start", solo: x.creds[0].playerId }),
    /房主/,
  );
  await assert.rejects(x.act(0, { type: "truth", text: solution }), /先完成/);
  await x.tasks();
  await assert.rejects(
    x.act(1, { type: "search", answer: "断开红电源" }),
    /不是你的/,
  );
  await assert.rejects(
    x.act(
      0,
      { type: "search", answer: "断开红电源" },
      { actor: x.creds[1].playerId },
    ),
    /不能代替/,
  );
  await assert.rejects(x.act(2, { type: "guessTime", seconds: 7 }), /等待/);
  await assert.rejects(x.act(2, { type: "release" }), /计时/);
  await assert.rejects(
    x.act(1, { type: "hold", elapsed: 7000, now: 123 }),
    /./,
  ); // rejected after strict schema change
});

test("idempotency: duplicate failure costs one HP only and submissions cannot replay with new id", async () => {
  const x = setup();
  await x.tasks();
  const packet = {
    id: randomUUID(),
    action: { type: "search", answer: "摸红电线" },
  };
  await x.game.command(x.r, x.creds[0].playerId, packet);
  await x.game.command(x.r, x.creds[0].playerId, packet);
  assert.equal(x.r.players[0].hp, 4);
  assert.equal(x.r.solo.loss, 1);
  await assert.rejects(x.act(0, { type: "hypotheses", guesses }), /不能提交/);
});

test("team damage: nomination, refusal, expiration and only target can approve, duplicate consent harmless", async () => {
  const x = setup();
  await x.start();
  await x.act(0, { type: "hypotheses", guesses: Array(5).fill("不知道") });
  assert.equal(x.r.hypothesisCount, 0);
  assert.equal(x.r.players[0].hp, 5);
  await assert.rejects(
    x.act(0, { type: "search", answer: "断红电源" }),
    /协商/,
  );
  await x.act(0, { type: "nominate", target: x.creds[1].playerId });
  await assert.rejects(x.act(0, { type: "confirm", accept: true }), /被提名者/);
  await x.act(1, { type: "confirm", accept: false });
  assert.equal(x.r.players[1].hp, 5);
  await x.act(0, { type: "nominate", target: x.creds[1].playerId });
  x.tick(30001);
  x.game.expire(x.r);
  assert.equal(x.r.penalty?.target, undefined);
  assert.equal(x.r.players[1].hp, 5);
  await x.act(2, { type: "nominate", target: x.creds[0].playerId });
  const packet = {
    id: randomUUID(),
    action: { type: "confirm", accept: true },
  };
  await x.game.command(x.r, x.creds[0].playerId, packet);
  await x.game.command(x.r, x.creds[0].playerId, packet);
  assert.equal(x.r.players[0].hp, 4);
  assert.equal(x.r.penalty, undefined);
});

test("tasks guarantee all 3 clues after 3 real HP losses; hidden heal max5, once only", async () => {
  const x = setup();
  await x.tasks();
  for (let j = 0; j < 3; j++)
    await x.act(0, { type: "search", answer: "破坏" });
  assert.equal(x.r.solo.loss, 3);
  assert.equal(x.r.solo.done, true);
  assert.equal(x.r.players[0].cards.length, 3);
  await x.act(0, { type: "hidden", answer: "蓝纸夹层" });
  assert.equal(x.r.players[0].hp, 3);
  await assert.rejects(x.act(0, { type: "hidden", answer: "蓝纸" }), /无法/);
  for (let j = 0; j < 9; j++) {
    await x.act(1, { type: "hold" });
    x.tick(7000);
    await x.act(1, { type: "release" });
    await x.act(2, { type: "guessTime", seconds: 2 });
  }
  assert.equal(x.r.duo.loss, 3);
  assert.equal(x.r.duo.done, true);
  assert.equal(x.r.players[1].cards.length, 3);
  assert.equal(x.r.phase, "deduction");
  const y = setup();
  await y.tasks();
  await y.act(0, { type: "hidden", answer: "蓝纸" });
  assert.equal(y.r.players[0].hp, 5);
});

test("skills are server managed, once per game; shield blocks task loss without advancing fallback", async () => {
  const x = setup();
  await x.tasks();
  await x.act(1, { type: "useSkill" });
  assert.equal(x.r.players[1].shield, true);
  await assert.rejects(x.act(1, { type: "useSkill" }), /无法/);
  await x.act(2, { type: "useSkill" });
  assert.equal(x.game.snapshot(x.r, x.creds[2].playerId).cards[0].id, "TIP");
  await x.act(0, { type: "search", answer: "破坏" });
  await x.act(0, { type: "useSkill" });
  assert.equal(x.r.players[0].hp, 5);
  const y = setup();
  await y.act(0, { type: "skill", skill: "shield" });
  await y.act(1, { type: "skill", skill: "insight" });
  await y.act(2, { type: "skill", skill: "medic" });
  await y.act(0, { type: "start", solo: y.creds[0].playerId });
  await y.act(0, { type: "hypotheses", guesses });
  await y.act(0, { type: "useSkill" });
  await y.act(0, { type: "search", answer: "破坏" });
  assert.equal(y.r.players[0].hp, 5);
  assert.equal(y.r.solo.loss, 0);
});

test("zero-HP roles do not deadlock; full depletion ends and private hand is still publishable while alive team", async () => {
  const x = setup();
  await x.tasks();
  x.r.players[0].hp = 1;
  await x.act(0, { type: "search", answer: "破坏" });
  assert.equal(x.r.solo.done, true);
  assert.equal(x.r.players[0].hp, 0);
  await x.act(0, { type: "publish", card: "S1" });
  await assert.rejects(x.act(0, { type: "useSkill" }), /零血/);
  x.r.players[2].hp = 1;
  for (let j = 0; j < 3; j++) {
    await x.act(1, { type: "hold" });
    x.tick(7000);
    await x.act(1, { type: "release" });
    await x.act(2, { type: "guessTime", seconds: 3 });
  }
  assert.equal(x.r.players[2].hp, 0);
  assert.equal(x.r.duo.elapsed, 7000);
  assert.equal(x.r.duo.guesser, x.creds[1].playerId);
  for (let j = 0; j < 3; j++) await x.act(1, { type: "guessTime", seconds: 7 });
  assert.equal(x.r.phase, "deduction");
  await x.act(1, { type: "truth", text: "什么都不清楚" });
  x.r.players[1].hp = 1;
  await x.act(1, { type: "nominate", target: x.creds[1].playerId });
  await x.act(1, { type: "confirm", accept: true });
  assert.equal(x.r.phase, "ended");
  assert.match(x.r.outcome!, /耗尽/);
});

test("free text fixed scoring, negations not credited; incorrect final creates consent, not automatic damage", async () => {
  assert.equal(offlineFacts(solution).length, 6);
  assert.equal(
    offlineFacts("不是主管陈原伪报人员清空。没有录音回放。").length,
    0,
  );
  const x = setup();
  await x.tasks();
  await x.solve();
  await x.act(1, {
    type: "truth",
    text: "槐桥地下通道发生洪水。今晚是录音回放。",
  });
  assert.match(x.r.attempts[0].grade, /初见端倪/);
  assert.ok(x.r.penalty);
  assert.equal(x.r.players[1].hp, 5);
});

test("private snapshots never contain other hands, token hashes, truth, unearned clue cards or timer milliseconds", async () => {
  const x = setup();
  await x.tasks();
  await x.act(0, { type: "search", answer: "断开红电源" });
  await x.act(1, { type: "hold" });
  x.tick(7200);
  await x.act(1, { type: "release" });
  const v = x.game.snapshot(x.r, x.creds[1].playerId),
    raw = JSON.stringify(v);
  assert.equal(v.cards.length, 0);
  for (const secret of [
    "洪水报警单",
    "带压痕的签名",
    "tokenHash",
    "elapsed",
    "start",
    "F1",
    "为免承担",
    x.creds[0].token,
  ])
    assert.ok(!raw.includes(secret), secret);
  assert.equal(v.tasks.duo.hint, 7);
  assert.equal(v.reveal, undefined);
});
