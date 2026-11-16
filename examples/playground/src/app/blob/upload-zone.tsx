"use client";

import { useActionState, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { formatBytes } from "@/lib/blob/format";
import { MAX_UPLOAD_MB } from "@/lib/blob/limits";
import { cn } from "@/lib/utils";
import { uploadFileAction } from "./actions";

export function UploadZone() {
  const [state, formAction, pending] = useActionState(uploadFileAction, null);
  const [dragging, setDragging] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Checks the size here because the server rejects oversized bodies before the action runs, which the client cannot recover from. */
  function submitFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setSizeError(`${file.name} is ${formatBytes(file.size)} — uploads are limited to ${MAX_UPLOAD_MB} MB`);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setSizeError(null);
    formRef.current?.requestSubmit();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (pending || !e.dataTransfer.files.length || !inputRef.current) return;
    const transfer = new DataTransfer();
    transfer.items.add(e.dataTransfer.files[0]);
    inputRef.current.files = transfer.files;
    submitFile(transfer.files[0]);
  }

  return (
    <form ref={formRef} action={formAction}>
      <input
        ref={inputRef}
        type="file"
        name="file"
        className="hidden"
        onChange={() => submitFile(inputRef.current?.files?.[0])}
      />
      <button
        type="button"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          "group flex w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border bg-card p-12 text-center transition-all duration-300",
          "hover:border-ring hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          dragging && "scale-[1.02] border-ring bg-muted/50",
          pending && "pointer-events-none opacity-60",
        )}
      >
        {pending ? (
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        ) : (
          <Upload
            className={cn(
              "size-8 text-muted-foreground transition-transform duration-300 group-hover:-translate-y-0.5",
              dragging && "-translate-y-0.5",
            )}
          />
        )}
        <div>
          <p className="font-medium">{pending ? "Uploading..." : "Drop a file to share"}</p>
          <p className="text-sm text-muted-foreground">or click to browse your files</p>
        </div>
      </button>
      {(sizeError ?? state?.error) && (
        <p className="mt-2 text-sm text-destructive animate-in fade-in slide-in-from-top-1">
          {sizeError ?? state?.error}
        </p>
      )}
    </form>
  );
}
