import type { SecretName } from "@nivra/domain";

/** Provider variables the engine removes from its own environment at start (D8): Mastra would fall back to them. */
export const PROVIDER_ENV_VARS = ["NEBIUS_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"] as const;

/**
 * The engine's secrets, held in memory only (D8). Values arrive in `initialize` and `secrets.update`; steps read them
 * through `get` when they need one, so a key is never part of workflow input, request context, run input or events.
 * `mask` replaces every known value in a text, and everything the run store keeps passes through it.
 */
export class SecretVault {
  readonly #values = new Map<SecretName, string>();

  set(name: SecretName, value: string): void {
    this.#values.set(name, value);
  }

  remove(name: SecretName): void {
    this.#values.delete(name);
  }

  get(name: SecretName): string | null {
    return this.#values.get(name) ?? null;
  }

  has(name: SecretName): boolean {
    return this.#values.has(name);
  }

  /** Masks the longest values first, so a value inside another is replaced whole. */
  readonly mask = (text: string): string => {
    if (this.#values.size === 0) return text;
    let masked = text;
    for (const [name, value] of [...this.#values].sort((a, b) => b[1].length - a[1].length)) {
      if (masked.includes(value)) masked = masked.split(value).join(`[secret:${name}]`);
    }
    return masked;
  };
}

/** Removes provider keys from an environment, in place. */
export function stripProviderEnv(env: NodeJS.ProcessEnv): void {
  for (const name of PROVIDER_ENV_VARS) delete env[name];
}
