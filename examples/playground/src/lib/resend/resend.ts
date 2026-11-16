import { Resend } from "resend";

/** The Resend SDK reads RESEND_BASE_URL at module load, so next.config.ts must set it to keep email traffic on the emulator. */
export const resend = new Resend("re_emulated_key");
