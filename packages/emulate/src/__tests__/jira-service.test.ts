import { describe, expect, it } from "vitest";
import { createEmulator } from "../api.js";
import { SERVICE_NAMES, SERVICE_REGISTRY } from "../registry.js";

const basic = (email: string, token: string) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

describe("jira service", () => {
  it("is registered with the CLI", () => {
    expect(SERVICE_NAMES).toContain("jira");
    expect(SERVICE_REGISTRY.jira.label).toContain("Jira");
  });

  it("starts through createEmulator, applies seed config, and resets", async () => {
    const jira = await createEmulator({
      service: "jira",
      port: 14300,
      seed: {
        jira: {
          users: [{ email: "qa@example.com", display_name: "QA", api_token: "qa_token" }],
          projects: [{ key: "QA", name: "Quality" }],
          issues: [{ project: "QA", summary: "Seeded through createEmulator" }],
        },
      },
    });

    try {
      const me = await fetch(`${jira.url}/rest/api/3/myself`, {
        headers: { Authorization: basic("qa@example.com", "qa_token") },
      });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { displayName: string }).displayName).toBe("QA");

      const search = await fetch(`${jira.url}/rest/api/3/search/jql`, {
        method: "POST",
        headers: { Authorization: basic("admin@jira.local", "jira_test_token"), "Content-Type": "application/json" },
        body: JSON.stringify({ jql: "project = QA", fields: ["summary"] }),
      });
      const found = (await search.json()) as { issues: Array<{ key: string; fields: { summary: string } }> };
      expect(found.issues.map((issue) => issue.fields.summary)).toEqual(["Seeded through createEmulator"]);

      const missing = await fetch(`${jira.url}/rest/api/3/issue/QA-99`, {
        headers: { Authorization: basic("admin@jira.local", "jira_test_token") },
      });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { errorMessages: string[] }).errorMessages).toHaveLength(1);

      await fetch(`${jira.url}/rest/api/3/issue`, {
        method: "POST",
        headers: { Authorization: basic("admin@jira.local", "jira_test_token"), "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { project: { key: "QA" }, issuetype: { name: "Task" }, summary: "Temporary" } }),
      });
      jira.reset();
      const afterReset = await fetch(`${jira.url}/rest/api/3/issue/QA-2`, {
        headers: { Authorization: basic("admin@jira.local", "jira_test_token") },
      });
      expect(afterReset.status).toBe(404);
      const seeded = await fetch(`${jira.url}/rest/api/3/issue/QA-1`, {
        headers: { Authorization: basic("admin@jira.local", "jira_test_token") },
      });
      expect(seeded.status).toBe(200);
    } finally {
      await jira.close();
    }
  });
});
