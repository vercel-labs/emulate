import type { RouteContext } from "@emulators/core";
import {
  findMissingLabelIds,
  getCurrentHistoryId,
  googleApiError,
  isHistoryChangeType,
  listHistoryForUser,
  normalizeLimit,
} from "../helpers.js";
import { getString, getStringArray, parseGoogleBody, requireGmailUser } from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

interface GmailWatchState {
  topicName: string;
  labelIds: string[];
  labelFilterBehavior: string | null;
  expiration: string;
}

const WATCH_STATE_KEY = "google.gmail.watchStates";

export function historyRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  app.get("/gmail/v1/users/:userId/history", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const url = new URL(c.req.url);
    const startHistoryId = url.searchParams.get("startHistoryId")?.trim();
    if (!startHistoryId) {
      return googleApiError(c, 400, "Start history ID is required.", "invalidArgument", "INVALID_ARGUMENT");
    }

    const historyTypes = url.searchParams
      .getAll("historyTypes")
      .filter(isHistoryChangeType);

    return c.json(
      listHistoryForUser(gs, authEmail, {
        startHistoryId,
        historyTypes,
        labelId: url.searchParams.get("labelId") ?? undefined,
        maxResults: normalizeLimit(url.searchParams.get("maxResults"), 100, 500),
        pageToken: url.searchParams.get("pageToken"),
      }),
    );
  });

  app.post("/gmail/v1/users/:userId/watch", async (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const topicName = getString(body, "topicName")?.trim();
    if (!topicName) {
      return googleApiError(c, 400, "Topic name is required.", "invalidArgument", "INVALID_ARGUMENT");
    }

    const labelIds = getStringArray(body, "labelIds");
    const missingLabelIds = findMissingLabelIds(gs, authEmail, labelIds);
    if (missingLabelIds.length > 0) {
      return googleApiError(c, 400, `Invalid label IDs: ${missingLabelIds.join(", ")}`, "invalidArgument", "INVALID_ARGUMENT");
    }

    const expiration = String(Date.now() + 24 * 60 * 60 * 1000);
    const states = store.getData<Map<string, GmailWatchState>>(WATCH_STATE_KEY) ?? new Map();
    states.set(authEmail, {
      topicName,
      labelIds,
      labelFilterBehavior: getString(body, "labelFilterBehavior", "labelFilterAction") ?? null,
      expiration,
    });
    store.setData(WATCH_STATE_KEY, states);

    return c.json({
      historyId: getCurrentHistoryId(gs, authEmail),
      expiration,
    });
  });

  app.post("/gmail/v1/users/:userId/stop", (c) => {
    const authEmail = requireGmailUser(c);
    if (authEmail instanceof Response) return authEmail;

    const states = store.getData<Map<string, GmailWatchState>>(WATCH_STATE_KEY) ?? new Map();
    states.delete(authEmail);
    store.setData(WATCH_STATE_KEY, states);

    return c.body(null, 200);
  });
}
