import { Resend } from "resend";

// The Resend SDK reads RESEND_BASE_URL from the environment at module load
// time. When running with the embedded emulator, set it in next.config.ts so
// all email traffic stays local.
export const resend = new Resend("re_emulated_key");
