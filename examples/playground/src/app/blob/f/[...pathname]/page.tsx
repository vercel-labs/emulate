import Link from "next/link";
import { notFound } from "next/navigation";
import { head, BlobNotFoundError } from "@/lib/blob/blob";
import { ArrowLeft, Download } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShareLinkField } from "@/components/blob/share-link-field";
import { formatBytes, formatDate } from "@/lib/blob/format";
import { pathnameFromShareSegments, sharePathForPathname } from "@/lib/blob/share-url";

export const dynamic = "force-dynamic";

export default async function FilePage({ params }: { params: Promise<{ pathname: string[] }> }) {
  const { pathname } = await params;
  const path = pathnameFromShareSegments(pathname);

  let blob;
  try {
    blob = await head(path);
  } catch (err) {
    if (err instanceof BlobNotFoundError) notFound();
    throw err;
  }

  const details: [string, string][] = [
    ["Size", formatBytes(blob.size)],
    ["Content type", blob.contentType],
    ["Uploaded", formatDate(blob.uploadedAt)],
    ["Cache control", blob.cacheControl],
    ["ETag", blob.etag ?? "—"],
  ];

  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-4 p-4 py-12 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <Link
        href="/blob"
        className="group inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5 transition-transform group-hover:-translate-x-0.5" />
        All files
      </Link>

      <Card className="pb-0">
        <CardHeader>
          <CardTitle className="break-all">{blob.pathname}</CardTitle>
          <CardDescription>Shared via the Vercel Blob emulator</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {blob.contentType.startsWith("image/") && (
            <img
              src={blob.url}
              alt={blob.pathname}
              className="mx-auto max-h-80 max-w-full rounded-lg border border-border animate-in fade-in duration-500"
            />
          )}
          <ShareLinkField path={sharePathForPathname(blob.pathname)} />
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
            {details.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="truncate font-mono text-xs leading-5" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
        <CardFooter>
          <Button nativeButton={false} render={<a href={blob.downloadUrl} />}>
            <Download />
            Download
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
