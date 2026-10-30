import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it, type TestContext } from "node:test";
import { showWindowWhenReady, WINDOW_SHOW_FALLBACK_MS } from "../src/main/window-visibility.ts";

class Window extends EventEmitter {
  visible = false;
  destroyed = false;
  shows = 0;
  isDestroyed(): boolean { return this.destroyed; }
  isVisible(): boolean { return this.visible; }
  show(): void { this.shows++; this.visible = true; this.emit("show"); }
}

function startup(t: TestContext): Window {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const window = new Window();
  showWindowWhenReady(window);
  return window;
}

function noListeners(window: Window): void {
  for (const event of ["ready-to-show", "show", "close", "closed"]) assert.equal(window.listenerCount(event), 0, event);
}

describe("window startup visibility (NIV-28)", () => {
  it("shows immediately when ready and never reopens a window hidden after it appeared", (t) => {
    const window = startup(t);
    assert.equal(window.shows, 0);
    t.mock.timers.tick(WINDOW_SHOW_FALLBACK_MS - 1);
    window.emit("ready-to-show");
    assert.equal(window.visible, true);
    assert.equal(window.shows, 1);
    noListeners(window);
    window.visible = false;
    t.mock.timers.tick(10_000);
    window.emit("ready-to-show");
    assert.equal(window.shows, 1);
    assert.equal(window.visible, false);
  });

  it("shows at five seconds when readiness never arrives and ignores later readiness", (t) => {
    const window = startup(t);
    assert.equal(WINDOW_SHOW_FALLBACK_MS, 5_000);
    t.mock.timers.tick(4_999);
    assert.equal(window.shows, 0);
    t.mock.timers.tick(1);
    assert.equal(window.visible, true);
    assert.equal(window.shows, 1);
    noListeners(window);
    window.emit("ready-to-show");
    t.mock.timers.tick(10_000);
    assert.equal(window.shows, 1);
  });

  it("cancels startup when another path shows the window", (t) => {
    const window = startup(t);
    window.show();
    noListeners(window);
    window.visible = false;
    t.mock.timers.tick(10_000);
    window.emit("ready-to-show");
    assert.equal(window.shows, 1);
    assert.equal(window.visible, false);
  });

  for (const event of ["close", "closed"] as const) it(`cancels a pending fallback on ${event}, including late readiness`, (t) => {
    const window = startup(t);
    t.mock.timers.tick(1_000);
    window.emit(event);
    noListeners(window);
    t.mock.timers.tick(10_000);
    window.emit("ready-to-show");
    assert.equal(window.shows, 0);
  });

  it("does not show a window destroyed without a close event", (t) => {
    const window = startup(t);
    window.destroyed = true;
    t.mock.timers.tick(WINDOW_SHOW_FALLBACK_MS);
    assert.equal(window.shows, 0);
    noListeners(window);
  });

  it("adds no startup work to an already visible or destroyed window", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const state of ["visible", "destroyed"] as const) {
      const window = new Window();
      window[state] = true;
      showWindowWhenReady(window);
      noListeners(window);
      t.mock.timers.tick(10_000);
      window.emit("ready-to-show");
      assert.equal(window.shows, 0);
    }
  });
});
