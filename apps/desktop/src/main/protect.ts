import { maskKnownValues, maskSecretPatterns, secretShapes } from "@nivra/domain";

/**
 * One protection policy for everything the workspace keeps (D8, D26), applied before anything is stored. Known secrets
 * are the keys the host holds; recognised credentials are the shared shapes (`packages/domain`). What the person types
 * is refused, never quietly changed: they are told which field and what kind of credential, never the value. What the
 * engine or a model produced is masked again, keeping its line breaks, on top of the engine's own masking.
 */

/** The secrets the host holds, by name, as `[name, value]`. */
export type KnownSecrets = ReadonlyArray<readonly [name: string, value: string]>;

const SHAPE_WORDS: Readonly<Record<string, string>> = {
  "private-key": "a private key",
  "aws-access-key": "an AWS access key",
  "github-token": "a GitHub token",
  "github-fine-grained-token": "a GitHub token",
  "api-key": "an API key",
  "slack-token": "a Slack token",
  "linear-token": "a Linear API key",
};

/**
 * Throws when text the person typed into `field` holds a saved key or a recognised credential, saying what to do.
 * `field` reads as the start of a sentence ("Your message", "The goal"); `action` is what they were doing.
 */
export function refuseCredentials(field: string, text: string, known: KnownSecrets, action: "send" | "save" = "save"): void {
  const nothing = action === "send" ? "nothing was sent" : "nothing was saved";
  if (known.some(([, value]) => value.length > 0 && text.includes(value))) {
    throw new Error(`${field} holds your saved Token Factory key, so ${nothing}. Remove it, then ${action} again.`);
  }
  const [shape] = secretShapes(text);
  if (shape) throw new Error(`${field} looks like it holds ${SHAPE_WORDS[shape] ?? "a credential"}, so ${nothing}. Remove it, then ${action} again.`);
}

/** Masks text the engine or a model produced before the workspace keeps it: saved keys, then credential shapes. */
export function maskForStorage(text: string, known: KnownSecrets): string {
  return maskSecretPatterns(maskKnownValues(text, known), { keepLines: true });
}

/** The same for a structured value: every string in it, wherever it sits, so no mask can span two fields. */
export function maskValue<T>(value: T, known: KnownSecrets): T {
  if (typeof value === "string") return maskForStorage(value, known) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => maskValue(item, known)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskValue(item, known)])) as T;
  return value;
}
