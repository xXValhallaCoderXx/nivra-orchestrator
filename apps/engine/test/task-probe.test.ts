import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createNebiusBackend } from "../src/exec/nebius/session.ts";
import { takeSnapshot } from "../src/exec/snapshot.ts";
import { buildTaskFixture, trickyGreet } from "../scripts/task-fixture.ts";
import { runToolchainProbe } from "../scripts/task-probe-run.ts";
import { MAX_WRITE_BYTES } from "../src/task/scripts.ts";
import { clock, succeed } from "./fake-sandboxes.ts";
import { RealGuest } from "./real-guest.ts";
import { cleanUp, GIT, localSession, scratch, track } from "./workspace-fixtures.ts";

/**
 * The live toolchain probe's five operations (NIV-7, D39), rehearsed against the fake service with a guest that really
 * runs each command; busybox isn't on this machine, so its applet list is given. The live run is approved separately.
 */
after(cleanUp);

describe("the toolchain probe, rehearsed (NIV-7)", () => {
  it("writes the most one write carries, reads it back exactly, sees it from the case, and collects exactly the fixture plus the write", async () => {
    const parent = track(mkdtempSync(join(scratch("probe"), "fixture-")));
    const fixture = buildTaskFixture(join(parent, "repo"), GIT);
    const local = await localSession(fixture.root);
    const snapshot = await takeSnapshot({ folder: fixture.root, session: local, git: GIT, baseline: fixture.baseline }).finally(() => local.close());
    const guest = new RealGuest();
    guest.quick = true;
    guest.intercept = ({ args }) => (args[0] === "--list" ? succeed({ stdout: "sh\nprintf\nmkdir\nchmod\nsha256sum\ntar\n" }) : undefined);
    const time = clock();
    const backend = createNebiusBackend({ credentials: () => ({ key: "nebius-test-key-0123456789", project: "project-e00test" }), baseImage: guest.baseImage, journalDir: scratch("journals"), transport: () => guest.service.transport, applets: "", limits: { maxOperations: 5, maxTimeoutSeconds: 60, prepareTimeoutSeconds: 60, pollMs: 10 }, now: time.now, sleep: time.sleep });
    const outcome = await runToolchainProbe({ backend, snapshot, transport: guest.service.transport, budgetMs: 15 * 60_000, closeBudgetMs: 7 * 60_000, applets: "" });
    assert.equal(outcome.stopped, null);
    assert.deepEqual([outcome.write?.bytes, outcome.write?.exact, outcome.kase?.verdict, outcome.collect?.integrity, outcome.applets?.list.length], [MAX_WRITE_BYTES, true, "passed", null, 6]);
    assert.equal(Buffer.byteLength(trickyGreet()), MAX_WRITE_BYTES);
    assert.deepEqual(guest.ran.length, 5, "the probe ran more or fewer than its five operations");
    assert.deepEqual([outcome.record?.read, outcome.record?.holdsContent], [true, false]);
    assert.equal(outcome.cleanup?.unresolved.length, 0);
  });
});
