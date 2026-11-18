"use client";

import { useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CopyLinkButtonProps {
  url: string;
  /** Icon-only ghost button for list rows; labeled outline button otherwise. */
  compact?: boolean;
}

export function CopyLinkButton({ url, compact = false }: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const absolute = url.startsWith("/") ? `${window.location.origin}${url}` : url;
    await navigator.clipboard.writeText(absolute);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (compact) {
    return (
      <Button variant="ghost" size="icon" onClick={copy} aria-label="Copy share link">
        {copied ? <Check className="text-green-600 animate-in zoom-in duration-200" /> : <Link2 />}
      </Button>
    );
  }

  return (
    <Button variant="outline" onClick={copy}>
      {copied ? <Check className="text-green-600 animate-in zoom-in duration-200" /> : <Copy />}
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}
