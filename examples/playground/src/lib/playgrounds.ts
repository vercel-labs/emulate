export interface Flow {
  href: string;
  label: string;
  description: string;
  services: string[];
}

/** Demo flows that drive an emulator through a real app feature. */
export const flows: Flow[] = [
  {
    href: "/oauth",
    label: "OAuth sign-in",
    description: "Sign in through a provider's consent screen and read the profile it returns.",
    services: ["github", "google", "vercel", "microsoft", "okta", "clerk", "apple"],
  },
  {
    href: "/resend",
    label: "Resend magic link",
    description: "Email a one-time code with the Resend SDK and read it in the emulated inbox.",
    services: ["resend"],
  },
  {
    href: "/stripe",
    label: "Stripe checkout",
    description: "Shop a small store, pay on the hosted checkout page, and receive the webhook.",
    services: ["stripe"],
  },
  {
    href: "/twilio",
    label: "Twilio SMS verification",
    description: "Verify a phone number with Twilio Verify and read the code in the inspector.",
    services: ["twilio"],
  },
  {
    href: "/blob",
    label: "Vercel Blob sharing",
    description: "Upload files with the Vercel Blob SDK and open them through share links.",
    services: ["vercel"],
  },
];
