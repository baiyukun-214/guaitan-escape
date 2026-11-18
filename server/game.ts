import { randomBytes, randomInt, createHash } from "node:crypto";
import type { View, Skill, Phase, Credentials, Card } from "../src/shared.js";
import { HostAI } from "./ai.js";
import {
  INTRO,
  RULES,
  SOLO_CARDS,
  DUO_CARDS,
  SOLO_PROMPTS,
  SOLO_ANSWERS,
  HIDDEN,
  COMBINATIONS,
  cardById,
  HINT,
  TRUTH,
} from "./story.js";
import { z } from "zod";
const short = z.string().min(1).max(80);
const actionUnion = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("skill"),
      skill: z.enum(["shield", "insight", "medic"]),
    })
    .strict(),
  z.object({ type: z.literal("start"), solo: short }).strict(),
  z
    .object({
      type: z.literal("hypotheses"),
      guesses: z.array(z.string().min(2).max(600)).length(5),
      offline: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("nominate"), target: short }).strict(),
  z.object({ type: z.literal("confirm"), accept: z.boolean() }).strict(),
  z
    .object({ type: z.literal("search"), answer: z.string().min(1).max(500) })
    .strict(),
  z
    .object({ type: z.literal("hidden"), answer: z.string().min(1).max(200) })
    .strict(),
  z.object({ type: z.literal("hold") }).strict(),
  z.object({ type: z.literal("release") }).strict(),
  z
    .object({
      type: z.literal("guessTime"),
      seconds: z.number().int().min(1).max(15),
    })
    .strict(),
  z.object({ type: z.literal("publish"), card: short }).strict(),
  z.object({ type: z.literal("combine"), a: short, b: short }).strict(),
  z.object({ type: z.literal("useSkill") }).strict(),
  z
    .object({
      type: z.literal("truth"),
      text: z.string().min(5).max(5000),
      offline: z.boolean().optional(),
    })
    .strict(),
]);
export const commandSchema = z
  .object({
    id: z.string().min(8).max(100),
    actor: short.optional(),
    action: actionUnion,
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
type Player = {
  id: string;
  tokenHash: string;
  name: string;
  hp: number;
  skill?: Skill;
  used: boolean;
  shield: boolean;
  cards: string[];
};
export type Room = {
  code: string;
  mode: "live" | "dev";
  host: string;
  phase: Phase;
  revision: number;
  players: Player[];
  created: number;
  logs: { id: string; text: string }[];
  shared: string[];
  seen: string[];
  aiStatus: string;
  solo: {
    player: string;
    loss: number;
    found: number;
    done: boolean;
    hidden: boolean;
  };
  duo: {
    players: string[];
    loss: number;
    wins: number;
    fails: number;
    done: boolean;
    start?: number;
    elapsed?: number;
    timer: string;
    guesser: string;
  };
  penalty?: { id: string; reason: string; target?: string; expires?: number };
  attempts: { text: string; grade: string }[];
  hypotheses?: string[];
  hypothesisCount?: number;
  outcome?: string;
};
const id = () => randomBytes(16).toString("hex");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fail(msg: string): never {
  throw new Error(msg);
}
export class Game {
  rooms = new Map<string, Room>();
  constructor(
    public ai: HostAI,
    public save: (r: Room) => void = () => {},
    public now: () => number = Date.now,
  ) {}
  log(r: Room, text: string) {
    r.logs.push({ id: id(), text });
    if (r.logs.length > 100) r.logs.shift();
  }
  create(name: string, dev = false): Credentials {
    if (this.rooms.size >= 200) fail("房间数已达上限，请稍后重试");
    let code = "";
    do {
      code = Array.from(
        { length: 6 },
        () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[randomInt(32)],
      ).join("");
    } while (this.rooms.has(code));
    const token = id() + id(),
      p: Player = {
        id: id(),
        name,
        hp: 5,
        tokenHash: hash(token),
        used: false,
        shield: false,
        cards: [],
      };
    const r: Room = {
      code,
      mode: dev ? "dev" : "live",
      host: p.id,
      phase: "lobby",
      revision: 0,
      players: [p],
      created: this.now(),
      logs: [],
      shared: [],
      seen: [],
      aiStatus: this.ai.label,
      solo: { player: "", loss: 0, found: 0, done: false, hidden: false },
      duo: {
        players: [],
        loss: 0,
        wins: 0,
        fails: 0,
        done: false,
        timer: "",
        guesser: "",
      },
      attempts: [],
    };
    if (dev)
      for (let n = 2; n <= 3; n++)
        r.players.push({
          id: id(),
          tokenHash: hash(id() + id()),
          name: "试玩接线员" + n,
          hp: 5,
          used: false,
          shield: false,
          cards: [],
        });
    this.log(
      r,
      dev
        ? "开发试玩沙盒：你可以切换三席；此房间禁止真人加入。"
        : "接线台已开启。等齐三位接线员，各选技能后由房主开始。",
    );
    this.rooms.set(code, r);
    this.save(r);
    return { code, playerId: p.id, token };
  }
  join(code: string, name: string): Credentials {
    const r = this.rooms.get(code) ?? fail("房间不存在");
    if (r.mode !== "live" || r.phase !== "lobby" || r.players.length >= 3)
      fail("房间不可加入");
    const token = id() + id(),
      p: Player = {
        id: id(),
        name,
        tokenHash: hash(token),
        hp: 5,
        used: false,
        shield: false,
        cards: [],
      };
    r.players.push(p);
    r.revision++;
    this.save(r);
    return { code, playerId: p.id, token };
  }
  auth(code: string, token: string) {
    const r = this.rooms.get(code) ?? fail("房间不存在");
    const p =
      r.players.find((p) => p.tokenHash === hash(token)) ??
      fail("身份失效，请使用原浏览器重连");
    return { r, p };
  }
  snapshot(r: Room, me: string, connected: Set<string> = new Set()): View {
    const p = r.players.find((p) => p.id === me) ?? fail("未知席位");
    return {
      code: r.code,
      mode: r.mode,
      phase: r.phase,
      host: r.host,
      me,
      revision: r.revision,
      aiMode: this.ai.label,
      aiStatus: r.aiStatus,
      story: INTRO,
      rules: RULES,
      players: r.players.map((x) => ({
        id: x.id,
        name: x.name,
        hp: x.hp,
        skill: x.skill,
        used: x.used,
        connected: connected.has(x.id),
      })),
      logs: r.logs,
      cards: p.cards.map((x) => cardById(x)!).filter(Boolean),
      shared: r.shared.map((x) => cardById(x)!).filter(Boolean),
      tasks: {
        solo: {
          player: r.solo.player,
          loss: r.solo.loss,
          found: r.solo.found,
          total: 3,
          done: r.solo.done,
          prompt: SOLO_PROMPTS[r.solo.found] ?? "基础线索已全部收集。",
        },
        duo: {
          players: r.duo.players,
          loss: r.duo.loss,
          wins: r.duo.wins,
          fails: r.duo.fails,
          done: r.duo.done,
          timer: r.duo.timer,
          guesser: r.duo.guesser,
          holding: r.duo.start !== undefined,
          ready: r.duo.elapsed !== undefined,
          ...(r.duo.elapsed !== undefined
            ? { hint: Math.round(r.duo.elapsed / 1000) % 10 }
            : {}),
        },
      },
      penalty: r.penalty,
      attempts: r.attempts,
      ...(r.phase === "hypothesis" && r.hypotheses
        ? { hypothesisDraft: r.hypotheses }
        : {}),
      hypothesisCount: r.hypothesisCount,
      outcome: r.outcome,
      ...(r.phase === "ended" ? { reveal: TRUTH } : {}),
    };
  }
  expire(r: Room) {
    let changed = false;
    if (r.penalty?.expires && this.now() > r.penalty.expires) {
      r.penalty.target = undefined;
      r.penalty.expires = undefined;
      this.log(r, "扣血提议已超时，未扣除任何血量。请重新提名承担者。");
      changed = true;
    }
    if (r.duo.start !== undefined && this.now() - r.duo.start > 16000) {
      r.duo.start = undefined;
      r.duo.elapsed = 15000;
      this.log(r, "测试音超过15秒，系统已自动截断为15秒，请搭档报时。");
      changed = true;
    }
    if (changed) {
      r.revision++;
      this.save(r);
    }
    return changed;
  }
  private living(r: Room, id: string) {
    return r.players.find((p) => p.id === id && p.hp > 0);
  }
  private award(p: Player, cards: Card[]) {
    p.cards = [...new Set([...p.cards, ...cards.map((x) => x.id)])];
  }
  private hurt(r: Room, p: Player, task?: "solo" | "duo") {
    if (task && p.shield) {
      p.shield = false;
      this.log(r, `${p.name}的绝缘手套抵消本次任务损伤。`);
      return;
    }
    p.hp = Math.max(0, p.hp - 1);
    if (task) r[task].loss++;
    this.log(
      r,
      `${p.name}失去1血${task ? "（任务损伤）" : "（已确认的团队试错）"}，剩余${p.hp}血。`,
    );
    if (r.players.every((p) => p.hp === 0)) {
      r.phase = "ended";
      r.outcome = "信号熄灭：全员血量耗尽。事故档案解封，可复盘。";
      r.penalty = undefined;
      return;
    }
    if (task === "solo" && (r.solo.loss >= 3 || p.hp === 0)) {
      this.award(p, SOLO_CARDS);
      r.solo.found = 3;
      r.solo.done = true;
      this.log(
        r,
        "单人任务触发应急封存包：全部3张基础线索已交给搜证者。零血仍可公开手牌。",
      );
    }
    if (task === "duo") {
      if (r.duo.loss >= 3 || r.duo.players.every((id) => !this.living(r, id))) {
        const owner = r.players.find((p) => p.id === r.duo.players[0])!;
        this.award(owner, DUO_CARDS);
        r.duo.wins = 3;
        r.duo.done = true;
        this.log(
          r,
          "双人任务触发应急校验包：全部3张基础线索已交给双人组第一席。",
        );
      } else if (!this.living(r, r.duo.guesser)) {
        [r.duo.timer, r.duo.guesser] = [r.duo.guesser, r.duo.timer];
      }
    }
  }
  private advance(r: Room) {
    if (r.phase === "tasks" && r.solo.done && r.duo.done) {
      r.phase = "deduction";
      this.log(
        r,
        "所有基础线索已回收。公开手牌、组合对应卡片，还原事故的六个关键事实。",
      );
    }
  }
  private penalty(r: Room, reason: string) {
    r.penalty = { id: id(), reason };
    this.log(
      r,
      "团队试错待处理：请选择一位有血量的接线员，并由本人确认承担1血；拒绝或超时不扣血。",
    );
  }
  async command(r: Room, identity: string, raw: unknown) {
    const cmd = commandSchema.parse(raw);
    this.expire(r);
    const actor = cmd.actor ?? identity;
    if (actor !== identity && !(r.mode === "dev" && identity === r.host))
      fail("不能代替队友操作");
    const p = r.players.find((p) => p.id === actor) ?? fail("未知玩家");
    const key = identity + ":" + cmd.id;
    if (r.seen.includes(key)) return;
    const a = cmd.action;
    if (r.phase === "ended") fail("本局已结束，请创建新房间");
    if (
      r.penalty &&
      !["nominate", "confirm", "publish", "combine"].includes(a.type)
    )
      fail("请先协商并确认本次团队扣血");
    if (p.hp === 0 && !["publish", "combine"].includes(a.type))
      fail("零血只能阅读、公开和组合线索，不能继续冒险或承担损伤");
    if (a.type === "skill") {
      if (r.phase !== "lobby") fail("只能在开局前选技能");
      p.skill = a.skill;
    } else if (a.type === "start") {
      if (identity !== r.host || actor !== r.host) fail("只有房主能开始");
      if (
        r.phase !== "lobby" ||
        r.players.length !== 3 ||
        r.players.some((p) => !p.skill)
      )
        fail("需要三人到齐并选好技能");
      if (!r.players.some((p) => p.id === a.solo)) fail("无效搜证者");
      const duo = r.players.filter((p) => p.id !== a.solo).map((p) => p.id);
      r.solo.player = a.solo;
      r.duo.players = duo;
      r.duo.timer = duo[0];
      r.duo.guesser = duo[1];
      r.phase = "hypothesis";
      this.log(r, "请按五个问题分别给出猜想。仅公布正确数量，不公布哪项正确。");
    } else if (a.type === "hypotheses") {
      if (r.phase !== "hypothesis" || r.hypothesisCount !== undefined)
        fail("当前不能提交初步猜想");
      r.hypotheses = a.guesses;
      const results = await Promise.all(
        a.guesses.map(async (s) =>
          a.offline
            ? {
                ids: (await import("./story.js")).offlineFacts(s),
                status: "玩家选择离线判定（非AI）",
              }
            : this.ai.judge(s),
        ),
      );
      if (results.some((x) => x.status.startsWith("AI 不可用"))) {
        r.aiStatus = "AI 不可用：五项原文已保留，请重试；未扣血";
        this.log(r, r.aiStatus);
      } else {
        const count = results.filter((x, i) =>
          x.ids.includes("F" + (i + 1)),
        ).length;
        r.aiStatus = results[0].status;
        r.hypothesisCount = count;
        r.phase = "tasks";
        this.log(
          r,
          `初步猜想：5项中答对${count}项。${count >= 3 ? "不扣血。" : "需团队确认承担1血。"}`,
        );
        if (count < 3) this.penalty(r, "初步猜想正确数不足3项");
      }
    } else if (a.type === "nominate") {
      if (!r.penalty) fail("没有待承担损伤");
      if (!this.living(r, a.target)) fail("只能选择有血量者");
      r.penalty.target = a.target;
      r.penalty.expires = this.now() + 30000;
    } else if (a.type === "confirm") {
      if (!r.penalty || r.penalty.target !== actor)
        fail("只有被提名者本人可确认");
      if (a.accept) {
        r.penalty = undefined;
        this.hurt(r, p);
      } else {
        r.penalty.target = undefined;
        r.penalty.expires = undefined;
        this.log(r, `${p.name}拒绝承担，本次未扣血。请继续协商。`);
      }
    } else if (a.type === "search") {
      if (r.phase !== "tasks" || r.solo.done || r.solo.player !== actor)
        fail("不是你的单人搜证任务");
      if (SOLO_ANSWERS[r.solo.found](a.answer)) {
        this.award(p, [SOLO_CARDS[r.solo.found]]);
        r.solo.found++;
        r.solo.done = r.solo.found === 3;
        this.log(r, `${p.name}安全取得一张私密线索。`);
      } else this.hurt(r, p, "solo");
    } else if (a.type === "hidden") {
      if (
        !["tasks", "deduction"].includes(r.phase) ||
        actor !== r.solo.player ||
        r.solo.hidden
      )
        fail("无法继续寻找隐藏补给");
      if (!/蓝纸|夹层|留给下一班/.test(a.answer))
        fail("没有找到：规则中有明确的补给提示，本次未扣血");
      r.solo.hidden = true;
      this.award(p, [HIDDEN]);
      p.hp = Math.min(5, p.hp + 1);
      this.log(r, `${p.name}找到隐藏补给，恢复1血（最高5）。`);
    } else if (a.type === "hold") {
      if (
        r.phase !== "tasks" ||
        r.duo.done ||
        actor !== r.duo.timer ||
        r.duo.start !== undefined ||
        r.duo.elapsed !== undefined
      )
        fail("当前不能开始测试音");
      if (!this.living(r, r.duo.timer)) fail("计时员零血：使用应急自动测试");
      r.duo.start = this.now();
    } else if (a.type === "release") {
      if (
        r.phase !== "tasks" ||
        r.duo.done ||
        actor !== r.duo.timer ||
        r.duo.start === undefined
      )
        fail("不是你的计时轮次");
      r.duo.elapsed = Math.max(1000, Math.min(15000, this.now() - r.duo.start));
      r.duo.start = undefined;
    } else if (a.type === "guessTime") {
      if (
        r.phase !== "tasks" ||
        r.duo.done ||
        actor !== r.duo.guesser ||
        r.duo.elapsed === undefined
      )
        fail("请等待搭档结束测试音，只有报时员可作答");
      const seconds = Math.round(r.duo.elapsed / 1000);
      r.duo.elapsed = undefined;
      if (a.seconds === seconds) {
        this.award(p, [DUO_CARDS[r.duo.wins]]);
        r.duo.wins++;
        r.duo.fails = 0;
        this.log(
          r,
          `双轨校验成功${r.duo.wins}/3，一张私密音轨线索交给${p.name}。`,
        );
        if (r.duo.wins === 3) r.duo.done = true;
      } else {
        r.duo.fails++;
        this.log(r, `报时不符，本组累计失误${r.duo.fails}/3。`);
        if (r.duo.fails === 3) {
          r.duo.fails = 0;
          this.hurt(r, p, "duo");
        }
      }
    } else if (a.type === "publish") {
      if (!p.cards.includes(a.card)) fail("只能公开自己的线索");
      if (!r.shared.includes(a.card)) {
        r.shared.push(a.card);
        this.log(r, `${p.name}公开了「${cardById(a.card)!.title}」。`);
      }
    } else if (a.type === "combine") {
      if (!["tasks", "deduction"].includes(r.phase)) fail("当前不能组合线索");
      const combo = COMBINATIONS.find(
        (x) => (x.a === a.a && x.b === a.b) || (x.a === a.b && x.b === a.a),
      );
      if (!combo || !r.shared.includes(a.a) || !r.shared.includes(a.b))
        fail("需要先公开两张有组合关系的线索");
      if (!r.shared.includes(combo.card.id)) {
        r.shared.push(combo.card.id);
        this.log(r, `关联成功：「${combo.card.title}」。`);
      }
    } else if (a.type === "useSkill") {
      if (!["tasks", "deduction"].includes(r.phase) || !p.skill || p.used)
        fail("技能无法使用");
      if (p.skill === "medic" && p.hp === 5) fail("血量已满，不消耗技能");
      p.used = true;
      if (p.skill === "medic") p.hp = Math.min(5, p.hp + 1);
      else if (p.skill === "shield") p.shield = true;
      else this.award(p, [{ id: "TIP", title: "交叉核对", text: HINT }]);
      // Insight is private, represented by a fixed card, not host-generated spoilers.
      if (p.skill === "insight") p.cards = [...new Set([...p.cards, "TIP"])];
      this.log(r, `${p.name}使用了技能。`);
    } else if (a.type === "truth") {
      if (r.phase !== "deduction") fail("请先完成搜证与协作任务");
      let verdict = a.offline
        ? {
            ids: (await import("./story.js")).offlineFacts(a.text),
            status: "玩家选择离线关键词判定（非AI）",
          }
        : await this.ai.judge(a.text);
      r.aiStatus = verdict.status;
      if (verdict.status.startsWith("AI 不可用"))
        r.attempts.push({
          text: a.text,
          grade: "AI暂不可用 · 未判定、未扣血，可重试",
        });
      else {
        const n = verdict.ids.length,
          grade =
            n === 6
              ? "一语中的"
              : n >= 4
                ? "接近真相"
                : n >= 2
                  ? "初见端倪"
                  : "毫无头绪";
        r.attempts.push({ text: a.text, grade: `${grade} · ${n}/6项关键事实` });
        this.log(r, `还原结果：${grade}（覆盖${n}/6项）。`);
        if (n === 6) {
          r.phase = "ended";
          r.outcome =
            "信号留存：完整证词已归档。你们拆穿了异常来电，也找回了被抹去的救援。";
        } else this.penalty(r, "真相还原未完整，需要再试");
      }
    }
    // If only one duo member survives, a fixed server pulse lets that member guess without impersonation.
    if (r.phase === "tasks" && !r.duo.done) {
      const alive = r.duo.players.filter((x) => this.living(r, x));
      if (alive.length === 1) {
        r.duo.guesser = alive[0];
        r.duo.timer = r.duo.players.find((x) => x !== alive[0])!;
        if (r.duo.elapsed === undefined && r.duo.start === undefined) {
          r.duo.elapsed = 7000;
          this.log(
            r,
            "双人组仅一人有行动力：系统发出7秒应急测试音，由幸存者报时，无需替队友操作。",
          );
        }
      }
    }
    this.advance(r);
    r.seen.push(key);
    r.revision++;
    this.save(r);
  }
  async atmosphere(r: Room) {
    const text = await this.ai.narrate(
      r.shared.map((x) => cardById(x)?.text ?? ""),
      "线路接通，等待玩家继续调查。",
    );
    if (text) {
      this.log(r, "主持人：" + text);
      r.revision++;
      this.save(r);
    }
  }
}
