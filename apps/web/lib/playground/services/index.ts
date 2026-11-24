import { ai } from "./ai";
import { apple } from "./apple";
import { aws } from "./aws";
import { clerk } from "./clerk";
import { github } from "./github";
import { google } from "./google";
import { linear } from "./linear";
import { microsoft } from "./microsoft";
import { mongoatlas } from "./mongoatlas";
import { okta } from "./okta";
import { resend } from "./resend";
import { slack } from "./slack";
import { stripe } from "./stripe";
import { twilio } from "./twilio";
import { vercel } from "./vercel";
import type { ConsoleService } from "./types";

export type { ConsolePreset, ConsoleService, ConsoleVariable, PresetGroup } from "./types";

/** Every emulator's catalog of ready-made requests, shown by the request console at /playground/<name>. */
export const consoleServices: ConsoleService[] = [
  ai,
  apple,
  aws,
  clerk,
  github,
  google,
  linear,
  microsoft,
  mongoatlas,
  okta,
  resend,
  slack,
  stripe,
  twilio,
  vercel,
];
