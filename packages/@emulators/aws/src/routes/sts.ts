import type { Context, RouteContext } from "@emulators/core";
import { getAwsStore } from "../store.js";
import {
  awsXmlResponse,
  awsErrorXml,
  escapeXml,
  generateAwsId,
  generateMessageId,
  getAccountId,
  parseQueryString,
} from "../helpers.js";
import { randomBytes } from "crypto";

export function stsRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const aws = () => getAwsStore(store);
  const accountId = getAccountId();

  const handleStsAction = async (c: Context) => {
    const body = await c.req.text();
    const params = parseQueryString(body);
    const action = params["Action"] ?? c.req.query("Action") ?? "";

    switch (action) {
      case "AssumeRole":
        return assumeRole(c, params);
      case "GetCallerIdentity":
        return getCallerIdentity(c);
      default:
        return awsErrorXml(c, "InvalidAction", `The action ${action} is not valid for this endpoint.`, 400);
    }
  };

  // Path-prefix routes (legacy convention used by other emulate AWS routes).
  app.post("/sts", handleStsAction);
  app.post("/sts/", handleStsAction);

  // AWS SDK wire format: STS targets `POST /` with form-encoded body. We
  // dispatch only when the body looks like an STS form (contains
  // `Action=AssumeRole|GetCallerIdentity`) so that S3 wildcards remain
  // unaffected. S3 has no `POST /` handler today, so this is safe.
  const handleRootStsDispatch = async (c: Context) => {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("application/x-www-form-urlencoded")) {
      return c.notFound();
    }
    const body = await c.req.text();
    const params = parseQueryString(body);
    const action = params["Action"] ?? "";
    if (action !== "AssumeRole" && action !== "GetCallerIdentity") {
      return c.notFound();
    }
    if (action === "AssumeRole") {
      return assumeRole(c, params);
    }
    return getCallerIdentity(c);
  };
  app.post("/", handleRootStsDispatch);

  function assumeRole(c: Context, params: Record<string, string>) {
    const roleArn = params["RoleArn"] ?? "";
    const sessionName = params["RoleSessionName"] ?? "session";
    if (!roleArn) {
      return awsErrorXml(c, "ValidationError", "The request must contain the parameter RoleArn.", 400);
    }
    if (!params["RoleSessionName"]) {
      return awsErrorXml(c, "ValidationError", "The request must contain the parameter RoleSessionName.", 400);
    }

    // Synthetic credentials: emulate does not enforce IAM. If the role exists
    // in the in-memory IAM store we reuse its role_id for stability; otherwise
    // we mint a fresh AROA-prefixed id so callers can still parse the response
    // shape. This matches LocalStack-style behavior.
    const existingRole = aws()
      .iamRoles.all()
      .find((r) => r.arn === roleArn);
    const roleId = existingRole?.role_id ?? generateAwsId("AROA");

    // DurationSeconds must be within STS limits: 900s (15m) .. 43200s (12h).
    // AWS rejects out-of-range values with a ValidationError rather than
    // silently clamping, so we mirror that. Defaults to 3600s when omitted.
    const MIN_DURATION_SEC = 900;
    const MAX_DURATION_SEC = 43200;
    let durationSec = 3600;
    const rawDuration = params["DurationSeconds"];
    if (rawDuration !== undefined && rawDuration !== "") {
      const requestedDuration = Number(rawDuration);
      if (!Number.isInteger(requestedDuration)) {
        return awsErrorXml(
          c,
          "ValidationError",
          `1 validation error detected: Value '${rawDuration}' at 'durationSeconds' failed to satisfy constraint: Member must be a valid integer.`,
          400,
        );
      }
      if (requestedDuration < MIN_DURATION_SEC) {
        return awsErrorXml(
          c,
          "ValidationError",
          `1 validation error detected: Value '${rawDuration}' at 'durationSeconds' failed to satisfy constraint: Member must have value greater than or equal to ${MIN_DURATION_SEC}.`,
          400,
        );
      }
      if (requestedDuration > MAX_DURATION_SEC) {
        return awsErrorXml(
          c,
          "ValidationError",
          `1 validation error detected: Value '${rawDuration}' at 'durationSeconds' failed to satisfy constraint: Member must have value less than or equal to ${MAX_DURATION_SEC}.`,
          400,
        );
      }
      durationSec = requestedDuration;
    }

    const accessKeyId = "ASIA" + randomBytes(8).toString("hex").toUpperCase();
    const secretAccessKey = randomBytes(30).toString("base64");
    const sessionToken = randomBytes(64).toString("base64");
    const expiration = new Date(Date.now() + durationSec * 1000).toISOString();
    const assumedRoleArn = `${roleArn}/${sessionName}`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>${accessKeyId}</AccessKeyId>
      <SecretAccessKey>${escapeXml(secretAccessKey)}</SecretAccessKey>
      <SessionToken>${escapeXml(sessionToken)}</SessionToken>
      <Expiration>${expiration}</Expiration>
    </Credentials>
    <AssumedRoleUser>
      <Arn>${escapeXml(assumedRoleArn)}</Arn>
      <AssumedRoleId>${roleId}:${escapeXml(sessionName)}</AssumedRoleId>
    </AssumedRoleUser>
    <PackedPolicySize>0</PackedPolicySize>
  </AssumeRoleResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</AssumeRoleResponse>`;
    return awsXmlResponse(c, xml);
  }

  function getCallerIdentity(c: Context) {
    const authUser = c.get("authUser") as { login?: string } | undefined;
    const userName = authUser?.login ?? "admin";
    const arn = `arn:aws:iam::${accountId}:user/${userName}`;

    // Prefer the stable UserId from the IAM store when available.
    const user = aws().iamUsers.findOneBy("user_name", userName);
    const userId = user?.user_id ?? generateAwsId("AIDA");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetCallerIdentityResult>
    <Arn>${escapeXml(arn)}</Arn>
    <UserId>${userId}</UserId>
    <Account>${accountId}</Account>
  </GetCallerIdentityResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</GetCallerIdentityResponse>`;
    return awsXmlResponse(c, xml);
  }
}
