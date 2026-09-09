---
name: zendesk
description: Emulated Zendesk Support API v2 for local development and testing. Use when the user needs to create or update tickets locally, manage users and organizations, test organization memberships, search Zendesk data, import tickets, drive triggers and webhooks, or run a Zendesk integration without a real Zendesk instance. Triggers include "Zendesk API", "emulate Zendesk", "test tickets locally", "Zendesk webhook", "Zendesk trigger", "ZENDESK_SUBDOMAIN", "ZENDESK_API_TOKEN", "organization_memberships", "node-zendesk", or any task requiring a local Zendesk Support API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Zendesk Support API Emulator

Fully stateful Zendesk Support API v2 emulation. Tickets with comments, audits, and metrics, requests, users, organizations, memberships, groups, ticket and custom fields, tags, search, views, macros, triggers, webhooks, uploads, job statuses, and incremental exports persist in memory. Triggers evaluate on every ticket create and update and can call webhooks with rendered placeholders; user, organization, and ticket events fan out to subscribed webhooks with Zendesk signatures.

No emails are sent and no real Zendesk account is touched.

## Start

```bash
# Zendesk only
npx emulate --service zendesk

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const zendesk = await createEmulator({ service: 'zendesk', port: 4000 })
// zendesk.url === 'http://localhost:4000'
```

## Defaults

```text
ZENDESK_SUBDOMAIN=emulate-support
ZENDESK_EMAIL=admin@example.com
ZENDESK_API_TOKEN=test_emulate_zendesk_api_token
```

Seeded data:

| Kind | Value |
|------|-------|
| Admin | Support Admin, `admin@example.com` |
| Agent | Alex Agent, `agent@example.com` |
| End user | Test Customer, `test@example.com`, member of organization Example Inc (domain `example.com`) |
| Group | Support (default) |
| Ticket fields | System fields plus custom text field "Case reference" and dropdown "Category" (`category_billing`, `category_technical`, `category_other`) |
| Organization fields | `english` (checkbox), `client_id` (text) |
| Ticket | #1 "Welcome to the Zendesk emulator", open, assigned to Alex Agent, with one agent reply |
| Macro | "Mark as solved" |
| Views | The six standard Zendesk views |

## Pointing Your App at the Emulator

Zendesk clients build URLs as `https://{subdomain}.zendesk.com/api/v2`. Point them at the emulator base URL instead. Both `/api/v2/tickets` and `/api/v2/tickets.json` work.

### Plain HTTP client (axios, fetch)

```typescript
const client = axios.create({
  baseURL: `${process.env.ZENDESK_EMULATOR_URL}/api/v2`,
  headers: {
    Authorization: `Basic ${Buffer.from(`${email}/token:${apiToken}`).toString('base64')}`,
    'Content-Type': 'application/json',
  },
})

const { data } = await client.post('/organizations', { organization: { name: 'acme-corp' } })
```

### node-zendesk

```typescript
import { createClient } from 'node-zendesk'

const client = createClient({
  username: 'admin@example.com',
  token: 'test_emulate_zendesk_api_token',
  subdomain: 'emulate-support',
  endpointUri: 'http://localhost:4000/api/v2',
})
```

### Authentication accepted

- `Authorization: Basic base64(email/token:API_TOKEN)` with a seeded API token. The email selects the current user when it matches an agent; otherwise the first admin is used.
- `Authorization: Basic base64(email:password)` for users seeded with a `password`.
- `Authorization: Bearer <token>` for seeded `oauth_tokens`.
- `X-On-Behalf-Of: <email or id>` makes agent requests act as that end user, which is how `/requests` behaves for end users.

Unauthenticated requests get `401 {"error":"Couldn't authenticate you"}`.

## Seed Config

```yaml
zendesk:
  subdomain: acme-support
  api_tokens:
    - token: acme_api_token
      email: ops@acme.test
  groups:
    - name: Support
      default: true
    - name: Billing
  organizations:
    - name: cyna-customer
      domain_names: [customer.test]
      organization_fields:
        english: false
        client_id: cmp_123
  users:
    - name: Ops Admin
      email: ops@acme.test
      role: admin
    - name: Billing Agent
      email: billing@acme.test
      role: agent
      groups: [Billing]
    - name: Customer Contact
      email: contact@customer.test
      role: end-user
  ticket_fields:
    - type: text
      title: case_th
    - type: tagger
      title: TYPE
      options:
        - name: Incident
          value: type_incident
        - name: Request
          value: type_request
  organization_fields:
    - key: english
      type: checkbox
    - key: client_id
      type: text
  tickets:
    - subject: Cannot log in
      description: The portal rejects my password.
      requester: contact@customer.test
      assignee: billing@acme.test
      status: open
      priority: high
      tags: [portal]
      custom_fields:
        case_th: TH-42
        TYPE: type_incident
      created_at: 2025-03-01T09:00:00Z
      comments:
        - author: billing@acme.test
          body: Looking into it now.
  webhooks:
    - name: App notifier
      endpoint: http://localhost:3000/api/webhooks/zendesk
      signing_secret: zendesk_webhook_secret
      subscriptions: [conditional_ticket_events, "zen:event-type:user.created"]
      authentication:
        type: bearer_token
        data:
          token: app_token
  triggers:
    - title: Notify app on ticket updates
      conditions:
        all:
          - field: update_type
            operator: is
            value: Change
      actions:
        - field: notification_webhook
          value: ["App notifier", '{"id": {{ticket.id}}, "status": "{{ticket.status}}", "requester": "{{ticket.requester.email}}"}']
```

Users are attached to an organization when `organization` is set or when their email domain matches an organization's `domain_names`. Agents join the default group unless `groups` lists others. Ticket `custom_fields` accept field titles or ids as keys.

## API Endpoints

Authenticate every call with `-u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN"`. Bodies are JSON.

### Tickets

```bash
# Create a ticket for a new requester
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X POST http://localhost:4000/api/v2/tickets.json \
  -H "Content-Type: application/json" \
  -d '{"ticket":{"subject":"Printer on fire","comment":{"body":"Help"},"requester":{"name":"New","email":"new@example.com"},"priority":"urgent","tags":["hardware"]}}'

# Update with a public comment and a status change
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X PUT http://localhost:4000/api/v2/tickets/1.json \
  -H "Content-Type: application/json" \
  -d '{"ticket":{"comment":{"body":"On it","public":true},"status":"pending","additional_tags":["escalated"]}}'

# Show many, comments, audits, metrics, tags
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" "http://localhost:4000/api/v2/tickets/show_many.json?ids=1,2"
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/tickets/1/comments.json
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/tickets/1/audits.json
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/tickets/1/metrics.json

# Bulk import with historical timestamps (returns a completed job_status)
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X POST "http://localhost:4000/api/v2/imports/tickets/create_many.json?archive_immediately=true" \
  -H "Content-Type: application/json" \
  -d '{"tickets":[{"subject":"Legacy","requester_id":10003,"status":"closed","created_at":"2024-01-05T10:00:00Z","comments":[{"author_id":10003,"value":"Old question"}]}]}'
```

Ticket rules follow Zendesk: a new ticket is `new` (or `open` when assigned), `status: closed` cannot be set through the normal update endpoint, closed tickets reject updates, an end-user comment on a solved ticket reopens it, and tagger custom field values add their option value as a tag. Each create or update writes an audit with `Comment`, `Create`, and `Change` events and updates ticket metrics (replies, reopens, reply and resolution times).

Other ticket routes: `tickets/recent`, `tickets/count`, `create_many`, `update_many`, `destroy_many`, `mark_as_spam`, `merge`, `comments/:id/make_private`, `comments/:id/redact`, `incidents`, `problems`, `collaborators`, `followers`, `email_ccs`, `satisfaction_rating`, `tickets/:id/macros/:id/apply`, `deleted_tickets` with `restore`, `ticket_audits`, `ticket_metrics`, and `incremental/tickets`.

### Requests (end-user side)

```bash
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -H "X-On-Behalf-Of: test@example.com" http://localhost:4000/api/v2/requests.json
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -H "X-On-Behalf-Of: test@example.com" -X POST http://localhost:4000/api/v2/requests.json \
  -H "Content-Type: application/json" -d '{"request":{"subject":"Portal request","comment":{"body":"From the portal"}}}'
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" "http://localhost:4000/api/v2/organizations/20001/requests.json?page[size]=50"
```

End users only see tickets they requested, are CCed on, or that belong to an organization with `shared_tickets`.

### Users

```bash
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X POST http://localhost:4000/api/v2/users.json \
  -H "Content-Type: application/json" -d '{"user":{"name":"Jane","email":"jane@example.com","skip_verify_email":true}}'
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" "http://localhost:4000/api/v2/users/search.json?query=jane%40example.com"
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/users/me.json
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X DELETE "http://localhost:4000/api/v2/users/destroy_many.json?ids=10005,10006"
```

Duplicate emails return `422 RecordInvalid` with `details.email`. Also available: `users/:id`, `PUT users/:id`, `users/create_or_update`, `create_many`, `update_many`, `show_many`, `autocomplete`, `count`, `related`, `identities`, `organizations`, `organization_memberships`, `group_memberships`, `tickets/requested`, `tickets/ccd`, `tickets/assigned`, and `users/:id/tags`.

### Organizations And Memberships

```bash
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X POST http://localhost:4000/api/v2/organizations.json \
  -H "Content-Type: application/json" -d '{"organization":{"name":"acme-corp","organization_fields":{"english":true}}}'
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" "http://localhost:4000/api/v2/organizations/search.json?name=acme-corp"
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X PUT http://localhost:4000/api/v2/organizations/20002.json \
  -H "Content-Type: application/json" -d '{"organization":{"organization_fields":{"client_id":"cmp_1"}}}'
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X POST http://localhost:4000/api/v2/organization_memberships.json \
  -H "Content-Type: application/json" -d '{"organization_membership":{"user_id":10005,"organization_id":20002}}'
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X DELETE "http://localhost:4000/api/v2/organizations/destroy_many.json?ids=20002"
```

`organizations/search` matches the exact name (case-insensitive) or `external_id`. Creating a membership that already exists returns `422`, the same signal Zendesk gives. Also available: `create_or_update`, `create_many`, `update_many`, `show_many`, `autocomplete`, `count`, `related`, `organizations/:id/tickets`, `organizations/:id/users`, `organizations/:id/organization_memberships`, `organizations/:id/tags`, and the group and group membership endpoints.

### Fields, Tags, Search

```bash
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/ticket_fields.json
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X POST http://localhost:4000/api/v2/ticket_fields.json \
  -H "Content-Type: application/json" -d '{"ticket_field":{"type":"tagger","title":"Region","custom_field_options":[{"name":"EU","value":"region_eu"}]}}'
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/organization_fields.json
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/tags.json
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" "http://localhost:4000/api/v2/search.json?query=type%3Aticket%20status%3Copen%20tags%3Abilling"
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" "http://localhost:4000/api/v2/search/export.json?query=status%3Aopen&filter[type]=ticket&page[size]=100"
```

Search understands `type:`, `status:` (with `<`, `>`), `priority:`, `ticket_type:`, `tags:`, `requester:`, `assignee:` (including `me` and `none`), `organization:`, `group:`, `subject:`, `description:`, `external_id:`, `created`, `updated`, `solved` date comparisons, `email:`, `name:`, `role:`, negation with `-`, quoted phrases, and free text.

### Triggers, Views, Macros

```bash
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X POST http://localhost:4000/api/v2/triggers.json \
  -H "Content-Type: application/json" \
  -d '{"trigger":{"title":"Notify","conditions":{"all":[{"field":"update_type","operator":"is","value":"Create"}]},"actions":[{"field":"notification_webhook","value":["<webhook id>","{\"id\": {{ticket.id}}, \"title\": \"{{ticket.title}}\"}"]},{"field":"current_tags","value":"notified"}]}}'
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/views.json
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/views/500003/tickets.json
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/tickets/1/macros/300001/apply.json
```

Conditions support `status`, `type`, `priority`, `group_id`, `assignee_id` (`current_user`), `requester_id`, `organization_id`, `current_tags`, `subject`, `description`, `update_type`, `comment_is_public`, `via_id`, `brand_id`, `ticket_form_id`, and `custom_fields_<id>` with operators `is`, `is_not`, `less_than`, `greater_than`, `includes`, `not_includes`, `present`, `not_present`, `changed`, `changed_to`, `changed_from`, `not_changed`, `value`, `value_previous`. Actions support `status`, `priority`, `type`, `group_id`, `assignee_id`, `subject`, `set_tags`, `current_tags`, `remove_tags`, `comment_value`, `comment_mode_is_public`, `custom_fields_<id>`, and `notification_webhook`. Trigger changes are recorded as a separate audit with `via.channel = "rule"`.

Placeholders in webhook bodies include `{{ticket.id}}`, `{{ticket.title}}`, `{{ticket.description}}`, `{{ticket.status}}`, `{{ticket.priority}}`, `{{ticket.ticket_type}}`, `{{ticket.tags}}`, `{{ticket.external_id}}`, `{{ticket.url}}`, `{{ticket.requester.name}}`, `{{ticket.requester.email}}`, `{{ticket.requester.organization.name}}`, `{{ticket.assignee.email}}`, `{{ticket.group.name}}`, `{{ticket.organization.id}}`, `{{ticket.latest_comment}}`, `{{ticket.latest_comment.author.name}}`, `{{ticket.ticket_field_<id>}}`, `{{ticket.ticket_field_option_title_<id>}}`, `{{current_user.email}}`, and `{{account.subdomain}}`. String values are JSON-escaped so templates stay valid JSON; the `| json` filter emits a quoted JSON literal.

### Webhooks

```bash
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X POST http://localhost:4000/api/v2/webhooks.json \
  -H "Content-Type: application/json" \
  -d '{"webhook":{"name":"Users","endpoint":"http://localhost:3000/api/webhooks/zendesk","http_method":"POST","request_format":"json","status":"active","subscriptions":["zen:event-type:user.created"],"authentication":{"type":"basic_auth","data":{"username":"zd","password":"secret"},"add_position":"header"}}}'
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/webhooks/<id>/signing_secret.json
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/webhooks/<id>/invocations.json
```

Every invocation carries `X-Zendesk-Webhook-Id`, `X-Zendesk-Webhook-Invocation-Id`, `X-Zendesk-Account-Id`, `X-Zendesk-Webhook-Signature-Timestamp`, and `X-Zendesk-Webhook-Signature` = `base64(HMAC-SHA256(secret, timestamp + body))`, plus the configured Basic, Bearer, or API key header. Event webhooks receive the Zendesk event envelope (`id`, `type`, `subject`, `time`, `detail`, `event`, `account_id`, `zendesk_event_version`) for `zen:event-type:user.*`, `zen:event-type:organization.*`, and `zen:event-type:ticket.*` events. Subscriptions may use a `*` suffix.

### Verify a signature

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyZendesk(secret: string, body: string, headers: Headers): boolean {
  const timestamp = headers.get('x-zendesk-webhook-signature-timestamp') ?? ''
  const expected = createHmac('sha256', secret).update(timestamp + body).digest('base64')
  const actual = headers.get('x-zendesk-webhook-signature') ?? ''
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}
```

### Uploads, Jobs, Incremental Exports

```bash
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X POST "http://localhost:4000/api/v2/uploads.json?filename=log.txt" \
  -H "Content-Type: text/plain" --data-binary @log.txt
# then attach with {"ticket":{"comment":{"body":"See log","uploads":["<token>"]}}}
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" http://localhost:4000/api/v2/job_statuses/<id>.json
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" "http://localhost:4000/api/v2/incremental/tickets/cursor.json?start_time=0"
```

Bulk endpoints complete synchronously and return `job_status` with `status: "completed"` and per-item `results`.

### Simulator And Inspector

```bash
# Create a ticket as if an email arrived, or append a reply with ticket_id
curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN" -X POST http://localhost:4000/_zendesk/simulate/inbound-email \
  -H "Content-Type: application/json" -d '{"from":"someone@example.com","subject":"Help","body":"My laptop will not boot"}'
```

Open `GET /` for tickets, users, organizations and groups, fields, triggers, views, macros, webhooks with invocations, events, and credentials.

## Current Limits

Help Center (Guide) articles, Talk, Chat, Sunshine Conversations, side conversations, SLA policies, schedules, automations, skills-based routing, ticket forms beyond one default form, brands beyond one default brand, sharing agreements, suspended ticket queue, OAuth authorization flows, rate limiting, and outbound email notifications are not implemented. Trigger `notification_user` and `notification_group` actions are accepted but do nothing.
