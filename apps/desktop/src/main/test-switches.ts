import { isAbsolute } from "node:path";

/**
 * The local engine's test-only arguments, from the app's own command-line switches: loopback stand-ins for Token Factory,
 * Nebius Sandboxes and Tavily (D22, D36, D37), whose addresses the engine refuses unless they are on this machine, and a
 * file that holds an apply before the writer step it names, for checks of recovery through the real engine (D40). They
 * are honoured only when the app is unpackaged: a packaged app passes none, whatever it was started with. No Electron
 * (D12), so `node --test` drives it.
 */
const SWITCHES: ReadonlyArray<readonly [name: string, arg: string]> = [
  ["nivra-token-factory-url", "--token-factory-url"],
  ["nivra-sandboxes-url", "--sandboxes-url"],
  ["nivra-tavily-url", "--tavily-url"],
  ["nivra-test-apply-hold", "--apply-hold"],
];

/** The arguments the switches given ask for, in a fixed order; none when packaged. `value` is "" for a switch not given. */
export function testEngineArgs(packaged: boolean, value: (name: string) => string): string[] {
  if (packaged) return [];
  return SWITCHES.flatMap(([name, arg]) => {
    const given = value(name);
    if (!given) return [];
    // The engine resolves a relative path against its own working directory, which isn't the test's.
    if (arg === "--apply-hold" && !isAbsolute(given)) throw new Error(`--${name} takes an absolute file path, not "${given}".`);
    return [arg, given];
  });
}
