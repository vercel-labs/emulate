import type { RouteContext } from "@emulators/core";
import { renderCardPage, escapeHtml } from "@emulators/core";
import type { OpenAICompletionConfig } from "../entities.js";

const SERVICE_LABEL = "OpenAI";

export function playgroundRoutes({ app, store }: RouteContext): void {
  app.get("/playground", (c) => {
    const configs = store.getData<OpenAICompletionConfig[]>("openai.completions") ?? [];

    const configRows = configs.map((cfg) => {
      const preview = cfg.content.length > 60
        ? cfg.content.slice(0, 60) + "..."
        : cfg.content;
      return `<div class="org-row">
  <span class="org-icon">&gt;</span>
  <span class="org-name">${escapeHtml(cfg.pattern)}</span>
  <span class="card-subtitle">${escapeHtml(preview)}</span>
</div>`;
    }).join("\n");

    const configList = configs.length === 0
      ? '<p class="empty">No completion configs seeded.</p>'
      : configRows;

    const form = `<form class="user-form" method="post" action="/playground">
  <label class="card-subtitle">Test a prompt:</label>
  <div class="org-row">
    <input type="text" name="prompt" class="user-btn" placeholder="Type a message..." />
  </div>
  <button type="submit" class="user-btn">Send</button>
</form>`;

    const body = `${configList}${form}`;
    return c.html(renderCardPage("Playground", "Seeded completion patterns", body, SERVICE_LABEL));
  });

  app.post("/playground", async (c) => {
    const formData = await c.req.parseBody();
    const prompt = typeof formData.prompt === "string" ? formData.prompt : "";

    const configs = store.getData<OpenAICompletionConfig[]>("openai.completions") ?? [];

    let responseContent = "This is a mock response from the emulated OpenAI API.";
    for (const cfg of configs) {
      try {
        const regex = new RegExp(cfg.pattern, "i");
        if (regex.test(prompt)) {
          responseContent = cfg.content;
          break;
        }
      } catch {
        if (prompt.includes(cfg.pattern)) {
          responseContent = cfg.content;
          break;
        }
      }
    }

    const resultHtml = `<div class="org-row">
  <span class="org-icon">&gt;</span>
  <span class="org-name">${escapeHtml(prompt)}</span>
</div>
<div class="org-row">
  <span class="org-icon">A</span>
  <span class="card-subtitle">${escapeHtml(responseContent)}</span>
</div>`;

    const form = `<form class="user-form" method="post" action="/playground">
  <label class="card-subtitle">Test a prompt:</label>
  <div class="org-row">
    <input type="text" name="prompt" class="user-btn" placeholder="Type a message..." />
  </div>
  <button type="submit" class="user-btn">Send</button>
</form>`;

    const body = `${resultHtml}${form}`;
    return c.html(renderCardPage("Playground", "Seeded completion patterns", body, SERVICE_LABEL));
  });
}
