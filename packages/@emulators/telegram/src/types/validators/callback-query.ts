import { z } from "zod";

export const zAnswerCallbackQueryBody = z.object({
  callback_query_id: z.string().min(1),
  text: z.string().optional(),
  show_alert: z.boolean().optional(),
  url: z.string().optional(),
  cache_time: z.number().int().optional(),
});

export type AnswerCallbackQueryBody = z.infer<typeof zAnswerCallbackQueryBody>;
