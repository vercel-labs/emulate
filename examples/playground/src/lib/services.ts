export interface ConsolePreset {
  label: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ConsoleService {
  name: string;
  label: string;
  description: string;
  inspectorPath?: string;
  presets: ConsolePreset[];
}

const json = { "Content-Type": "application/json" };
const form = { "Content-Type": "application/x-www-form-urlencoded" };

/** Emulators without a demo flow, each reachable through the request console at /services/<name>. */
export const consoleServices: ConsoleService[] = [
  {
    name: "aws",
    label: "AWS",
    description: "S3, SQS, IAM, and Cognito.",
    inspectorPath: "/_inspector",
    presets: [
      { label: "List buckets", method: "GET", path: "/" },
      {
        label: "Put object",
        method: "PUT",
        path: "/emulate-default/hello.txt",
        headers: { "Content-Type": "text/plain" },
        body: "hello from the playground",
      },
      {
        label: "Create queue",
        method: "POST",
        path: "/sqs/123456789012/playground-demo",
        headers: form,
        body: "Action=CreateQueue&QueueName=playground-demo&Version=2012-11-05",
      },
    ],
  },
  {
    name: "linear",
    label: "Linear",
    description: "GraphQL API for issues, teams, and projects.",
    inspectorPath: "",
    presets: [
      {
        label: "Viewer",
        method: "POST",
        path: "/graphql",
        headers: { ...json, Authorization: "lin_test_admin" },
        body: '{ "query": "{ viewer { id name } }" }',
      },
      {
        label: "Issues",
        method: "POST",
        path: "/graphql",
        headers: { ...json, Authorization: "lin_test_admin" },
        body: '{ "query": "{ issues { nodes { id identifier title } } }" }',
      },
      {
        label: "Teams",
        method: "POST",
        path: "/graphql",
        headers: { ...json, Authorization: "lin_test_admin" },
        body: '{ "query": "{ teams { nodes { id key name } } }" }',
      },
    ],
  },
  {
    name: "mongoatlas",
    label: "MongoDB Atlas",
    description: "Atlas Admin API and Data API.",
    presets: [
      { label: "List projects", method: "GET", path: "/api/atlas/v2/groups" },
      {
        label: "Insert document",
        method: "POST",
        path: "/app/data-api/v1/action/insertOne",
        headers: json,
        body: '{ "dataSource": "Cluster0", "database": "test", "collection": "items", "document": { "name": "Playground item" } }',
      },
      {
        label: "Find documents",
        method: "POST",
        path: "/app/data-api/v1/action/find",
        headers: json,
        body: '{ "dataSource": "Cluster0", "database": "test", "collection": "items", "filter": {} }',
      },
    ],
  },
  {
    name: "slack",
    label: "Slack",
    description: "Web API for messages, channels, and users.",
    inspectorPath: "",
    presets: [
      {
        label: "Post to #general",
        method: "POST",
        path: "/api/chat.postMessage",
        headers: { ...json, Authorization: "Bearer xoxb-playground-token" },
        body: '{ "channel": "C000000001", "text": "Hello from the emulate playground." }',
      },
      {
        label: "List channels",
        method: "POST",
        path: "/api/conversations.list",
        headers: { Authorization: "Bearer xoxb-playground-token" },
      },
    ],
  },
];
