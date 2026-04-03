import { z } from "zod";

import { artifactSchema, messageSchema } from "./message.js";
import { taskStatusSchema } from "./task.js";

export const taskStatusUpdateEventSchema = z.object({
  type: z.literal("task-status-update"),
  taskId: z.string().min(1),
  contextId: z.string().min(1).optional(),
  status: taskStatusSchema,
  message: messageSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const taskArtifactUpdateEventSchema = z.object({
  type: z.literal("task-artifact-update"),
  taskId: z.string().min(1),
  contextId: z.string().min(1).optional(),
  artifact: artifactSchema,
  append: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const taskEventSchema = z.union([
  taskStatusUpdateEventSchema,
  taskArtifactUpdateEventSchema
]);

export type TaskStatusUpdateEvent = z.infer<typeof taskStatusUpdateEventSchema>;
export type TaskArtifactUpdateEvent = z.infer<typeof taskArtifactUpdateEventSchema>;
export type TaskEvent = z.infer<typeof taskEventSchema>;
