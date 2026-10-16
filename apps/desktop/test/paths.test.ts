import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPicked, driveFromMount, folderLabel, sameFolder } from "../src/main/paths.ts";
import { labelFor } from "../src/main/targets/types.ts";

/** D17: the folder's owner decides where its work runs, once, when it is added. */
const windows = { platform: "win32" as const, insideWsl: false };

describe("which engine a picked folder belongs to", () => {
  it("gives a Windows drive folder to the Windows engine", () => {
    assert.deepEqual(classifyPicked("C:\\Users\\odin\\repo ü%#", windows), { kind: "local", nativePath: "C:\\Users\\odin\\repo ü%#", notice: null });
    assert.equal(classifyPicked("d:/work/repo", windows).kind, "local");
  });

  it("gives a folder inside a distribution to that distribution, as a Linux path, from either UNC form", () => {
    assert.deepEqual(classifyPicked("\\\\wsl.localhost\\Ubuntu\\home\\odin\\repo ü%#", windows), { kind: "wsl", distro: "Ubuntu", nativePath: "/home/odin/repo ü%#" });
    assert.deepEqual(classifyPicked("\\\\wsl$\\Debian\\srv\\app\\", windows), { kind: "wsl", distro: "Debian", nativePath: "/srv/app" });
    assert.deepEqual(classifyPicked("\\\\wsl.localhost\\Ubuntu", windows), { kind: "wsl", distro: "Ubuntu", nativePath: "/" });
  });

  it("gives a Windows drive seen through WSL back to Windows, and says why", () => {
    const picked = classifyPicked("\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\odin\\repo", windows);
    assert.equal(picked.kind, "local");
    assert.equal(picked.kind === "local" ? picked.nativePath : null, "C:\\Users\\odin\\repo");
    assert.match(picked.kind === "local" ? (picked.notice ?? "") : "", /drive C:.*move the repository into Ubuntu/);
    // /mnt/wsl is WSL's own, not a drive.
    assert.equal(classifyPicked("\\\\wsl.localhost\\Ubuntu\\mnt\\wsl\\shared", windows).kind, "wsl");
  });

  it("refuses network shares and anything that isn't a full path, saying what to do", () => {
    const share = classifyPicked("\\\\server\\share\\repo", windows);
    assert.equal(share.kind, "refused");
    assert.match(share.kind === "refused" ? share.reason : "", /network share.*local drive or into a WSL distribution/);
    assert.equal(classifyPicked("repo", windows).kind, "refused");
    assert.equal(classifyPicked("repo", { platform: "linux", insideWsl: false }).kind, "refused");
  });

  it("keeps Linux folders local, warning only about Windows drives when running inside WSL", () => {
    assert.deepEqual(classifyPicked("/home/odin/repo", { platform: "linux", insideWsl: true }), { kind: "local", nativePath: "/home/odin/repo", notice: null });
    assert.equal(classifyPicked("/mnt/c/repo", { platform: "linux", insideWsl: false }).kind === "local", true);
    const slow = classifyPicked("/mnt/c/repo", { platform: "linux", insideWsl: true });
    assert.match(slow.kind === "local" ? (slow.notice ?? "") : "", /slow from Linux/);
  });
});

describe("path helpers", () => {
  it("turns a drive mount into the Windows path, and nothing else", () => {
    assert.equal(driveFromMount("/mnt/c"), "C:\\");
    assert.equal(driveFromMount("/mnt/d/a b/c"), "D:\\a b\\c");
    assert.equal(driveFromMount("/mnt/wsl/x"), null);
    assert.equal(driveFromMount("/home/odin"), null);
  });

  it("compares Windows folders without case or slash style, and Linux folders exactly", () => {
    assert.equal(sameFolder("C:\\Repo\\", "c:/repo", true), true);
    assert.equal(sameFolder("/home/odin/Repo", "/home/odin/repo", false), false);
    assert.equal(sameFolder("/home/odin/repo/", "/home/odin/repo", false), true);
  });

  it("labels folders and targets as the person sees them", () => {
    assert.equal(folderLabel("C:\\Users\\odin\\repo ü%#"), "repo ü%#");
    assert.equal(folderLabel("/home/odin/repo/"), "repo");
    assert.equal(labelFor("local", "win32"), "Windows · Local");
    assert.equal(labelFor("local", "linux"), "Linux · Local");
    assert.equal(labelFor("wsl:Ubuntu", "win32"), "Ubuntu · WSL");
  });
});
