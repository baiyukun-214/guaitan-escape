import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import type { io } from "socket.io-client";
import { App } from "../src/App.js";
import { Game } from "../server/game.js";
import { HostAI } from "../server/ai.js";
import type { Credentials } from "../src/shared.js";

// Non-browser DOM only: no browser automation, real URLs, or HTTP requests.
async function fixture(t: TestContext) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://game.test",
  });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    confirm: () => true,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(globals).map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { render, fireEvent, act, cleanup, waitFor } =
    await import("@testing-library/react");
  const game = new Game(new HostAI({ enabled: false, timeout: 1000 }));
  const createRoom = (name = "byk") => {
    const c = game.create(name, true);
    game.rooms.get(c.code)!.players.forEach((p) => {
      p.skill = "medic";
    });
    return c;
  };
  const first = createRoom();
  localStorage.setItem("night-call-session", JSON.stringify(first));
  const sockets: FakeSocket[] = [],
    packets: any[] = [];
  class FakeSocket {
    connected = true;
    listeners = new Map<string, ((...a: any[]) => void)[]>();
    viewId: string;
    constructor(public credentials: Credentials) {
      this.viewId = credentials.playerId;
    }
    on(event: string, listener: (...a: any[]) => void) {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
      return this;
    }
    receive(event: string, ...args: any[]) {
      this.listeners.get(event)?.forEach((fn) => fn(...args));
    }
    publish() {
      this.receive(
        "state",
        game.snapshot(game.rooms.get(this.credentials.code)!, this.viewId),
      );
    }
    disconnect() {
      this.connected = false;
    }
    timeout() {
      return this;
    }
    async emitWithAck(event: string, packet: any) {
      assert.equal(event, "action");
      packets.push(packet);
      try {
        await game.command(
          game.rooms.get(this.credentials.code)!,
          this.credentials.playerId,
          packet,
        );
        this.publish();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    }
    emit(event: string, playerId: string, ack: (result: any) => void) {
      assert.equal(event, "view");
      this.viewId = playerId;
      this.publish();
      ack({ ok: true });
    }
  }
  const connect = (() => {
    const credentials = JSON.parse(localStorage.getItem("night-call-session")!);
    const s = new FakeSocket(credentials);
    sockets.push(s);
    queueMicrotask(() => {
      s.receive("connect");
      s.publish();
    });
    return s;
  }) as unknown as typeof io;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, options?: RequestInit) => {
    if (path === "/api/health")
      return {
        json: async () => ({
          aiMode: "离线试玩主持（非AI）",
          devAvailable: true,
        }),
      };
    assert.equal(path, "/api/rooms");
    const body = JSON.parse(options!.body as string);
    assert.equal(body.dev, true);
    return { ok: true, json: async () => createRoom(body.name) };
  }) as typeof fetch;
  const ui = render(React.createElement(App, { connect }));
  t.after(async () => {
    await act(async () => cleanup());
    await new Promise<void>((resolve) => setImmediate(resolve));
    globalThis.fetch = savedFetch;
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const select = () => ui.getByLabelText(/单人搜证者/) as HTMLSelectElement;
  const start = () => ui.getByRole("button", { name: /三人就位.*开始值班/ });
  await waitFor(() =>
    assert.equal((start() as HTMLButtonElement).disabled, false),
  );
  return {
    game,
    first,
    sockets,
    packets,
    ui,
    fireEvent,
    act,
    waitFor,
    select,
    start,
  };
}

test("actual lobby: untouched default select submits a player ID, not the displayed nickname", async (t) => {
  const x = await fixture(t);
  assert.equal(x.select().selectedOptions[0].textContent, "byk");
  assert.equal(x.select().value, x.first.playerId);
  await x.act(async () => {
    x.fireEvent.click(x.start());
  });
  await x.waitFor(() =>
    assert.equal(x.game.rooms.get(x.first.code)!.phase, "hypothesis"),
  );
  assert.equal(x.packets.at(-1).action.solo, x.first.playerId);
});

test("actual lobby regression: leave A, create B without reload, default byk selection must submit B ID", async (t) => {
  const x = await fixture(t);
  x.fireEvent.click(x.ui.getByRole("button", { name: "退出" }));
  x.fireEvent.change(x.ui.getByLabelText("接线员昵称"), {
    target: { value: "byk" },
  });
  x.fireEvent.click(
    x.ui.getByRole("button", { name: /开发试玩：一人切换三席/ }),
  );
  await x.waitFor(() => assert.equal(x.sockets.length, 2));
  await x.waitFor(() =>
    assert.equal((x.start() as HTMLButtonElement).disabled, false),
  );
  const second = x.sockets[1].credentials;
  assert.notEqual(second.playerId, x.first.playerId);
  // Native select looks correct even in the broken code: React was keeping an invalid old value.
  assert.equal(x.select().selectedOptions[0].textContent, "byk");
  assert.equal(x.select().value, second.playerId);
  await x.act(async () => {
    x.fireEvent.click(x.start());
  });
  await x.waitFor(() =>
    assert.equal(x.game.rooms.get(second.code)!.phase, "hypothesis"),
  );
  assert.equal(x.packets.at(-1).action.solo, second.playerId);
  assert.equal(x.ui.queryByRole("alert"), null);
});

test("actual lobby: manual selection survives sandbox seat switches and reconnect state broadcasts", async (t) => {
  const x = await fixture(t),
    r = x.game.rooms.get(x.first.code)!,
    other = r.players[2].id;
  x.fireEvent.change(x.select(), { target: { value: other } });
  x.fireEvent.change(x.ui.getByLabelText("切换试玩席位"), {
    target: { value: r.players[1].id },
  });
  x.fireEvent.change(x.ui.getByLabelText("切换试玩席位"), {
    target: { value: r.host },
  });
  await x.act(async () => {
    x.sockets[0].receive("disconnect");
    x.sockets[0].receive("connect");
    x.sockets[0].publish();
  });
  assert.equal(x.select().value, other);
  await x.act(async () => {
    x.fireEvent.click(x.start());
  });
  await x.waitFor(() => assert.equal(r.phase, "hypothesis"));
  assert.equal(r.solo.player, other);
});
