import { describe, expect, it, vi } from "vitest";
import { checkContract, localOnlyFetch, type KnownGap } from "./blob-contract-support.js";

const expected = { status: 400 };
const gap: KnownGap<typeof expected> = {
  id: "example-gap",
  reason: "Example missing validation",
  source: "helper self-test",
  current: { status: 200 },
};

describe("Blob contract foundation safeguards", () => {
  it("accepts an ordinary contract pass", async () => {
    await expect(checkContract(async () => expected, expected)).resolves.toBe("contract-pass");
  });

  it("accepts only the exact documented gap", async () => {
    await expect(checkContract(async () => gap.current, expected, gap)).resolves.toBe("known-gap");
  });

  it("fails an unexpected success until its designation is removed", async () => {
    await expect(checkContract(async () => expected, expected, gap)).rejects.toThrow("unexpected success");
  });

  it("fails a new mismatch rather than masking it", async () => {
    await expect(checkContract(async () => ({ status: 500 }), expected, gap)).rejects.toThrow("unexpected mismatch");
  });

  it("propagates setup and transport exceptions", async () => {
    for (const message of ["fixture failed", "connection refused"]) {
      const failure = new Error(message);
      await expect(
        checkContract(
          async () => {
            throw failure;
          },
          expected,
          gap,
        ),
      ).rejects.toBe(failure);
    }
  });

  it("rejects a mismatch without a gap designation", async () => {
    await expect(checkContract(async () => gap.current, expected)).rejects.toThrow("unexpected mismatch");
  });

  it("blocks production, other ports and URL credentials before transport", async () => {
    const transport = vi.fn<typeof fetch>();
    const guarded = localOnlyFetch("http://127.0.0.1:12345", transport);
    for (const url of [
      "https://blob.vercel-storage.com/",
      "http://127.0.0.1:12346/",
      "http://localhost:12345/",
      "http://secret@127.0.0.1:12345/",
    ]) {
      await expect(guarded(url)).rejects.toThrow("blocked non-local fetch");
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("forces manual redirects, including when a caller requests follow", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://blob.vercel-storage.com/" } }),
      );
    const guarded = localOnlyFetch("http://127.0.0.1:12345", transport);
    await expect(guarded(new Request("http://127.0.0.1:12345/"), { redirect: "follow" })).rejects.toThrow(
      "blocked redirect",
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][1]?.redirect).toBe("manual");
  });
});
