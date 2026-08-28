import { describe, expect, it } from "vitest";
import {
  activityContentAsJSON,
  parseAgentActivityCreateInput,
  parseActivityContentInput,
  parseExternalUrlList,
  parsePlanInput,
  parseSignalAndMetadata,
  statusFromActivity,
} from "../agents.js";
import type { LinearAgentActivityContent } from "../entities.js";

describe("Linear agent helpers", () => {
  it("parses nested content into a discriminated union", () => {
    const thought = parseActivityContentInput({
      content: { type: "thought", body: "Thinking" },
    });
    expect(thought).toEqual({ type: "thought", body: "Thinking" });

    const action = parseActivityContentInput({
      content: {
        type: "action",
        action: "Searched",
        parameter: "query",
        result: "ok",
      },
    });
    expect(action).toEqual({
      type: "action",
      action: "Searched",
      parameter: "query",
      result: "ok",
    });

    const content: LinearAgentActivityContent = action;
    switch (content.type) {
      case "action":
        expect(content.parameter).toBe("query");
        break;
      default:
        throw new Error("expected action");
    }
  });

  it("rejects incomplete content shapes", () => {
    expect(() => parseActivityContentInput({ content: { type: "thought" } })).toThrow("content.body is required");
    expect(() => parseActivityContentInput({ content: { type: "action", action: "Run" } })).toThrow(
      "content.parameter is required",
    );
  });

  it("parses auth and select signal metadata", () => {
    expect(
      parseSignalAndMetadata("auth", {
        url: "https://auth.example/link",
        providerName: "Orbit",
      }),
    ).toEqual({
      signal: "auth",
      signalMetadata: { url: "https://auth.example/link", providerName: "Orbit" },
    });

    expect(
      parseSignalAndMetadata("select", {
        options: [{ label: "frontend", value: "src/frontend" }],
      }),
    ).toEqual({
      signal: "select",
      signalMetadata: { options: [{ label: "frontend", value: "src/frontend" }] },
    });
  });

  it("parses agentActivityCreate input", () => {
    const parsed = parseAgentActivityCreateInput({
      agentSessionId: "sess_1",
      content: { type: "elicitation", body: "Pick one" },
      signal: "select",
      signalMetadata: { options: [{ value: "a" }] },
    });
    expect(parsed.agentSessionId).toBe("sess_1");
    expect(parsed.content.type).toBe("elicitation");
    expect(parsed.signal).toBe("select");
  });

  it("maps activities to session status", () => {
    expect(statusFromActivity("thought", null)).toBe("active");
    expect(statusFromActivity("elicitation", null)).toBe("awaitingInput");
    expect(statusFromActivity("response", null)).toBe("complete");
    expect(statusFromActivity("error", null)).toBe("error");
    expect(statusFromActivity("prompt", "stop")).toBe("active");
  });

  it("serializes content without padded null fields", () => {
    expect(activityContentAsJSON({ type: "thought", body: "hi" })).toEqual({
      type: "thought",
      body: "hi",
    });
    expect(activityContentAsJSON({ type: "action", action: "Run", parameter: "tests" })).toEqual({
      type: "action",
      action: "Run",
      parameter: "tests",
    });
  });

  it("parses plan steps", () => {
    expect(
      parsePlanInput([
        { content: "Step 1", status: "inProgress" },
        { content: "Step 2", status: "pending" },
      ]),
    ).toEqual([
      { content: "Step 1", status: "inProgress" },
      { content: "Step 2", status: "pending" },
    ]);
  });

  it("rejects duplicate external URLs", () => {
    expect(() =>
      parseExternalUrlList(
        [
          { label: "Dashboard", url: "https://agent.example/session" },
          { label: "Logs", url: "https://agent.example/session" },
        ],
        "externalUrls",
      ),
    ).toThrow("externalUrls URLs must be unique");
  });
});
