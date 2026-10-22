import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PreviewGuard } from "../src/shared/preview-guard.ts";

/**
 * The research dialog's preview guard (D37): a preview answer is shown only while it answers the latest request and
 * nothing changed since.
 */
describe("the research dialog's preview guard (D37)", () => {
  it("drops the answer to an older request when a later one was made", () => {
    const guard = new PreviewGuard();
    const older = guard.asked();
    const latest = guard.asked();
    assert.deepEqual([guard.current(older), guard.current(latest)], [false, true]);
  });

  it("drops an answer that arrives after an edit, until a new request is made", () => {
    const guard = new PreviewGuard();
    const asked = guard.asked();
    guard.changed();
    assert.equal(guard.current(asked), false);
    const again = guard.asked();
    assert.deepEqual([guard.current(asked), guard.current(again)], [false, true]);
  });

  it("keeps only the latest request's answer, however many edits and requests came before it", () => {
    const guard = new PreviewGuard();
    const tokens = [guard.asked(), (guard.changed(), guard.asked()), guard.asked()];
    guard.changed();
    const last = guard.asked();
    assert.deepEqual([...tokens, last].map((token) => guard.current(token)), [false, false, false, true]);
  });
});
