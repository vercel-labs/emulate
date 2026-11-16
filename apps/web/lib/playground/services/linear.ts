import type { ConsolePreset, ConsoleService } from "./types";

const headers = { "Content-Type": "application/json", Authorization: "lin_test_admin" };
const formHeaders = { "Content-Type": "application/x-www-form-urlencoded" };

/** Builds a POST /graphql preset whose JSON body carries the document and its variables. */
function gql(
  label: string,
  description: string,
  query: string,
  variables: Record<string, unknown> = {},
): ConsolePreset {
  return {
    label,
    description,
    method: "POST",
    path: "/graphql",
    headers,
    body: JSON.stringify({ query, variables }, null, 2),
  };
}

/** Linear emulator console: every GraphQL operation and OAuth route, with presets that run on a fresh server. */
export const linear: ConsoleService = {
  name: "linear",
  label: "Linear",
  description: "GraphQL API for issues, comments, labels, webhooks, and agent sessions, plus the OAuth token routes.",
  variables: [
    {
      name: "agent_session_id",
      label: "Agent session id",
      hint: "Filled in when you run Start session on issue. You can also paste an id.",
    },
    {
      name: "agent_activity_id",
      label: "Agent activity id",
      hint: "Filled in when you run Create agent activity. You can also paste an id.",
    },
    {
      name: "code",
      label: "Authorization code",
      hint: "Filled in when you run Approve sign-in. Codes work once and expire after 10 minutes.",
    },
    {
      name: "refresh_token",
      label: "Refresh token",
      hint: "Filled in when you run Exchange authorization code or Refresh access token. You can also paste a token.",
    },
  ],
  groups: [
    {
      title: "Viewer and organization",
      presets: [
        gql(
          "Read viewer",
          "Returns the user behind the admin token, which every request in this console sends.",
          `query Viewer {
  viewer { id name email admin }
}`,
        ),
        gql(
          "Read organization",
          "Returns the workspace name and URL key from the seed.",
          `query Organization {
  organization { id name urlKey url }
}`,
        ),
      ],
    },
    {
      title: "Users",
      presets: [
        gql(
          "List users",
          "Lists every user, including the admin, the developer, and the Playground agent app user.",
          `query Users {
  users { nodes { id name email active admin app } }
}`,
        ),
        gql(
          "Read user",
          "Reads one user by email; edit the id to another email from List users.",
          `query User($id: String!) {
  user(id: $id) { id name displayName email }
}`,
          { id: "dev@linear.local" },
        ),
      ],
    },
    {
      title: "Teams and workflow states",
      presets: [
        gql(
          "List teams",
          "Lists teams with their keys, such as ENG, which other calls accept in place of a team id.",
          `query Teams {
  teams { nodes { id key name } }
}`,
        ),
        gql(
          "Read team",
          "Reads the ENG team by key; edit the id to another key from List teams.",
          `query Team($id: String!) {
  team(id: $id) { id key name description private }
}`,
          { id: "ENG" },
        ),
        gql(
          "List workflow states",
          "Lists workflow states for every team; a state name such as Todo works wherever a state id is asked for.",
          `query WorkflowStates {
  workflowStates { nodes { id name type position } }
}`,
        ),
        gql(
          "Read workflow state",
          "Reads a workflow state by name; Todo is seeded, and Backlog, In Progress, and Done are too.",
          `query WorkflowState($id: String!) {
  workflowState(id: $id) { id name type color position }
}`,
          { id: "Todo" },
        ),
      ],
    },
    {
      title: "Issues",
      presets: [
        gql(
          "List issues",
          "Lists the first ten issues with their identifiers, states, and assignees.",
          `query Issues {
  issues(first: 10) { nodes { id identifier title priorityLabel state { name } assignee { name } } }
}`,
        ),
        gql(
          "Read issue",
          "Reads one issue by identifier, such as ENG-2; the id also accepts an id returned by another call.",
          `query Issue($id: String!) {
  issue(id: $id) { id identifier title description priorityLabel state { name } labels { nodes { name } } }
}`,
          { id: "ENG-2" },
        ),
        gql(
          "Create issue",
          "Creates an issue on team ENG; change the title, priority (0 to 4), state, or labels as you like.",
          `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier title state { name } } }
}`,
          {
            input: {
              teamId: "ENG",
              title: "Write the release notes",
              description: "Summarize the login fixes for the team.",
              priority: 3,
              stateId: "Todo",
              labelIds: ["Feature"],
              assigneeId: "dev@linear.local",
            },
          },
        ),
        gql(
          "Update issue",
          "Changes the title and priority of ENG-2; edit the input to change any other field.",
          `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { identifier title priorityLabel } }
}`,
          { id: "ENG-2", input: { title: "Fix login redirect loop on Safari", priority: 1 } },
        ),
        gql(
          "Archive issue",
          "Archives ENG-3; run Unarchive issue next to restore it.",
          `mutation IssueArchive($id: String!) {
  issueArchive(id: $id) { success entity { identifier archivedAt } }
}`,
          { id: "ENG-3" },
        ),
        gql(
          "Unarchive issue",
          "Restores ENG-3 after Archive issue.",
          `mutation IssueUnarchive($id: String!) {
  issueUnarchive(id: $id) { success entity { identifier archivedAt } }
}`,
          { id: "ENG-3" },
        ),
        gql(
          "Delete issue",
          "Permanently deletes ENG-4 and its comments, so it runs once until the server restarts.",
          `mutation IssueDelete($id: String!) {
  issueDelete(id: $id) { success entity { identifier } }
}`,
          { id: "ENG-4" },
        ),
      ],
    },
    {
      title: "Issue labels",
      presets: [
        gql(
          "List labels",
          "Lists issue labels with their colors and teams.",
          `query IssueLabels {
  issueLabels { nodes { id name color team { key } } }
}`,
        ),
        gql(
          "Read label",
          "Reads a label by name; Bug is seeded for ENG.",
          `query IssueLabel($id: String!) {
  issueLabel(id: $id) { id name color description team { key } }
}`,
          { id: "Bug" },
        ),
        gql(
          "Create label",
          "Creates a label on team ENG; the name Docs is a sample, so change it freely.",
          `mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name color } }
}`,
          { input: { name: "Docs", color: "#0ea5e9", description: "Documentation work", teamId: "ENG" } },
        ),
        gql(
          "Update label",
          "Changes the color and description of the Chore label; its name stays the same.",
          `mutation IssueLabelUpdate($id: String!, $input: IssueLabelUpdateInput!) {
  issueLabelUpdate(id: $id, input: $input) { success issueLabel { id name color description } }
}`,
          { id: "Chore", input: { color: "#7c3aed", description: "Maintenance and cleanup" } },
        ),
        gql(
          "Delete label",
          "Deletes the Needs triage label and removes it from every issue that has it.",
          `mutation IssueLabelDelete($id: String!) {
  issueLabelDelete(id: $id) { success entityId }
}`,
          { id: "Needs triage" },
        ),
        gql(
          "Add label to issue",
          "Adds the Feature label to ENG-2; labelId also accepts a label name.",
          `mutation IssueAddLabel($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { success issue { identifier labels { nodes { name } } } }
}`,
          { id: "ENG-2", labelId: "Feature" },
        ),
        gql(
          "Remove label from issue",
          "Removes the Feature label from ENG-2, the reverse of Add label to issue.",
          `mutation IssueRemoveLabel($id: String!, $labelId: String!) {
  issueRemoveLabel(id: $id, labelId: $labelId) { success issue { identifier labels { nodes { name } } } }
}`,
          { id: "ENG-2", labelId: "Feature" },
        ),
      ],
    },
    {
      title: "Comments",
      presets: [
        gql(
          "List comments",
          "Lists every comment with its issue and author.",
          `query Comments {
  comments { nodes { id body issue { identifier } user { name } } }
}`,
        ),
        gql(
          "Read comment",
          "Reads the seeded comment seed-comment-1.",
          `query Comment($id: String!) {
  comment(id: $id) { id body createdAt issue { identifier } user { name } }
}`,
          { id: "seed-comment-1" },
        ),
        gql(
          "Create comment",
          "Adds a comment to ENG-2; change issueId to any other identifier.",
          `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body issue { identifier } } }
}`,
          { input: { issueId: "ENG-2", body: "Pushed a fix to the staging branch." } },
        ),
        gql(
          "Update comment",
          "Changes the body of the seeded comment seed-comment-1.",
          `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success comment { id body } }
}`,
          { id: "seed-comment-1", input: { body: "Reproduced on Safari 17 and Chrome 130." } },
        ),
        gql(
          "Delete comment",
          "Deletes the seeded comment seed-comment-2, so it runs once until the server restarts.",
          `mutation CommentDelete($id: String!) {
  commentDelete(id: $id) { success entityId }
}`,
          { id: "seed-comment-2" },
        ),
      ],
    },
    {
      title: "Projects and cycles",
      presets: [
        gql(
          "List projects",
          "Lists projects with their state and team; Local Project and Q4 Launch are seeded.",
          `query Projects {
  projects { nodes { id name state team { key } } }
}`,
        ),
        gql(
          "Read project",
          "Reads the Q4 Launch project by name; edit the id to Local Project to read that one.",
          `query Project($id: String!) {
  project(id: $id) { id name state description }
}`,
          { id: "Q4 Launch" },
        ),
        gql(
          "List cycles",
          "Lists cycles with their numbers and teams; Cycle 1 is seeded for ENG.",
          `query Cycles {
  cycles { nodes { id name number team { key } } }
}`,
        ),
        gql(
          "Read cycle",
          "Reads a cycle by name or number; edit the id to 1 or any cycle name from List cycles.",
          `query Cycle($id: String!) {
  cycle(id: $id) { id name number startsAt endsAt team { key } }
}`,
          { id: "Cycle 1" },
        ),
      ],
    },
    {
      title: "Webhooks",
      presets: [
        gql(
          "List webhooks",
          "Lists webhooks; the seeded Deploy notifier is disabled, so it never calls its URL.",
          `query Webhooks {
  webhooks { nodes { id label url enabled resourceTypes team { key } } }
}`,
        ),
        gql(
          "Read webhook",
          "Reads the seeded webhook seed-webhook-1.",
          `query Webhook($id: String!) {
  webhook(id: $id) { id label url enabled allPublicTeams }
}`,
          { id: "seed-webhook-1" },
        ),
        gql(
          "Create webhook",
          "Creates a disabled webhook on team ENG; set enabled to true to have it deliver events to its URL.",
          `mutation WebhookCreate($input: WebhookCreateInput!) {
  webhookCreate(input: $input) { success webhook { id label url enabled } }
}`,
          {
            input: {
              url: "https://example.com/hooks/linear",
              label: "Build notifier",
              resourceTypes: ["Issue", "Comment"],
              teamId: "ENG",
              enabled: false,
            },
          },
        ),
        gql(
          "Delete webhook",
          "Deletes the seeded webhook seed-webhook-1, so it runs once until the server restarts.",
          `mutation WebhookDelete($id: String!) {
  webhookDelete(id: $id) { success entityId }
}`,
          { id: "seed-webhook-1" },
        ),
      ],
    },
    {
      title: "Agent sessions",
      presets: [
        gql(
          "List agent sessions",
          "Lists agent sessions; they appear after Start session on issue or Start session on comment.",
          `query AgentSessions {
  agentSessions { nodes { id status issue { identifier } appUser { name } } }
}`,
        ),
        gql(
          "List agent activities",
          "Lists agent activities; they appear after Create agent activity.",
          `query AgentActivities {
  agentActivities { nodes { id ephemeral agentSession { id status } } }
}`,
        ),
        {
          ...gql(
            "Start session on issue",
            "Starts an agent session on ENG-2 owned by the Playground agent app user, and fills in agent_session_id.",
            `mutation AgentSessionCreateOnIssue($input: AgentSessionCreateOnIssue!) {
  agentSessionCreateOnIssue(input: $input) { success agentSession { id status } }
}`,
            { input: { issueId: "ENG-2" } },
          ),
          captures: { agent_session_id: "data.agentSessionCreateOnIssue.agentSession.id" },
        },
        gql(
          "Start session on comment",
          "Starts an agent session on the seeded comment seed-comment-1 without changing agent_session_id.",
          `mutation AgentSessionCreateOnComment($input: AgentSessionCreateOnComment!) {
  agentSessionCreateOnComment(input: $input) { success agentSession { id status } }
}`,
          { input: { commentId: "seed-comment-1" } },
        ),
        {
          ...gql(
            "Create agent activity",
            "Adds a thought to the session in agent_session_id and fills in agent_activity_id.",
            `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success agentActivity { id } }
}`,
            {
              input: {
                agentSessionId: "{{agent_session_id}}",
                content: { type: "thought", body: "Checking the login redirect handler." },
              },
            },
          ),
          captures: { agent_activity_id: "data.agentActivityCreate.agentActivity.id" },
        },
        gql(
          "Read agent session",
          "Reads the session in agent_session_id.",
          `query AgentSession($id: String!) {
  agentSession(id: $id) { id status summary issue { identifier } appUser { name } }
}`,
          { id: "{{agent_session_id}}" },
        ),
        gql(
          "Read agent activity",
          "Reads the activity in agent_activity_id.",
          `query AgentActivity($id: String!) {
  agentActivity(id: $id) { id ephemeral agentSession { id } }
}`,
          { id: "{{agent_activity_id}}" },
        ),
        gql(
          "Update agent session",
          "Sets the summary of the session in agent_session_id.",
          `mutation AgentSessionUpdate($id: String, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success agentSession { id status summary } }
}`,
          { id: "{{agent_session_id}}", input: { summary: "Found the redirect bug in the OAuth callback." } },
        ),
        gql(
          "Add session link",
          "Adds an external link to the session in agent_session_id.",
          `mutation AgentSessionUpdateExternalUrl($id: String!, $input: AgentSessionUpdateExternalUrlInput!) {
  agentSessionUpdateExternalUrl(id: $id, input: $input) { success agentSession { id externalLinks { label url } } }
}`,
          {
            id: "{{agent_session_id}}",
            input: { addedExternalUrls: [{ label: "Pull request", url: "https://example.com/pull/1" }] },
          },
        ),
      ],
    },
    {
      title: "OAuth",
      presets: [
        {
          label: "Get client credentials token",
          description:
            "Issues an app token for the seeded Playground agent app with the client_credentials grant, with no user login.",
          method: "POST",
          path: "/oauth/token",
          headers: formHeaders,
          body: "grant_type=client_credentials&client_id=lin_agent_client_id&client_secret=lin_agent_client_secret",
        },
        {
          label: "Approve sign-in",
          description:
            "Stands in for picking a user on the consent page: it posts the consent form for admin@linear.local, and the redirect's code fills in the code variable.",
          method: "POST",
          path: "/oauth/authorize/callback",
          headers: formHeaders,
          body: "user_ref=admin@linear.local&actor=user&redirect_uri=https%3A%2F%2Fplayground.emulate.local%2Foauth%2Fapi%2Fauth%2Fcallback%2Flinear&scope=read%20write&state=playground&client_id=emu_linear_client_id",
          captures: { code: "@location.code" },
        },
        {
          label: "Exchange authorization code",
          description: "Trades the code from Approve sign-in for access and refresh tokens; each code works once.",
          method: "POST",
          path: "/oauth/token",
          headers: formHeaders,
          body: "grant_type=authorization_code&client_id=emu_linear_client_id&client_secret=emu_linear_client_secret&redirect_uri=https%3A%2F%2Fplayground.emulate.local%2Foauth%2Fapi%2Fauth%2Fcallback%2Flinear&code={{code}}",
          captures: { refresh_token: "refresh_token" },
        },
        {
          label: "Refresh access token",
          description:
            "Trades a refresh token from Exchange authorization code for a new token pair and revokes the old refresh token.",
          method: "POST",
          path: "/oauth/token",
          headers: formHeaders,
          body: "grant_type=refresh_token&client_id=emu_linear_client_id&client_secret=emu_linear_client_secret&refresh_token={{refresh_token}}",
          captures: { refresh_token: "refresh_token" },
        },
        {
          label: "Revoke token",
          description: "Revokes the seeded token lin_test_revoke_me, after which requests that use it get a 401.",
          method: "POST",
          path: "/oauth/revoke",
          headers: formHeaders,
          body: "token=lin_test_revoke_me",
        },
      ],
    },
  ],
};
