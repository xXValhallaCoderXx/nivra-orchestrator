import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { byBytes, caseKey, isGitControlFile, proposedPathProblem, snapshotPathProblem } from "../src/exec/workspace-rules.ts";

/**
 * The path rules for what goes into a sandbox and what comes back (NIV-42, D34). A commit's own paths need only be
 * safe to write; a path a change adds or changes must also hold on every target a checkout may live on.
 */
describe("workspace path rules", () => {
  it("refuses a commit's paths that aren't safe to write anywhere, and nothing else", () => {
    for (const path of ["", "a//b", "./a", "a/./b", "a/../b", "..", "a/", ".git/config", ".GIT/config", ".git./x", ".git /x", ".Git", "git~1/config", "GIT~2/x", "a\nb", "tab\there", "zero​width", "bidi‮exe", `${"a".repeat(256)}/b`, "a/".repeat(600) + "b"]) {
      assert.notEqual(snapshotPathProblem(path), null, JSON.stringify(path.slice(0, 40)));
    }
    for (const path of ["README.md", "docs/ü.md", "aux.c", "con.txt", "a.git", ".github/workflows/ci.yml", ".gitignore", "dir with space/x", "x.", "PROGRA~1/x", `${"a".repeat(255)}/b`]) {
      assert.equal(snapshotPathProblem(path), null, path);
    }
  });

  it("also refuses, for a path a change adds, what any target's filesystem can't hold", () => {
    const refused: Array<[string, RegExp]> = [
      ["aux.c", /a name Windows reserves/],
      ["src/CON", /a name Windows reserves/],
      ["con.txt", /a name Windows reserves/],
      ["COM¹.log", /a name Windows reserves/],
      ["lpt3", /a name Windows reserves/],
      ["CONIN$", /a name Windows reserves/],
      ["a:b", /a character Windows forbids/],
      ["a\\b", /a character Windows forbids/],
      ["what?.md", /a character Windows forbids/],
      ["x.", /ends with a dot or a space/],
      ["dir /x", /ends with a dot or a space/],
      ["PROGRA~1/x", /the shape of a Windows short name/],
      ["file~12.txt", /the shape of a Windows short name/],
      [".git/hooks/pre-commit", /a \.git component/],
    ];
    for (const [path, words] of refused) assert.match(proposedPathProblem(path) ?? "", words, path);
    for (const path of ["README.md", "con-fig.ts", "auxiliary.c", "tilde~.txt", "v~1a.txt", "docs/ü.md", "COM10"]) assert.equal(proposedPathProblem(path), null, path);
  });

  it("knows git's own control files, compares paths as their bytes and folds case and Unicode form", () => {
    for (const path of [".gitmodules", "sub/.gitattributes", ".LFSCONFIG"]) assert.equal(isGitControlFile(path), true, path);
    for (const path of [".gitignore", "gitmodules", ".gitmodules.bak"]) assert.equal(isGitControlFile(path), false, path);
    assert.deepEqual(["b", "B", "a-b", "a_b", "a/b", "ü"].sort(byBytes), ["B", "a-b", "a/b", "a_b", "b", "ü"]);
    assert.equal(caseKey("README.md"), caseKey("readme.MD"));
    assert.equal(caseKey("é.txt"), caseKey("é.txt"));
  });
});
