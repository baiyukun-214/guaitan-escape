import { randomUUID } from "node:crypto";
import { Game, type Room } from "../server/game.js";
import { HostAI } from "../server/ai.js";
export const solution =
  "槐桥地下通道发生洪水。今晚是录音的本地检修回放。主管陈原切断主继电器。主管陈原伪报人员清空。林遥接通备用线指导救援。大家上干燥的上层检修梯，用手动绞盘开闸撤离。";
export const guesses = [
  "槐桥地下通道洪水",
  "今晚是录音回放",
  "陈原切断主电源",
  "陈原伪报人员清空",
  "林遥接备用线",
];
export function setup() {
  let now = 100000;
  const game = new Game(
    new HostAI({ enabled: false, timeout: 1000 }),
    () => {},
    () => now,
  );
  const creds = [game.create("甲")];
  creds.push(game.join(creds[0].code, "乙"), game.join(creds[0].code, "丙"));
  const r = game.rooms.get(creds[0].code)!;
  const act = (n: number, action: any, extra: any = {}) =>
    game.command(r, creds[n].playerId, { id: randomUUID(), action, ...extra });
  const start = async () => {
    for (let n = 0; n < 3; n++)
      await act(n, {
        type: "skill",
        skill: n === 0 ? "medic" : n === 1 ? "shield" : "insight",
      });
    await act(0, { type: "start", solo: creds[0].playerId });
  };
  const tasks = async () => {
    await start();
    await act(0, { type: "hypotheses", guesses });
  };
  const tick = (ms: number) => (now += ms);
  const solve = async () => {
    for (const answer of [
      "断开红色电源",
      "核对纸质签名和闸机日志",
      "上层检修梯手动绞盘",
    ])
      await act(0, { type: "search", answer });
    for (let j = 0; j < 3; j++) {
      await act(1, { type: "hold" });
      tick(7000);
      await act(1, { type: "release" });
      await act(2, { type: "guessTime", seconds: 7 });
    }
  };
  return { game, r, creds, act, start, tasks, tick, solve };
}
