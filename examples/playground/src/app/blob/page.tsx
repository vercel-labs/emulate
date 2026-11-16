import { list } from "@/lib/blob/blob";
import { ArrowRight, Link2, Send, Upload } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileRow } from "@/components/blob/file-row";
import { UploadZone } from "./upload-zone";

export const dynamic = "force-dynamic";

/** Starts with an empty list when the emulator is unreachable, such as during prerendering. */
export default async function Home() {
  let blobs: Awaited<ReturnType<typeof list>>["blobs"] = [];
  try {
    ({ blobs } = await list({ limit: 50 }));
  } catch {}
  blobs.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 p-4 py-12 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-semibold">File Sharing</h1>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <Upload className="size-4" />
            Upload a file
          </span>
          <ArrowRight className="size-3.5" />
          <span className="flex items-center gap-2">
            <Link2 className="size-4" />
            Get a share link
          </span>
          <ArrowRight className="size-3.5" />
          <span className="flex items-center gap-2">
            <Send className="size-4" />
            Send it to anyone
          </span>
        </div>
      </div>

      <UploadZone />

      <Card>
        <CardHeader>
          <CardTitle>Recent uploads</CardTitle>
          <CardDescription>
            {blobs.length === 0
              ? "Nothing here yet — upload a file to get started"
              : `${blobs.length} file${blobs.length === 1 ? "" : "s"} stored in the emulator`}
          </CardDescription>
        </CardHeader>
        {blobs.length > 0 && (
          <CardContent className="flex flex-col">
            {blobs.map((blob) => (
              <FileRow
                key={blob.pathname}
                url={blob.url}
                pathname={blob.pathname}
                size={blob.size}
                uploadedAt={blob.uploadedAt}
              />
            ))}
          </CardContent>
        )}
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        A file-sharing demo built on Vercel Blob, running entirely against the local emulator
      </p>
    </div>
  );
}
