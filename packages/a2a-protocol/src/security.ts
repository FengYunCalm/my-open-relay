import { z } from "zod";

export const noAuthSecuritySchemeSchema = z.object({
  type: z.literal("noauth"),
  description: z.string().min(1).optional()
});

export const apiKeySecuritySchemeSchema = z.object({
  type: z.literal("apiKey"),
  name: z.string().min(1),
  in: z.enum(["header", "query"]),
  description: z.string().min(1).optional()
});

export const bearerSecuritySchemeSchema = z.object({
  type: z.literal("bearer"),
  bearerFormat: z.string().min(1).optional(),
  description: z.string().min(1).optional()
});

export const openIdConnectSecuritySchemeSchema = z.object({
  type: z.literal("openIdConnect"),
  openIdConnectUrl: z.string().url(),
  scopes: z.array(z.string().min(1)).default([]),
  description: z.string().min(1).optional()
});

export const securitySchemeSchema = z.discriminatedUnion("type", [
  noAuthSecuritySchemeSchema,
  apiKeySecuritySchemeSchema,
  bearerSecuritySchemeSchema,
  openIdConnectSecuritySchemeSchema
]);

export type SecurityScheme = z.infer<typeof securitySchemeSchema>;
