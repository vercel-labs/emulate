import type { InspectorTab, RouteContext } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { getTwilioStore } from "../store.js";
import { maskSecret } from "../helpers.js";

const SERVICE_LABEL = "Twilio";
const TABS: InspectorTab[] = [
  { id: "messages", label: "Messages", href: "/?tab=messages" },
  { id: "verify", label: "Verify", href: "/?tab=verify" },
  { id: "calls", label: "Calls", href: "/?tab=calls" },
  { id: "conversations", label: "Conversations", href: "/?tab=conversations" },
  { id: "numbers", label: "Numbers", href: "/?tab=numbers" },
  { id: "services", label: "Services", href: "/?tab=services" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
  { id: "webhooks", label: "Webhooks", href: "/?tab=webhooks" },
];

type TabId = (typeof TABS)[number]["id"];

export function inspectorRoutes({ app, store }: RouteContext): void {
  const ts = () => getTwilioStore(store);

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "messages";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "messages";
    const body =
      active === "verify"
        ? verifyView()
        : active === "calls"
          ? callsView()
          : active === "conversations"
            ? conversationsView()
            : active === "numbers"
              ? numbersView()
              : active === "services"
                ? servicesView()
                : active === "auth"
                  ? authView()
                  : active === "webhooks"
                    ? webhooksView()
                    : messagesView();
    return c.html(renderInspectorPage("Twilio Inspector", TABS, active, body, SERVICE_LABEL));
  });

  function messagesView(): string {
    const rows = ts()
      .messages.all()
      .sort((a, b) => b.id - a.id)
      .map((message) => [
        escapeHtml(message.sid),
        escapeHtml(message.direction),
        escapeHtml(message.status),
        escapeHtml(message.from ?? ""),
        escapeHtml(message.to),
        escapeHtml(message.body ?? ""),
        escapeHtml(message.created_at),
      ]);
    return section(
      "Messages",
      table(["SID", "Direction", "Status", "From", "To", "Body", "Created"], rows, "No messages."),
    );
  }

  function verifyView(): string {
    const serviceRows = ts()
      .verifyServices.all()
      .map((service) => [escapeHtml(service.sid), escapeHtml(service.friendly_name), escapeHtml(service.code)]);
    const verificationRows = ts()
      .verifications.all()
      .sort((a, b) => b.id - a.id)
      .map((verification) => [
        escapeHtml(verification.sid),
        escapeHtml(verification.to),
        escapeHtml(verification.channel),
        escapeHtml(verification.status),
        escapeHtml(String(verification.attempts)),
      ]);
    return (
      section("Verify Services", table(["SID", "Name", "Code"], serviceRows, "No Verify services.")) +
      section(
        "Verifications",
        table(["SID", "To", "Channel", "Status", "Attempts"], verificationRows, "No verifications."),
      )
    );
  }

  function callsView(): string {
    const rows = ts()
      .calls.all()
      .sort((a, b) => b.id - a.id)
      .map((call) => [
        escapeHtml(call.sid),
        escapeHtml(call.direction),
        escapeHtml(call.status),
        escapeHtml(call.from),
        escapeHtml(call.to),
        escapeHtml(call.twiml_steps.join(", ")),
        escapeHtml(call.created_at),
      ]);
    return section("Calls", table(["SID", "Direction", "Status", "From", "To", "TwiML", "Created"], rows, "No calls."));
  }

  function numbersView(): string {
    const rows = ts()
      .phoneNumbers.all()
      .map((number) => [
        escapeHtml(number.sid),
        escapeHtml(number.phone_number),
        escapeHtml(number.friendly_name),
        escapeHtml(number.sms_url ?? ""),
        escapeHtml(number.voice_url ?? ""),
      ]);
    return section(
      "Phone Numbers",
      table(["SID", "Number", "Name", "SMS URL", "Voice URL"], rows, "No phone numbers."),
    );
  }

  function conversationsView(): string {
    const serviceRows = ts()
      .conversationServices.all()
      .map((service) => [
        escapeHtml(service.sid),
        escapeHtml(service.friendly_name),
        escapeHtml(String(ts().conversations.count((item) => item.service_sid === service.sid))),
      ]);
    const conversationRows = ts()
      .conversations.all()
      .map((conversation) => [
        escapeHtml(conversation.sid),
        escapeHtml(conversation.friendly_name ?? ""),
        escapeHtml(conversation.unique_name ?? ""),
        escapeHtml(conversation.state),
        escapeHtml(String(ts().conversationParticipants.count((item) => item.conversation_sid === conversation.sid))),
        escapeHtml(String(ts().conversationMessages.count((item) => item.conversation_sid === conversation.sid))),
      ]);
    return (
      section(
        "Conversation Services",
        table(["SID", "Name", "Conversations"], serviceRows, "No Conversation Services."),
      ) +
      section(
        "Conversations",
        table(
          ["SID", "Name", "Unique Name", "State", "Participants", "Messages"],
          conversationRows,
          "No conversations.",
        ),
      )
    );
  }

  function servicesView(): string {
    const messagingRows = ts()
      .messagingServices.all()
      .map((service) => [
        escapeHtml(service.sid),
        escapeHtml(service.friendly_name),
        escapeHtml(String(ts().messagingServicePhoneNumbers.count((item) => item.service_sid === service.sid))),
        escapeHtml(service.status_callback ?? ""),
      ]);
    return section(
      "Messaging Services",
      table(["SID", "Name", "Senders", "Status Callback"], messagingRows, "No Messaging Services."),
    );
  }

  function authView(): string {
    const accountRows = ts()
      .accounts.all()
      .map((account) => [
        escapeHtml(account.sid),
        escapeHtml(account.friendly_name),
        escapeHtml(account.status),
        escapeHtml(maskSecret(account.auth_token)),
      ]);
    const keyRows = ts()
      .apiKeys.all()
      .map((key) => [
        escapeHtml(key.sid),
        escapeHtml(key.friendly_name),
        escapeHtml(key.account_sid),
        escapeHtml(key.active ? "active" : "inactive"),
        escapeHtml(maskSecret(key.secret)),
      ]);
    return (
      section("Accounts", table(["SID", "Name", "Status", "Auth Token"], accountRows, "No accounts.")) +
      section("API Keys", table(["SID", "Name", "Account", "Status", "Secret"], keyRows, "No API keys."))
    );
  }

  function webhooksView(): string {
    const rows = ts()
      .webhookDeliveries.all()
      .slice(-50)
      .reverse()
      .map((delivery) => [
        escapeHtml(delivery.event),
        escapeHtml(delivery.url),
        escapeHtml(String(delivery.response_status ?? "")),
        escapeHtml(delivery.success ? "ok" : "failed"),
        escapeHtml(delivery.error ?? ""),
        escapeHtml(delivery.created_at),
      ]);
    return section(
      "Webhook Deliveries",
      table(["Event", "URL", "Status", "Result", "Error", "Created"], rows, "No webhook deliveries."),
    );
  }
}

function section(title: string, body: string): string {
  return `<section class="inspector-section">
  <h2>${escapeHtml(title)}</h2>
  ${body}
</section>`;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="inspector-empty">${escapeHtml(empty)}</p>`;
  const headerHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const rowHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n");
  return `<table class="inspector-table">
  <thead><tr>${headerHtml}</tr></thead>
  <tbody>
${rowHtml}
  </tbody>
</table>`;
}
