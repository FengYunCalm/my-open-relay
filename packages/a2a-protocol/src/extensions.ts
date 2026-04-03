import { z } from "zod";

export const extensionDeclarationSchema = z.object({
  uri: z.string().url(),
  description: z.string().min(1),
  required: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type ExtensionDeclaration = z.infer<typeof extensionDeclarationSchema>;
