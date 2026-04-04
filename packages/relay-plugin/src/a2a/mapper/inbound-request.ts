import { z } from "zod";

import { jsonRpcRequestSchema, messageSchema, type JsonRpcRequest, type Message } from "@opencode-peer-session-relay/a2a-protocol";

export const sendMessageParamsSchema = z.object({
  sourceSessionID: z.string().min(1).optional(),
  sessionID: z.string().min(1).optional(),
  contextId: z.string().min(1).optional(),
  message: messageSchema,
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const getTaskParamsSchema = z.object({
  taskId: z.string().min(1)
});

export const cancelTaskParamsSchema = z.object({
  taskId: z.string().min(1)
});

export type InboundRelayRequest = {
  requestId: string | number;
  sourceSessionID?: string;
  sessionID?: string;
  contextId?: string;
  message: Message;
  metadata: Record<string, unknown>;
};

export function mapSendMessageRequest(request: JsonRpcRequest): InboundRelayRequest {
  const parsedRequest = jsonRpcRequestSchema.parse(request);

  if (parsedRequest.method !== "sendMessage") {
    throw new Error(`Unsupported method for sendMessage handler: ${parsedRequest.method}`);
  }

  const params = sendMessageParamsSchema.parse(parsedRequest.params ?? {});

  return {
    requestId: parsedRequest.id,
    sourceSessionID: params.sourceSessionID,
    sessionID: params.sessionID,
    contextId: params.contextId,
    message: params.message,
    metadata: params.metadata
  };
}
