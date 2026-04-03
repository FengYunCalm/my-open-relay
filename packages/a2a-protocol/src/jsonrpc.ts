import { z } from "zod";

export const jsonValueSchema: z.ZodType<
  string | number | boolean | null | { [key: string]: unknown } | unknown[]
> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const jsonRpcIdSchema = z.union([z.string().min(1), z.number().finite()]);

export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcIdSchema,
  method: z.string().min(1),
  params: jsonValueSchema.optional()
});

export const jsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string().min(1),
  data: jsonValueSchema.optional()
});

export const jsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([jsonRpcIdSchema, z.null()]),
    result: jsonValueSchema.optional(),
    error: jsonRpcErrorSchema.optional()
  })
  .superRefine((value, ctx) => {
    const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
    const hasError = Object.prototype.hasOwnProperty.call(value, "error");

    if (hasResult === hasError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A JSON-RPC response must contain exactly one of result or error."
      });
    }
  });

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;
export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;
