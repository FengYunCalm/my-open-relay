import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const a2aConfigSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(7331),
  basePath: z.string().startsWith("/").default("/a2a"),
  healthPath: z.string().startsWith("/").default("/health"),
  readyPath: z.string().startsWith("/").default("/ready")
});

const runtimeConfigSchema = z.object({
  compactionContextLimit: z.number().int().positive().default(20),
  teamWorkerStaleAfterMs: z.number().int().positive().default(300000),
  injectViaNoReply: z.boolean().default(true),
  databasePath: z.string().min(1).optional()
});

export const relaySessionPairSchema = z.object({
  sourceSessionID: z.string().min(1),
  targetSessionID: z.string().min(1),
  bidirectional: z.boolean().default(false)
});

const routingConfigSchema = z.object({
  mode: z.enum(["open", "pair"]).default("open"),
  pairs: z.array(relaySessionPairSchema).default([])
});

const relayPluginConfigInputSchema = z.object({
  a2a: a2aConfigSchema.partial().optional(),
  runtime: runtimeConfigSchema.partial().optional(),
  routing: routingConfigSchema.partial().extend({
    pairs: z.array(relaySessionPairSchema).optional()
  }).optional(),
  configPath: z.string().min(1).optional()
});

export const relayPluginConfigSchema = z.object({
  a2a: z.preprocess(
    (value) => value ?? {},
    a2aConfigSchema.partial().transform((value) => a2aConfigSchema.parse(value))
  ),
  runtime: z.preprocess(
    (value) => value ?? {},
    runtimeConfigSchema.partial().transform((value) => runtimeConfigSchema.parse(value))
  ),
  routing: z.preprocess(
    (value) => value ?? {},
    routingConfigSchema.partial().transform((value) => routingConfigSchema.parse(value))
  )
});

export type RelayPluginConfig = z.infer<typeof relayPluginConfigSchema>;
export type RelaySessionPair = z.infer<typeof relaySessionPairSchema>;

type RelayPluginConfigInput = z.infer<typeof relayPluginConfigInputSchema>;

export function resolveInstalledConfigPathFromModuleUrl(moduleUrl: string): string {
  return fileURLToPath(new URL("./opencode-a2a-relay.config.json", moduleUrl));
}

function resolveInstalledConfigPath(overridePath?: string): string {
  if (overridePath) {
    return overridePath;
  }

  return resolveInstalledConfigPathFromModuleUrl(import.meta.url);
}

function loadInstalledRelayPluginConfig(overridePath?: string): RelayPluginConfigInput {
  const configPath = resolveInstalledConfigPath(overridePath);
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, "utf8");
  return relayPluginConfigInputSchema.parse(JSON.parse(raw));
}

function mergeRelayPluginConfig(base: RelayPluginConfigInput, override: RelayPluginConfigInput): RelayPluginConfigInput {
  return {
    a2a: {
      ...(base.a2a ?? {}),
      ...(override.a2a ?? {})
    },
    runtime: {
      ...(base.runtime ?? {}),
      ...(override.runtime ?? {})
    },
    routing: {
      ...(base.routing ?? {}),
      ...(override.routing ?? {}),
      pairs: override.routing?.pairs ?? base.routing?.pairs
    }
  };
}

export function isRelayPairAllowed(config: RelayPluginConfig, sourceSessionID: string | undefined, targetSessionID: string | undefined): boolean {
  if (config.routing.mode === "open") {
    return true;
  }

  if (!sourceSessionID || !targetSessionID) {
    return false;
  }

  return config.routing.pairs.some((pair) => {
    if (pair.sourceSessionID === sourceSessionID && pair.targetSessionID === targetSessionID) {
      return true;
    }

    if (pair.bidirectional && pair.sourceSessionID === targetSessionID && pair.targetSessionID === sourceSessionID) {
      return true;
    }

    return false;
  });
}

export function resolveRelayPluginConfig(input?: unknown): RelayPluginConfig {
  const directInput = relayPluginConfigInputSchema.parse(input ?? {});
  const fileConfig = loadInstalledRelayPluginConfig(directInput.configPath);
  const merged = mergeRelayPluginConfig(fileConfig, directInput);
  return relayPluginConfigSchema.parse(merged);
}

export function buildRelayPluginInstanceKey(config: RelayPluginConfig): string {
  return [
    config.a2a.host,
    String(config.a2a.port),
    config.a2a.basePath,
    config.runtime.databasePath ?? "__default_db__"
  ].join("|");
}
