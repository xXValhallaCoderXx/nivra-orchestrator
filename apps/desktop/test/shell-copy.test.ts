import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codeSpans } from "../src/renderer/src/shell/text.ts";

/** A message's commands, found by their code markup only, for the copy buttons beside them (NIV-56, PN1). */
describe("a message's code spans (NIV-56)", () => {
  it("splits a message at each command, in order, keeping the words around it", () => {
    assert.deepEqual(codeSpans("WSL didn't answer. Run `wsl --update` in a terminal, then press Check again."), [
      { code: false, text: "WSL didn't answer. Run " },
      { code: true, text: "wsl --update" },
      { code: false, text: " in a terminal, then press Check again." },
    ]);
    assert.deepEqual(
      codeSpans("Run `wsl --shutdown` in a terminal and press Check again; if it keeps failing, run `wsl --update`.").filter((part) => part.code).map((part) => part.text),
      ["wsl --shutdown", "wsl --update"],
    );
  });

  it("leaves a message with no command, an unclosed mark or an empty one as words", () => {
    assert.deepEqual(codeSpans("Nivra can't use that folder."), [{ code: false, text: "Nivra can't use that folder." }]);
    assert.deepEqual(codeSpans("a ` lone mark"), [{ code: false, text: "a ` lone mark" }]);
    assert.deepEqual(codeSpans("an `` empty one"), [{ code: false, text: "an `` empty one" }]);
    assert.deepEqual(codeSpans(""), []);
  });
});
