import { z } from "zod";

import { extensionDeclarationSchema } from "./extensions.js";
import { securitySchemeSchema } from "./security.js";

export const agentSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  examples: z.array(z.string().min(1)).default([])
});

export const agentCapabilitiesSchema = z.object({
  streaming: z.boolean().default(false),
  pushNotifications: z.boolean().default(false),
  stateTransitionHistory: z.boolean().default(false),
  humanTakeover: z.boolean().default(false)
});

export const agentCardSchema = z.object({
  protocolVersion: z.literal("1.0"),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  url: z.string().url(),
  preferredTransport: z.enum(["http+jsonrpc", "https+jsonrpc", "http+sse", "https+sse"]).default("https+jsonrpc"),
  defaultInputModes: z.array(z.string().min(1)).min(1),
  defaultOutputModes: z.array(z.string().min(1)).min(1),
  capabilities: agentCapabilitiesSchema,
  skills: z.array(agentSkillSchema).default([]),
  securitySchemes: z.array(securitySchemeSchema).min(1),
  extensions: z.array(extensionDeclarationSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type AgentCard = z.infer<typeof agentCardSchema>;
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;
export type AgentSkill = z.infer<typeof agentSkillSchema>;

export function parseAgentCard(value: unknown): AgentCard {
  return agentCardSchema.parse(value);
}
