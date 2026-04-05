import { z } from "zod";

export const relayCurrentSessionPlaceholder = "current";

export function isRelayCurrentSessionPlaceholder(value: unknown): value is string {
  return typeof value === "string" && value.trim().toLocaleLowerCase() === relayCurrentSessionPlaceholder;
}

export function shouldInjectRelaySessionID(value: unknown): boolean {
  return value === undefined || isRelayCurrentSessionPlaceholder(value);
}

export const concreteRelaySessionIDSchema = z.string().min(1).refine(
  (value) => !isRelayCurrentSessionPlaceholder(value),
  {
    message: `Reserved session placeholder \"${relayCurrentSessionPlaceholder}\" is not allowed here. Provide a real session ID, or omit the field when routed through OpenCode relay plugin hooks.`
  }
);
