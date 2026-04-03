import { z } from "zod";

export const partMetadataSchema = z.record(z.string(), z.unknown()).default({});

export const textPartSchema = z.object({
  text: z.string().min(1),
  mediaType: z.string().min(1).default("text/plain"),
  filename: z.string().min(1).optional(),
  metadata: partMetadataSchema
});

export const dataPartSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  mediaType: z.string().min(1).default("application/json"),
  filename: z.string().min(1).optional(),
  metadata: partMetadataSchema
});

export const urlPartSchema = z.object({
  url: z.string().url(),
  mediaType: z.string().min(1),
  filename: z.string().min(1).optional(),
  metadata: partMetadataSchema
});

export const rawPartSchema = z.object({
  raw: z.string().min(1),
  mediaType: z.string().min(1),
  filename: z.string().min(1).optional(),
  metadata: partMetadataSchema
});

export const partSchema = z.union([textPartSchema, dataPartSchema, urlPartSchema, rawPartSchema]);

export const messageSchema = z.object({
  kind: z.literal("message").default("message"),
  messageId: z.string().min(1),
  role: z.enum(["user", "agent"]),
  parts: z.array(partSchema).min(1),
  metadata: partMetadataSchema
});

export const artifactSchema = z.object({
  artifactId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  parts: z.array(partSchema).min(1),
  metadata: partMetadataSchema
});

export type Part = z.infer<typeof partSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
