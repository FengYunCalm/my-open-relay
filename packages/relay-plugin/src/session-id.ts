import { z } from "zod";

export const relayCurrentSessionPlaceholder = "current";
export const relaySessionPlaceholderAliases = [relayCurrentSessionPlaceholder, "/"] as const;

export function isRelayCurrentSessionPlaceholder(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLocaleLowerCase();
  return relaySessionPlaceholderAliases.includes(normalized as (typeof relaySessionPlaceholderAliases)[number]);
}

export function shouldInjectRelaySessionID(value: unknown): boolean {
  return value === undefined || isRelayCurrentSessionPlaceholder(value);
}

export const concreteRelaySessionIDSchema = z.string().min(1).refine(
  (value) => !isRelayCurrentSessionPlaceholder(value),
  {
    message: `Reserved session placeholders (${relaySessionPlaceholderAliases.map((item) => JSON.stringify(item)).join(", ")}) are not allowed here. Provide a real session ID, or omit the field when routed through OpenCode relay plugin hooks.`
  }
);
