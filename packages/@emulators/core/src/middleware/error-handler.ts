import { errorStatus, renderApiError, type Context, type ErrorHandler, type MiddlewareHandler } from "../http.js";

export { errorStatus };

/**
 * Use with `app.onError(...)`. Route handlers throw to the app error handler.
 */
export function createApiErrorHandler(documentationUrl?: string): ErrorHandler {
  return (err, c) => {
    if (documentationUrl) {
      c.set("docsUrl", documentationUrl);
    }
    return renderApiError(err, c);
  };
}

/** Sets `docsUrl` on the context for successful responses; register `createApiErrorHandler` for thrown `ApiError`s. */
export function createErrorHandler(documentationUrl?: string): MiddlewareHandler {
  return async (c, next) => {
    if (documentationUrl) {
      c.set("docsUrl", documentationUrl);
    }
    await next();
  };
}

export const errorHandler: MiddlewareHandler = createErrorHandler();

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors?: Array<{ resource: string; field: string; code: string }>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function notFound(resource?: string): ApiError {
  return new ApiError(404, resource ? `${resource} not found` : "Not Found");
}

export function validationError(message: string, errors?: ApiError["errors"]): ApiError {
  return new ApiError(422, message, errors);
}

export function unauthorized(): ApiError {
  return new ApiError(401, "Requires authentication");
}

export function forbidden(): ApiError {
  return new ApiError(403, "Forbidden");
}

export async function parseJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    throw new ApiError(400, "Problems parsing JSON");
  }
}
