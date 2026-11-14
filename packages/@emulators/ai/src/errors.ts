/** A client error that every codec renders as its native 400-class error body. */
export class AiRequestError extends Error {
  constructor(
    message: string,
    public readonly param?: string,
    public readonly code?: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AiRequestError";
  }
}

/** An invalid seed config or runtime rules body; `path` names the offending key, for example `rules[2].match.tool`. */
export class AiConfigError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "AiConfigError";
  }
}

/** The OpenAI error `type` for a status when the failure does not name one. */
export function defaultErrorType(status: number): string {
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}
