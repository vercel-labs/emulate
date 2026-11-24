export interface PlaygroundFlow {
  slug: string;
  label: string;
  description: string;
  services: string[];
}

/** Guided demos that drive an emulator in the tab through a real app feature. */
export const flows: PlaygroundFlow[] = [
  {
    slug: "oauth-sign-in",
    label: "OAuth sign-in",
    description: "Sign in through a provider, pick an account, and read the profile and token it returns.",
    services: ["github", "google", "vercel", "microsoft", "okta", "clerk", "apple"],
  },
  {
    slug: "magic-link",
    label: "Resend magic link",
    description: "Email a one-time code, read it in the inbox, and sign in with it.",
    services: ["resend"],
  },
  {
    slug: "checkout",
    label: "Stripe checkout",
    description: "Fill a bag in a small store, pay through a checkout session, and see the paid order.",
    services: ["stripe"],
  },
  {
    slug: "sms-verification",
    label: "Twilio SMS verification",
    description: "Verify a phone number with Twilio Verify and check the code.",
    services: ["twilio"],
  },
  {
    slug: "file-sharing",
    label: "Vercel Blob sharing",
    description: "Upload files to Vercel Blob, list them, preview them, and delete them.",
    services: ["vercel"],
  },
];
