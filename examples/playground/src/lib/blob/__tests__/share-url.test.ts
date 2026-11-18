import { describe, expect, it } from "vitest";
import { pathnameFromShareSegments, sharePathForPathname } from "../share-url";

describe("blob share links", () => {
  it("leads back to the same blob when a name needs encoding", () => {
    for (const pathname of ["plain.txt", "my notes-vpypvk4n.txt", "folder/100% done & more.txt"]) {
      const segments = sharePathForPathname(pathname).replace("/blob/f/", "").split("/");
      expect(pathnameFromShareSegments(segments)).toBe(pathname);
    }
  });
});
