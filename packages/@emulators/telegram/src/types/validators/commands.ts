import { z } from "zod";

export const zBotCommand = z.object({
  command: z.string(),
  description: z.string(),
});

export const zSetMyCommandsBody = z.object({
  commands: z.array(zBotCommand),
});

export type SetMyCommandsBody = z.infer<typeof zSetMyCommandsBody>;
