import type { ConsoleService } from "./types";

const auth = { Authorization: "Bearer re_emulated_key" };
const json = { ...auth, "Content-Type": "application/json" };
const sender = "Playground <hello@example.com>";

export const resend: ConsoleService = {
  name: "resend",
  label: "Resend",
  description: "Send and list emails, manage domains, API keys, audiences, and contacts.",
  variables: [
    { name: "email_id", label: "Email id", hint: "Filled in when you run Send email. You can also paste an id." },
    {
      name: "scheduled_email_id",
      label: "Scheduled email id",
      hint: "Filled in when you run Schedule email. You can also paste an id.",
    },
    { name: "domain_id", label: "Domain id", hint: "Filled in when you run Create domain. You can also paste an id." },
    {
      name: "api_key_id",
      label: "API key id",
      hint: "Filled in when you run Create API key. You can also paste an id.",
    },
    {
      name: "audience_id",
      label: "Audience id",
      hint: "Filled in when you run Create audience. You can also paste an id.",
    },
    { name: "contact_id", label: "Contact id", hint: "Filled in when you run Add contact. You can also paste an id." },
  ],
  groups: [
    {
      title: "Emails",
      presets: [
        {
          label: "Send email",
          captures: { email_id: "id" },
          description: "Sends one email from example.com and stores it. Run this first to get an email_id.",
          method: "POST",
          path: "/emails",
          headers: json,
          body: JSON.stringify(
            {
              from: sender,
              to: "customer@example.com",
              subject: "Welcome aboard",
              html: "<p>Thanks for signing up.</p>",
            },
            null,
            2,
          ),
        },
        {
          label: "Send with idempotency key",
          description:
            "Sends the same email once. Repeating the request with the same Idempotency-Key returns the original id without sending again.",
          method: "POST",
          path: "/emails",
          headers: { ...json, "Idempotency-Key": "welcome-example-1" },
          body: JSON.stringify(
            {
              from: sender,
              to: "customer@example.com",
              subject: "Welcome aboard",
              text: "Thanks for signing up.",
            },
            null,
            2,
          ),
        },
        {
          label: "Send batch",
          description: "Sends up to 100 emails in one request. The response lists one id per email.",
          method: "POST",
          path: "/emails/batch",
          headers: json,
          body: JSON.stringify(
            [
              { from: sender, to: "ada@example.com", subject: "Your order shipped", text: "It is on its way." },
              { from: sender, to: "grace@example.com", subject: "Your order shipped", text: "It is on its way." },
            ],
            null,
            2,
          ),
        },
        {
          label: "Schedule email",
          captures: { scheduled_email_id: "id" },
          description:
            "Stores an email with a future send time. Its id is scheduled_email_id for Cancel scheduled email.",
          method: "POST",
          path: "/emails",
          headers: json,
          body: JSON.stringify(
            {
              from: sender,
              to: "customer@example.com",
              subject: "Reminder",
              text: "Your trial ends soon.",
              scheduled_at: "2030-01-01T09:00:00Z",
            },
            null,
            2,
          ),
        },
        {
          label: "List emails",
          description: "Lists every email stored by the emulator.",
          method: "GET",
          path: "/emails",
          headers: auth,
        },
        {
          label: "Get email",
          description: "Returns one email by id. Run Send email first and use its id as email_id.",
          method: "GET",
          path: "/emails/{{email_id}}",
          headers: auth,
        },
        {
          label: "Cancel scheduled email",
          description: "Cancels an email that is still scheduled. Run Schedule email first and use its id.",
          method: "POST",
          path: "/emails/{{scheduled_email_id}}/cancel",
          headers: auth,
        },
      ],
    },
    {
      title: "Domains",
      presets: [
        {
          label: "Create domain",
          captures: { domain_id: "id" },
          description: "Adds a domain in pending state with its DNS records. Its id is domain_id.",
          method: "POST",
          path: "/domains",
          headers: json,
          body: JSON.stringify({ name: "updates.example.com" }, null, 2),
        },
        {
          label: "List domains",
          description: "Lists every domain, including the seeded example.com with its id.",
          method: "GET",
          path: "/domains",
          headers: auth,
        },
        {
          label: "Get domain",
          description: "Returns one domain and its DNS records. Run List domains first to get a domain_id.",
          method: "GET",
          path: "/domains/{{domain_id}}",
          headers: auth,
        },
        {
          label: "Verify domain",
          description: "Marks a domain and its DNS records as verified. Run Create domain first to get a domain_id.",
          method: "POST",
          path: "/domains/{{domain_id}}/verify",
          headers: auth,
        },
        {
          label: "Delete domain",
          description: "Removes a domain. Run Create domain first so you do not delete the seeded example.com.",
          method: "DELETE",
          path: "/domains/{{domain_id}}",
          headers: auth,
        },
      ],
    },
    {
      title: "API keys",
      presets: [
        {
          label: "Create API key",
          captures: { api_key_id: "id" },
          description: "Creates an API key and returns its token. Its id is api_key_id.",
          method: "POST",
          path: "/api-keys",
          headers: json,
          body: JSON.stringify({ name: "Local development" }, null, 2),
        },
        {
          label: "List API keys",
          description: "Lists API keys by id and name. Tokens are not shown again.",
          method: "GET",
          path: "/api-keys",
          headers: auth,
        },
        {
          label: "Delete API key",
          description: "Deletes one API key. Run Create API key first and use its id as api_key_id.",
          method: "DELETE",
          path: "/api-keys/{{api_key_id}}",
          headers: auth,
        },
      ],
    },
    {
      title: "Audiences and contacts",
      presets: [
        {
          label: "Create audience",
          captures: { audience_id: "id" },
          description: "Creates an audience that contacts can join. Its id is audience_id.",
          method: "POST",
          path: "/audiences",
          headers: json,
          body: JSON.stringify({ name: "Newsletter" }, null, 2),
        },
        {
          label: "List audiences",
          description: "Lists audiences with their ids.",
          method: "GET",
          path: "/audiences",
          headers: auth,
        },
        {
          label: "Add contact",
          captures: { contact_id: "id" },
          description: "Adds a contact to an audience. Run Create audience first; the returned id is contact_id.",
          method: "POST",
          path: "/audiences/{{audience_id}}/contacts",
          headers: json,
          body: JSON.stringify({ email: "reader@example.com", first_name: "Ada", last_name: "Lovelace" }, null, 2),
        },
        {
          label: "List contacts",
          description: "Lists the contacts in one audience. Run Create audience first to get an audience_id.",
          method: "GET",
          path: "/audiences/{{audience_id}}/contacts",
          headers: auth,
        },
        {
          label: "Delete contact",
          description: "Removes one contact from an audience. Run Add contact first to get a contact_id.",
          method: "DELETE",
          path: "/audiences/{{audience_id}}/contacts/{{contact_id}}",
          headers: auth,
        },
        {
          label: "Delete audience",
          description: "Deletes one audience by id. Run it last, after the contact presets.",
          method: "DELETE",
          path: "/audiences/{{audience_id}}",
          headers: auth,
        },
      ],
    },
  ],
};
