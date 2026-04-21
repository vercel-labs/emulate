import { z } from "zod";

export const zGetUpdatesBody = z.object({
  offset: z.number().int().optional(),
  limit: z.number().int().optional(),
  timeout: z.number().int().optional(),
  allowed_updates: z.array(z.string()).optional(),
});
export type GetUpdatesBody = z.infer<typeof zGetUpdatesBody>;

export const zSetWebhookBody = z.object({
  url: z.string().optional(),
  secret_token: z.string().optional(),
  allowed_updates: z.array(z.string()).optional(),
});
export type SetWebhookBody = z.infer<typeof zSetWebhookBody>;

export const zGetFileBody = z.object({
  file_id: z.string().min(1),
});
export type GetFileBody = z.infer<typeof zGetFileBody>;
