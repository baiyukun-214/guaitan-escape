export type Phase = "lobby" | "hypothesis" | "tasks" | "deduction" | "ended";
export type Skill = "shield" | "insight" | "medic";
export type Card = {
  id: string;
  title: string;
  text: string;
  combine?: string[];
};
export type PublicPlayer = {
  id: string;
  name: string;
  hp: number;
  skill?: Skill;
  used: boolean;
  connected: boolean;
};
export type View = {
  code: string;
  mode: "live" | "dev";
  phase: Phase;
  host: string;
  me: string;
  revision: number;
  aiMode: string;
  aiStatus: string;
  story: string;
  rules: string[];
  players: PublicPlayer[];
  logs: { id: string; text: string }[];
  cards: Card[];
  shared: Card[];
  tasks: {
    solo: {
      player: string;
      loss: number;
      found: number;
      total: number;
      done: boolean;
      prompt: string;
    };
    duo: {
      players: string[];
      loss: number;
      wins: number;
      fails: number;
      done: boolean;
      timer: string;
      guesser: string;
      holding: boolean;
      ready: boolean;
      hint?: number;
    };
  };
  penalty?: { id: string; reason: string; target?: string; expires?: number };
  hypothesisDraft?: string[];
  attempts: { text: string; grade: string }[];
  hypothesisCount?: number;
  outcome?: string;
  reveal?: string;
};
export type Credentials = { code: string; playerId: string; token: string };
export const SKILLS: { id: Skill; name: string; description: string }[] = [
  {
    id: "shield",
    name: "绝缘手套",
    description: "主动开启一次：抵消下一次本人的任务失误扣血（不计兜底）。",
  },
  {
    id: "insight",
    name: "交叉核对",
    description: "任务或推理阶段一次：获得不泄露谜底的搜证建议。",
  },
  {
    id: "medic",
    name: "应急药盒",
    description: "任务或推理阶段一次：为自己恢复1血，最高5。零血不可使用。",
  },
];
