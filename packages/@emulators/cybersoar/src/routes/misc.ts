import type { AppEnv, Hono } from "@emulators/core";
import {
  CYBERSOAR_SERVICES,
  CYBERSOAR_STATUSES,
  CYBERSOAR_VERDICTS,
  type CybersoarService,
  type CybersoarStatus,
  type CybersoarVerdict,
} from "../entities.js";
import { badRequest, CybersoarError, isoDate, num, parseJsonBody, sendError, str, stringArray } from "../helpers.js";
import { logEvent, type CsStore } from "../store.js";
import { closeAlert, createAlert, ensureCustomer, formatAlert } from "./alerts.js";

export function miscRoutes(app: Hono<AppEnv>, cs: CsStore): void {
  app.post("/_cybersoar/simulate/alert", async (c) => {
    try {
      const body = await parseJsonBody(c);
      const customerName = str(body.customer);
      if (!customerName) throw badRequest("customer is required");
      const service = str(body.service) ?? "MS365";
      if (!CYBERSOAR_SERVICES.includes(service as CybersoarService))
        throw badRequest(`service must be one of the following values: ${CYBERSOAR_SERVICES.join(", ")}`);
      const status = str(body.status);
      if (status && !CYBERSOAR_STATUSES.includes(status as CybersoarStatus))
        throw badRequest(`status must be one of the following values: ${CYBERSOAR_STATUSES.join(", ")}`);
      const verdict = str(body.verdict);
      if (verdict && !CYBERSOAR_VERDICTS.includes(verdict as CybersoarVerdict))
        throw badRequest(`verdict must be one of the following values: ${CYBERSOAR_VERDICTS.join(", ")}`);
      const customer = ensureCustomer(cs, { name: customerName, msp: str(body.msp) });
      const count = Math.min(Math.max(num(body.count) ?? 1, 1), 500);
      const ingestAt = isoDate(body.ingestAt, "ingestAt");
      const alerts = Array.from({ length: count }, (_, index) =>
        createAlert(cs, {
          customer,
          service: service as CybersoarService,
          ruleName: str(body.ruleName) ?? "Simulated detection",
          criticity: num(body.criticity),
          status: status as CybersoarStatus | undefined,
          verdict: verdict as CybersoarVerdict | undefined,
          tags: stringArray(body.tags),
          ingestAt: ingestAt ? new Date(Date.parse(ingestAt) - index * 60000).toISOString() : undefined,
          caseId: str(body.caseId),
          description: str(body.description),
        }),
      );
      return c.json({ data: alerts.map(formatAlert), meta: { count: alerts.length } }, 201);
    } catch (error) {
      if (error instanceof CybersoarError) return sendError(c, error);
      throw error;
    }
  });

  app.post("/_cybersoar/simulate/close", async (c) => {
    try {
      const body = await parseJsonBody(c);
      const verdict = str(body.verdict) ?? "TP";
      if (!CYBERSOAR_VERDICTS.includes(verdict as CybersoarVerdict))
        throw badRequest(`verdict must be one of the following values: ${CYBERSOAR_VERDICTS.join(", ")}`);
      const id = str(body.id) ?? str(body.alertId);
      const caseId = str(body.caseId);
      const targets = id ? cs.alerts.findBy("alert_id", id) : caseId ? cs.alerts.findBy("case_id", caseId) : [];
      if (targets.length === 0)
        return c.json({ statusCode: 404, message: "No alert matched id or caseId", error: "Not Found" }, 404);
      const closed = targets.map((alert) =>
        closeAlert(cs, alert, verdict as CybersoarVerdict, {
          notify: body.notify === true || body.notify === "true",
          analyst: str(body.analyst),
        }),
      );
      return c.json({ data: closed.map(formatAlert), meta: { count: closed.length } });
    } catch (error) {
      if (error instanceof CybersoarError) return sendError(c, error);
      throw error;
    }
  });

  app.get("/_cybersoar/events", (c) => {
    const type = c.req.query("type");
    const limit = Math.min(num(c.req.query("limit")) ?? 100, 1000);
    const events = [...cs.events.all()]
      .filter((event) => !type || event.type === type)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return c.json({
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        subject: event.subject,
        detail: event.detail,
        created_at: event.created_at,
      })),
    });
  });

  app.delete("/_cybersoar/events", (c) => {
    cs.events.clear();
    return c.json({ ok: true });
  });
}
