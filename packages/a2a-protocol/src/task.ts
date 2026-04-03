import { z } from "zod";

import { artifactSchema, messageSchema } from "./message.js";

export const taskStatusSchema = z.enum([
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled"
]);

export const taskSchema = z.object({
  kind: z.literal("task").default("task"),
  taskId: z.string().min(1),
  contextId: z.string().min(1).optional(),
  status: taskStatusSchema,
  latestMessage: messageSchema.optional(),
  artifacts: z.array(artifactSchema).default([]),
  history: z.array(messageSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type Task = z.infer<typeof taskSchema>;
