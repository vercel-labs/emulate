import type { RouteContext } from "@emulators/core";
import type { Context } from "hono";
import { evaluateFeatureFlag } from "../flag-eval.js";
import { asRecord, asString, parseCaptureBody } from "../helpers.js";
import { getPostHogStore } from "../store.js";

export function decideRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ph = () => getPostHogStore(store);

  const handler = async (c: Context) => {
    const body = await parseCaptureBody(c);
    const token = asString(body.token);
    const project = token ? ph().projects.findOneBy("api_token", token) : undefined;

    if (!project) {
      return c.body(null, 401);
    }

    const distinctId = asString(body.distinct_id);
    const flags = ph().featureFlags.findBy("project_id", project.project_id);
    const featureFlags: Record<string, boolean | string> = {};

    for (const flag of flags) {
      featureFlags[flag.key] = evaluateFeatureFlag(flag, {
        distinct_id: distinctId,
        person_properties: asRecord(body.person_properties),
        groups: asRecord(body.$groups),
        group_properties: asRecord(body.group_properties),
      });
    }

    return c.json({
      featureFlags,
      featureFlagPayloads: {},
      errorsWhileComputingFlags: false,
      config: { enable_collect_everything: true },
      sessionRecording: false,
      supportedCompression: [],
      siteApps: [],
      capturePerformance: false,
      autocapture_opt_out: true,
      surveys: false,
      toolbarParams: {},
      isAuthenticated: false,
      editorParams: {},
    });
  };

  for (const path of ["/decide", "/decide/", "/flags", "/flags/"]) {
    app.post(path, handler);
  }
}
