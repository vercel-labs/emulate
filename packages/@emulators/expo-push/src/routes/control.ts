import type { Context, RouteContext } from "@emulators/core";
import { isPlainObject, requestError } from "../helpers.js";
import { ExpoPushConfigError, parseConfig } from "../rules.js";
import { applyConfig, getConfig, getExpoPushStore, getSeedConfig, setConfig } from "../store.js";

/** Browsers send `Origin` on cross-site requests; a page on another site must not reset a developer's emulator. */
function crossSite(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== (c.req.header("host") ?? new URL(c.req.url).host);
  } catch {
    return true;
  }
}

export function controlRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const es = () => getExpoPushStore(store);

  app.use("/_expo-push/*", async (c, next) => {
    if (crossSite(c))
      return requestError(c, 403, "FORBIDDEN", "Cross-origin requests are not allowed on control routes.");
    await next();
  });

  /** Messages the service accepted or refused, oldest first. Filters: token, title, body (substring), status. */
  app.get("/_expo-push/messages", (c) => {
    const token = c.req.query("token");
    const title = c.req.query("title");
    const body = c.req.query("body");
    const status = c.req.query("status");
    const data = es()
      .messages.all()
      .filter((m) => {
        if (token !== undefined && m.token !== token) return false;
        if (title !== undefined && !String(m.message.title ?? "").includes(title)) return false;
        if (body !== undefined && !String(m.message.body ?? "").includes(body)) return false;
        if (status !== undefined && m.ticket.status !== status) return false;
        return true;
      });
    return c.json({ data });
  });

  app.get("/_expo-push/requests", (c) => c.json({ data: es().requests.all() }));

  app.get("/_expo-push/rules", (c) => c.json({ data: getConfig(store).rules }));

  /** Replaces the failure rules and zeroes their hit counts; devices, ids, and the call record stay. */
  app.put("/_expo-push/rules", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isPlainObject(body) || !Array.isArray(body.failures)) {
      return requestError(c, 400, "VALIDATION_ERROR", 'Body must be {"failures": [...]}');
    }
    try {
      const parsed = parseConfig({ failures: body.failures });
      store.setData("expo_push.hits", {});
      setConfig(store, { ...getConfig(store), rules: parsed.rules });
    } catch (error) {
      if (error instanceof ExpoPushConfigError) return requestError(c, 400, "VALIDATION_ERROR", error.message);
      throw error;
    }
    return c.json({ data: getConfig(store).rules });
  });

  /** Registers or updates a device; `registered: false` makes later receipts say DeviceNotRegistered. */
  app.post("/_expo-push/devices", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    try {
      const parsed = parseConfig({ devices: [body] });
      const device = parsed.devices[0];
      const existing = es().devices.findOneBy("token", device.token);
      const saved = existing ? es().devices.update(existing.id, device) : es().devices.insert(device);
      return c.json({ data: saved }, existing ? 200 : 201);
    } catch (error) {
      if (error instanceof ExpoPushConfigError) return requestError(c, 400, "VALIDATION_ERROR", error.message);
      throw error;
    }
  });

  /** Clears the call record and hit counts and restores seeded devices, rules, and ids. */
  app.post("/_expo-push/reset", (c) => {
    applyConfig(store, getSeedConfig(store));
    return c.json({ data: { reset: true } });
  });
}
