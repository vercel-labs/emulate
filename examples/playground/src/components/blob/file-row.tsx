"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { File, Trash2 } from "lucide-react";
import { deleteFileAction } from "@/app/blob/actions";
import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "@/components/blob/copy-link-button";
import { formatBytes, formatDate } from "@/lib/blob/format";
import { sharePathForPathname } from "@/lib/blob/share-url";
import { cn } from "@/lib/utils";

const IMAGE_EXT = /\.(avif|gif|jpe?g|png|svg|webp)$/i;

interface FileRowProps {
  url: string;
  pathname: string;
  size: number;
  uploadedAt: Date | string;
}

export function FileRow({ url, pathname, size, uploadedAt }: FileRowProps) {
  const [removing, setRemoving] = useState(false);
  const [, startTransition] = useTransition();
  const sharePath = sharePathForPathname(pathname);

  function handleDelete() {
    setRemoving(true);
    startTransition(() => deleteFileAction(url));
  }

  return (
    <div
      className={cn(
        "grid transition-all duration-300 ease-in-out",
        removing ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
      )}
    >
      <div className="overflow-hidden">
        <div className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted/40">
          {IMAGE_EXT.test(pathname) ? (
            <img src={url} alt={pathname} className="size-10 shrink-0 rounded-md border border-border object-cover" />
          ) : (
            <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
              <File className="size-4 text-muted-foreground" />
            </div>
          )}
          <Link href={sharePath} className="min-w-0 flex-1 truncate font-medium hover:underline">
            {pathname}
          </Link>
          <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(size)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatDate(uploadedAt)}</span>
          <CopyLinkButton url={sharePath} compact />
          <Button
            variant="ghost"
            size="icon"
            disabled={removing}
            onClick={handleDelete}
            aria-label={`Delete ${pathname}`}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>
  );
}
