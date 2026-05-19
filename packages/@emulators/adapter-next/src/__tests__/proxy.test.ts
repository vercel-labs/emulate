import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmulateProxy } from "../index";

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

describe("createEmulateProxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards service routes to local targets with the service prefix stripped", async () => {
    let forwardedRequest: Request | null = null;
    const fetchMock = vi.fn(async (input: unknown) => {
      forwardedRequest = input as Request;
      return new Response("ok", {
        status: 201,
        headers: { Location: "/emails/email_1" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const proxy = createEmulateProxy({
      targets: {
        resend: "http://127.0.0.1:4018",
      },
    });

    const response = await proxy.POST(
      new Request("https://preview.example.com/emulate/resend/emails?limit=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "preview.example.com",
        },
        body: JSON.stringify({ to: "test@example.com" }),
      }),
      ctx(["resend", "emails"]),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(forwardedRequest).not.toBeNull();
    const request = forwardedRequest!;
    expect(request.url).toBe("http://127.0.0.1:4018/emails?limit=1");
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("x-forwarded-host")).toBe("preview.example.com");
    expect(request.headers.get("x-forwarded-proto")).toBe("https");
    expect(request.headers.get("x-forwarded-prefix")).toBe("/emulate/resend");
    expect(request.headers.get("x-emulate-proxy")).toBe("next");
    expect(request.headers.get("x-emulate-service")).toBe("resend");
    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toBe("/emulate/resend/emails/email_1");
  });

  it("rewrites html returned by proxied service targets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response('<form action="/emails"><a href="/inbox">Inbox</a></form>', {
          headers: { "Content-Type": "text/html" },
        });
      }),
    );

    const proxy = createEmulateProxy({
      targets: {
        resend: "http://127.0.0.1:4018",
      },
    });

    const response = await proxy.GET(
      new Request("https://preview.example.com/api/emulate/resend/inbox"),
      ctx(["resend", "inbox"]),
    );

    await expect(response.text()).resolves.toBe(
      '<form action="/api/emulate/resend/emails"><a href="/api/emulate/resend/inbox">Inbox</a></form>',
    );
  });

  it("does not double prefix public redirect locations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("ok", {
          headers: { Location: "/emulate/resend/inbox" },
        });
      }),
    );

    const proxy = createEmulateProxy({
      targets: {
        resend: "http://127.0.0.1:4018",
      },
    });

    const response = await proxy.GET(
      new Request("https://preview.example.com/emulate/resend/login"),
      ctx(["resend", "login"]),
    );

    expect(response.headers.get("Location")).toBe("/emulate/resend/inbox");
  });

  it("keeps target redirects manual so locations can be rewritten", async () => {
    let forwardedRequest: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        forwardedRequest = input as Request;
        return new Response(null, {
          status: 302,
          headers: { Location: "/inbox" },
        });
      }),
    );

    const proxy = createEmulateProxy({
      targets: {
        resend: "http://127.0.0.1:4018",
      },
    });

    const response = await proxy.GET(
      new Request("https://preview.example.com/emulate/resend/login"),
      ctx(["resend", "login"]),
    );

    expect(forwardedRequest).not.toBeNull();
    expect(forwardedRequest!.redirect).toBe("manual");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/emulate/resend/inbox");
  });

  it("forwards every path segment in single target mode", async () => {
    let forwardedRequest: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        forwardedRequest = input as Request;
        return new Response("ok", {
          headers: { Location: "/aws/sqs" },
        });
      }),
    );

    const proxy = createEmulateProxy({
      routePrefix: "/emulate",
      target: {
        target: "http://127.0.0.1:4020/runtime",
        pathPrefix: "/v1",
      },
    });

    const response = await proxy.GET(
      new Request("https://preview.example.com/emulate/aws/sqs?Action=ListQueues"),
      ctx(["aws", "sqs"]),
    );

    expect(forwardedRequest).not.toBeNull();
    const request = forwardedRequest!;
    expect(request.url).toBe("http://127.0.0.1:4020/runtime/v1/aws/sqs?Action=ListQueues");
    expect(request.headers.get("x-forwarded-prefix")).toBe("/emulate");
    expect(response.headers.get("Location")).toBe("/emulate/aws/sqs");
  });

  it("allows config and target headers to extend the forwarded header contract", async () => {
    let forwardedRequest: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        forwardedRequest = input as Request;
        return new Response("ok");
      }),
    );

    const proxy = createEmulateProxy({
      headers: { "x-emulate-env": "preview" },
      targets: {
        resend: {
          target: "http://127.0.0.1:4018",
          headers: (_request, context) => ({ "x-emulate-public-prefix": context.publicPrefix }),
        },
      },
    });

    await proxy.GET(new Request("https://preview.example.com/emulate/resend/inbox"), ctx(["resend", "inbox"]));

    expect(forwardedRequest).not.toBeNull();
    const headers = forwardedRequest!.headers;
    expect(headers.get("x-emulate-env")).toBe("preview");
    expect(headers.get("x-emulate-public-prefix")).toBe("/emulate/resend");
  });

  it("returns 404 for unknown service targets", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const proxy = createEmulateProxy({
      targets: {
        resend: "http://127.0.0.1:4018",
      },
    });

    const response = await proxy.GET(new Request("https://preview.example.com/emulate/aws/sqs"), ctx(["aws", "sqs"]));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Unknown service: aws");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid target configuration", () => {
    expect(() => createEmulateProxy({})).toThrow("createEmulateProxy requires `target` or `targets`");
    expect(() =>
      createEmulateProxy({
        target: "http://127.0.0.1:4020",
        targets: {
          resend: "http://127.0.0.1:4018",
        },
      }),
    ).toThrow("createEmulateProxy accepts either `target` or `targets`, not both");
  });
});
