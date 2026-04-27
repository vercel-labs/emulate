import { randomBytes } from "node:crypto";
import type { RouteContext } from "@emulators/core";
import { extractMultipartBoundary, googleApiError, splitMultipartParts } from "../helpers.js";
import { requireGoogleAuth } from "../route-helpers.js";

type BatchOperation = {
  method: string;
  path: string;
};

export function batchRoutes({ app }: RouteContext): void {
  app.post("/batch/gmail/v1", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const contentType = c.req.header("Content-Type") ?? "";
    const rawBody = await c.req.text();
    const operations = parseBatchOperations(contentType, rawBody);
    if (!operations) {
      return googleApiError(c, 400, "Invalid batch request body.", "invalidArgument", "INVALID_ARGUMENT");
    }

    const responseBoundary = `batch_${randomBytes(8).toString("hex")}`;
    const authorization = c.req.header("Authorization");
    const responseParts = await Promise.all(
      operations.map(async (operation) => {
        const url = operation.path.startsWith("/") ? operation.path : `/${operation.path}`;
        const response = await app.request(url, {
          method: operation.method,
          headers: authorization ? { Authorization: authorization } : undefined,
        });

        return renderBatchResponsePart(response);
      }),
    );

    const responseBody = [
      ...responseParts.map((part) => `--${responseBoundary}\r\n${part}`),
      `--${responseBoundary}--`,
    ].join("\r\n");

    return new Response(responseBody, {
      headers: {
        "Content-Type": `multipart/mixed; boundary=${responseBoundary}`,
      },
    });
  });
}

function parseBatchOperations(contentType: string, rawBody: string): BatchOperation[] | null {
  const boundary = extractMultipartBoundary(contentType);
  if (!boundary) return null;

  return splitMultipartParts(boundary, rawBody)
    .map(parseBatchOperation)
    .filter((operation): operation is BatchOperation => Boolean(operation));
}

function parseBatchOperation(part: string): BatchOperation | undefined {
  const separatorIndex = part.indexOf("\r\n\r\n");
  const separator = separatorIndex >= 0 ? "\r\n\r\n" : "\n\n";
  const actualIndex = separatorIndex >= 0 ? separatorIndex : part.indexOf("\n\n");
  if (actualIndex < 0) return;

  const requestText = part.slice(actualIndex + separator.length).trim();
  const [requestLine] = requestText.split(/\r?\n/, 1);
  const requestMatch = requestLine?.match(/^([A-Z]+)\s+(\S+?)(?:\s+HTTP\/[0-9.]+)?$/);
  if (!requestMatch) return;

  return {
    method: requestMatch[1],
    path: requestMatch[2],
  };
}

async function renderBatchResponsePart(response: Response): Promise<string> {
  const body = await response.text();
  const statusText = response.statusText || getStatusText(response.status);
  const contentType = response.headers.get("Content-Type") ?? "application/json; charset=UTF-8";

  return [
    "Content-Type: application/http",
    "",
    `HTTP/1.1 ${response.status} ${statusText}`,
    `Content-Type: ${contentType}`,
    "",
    body,
  ].join("\r\n");
}

function getStatusText(status: number): string {
  switch (status) {
    case 200:
      return "OK";
    case 204:
      return "No Content";
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    default:
      return "OK";
  }
}
