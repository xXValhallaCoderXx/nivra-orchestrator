import assert from "node:assert/strict";
import { after, it } from "node:test";
import { createNebiusBackend } from "../src/exec/nebius/session.ts";
import { clock } from "./fake-sandboxes.ts";
import { RealGuest } from "./real-guest.ts";
import { FIXTURE, KEY, PROJECT } from "./task-fixtures.ts";
import { cleanUp, repoWith, scratch, snap } from "./workspace-fixtures.ts";

after(cleanUp);
it("extends the boundary's operation capacity only between operations, without resetting usage or the deadline", async () => {
  const root = repoWith(FIXTURE), snapshot = await snap(root), guest = new RealGuest(), time = clock();
  guest.quick = true;
  const backend = createNebiusBackend({ credentials: () => ({ key: KEY, project: PROJECT }), baseImage: guest.baseImage, journalDir: scratch("capacity journal"), transport: () => guest.service.transport, applets: "", limits: { maxOperations: 2, maxTimeoutSeconds: 60, prepareTimeoutSeconds: 60, pollMs: 1 }, now: time.now, sleep: time.sleep });
  const session = await backend.open({ workspace: "/workspace", network: "deny", snapshot: snapshot.archive, budgetMs: 600_000 });
  const request = { argv: ["/bin/sh", "-c", "true"] as const, cwd: "/workspace", timeoutMs: 1000, maxOutputBytes: 1024, persist: false };
  try {
    await session.exec(request);
    await assert.rejects(session.exec(request), /most one session/);
    assert.equal(guest.ran.length, 2);
    session.addOperationCapacity!(1);
    const running = session.exec(request);
    assert.throws(() => session.addOperationCapacity!(1), /between settled operations/);
    await running;
    await assert.rejects(session.exec(request), /most one session/);
    assert.equal(guest.ran.length, 3);
    session.addOperationCapacity!(10);
    await time.sleep(600_000);
    await assert.rejects(session.exec(request), /time left/);
    assert.equal(guest.ran.length, 3);
  } finally { await session.close(); }
});
