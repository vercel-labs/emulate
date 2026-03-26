import type { RouteContext } from "@emulators/core";
import { getAwsStore } from "../store.js";
import { escapeXml } from "../helpers.js";

export function inspectorRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const aws = () => getAwsStore(store);

  app.get("/", (c) => {
    const tab = c.req.query("tab") ?? "s3";
    const s3Store = aws();

    const buckets = s3Store.s3Buckets.all();
    const queues = s3Store.sqsQueues.all();
    const users = s3Store.iamUsers.all();
    const roles = s3Store.iamRoles.all();

    let contentHtml = "";

    if (tab === "s3") {
      const rows = buckets
        .map((b) => {
          const objects = s3Store.s3Objects.findBy("bucket_name", b.bucket_name);
          return `<tr>
            <td>${escapeXml(b.bucket_name)}</td>
            <td>${objects.length}</td>
            <td>${escapeXml(b.region)}</td>
            <td>${escapeXml(b.creation_date)}</td>
          </tr>`;
        })
        .join("\n");

      contentHtml = `
        <h2>S3 Buckets (${buckets.length})</h2>
        <table>
          <thead><tr><th>Bucket</th><th>Objects</th><th>Region</th><th>Created</th></tr></thead>
          <tbody>${rows || "<tr><td colspan=\"4\">No buckets</td></tr>"}</tbody>
        </table>`;

      // Show objects for each bucket
      for (const bucket of buckets) {
        const objects = s3Store.s3Objects.findBy("bucket_name", bucket.bucket_name);
        if (objects.length > 0) {
          const objRows = objects
            .map(
              (o) => `<tr>
              <td>${escapeXml(o.key)}</td>
              <td>${o.content_length}</td>
              <td>${escapeXml(o.content_type)}</td>
              <td>${escapeXml(o.last_modified)}</td>
            </tr>`,
            )
            .join("\n");
          contentHtml += `
            <h3>${escapeXml(bucket.bucket_name)} objects</h3>
            <table>
              <thead><tr><th>Key</th><th>Size</th><th>Type</th><th>Last Modified</th></tr></thead>
              <tbody>${objRows}</tbody>
            </table>`;
        }
      }
    } else if (tab === "sqs") {
      const rows = queues
        .map((q) => {
          const messages = s3Store.sqsMessages.findBy("queue_name", q.queue_name);
          return `<tr>
            <td>${escapeXml(q.queue_name)}</td>
            <td>${messages.length}</td>
            <td>${q.fifo ? "Yes" : "No"}</td>
            <td>${q.visibility_timeout}s</td>
          </tr>`;
        })
        .join("\n");

      contentHtml = `
        <h2>SQS Queues (${queues.length})</h2>
        <table>
          <thead><tr><th>Queue</th><th>Messages</th><th>FIFO</th><th>Visibility Timeout</th></tr></thead>
          <tbody>${rows || "<tr><td colspan=\"4\">No queues</td></tr>"}</tbody>
        </table>`;
    } else if (tab === "iam") {
      const userRows = users
        .map(
          (u) => `<tr>
          <td>${escapeXml(u.user_name)}</td>
          <td>${escapeXml(u.user_id)}</td>
          <td>${u.access_keys.length}</td>
          <td>${escapeXml(u.arn)}</td>
        </tr>`,
        )
        .join("\n");

      const roleRows = roles
        .map(
          (r) => `<tr>
          <td>${escapeXml(r.role_name)}</td>
          <td>${escapeXml(r.role_id)}</td>
          <td>${escapeXml(r.description)}</td>
          <td>${escapeXml(r.arn)}</td>
        </tr>`,
        )
        .join("\n");

      contentHtml = `
        <h2>IAM Users (${users.length})</h2>
        <table>
          <thead><tr><th>User</th><th>User ID</th><th>Access Keys</th><th>ARN</th></tr></thead>
          <tbody>${userRows || "<tr><td colspan=\"4\">No users</td></tr>"}</tbody>
        </table>
        <h2>IAM Roles (${roles.length})</h2>
        <table>
          <thead><tr><th>Role</th><th>Role ID</th><th>Description</th><th>ARN</th></tr></thead>
          <tbody>${roleRows || "<tr><td colspan=\"4\">No roles</td></tr>"}</tbody>
        </table>`;
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>AWS Emulator - Inspector</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
    .header h1 { margin: 0; font-size: 24px; }
    .badge { background: #ff9900; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
    .tabs { display: flex; gap: 4px; margin-bottom: 20px; }
    .tabs a { padding: 8px 16px; border-radius: 6px 6px 0 0; text-decoration: none; color: #333; background: #e0e0e0; }
    .tabs a.active { background: #fff; font-weight: 600; }
    .content { background: #fff; border-radius: 8px; padding: 20px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
    th { background: #f9f9f9; font-weight: 600; }
    h2 { margin-top: 0; }
    h3 { margin-top: 16px; color: #555; }
  </style>
</head>
<body>
  <div class="header">
    <h1>AWS Emulator</h1>
    <span class="badge">Inspector</span>
  </div>
  <div class="tabs">
    <a href="/?tab=s3" class="${tab === "s3" ? "active" : ""}">S3</a>
    <a href="/?tab=sqs" class="${tab === "sqs" ? "active" : ""}">SQS</a>
    <a href="/?tab=iam" class="${tab === "iam" ? "active" : ""}">IAM</a>
  </div>
  <div class="content">
    ${contentHtml}
  </div>
</body>
</html>`;

    return c.html(html);
  });
}
