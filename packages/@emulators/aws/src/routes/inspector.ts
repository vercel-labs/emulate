import type { RouteContext, InspectorTab } from "@emulators/core";
import { renderInspectorPage } from "@emulators/core";
import { getAwsStore } from "../store.js";
import { escapeXml } from "../helpers.js";

const SERVICE_LABEL = "AWS";

const TABS: InspectorTab[] = [
  { id: "s3", label: "S3", href: "/?tab=s3" },
  { id: "sqs", label: "SQS", href: "/?tab=sqs" },
  { id: "iam", label: "IAM", href: "/?tab=iam" },
];

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
        <div class="inspector-section">
          <h2>S3 Buckets (${buckets.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>Bucket</th><th>Objects</th><th>Region</th><th>Created</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="4"><div class="inspector-empty">No buckets</div></td></tr>`}</tbody>
          </table>
        </div>`;

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
            <div class="inspector-section">
              <h3>${escapeXml(bucket.bucket_name)} objects</h3>
              <table class="inspector-table">
                <thead><tr><th>Key</th><th>Size</th><th>Type</th><th>Last Modified</th></tr></thead>
                <tbody>${objRows}</tbody>
              </table>
            </div>`;
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
        <div class="inspector-section">
          <h2>SQS Queues (${queues.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>Queue</th><th>Messages</th><th>FIFO</th><th>Visibility Timeout</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="4"><div class="inspector-empty">No queues</div></td></tr>`}</tbody>
          </table>
        </div>`;
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
        <div class="inspector-section">
          <h2>IAM Users (${users.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>User</th><th>User ID</th><th>Access Keys</th><th>ARN</th></tr></thead>
            <tbody>${userRows || `<tr><td colspan="4"><div class="inspector-empty">No users</div></td></tr>`}</tbody>
          </table>
        </div>
        <div class="inspector-section">
          <h2>IAM Roles (${roles.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>Role</th><th>Role ID</th><th>Description</th><th>ARN</th></tr></thead>
            <tbody>${roleRows || `<tr><td colspan="4"><div class="inspector-empty">No roles</div></td></tr>`}</tbody>
          </table>
        </div>`;
    }

    return c.html(renderInspectorPage("Inspector", TABS, tab, contentHtml, SERVICE_LABEL));
  });
}
