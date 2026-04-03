import { randomUUID } from "node:crypto";

const prefixSchema = /^[a-z][a-z0-9-]*$/;

export function createOpaqueId(prefix: string): string {
  const normalizedPrefix = prefix.trim().toLowerCase();

  if (!prefixSchema.test(normalizedPrefix)) {
    throw new Error(`Invalid opaque id prefix: ${prefix}`);
  }

  return `${normalizedPrefix}_${randomUUID()}`;
}

export function hasOpaqueIdPrefix(value: string, prefix: string): boolean {
  return value.startsWith(`${prefix}_`);
}
