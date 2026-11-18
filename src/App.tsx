import React, { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { View, Credentials, Card } from "./shared";
import { SKILLS } from "./shared";
const PHASES = [
  ["lobby", "接线准备"],
  ["hypothesis", "初步猜想"],
  ["tasks", "分线调查"],
  ["deduction", "还原真相"],
  ["ended", "档案归档"],
];
const AXES = [
  "事故是什么、发生在哪里？",
  "今晚声音的来源是什么？",
  "谁切断了什么？",
  "清空报告是否真实、是谁写的？",
  "谁利用哪条线路继续救援？",
];
export function App({ connect = io }: { connect?: typeof io }) {
  const [credentials, setCredentials] = useState<Credentials | undefined>(
    () => {
      try {
        return (
          JSON.parse(localStorage.getItem("night-call-session") ?? "null") ??
          undefined
        );
      } catch {
        return undefined;
      }
    },
  );
  const [view, setView] = useState<View>(),
    [status, setStatus] = useState("未连接"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState<any>();
  const [health, setHealth] = useState<{
      aiMode: string;
      devAvailable: boolean;
    }>(),
    [name, setName] = useState(""),
    [code, setCode] = useState("");
  const [solo, setSolo] = useState(""),
    [guesses, setGuesses] = useState<string[]>(["", "", "", "", ""]),
    [answer, setAnswer] = useState(""),
    [hidden, setHidden] = useState(""),
    [seconds, setSeconds] = useState(7),
    [truth, setTruth] = useState(""),
    [offline, setOffline] = useState(false),
    [comboA, setComboA] = useState(""),
    [comboB, setComboB] = useState("");
  const socket = useRef<Socket | undefined>(undefined);
  const current = useRef(view);
  current.current = view;
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setError("无法连接服务器，请确认后端已启动。"));
  }, []);
  useEffect(() => {
    if (!credentials) return;
    localStorage.setItem("night-call-session", JSON.stringify(credentials));
    const s = connect({
      auth: { code: credentials.code, token: credentials.token },
    });
    socket.current = s;
    s.on("connect", () => setStatus("线路已连接"));
    s.on("disconnect", () => setStatus("线路中断 · 正在重连"));
    s.on("connect_error", (e) => {
      setStatus("连接失败");
      setError(
        e.message === "身份验证失败"
          ? "身份验证失败，原存档可能已失效。可退出重开。"
          : "连接中断，正在重试。",
      );
    });
    s.on("state", (v: View) => {
      setView(v);
      if (v.hypothesisDraft)
        setGuesses((old) =>
          old.every((value) => !value.trim()) ? v.hypothesisDraft! : old,
        );
    });
    return () => {
      s.disconnect();
      socket.current = undefined;
    };
  }, [credentials, connect]);
  async function enter(join: boolean, dev = false) {
    if (!name.trim()) {
      setError("请先填一个接线员昵称。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await fetch(
        join ? `/api/rooms/${code.trim().toUpperCase()}/join` : "/api/rooms",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, dev }),
        },
      );
      const body = await r.json();
      if (!r.ok) throw Error(body.error);
      setCredentials(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send(action: any, reused?: any) {
    if (!socket.current?.connected) {
      setError("尚未连接，输入已保留，请等待重连。");
      return;
    }
    const packet = reused ?? {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      actor: current.current?.me,
      action,
    };
    setBusy(true);
    setError("");
    try {
      const result = await socket.current
        .timeout(65000)
        .emitWithAck("action", packet);
      if (!result.ok) throw Error(result.error);
      setRetry(undefined);
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      if (message.includes("timed out")) setRetry(packet);
    } finally {
      setBusy(false);
    }
  }
  // A native <select> can visually show its first option while React still holds
  // a non-empty ID from a previous room. Resolve once against this roster and
  // use the same ID for both the displayed selection and the start payload.
  const selectedSolo = view?.players.some((p) => p.id === solo)
    ? solo
    : (view?.players[0]?.id ?? "");
  const me = view?.players.find((p) => p.id === view.me);
  const playerName = (id: string) =>
    view?.players.find((p) => p.id === id)?.name ?? "待分配";
  const btnDisabled = busy || status !== "线路已连接";
  const card = (c: Card, privateCard = false) => (
    <article className="clue" key={c.id}>
      <div className="clue-top">
        <span>
          {privateCard ? "私密档案" : "共享档案"} / {c.id}
        </span>
        <span>⌁</span>
      </div>
      <h3>{c.title}</h3>
      <p>{c.text}</p>
      {c.combine && (
        <small>可与 {c.combine.join("、")} 关联 · 需双方先公开</small>
      )}
      {privateCard && (
        <button
          className="paper-button"
          disabled={btnDisabled || view?.shared.some((x) => x.id === c.id)}
          onClick={() => send({ type: "publish", card: c.id })}
        >
          {view?.shared.some((x) => x.id === c.id) ? "已公开" : "公开给队友 ↗"}
        </button>
      )}
    </article>
  );
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-icon">☎</span>
          <span>
            怪谈逃生指南<small>THE NIGHT SHIFT ARCHIVES</small>
          </span>
        </a>
        <div className="header-meta">
          <span className={"led " + (status === "线路已连接" ? "on" : "")} />
          <span>{credentials ? status : "原创合作推理 · 档案 001"}</span>
          {credentials && (
            <button
              className="text-button"
              onClick={() => {
                if (
                  confirm(
                    "退出只清除当前浏览器身份，不会终止房间。再次进入旧房间需原令牌；确定退出？",
                  )
                ) {
                  localStorage.removeItem("night-call-session");
                  setCredentials(undefined);
                  setView(undefined);
                }
              }}
            >
              退出
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="notice error" role="alert">
          {error}
          {retry && (
            <button onClick={() => send(undefined, retry)} disabled={busy}>
              安全重试上次操作
            </button>
          )}
          <button
            aria-label="关闭提示"
            className="text-button"
            onClick={() => setError("")}
          >
            ×
          </button>
        </div>
      )}
      {!credentials ? (
        <main className="landing">
          <section className="hero">
            <div className="eyebrow">CASE FILE 001 / 原创故事</div>
            <h1>
              夜班<span>来电</span>
            </h1>
            <p className="hero-quote">
              “水到第二级台阶了。
              <br />
              别让他再把电闸拉下去。”
            </p>
            <p className="muted">
              三名接线员，一条停用的热线。
              <br />
              当过去再次响起，你们能把真相留到天亮吗？
            </p>
            <div className="hero-tags">
              <span>3人合作</span>
              <span>文字主持</span>
              <span>约30—45分钟</span>
            </div>
            <div className="waveform" aria-hidden="true">
              {Array.from({ length: 52 }, (_, i) => (
                <i
                  key={i}
                  style={{
                    height:
                      Math.sin(i * 2.3) * Math.cos(i * 0.4) * 28 + 36 + "px",
                  }}
                />
              ))}
            </div>
          </section>
          <section className="entry panel">
            <div className="eyebrow">接线台登录 / NO ACCOUNT NEEDED</div>
            <h2>准备接班</h2>
            <p>每人一台设备。用微信语音交流，线索留在桌面。</p>
            <label>
              接线员昵称
              <input
                value={name}
                maxLength={16}
                onChange={(e) => setName(e.target.value)}
                placeholder="今晚怎么称呼你？"
              />
            </label>
            <button
              className="primary"
              disabled={busy}
              onClick={() => enter(false)}
            >
              开启三人接线台 <span>→</span>
            </button>
            <div className="divider">或加入已有房间</div>
            <div className="join">
              <input
                aria-label="六位房间码"
                value={code}
                maxLength={6}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="6位房间码"
              />
              <button
                disabled={busy || code.length !== 6}
                onClick={() => enter(true)}
              >
                接入
              </button>
            </div>
            <div className="mode-label">
              {health?.aiMode ?? "正在确认主持模式…"}
            </div>
            <small className="muted">
              当前仅本机/已开放的局域网可连接，不代表已部署互联网。
            </small>
            {health?.devAvailable && (
              <button
                className="dev-button"
                disabled={busy}
                onClick={() => enter(false, true)}
              >
                开发试玩：一人切换三席（独立沙盒）
              </button>
            )}
          </section>
          <section className="landing-foot">
            <div>
              <b>01 / 读懂规则</b>
              <p>五个猜想，只知道对了几项。</p>
            </div>
            <div>
              <b>02 / 分线搜证</b>
              <p>独自查档，或与搭档校验音轨。</p>
            </div>
            <div>
              <b>03 / 拼合真相</b>
              <p>交换手牌，让每个异常得到解释。</p>
            </div>
          </section>
        </main>
      ) : !view ? (
        <main className="loading panel">
          <h2>正在接通线路…</h2>
          <p>你的身份已在本浏览器保存，刷新可重连。</p>
        </main>
      ) : (
        <>
          {view.mode === "dev" && (
            <div className="dev-banner">
              <b>开发试玩沙盒 · 非真人房间</b>
              <span>可切换席位，不向真人房开放代操作权限</span>
              <select
                aria-label="切换试玩席位"
                value={view.me}
                onChange={(e) => {
                  socket.current?.emit("view", e.target.value, (r: any) => {
                    if (!r.ok) setError(r.error);
                  });
                }}
              >
                {view.players.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="case-heading">
            <div>
              <div className="eyebrow">槐桥热线 / CASE 001</div>
              <h1>
                夜班来电 <span className="room-code">房间 {view.code}</span>
              </h1>
            </div>
            <div className="mode-label">{view.aiMode}</div>
          </div>
          <nav className="phases" aria-label="游戏阶段">
            {PHASES.map(([id, label], i) => (
              <div
                key={id}
                className={
                  view.phase === id
                    ? "active"
                    : PHASES.findIndex((x) => x[0] === view.phase) > i
                      ? "complete"
                      : ""
                }
              >
                <span>{String(i + 1).padStart(2, "0")}</span>
                {label}
              </div>
            ))}
          </nav>
          <div className="team">
            {view.players.map((p, i) => (
              <article
                key={p.id}
                className={"player " + (p.id === view.me ? "is-me" : "")}
              >
                <div className="avatar">0{i + 1}</div>
                <div className="player-info">
                  <b>
                    {p.name} {p.id === view.me && <em>你</em>}
                    {p.id === view.host && <small> / 房主</small>}
                  </b>
                  <div className="hearts" aria-label={`${p.hp}点血量`}>
                    {Array.from({ length: 5 }, (_, j) => (
                      <span key={j} className={j < p.hp ? "full" : ""}>
                        ♥
                      </span>
                    ))}
                    <small>{p.hp}/5</small>
                  </div>
                  <small>
                    {SKILLS.find((x) => x.id === p.skill)?.name ?? "未选技能"}
                    {p.used ? " · 已使用" : ""}
                    {p.hp === 0
                      ? " · 零血（可分享线索）"
                      : ` · ${p.connected || view.mode === "dev" ? "在线" : "离线"}`}
                  </small>
                </div>
              </article>
            ))}
          </div>
          <nav className="mobile-shortcuts" aria-label="桌面快捷导航">
            <a href="#operations">当前任务</a>
            <a href="#my-hand">我的线索 {view.cards.length}</a>
            <a href="#evidence">共享板</a>
          </nav>
          <main className="desk">
            <aside className="left-column">
              <section className="panel narrative">
                <div className="eyebrow">值班交接 / BRIEFING</div>
                <h2>最后一班</h2>
                <p>{view.story}</p>
                <details open>
                  <summary>
                    接线规则 <span>07 条</span>
                  </summary>
                  <ol className="rules">
                    {view.rules.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ol>
                </details>
              </section>
              <section className="panel safety">
                <h3>接线员须知</h3>
                <p>
                  零血者可阅读、公开、组合线索，不可行动。全员零血结算失败。
                </p>
                <p>
                  任务累计实扣3血，自动获得该任务全部基础线索；失去行动力时有应急接管。任务之外扣血，必须本人确认。
                </p>
                <p>技能每人一次。隐藏补给可回血，上限5。</p>
              </section>
            </aside>
            <section className="center-column">
              {view.penalty && (
                <section className="panel penalty">
                  <div className="eyebrow">团队协商 / 需本人同意</div>
                  <h2>谁来承担这次试错？</h2>
                  <p>
                    {view.penalty.reason}
                    。确认后扣1血。拒绝或30秒超时不扣血，可重新选人；处理前暂停下一步。
                  </p>
                  <div className="button-row">
                    {view.players
                      .filter((p) => p.hp > 0)
                      .map((p) => (
                        <button
                          disabled={btnDisabled}
                          key={p.id}
                          onClick={() =>
                            send({ type: "nominate", target: p.id })
                          }
                        >
                          {p.name}
                          {view.penalty?.target === p.id ? " · 等待确认" : ""}
                        </button>
                      ))}
                  </div>
                  {view.penalty.target === view.me && (
                    <div className="button-row">
                      <button
                        className="danger"
                        disabled={btnDisabled}
                        onClick={() => send({ type: "confirm", accept: true })}
                      >
                        我确认承担1血
                      </button>
                      <button
                        disabled={btnDisabled}
                        onClick={() => send({ type: "confirm", accept: false })}
                      >
                        拒绝本次提议
                      </button>
                    </div>
                  )}
                </section>
              )}
              <section className="panel action-panel" id="operations">
                <div className="eyebrow">
                  {PHASES.find((x) => x[0] === view.phase)?.[1]} / 操作台
                </div>
                {view.phase === "lobby" && (
                  <>
                    <h2>先选一件值班装备</h2>
                    <p>每位接线员初始5血。三人选好技能后，由房主分配任务。</p>
                    <div className="skill-options">
                      {SKILLS.map((s) => (
                        <button
                          className={me?.skill === s.id ? "selected" : ""}
                          key={s.id}
                          disabled={btnDisabled}
                          onClick={() => send({ type: "skill", skill: s.id })}
                        >
                          <b>{s.name}</b>
                          <span>{s.description}</span>
                        </button>
                      ))}
                    </div>
                    {view.host === view.me ? (
                      <>
                        <label>
                          单人搜证者（其余两人组成音轨校验组）
                          <select
                            value={selectedSolo}
                            onChange={(e) => setSolo(e.target.value)}
                          >
                            {view.players.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="primary"
                          disabled={
                            btnDisabled ||
                            !selectedSolo ||
                            view.players.length !== 3 ||
                            view.players.some((p) => !p.skill)
                          }
                          onClick={() =>
                            send({ type: "start", solo: selectedSolo })
                          }
                        >
                          三人就位 · 开始值班 →
                        </button>
                      </>
                    ) : (
                      <p className="waiting">
                        等待房主开始。真实三人局请把房间码告诉朋友，勿分享身份令牌。
                      </p>
                    )}
                  </>
                )}
                {view.phase === "hypothesis" && (
                  <>
                    <h2>先留下五个猜想</h2>
                    <p>
                      按五个方向各写一项。正确不少于3项不扣血，否则团队承担1血。只公布正确总数，不公布具体命中项。
                    </p>
                    {AXES.map((q, i) => (
                      <label key={q}>
                        <span className="question-number">0{i + 1}</span>
                        {q}
                        <textarea
                          rows={2}
                          value={guesses[i]}
                          onChange={(e) =>
                            setGuesses((x) =>
                              x.map((v, j) => (j === i ? e.target.value : v)),
                            )
                          }
                          maxLength={600}
                          placeholder="说出你们当前的判断…"
                        />
                      </label>
                    ))}
                    <button
                      className="primary"
                      disabled={
                        btnDisabled ||
                        guesses.some((x) => x.trim().length < 2) ||
                        !!view.penalty
                      }
                      onClick={() =>
                        send({ type: "hypotheses", guesses, offline })
                      }
                    >
                      提交五个猜想 →
                    </button>
                  </>
                )}
                {view.phase === "tasks" && (
                  <>
                    <h2>两条线，指向同一件事</h2>
                    <p>
                      基础线索共6张：单人3张、双人3张。收集后保存在各自私密手牌；你可以选择公开。
                    </p>
                    <div className="task">
                      <div className="task-heading">
                        <h3>01 / 单人档案搜证</h3>
                        <span>
                          {view.tasks.solo.done
                            ? "已完成"
                            : `${view.tasks.solo.found}/3 张`}
                        </span>
                      </div>
                      <p className="muted">
                        负责人：{playerName(view.tasks.solo.player)} · 已扣{" "}
                        {view.tasks.solo.loss}/3 血
                      </p>
                      {view.me === view.tasks.solo.player &&
                      !view.tasks.solo.done ? (
                        <>
                          <p>{view.tasks.solo.prompt}</p>
                          <textarea
                            aria-label="搜证操作"
                            rows={2}
                            value={answer}
                            maxLength={500}
                            onChange={(e) => setAnswer(e.target.value)}
                            placeholder="依据规则说明你的操作"
                          />
                          <button
                            disabled={
                              btnDisabled ||
                              !!view.penalty ||
                              !answer.trim() ||
                              me?.hp === 0
                            }
                            onClick={() => send({ type: "search", answer })}
                          >
                            执行搜证
                          </button>
                        </>
                      ) : (
                        <p>
                          {view.tasks.solo.done
                            ? "搜证包已封存，请搜证者公开线索。"
                            : "这条线路由另一位接线员调查。"}
                        </p>
                      )}
                    </div>
                    <div className="task">
                      <div className="task-heading">
                        <h3>02 / 双人音轨校验</h3>
                        <span>
                          {view.tasks.duo.done
                            ? "已完成"
                            : `${view.tasks.duo.wins}/3 张`}
                        </span>
                      </div>
                      <p className="muted">
                        计时员 {playerName(view.tasks.duo.timer)} / 报时员{" "}
                        {playerName(view.tasks.duo.guesser)}
                        <br />
                        本组失误 {view.tasks.duo.fails}/3 · 已扣{" "}
                        {view.tasks.duo.loss}/3 血
                      </p>
                      <p>
                        计时员开始测试，1—15秒内停止；服务端计时并四舍五入。报时员根据秒数末位，报完整秒数。错3次扣报时员1血，之后重新累计。
                      </p>
                      {!view.tasks.duo.done && (
                        <>
                          <div
                            className={
                              "signal " +
                              (view.tasks.duo.holding ? "playing" : "")
                            }
                          >
                            <span />
                            {view.tasks.duo.holding
                              ? "测试信号进行中…"
                              : view.tasks.duo.ready
                                ? `主机提示：秒数末位为 ${view.tasks.duo.hint}`
                                : "等待测试信号"}
                          </div>
                          {view.me === view.tasks.duo.timer && (
                            <button
                              disabled={
                                btnDisabled ||
                                !!view.penalty ||
                                view.tasks.duo.ready ||
                                me?.hp === 0
                              }
                              onClick={() =>
                                send({
                                  type: view.tasks.duo.holding
                                    ? "release"
                                    : "hold",
                                })
                              }
                            >
                              {view.tasks.duo.holding
                                ? "停止测试信号"
                                : "开始测试信号"}
                            </button>
                          )}
                          {view.me === view.tasks.duo.guesser && (
                            <div className="inline">
                              <input
                                aria-label="猜测秒数"
                                type="number"
                                min={1}
                                max={15}
                                value={seconds}
                                onChange={(e) =>
                                  setSeconds(Number(e.target.value))
                                }
                              />
                              <button
                                disabled={
                                  btnDisabled ||
                                  !!view.penalty ||
                                  !view.tasks.duo.ready ||
                                  me?.hp === 0
                                }
                                onClick={() =>
                                  send({ type: "guessTime", seconds })
                                }
                              >
                                报出完整秒数
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}
                {view.phase === "deduction" && (
                  <>
                    <h2>把那一晚，完整说出来</h2>
                    <p>
                      从事故与声音来源，到中断求助、清空报告、备用救援和逃生路线：请用完整叙述连接这六个方向。换一种说法也可以；离线模式只做关键词匹配，不代表真实AI理解。
                    </p>
                    <textarea
                      className="testimony"
                      aria-label="真相还原"
                      value={truth}
                      onChange={(e) => setTruth(e.target.value)}
                      maxLength={5000}
                      placeholder="那晚发生了什么？谁做了什么，最后如何结束？"
                    />
                    <div className="input-footer">
                      {truth.length}/5000 · 未提交的输入保留在当前页面
                    </div>
                    <button
                      className="primary"
                      disabled={
                        btnDisabled ||
                        !!view.penalty ||
                        truth.trim().length < 5 ||
                        me?.hp === 0
                      }
                      onClick={() =>
                        send({ type: "truth", text: truth, offline })
                      }
                    >
                      提交团队证词 →
                    </button>
                    {view.attempts
                      .slice()
                      .reverse()
                      .map((a, i) => (
                        <details className="attempt" key={i}>
                          <summary>{a.grade}</summary>
                          <p>{a.text}</p>
                        </details>
                      ))}
                  </>
                )}
                {view.phase === "ended" && (
                  <>
                    <div className="result-seal">档 案 已 归 档</div>
                    <h2>{view.outcome}</h2>
                    <p className="reveal">{view.reveal}</p>
                    <p>
                      本局结束后才解封主持人底稿。你可以继续查看手牌和调查记录；要重玩，请退出并开新房。
                    </p>
                  </>
                )}
              </section>
              <section className="panel evidence" id="evidence">
                <div className="section-heading">
                  <div>
                    <div className="eyebrow">PUBLIC BOARD</div>
                    <h2>
                      共享线索板 <small>{view.shared.length}</small>
                    </h2>
                  </div>
                </div>
                {view.shared.length === 0 ? (
                  <div className="empty">
                    ⌁
                    <p>
                      这里还没有公开的线索
                      <br />
                      <small>你手中的线索，也许正是队友缺少的一半。</small>
                    </p>
                  </div>
                ) : (
                  <div className="card-grid">
                    {view.shared.map((c) => card(c))}
                  </div>
                )}
                {["tasks", "deduction"].includes(view.phase) && (
                  <div className="combine">
                    <h3>关联两张线索</h3>
                    <div className="combine-controls">
                      <select
                        aria-label="第一张组合线索"
                        value={comboA}
                        onChange={(e) => setComboA(e.target.value)}
                      >
                        <option value="">选择第一张</option>
                        {view.shared.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.id} · {c.title}
                          </option>
                        ))}
                      </select>
                      <span>＋</span>
                      <select
                        aria-label="第二张组合线索"
                        value={comboB}
                        onChange={(e) => setComboB(e.target.value)}
                      >
                        <option value="">选择第二张</option>
                        {view.shared.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.id} · {c.title}
                          </option>
                        ))}
                      </select>
                      <button
                        disabled={btnDisabled || !comboA || !comboB}
                        onClick={() =>
                          send({ type: "combine", a: comboA, b: comboB })
                        }
                      >
                        关联
                      </button>
                    </div>
                  </div>
                )}
              </section>
              <section className="panel log">
                <div className="eyebrow">LINE LOG / 线路记录</div>
                <h2>主持台</h2>
                <p className="ai-status">{view.aiStatus}</p>
                {view.logs
                  .slice()
                  .reverse()
                  .map((l, i) => (
                    <div
                      className={"log-entry " + (i === 0 ? "latest" : "")}
                      key={l.id}
                    >
                      <span>
                        {String(view.logs.length - i).padStart(2, "0")}
                      </span>
                      <p>{l.text}</p>
                    </div>
                  ))}
              </section>
            </section>
            <aside className="right-column">
              <section className="panel private" id="my-hand">
                <div className="eyebrow">PRIVATE HAND / 仅你可见</div>
                <h2>
                  我的线索 <small>{view.cards.length}</small>
                </h2>
                <p className="muted">
                  以 {me?.name} 的身份查看。未公开手牌不会推送给队友。
                </p>
                {view.cards.length ? (
                  view.cards.map((c) => card(c, true))
                ) : (
                  <div className="empty">
                    ▤<p>还没有获得线索</p>
                  </div>
                )}
              </section>
              {["tasks", "deduction"].includes(view.phase) && (
                <section className="panel tools">
                  <h3>值班装备</h3>
                  <p>{SKILLS.find((s) => s.id === me?.skill)?.description}</p>
                  <button
                    disabled={
                      btnDisabled || !!view.penalty || me?.used || me?.hp === 0
                    }
                    onClick={() => send({ type: "useSkill" })}
                  >
                    {me?.used
                      ? "本局已使用"
                      : "使用 " +
                        (SKILLS.find((s) => s.id === me?.skill)?.name ??
                          "技能")}
                  </button>
                  {view.me === view.tasks.solo.player && (
                    <details>
                      <summary>寻找隐藏补给</summary>
                      <input
                        aria-label="隐藏补给搜索位置"
                        value={hidden}
                        onChange={(e) => setHidden(e.target.value)}
                        placeholder="从规则寻找搜索位置"
                      />
                      <button
                        disabled={
                          btnDisabled ||
                          !!view.penalty ||
                          !hidden ||
                          me?.hp === 0
                        }
                        onClick={() => send({ type: "hidden", answer: hidden })}
                      >
                        搜索补给（不扣血）
                      </button>
                    </details>
                  )}
                </section>
              )}
              {view.aiMode.startsWith("AI") && (
                <section className="panel">
                  <h3>主持方式</h3>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={offline}
                      onChange={(e) => setOffline(e.target.checked)}
                    />
                    本次改用离线关键词判定
                  </label>
                  <small>
                    服务不可用时不会扣血，可保留原文重试。选中后明确放弃本次AI语义判断。
                  </small>
                </section>
              )}
            </aside>
          </main>
        </>
      )}
      <footer>
        槐桥求助热线 · 原创虚构故事，与现实事件无关{" "}
        <span>保留信号，直到天亮。</span>
      </footer>
    </div>
  );
}
