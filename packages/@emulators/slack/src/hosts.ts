import type { ServiceHost } from "@emulators/core";

/** Real Slack hosts. Web API, OAuth, incoming webhook, and file paths do not overlap. */
export const hosts: readonly ServiceHost[] = [
  { host: "slack.com" },
  { host: "hooks.slack.com" },
  { host: "files.slack.com" },
];
