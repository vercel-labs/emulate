import type { RouteContext } from "@emulators/core";
import { getTwilioStore } from "../store.js";
import { formatAccount } from "../formatters.js";
import {
  accountFromParam,
  bodyString,
  parseTwilioBody,
  requireTwilioAuth,
  twilioError,
  twilioList,
} from "../helpers.js";

export function accountRoutes({ app, store }: RouteContext): void {
  const ts = getTwilioStore(store);

  app.get("/2010-04-01/Accounts.json", (c) => {
    const auth = requireTwilioAuth(c, ts);
    if (auth instanceof Response) return auth;
    const accounts = ts.accounts
      .all()
      .filter((account) => account.sid === auth.sid || account.owner_account_sid === auth.sid);
    return twilioList(c, "accounts", accounts, "/2010-04-01/Accounts.json", formatAccount);
  });

  app.get("/2010-04-01/Accounts/:accountSid.json", (c) => {
    const auth = requireTwilioAuth(c, ts);
    if (auth instanceof Response) return auth;
    const account = accountFromParam(c, ts, auth);
    if (account instanceof Response) return account;
    return c.json(formatAccount(account));
  });

  app.post("/2010-04-01/Accounts/:accountSid.json", async (c) => {
    const auth = requireTwilioAuth(c, ts);
    if (auth instanceof Response) return auth;
    const account = accountFromParam(c, ts, auth);
    if (account instanceof Response) return account;
    const body = await parseTwilioBody(c);
    const friendlyName = bodyString(body, "FriendlyName");
    const status = bodyString(body, "Status");
    if (status && !["active", "suspended", "closed"].includes(status)) {
      return twilioError(c, 400, "Status is invalid", 20001);
    }
    const updated = ts.accounts.update(account.id, {
      friendly_name: friendlyName ?? account.friendly_name,
      status: (status as typeof account.status | undefined) ?? account.status,
    })!;
    return c.json(formatAccount(updated));
  });
}
