"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { cardClass, hintClass, mutedClass, secondaryButtonClass } from "@/components/playground/ui";
import { getEmulator } from "@/lib/playground/runtime";

const FOLDER = "playground-demo/";
const MAX_UPLOAD_MB = 50;
const BLOB_HEADERS = { Authorization: "Bearer vercel_blob_rw_devstore_devsecret", "x-api-version": "12" };

interface BlobItem {
  url: string;
  pathname: string;
  size: number;
  uploadedAt: string;
  etag: string;
}

interface BlobDetails extends BlobItem {
  contentType: string;
  cacheControl: string;
}

interface Selection {
  pathname: string;
  details: BlobDetails | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(date: string): string {
  return new Date(date).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/** Sends a request to the Vercel emulator and throws with the emulator's error message on a non-2xx response. */
async function blobRequest(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {},
): Promise<Response> {
  const emulator = await getEmulator("vercel");
  const res = await emulator.fetch(path, { ...init, headers: { ...BLOB_HEADERS, ...init.headers } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Request failed with status ${res.status}`);
  }
  return res;
}

async function listFiles(): Promise<BlobItem[]> {
  const data = (await (await blobRequest(`/api/blob?prefix=${FOLDER}`)).json()) as { blobs: BlobItem[] };
  return data.blobs.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/** Uploads, lists, previews, shares and deletes Vercel Blob files. Each file has a real link the browser can open. */
export function FileSharing() {
  const [files, setFiles] = useState<BlobItem[] | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef(0);

  useEffect(() => {
    listFiles().then(setFiles, (err: unknown) => setError(messageOf(err)));
  }, []);

  useEffect(() => {
    const token = latest;
    return () => {
      token.current++;
    };
  }, []);

  async function run(task: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(false);
    }
  }

  async function select(pathname: string) {
    const id = ++latest.current;
    setSelection({ pathname, details: null });
    const details = (await (await blobRequest(`/api/blob?url=${encodeURIComponent(pathname)}`)).json()) as BlobDetails;
    if (id !== latest.current) return;
    setSelection({ pathname, details });
  }

  function upload(file: File) {
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setError(`${file.name} is ${formatBytes(file.size)} — uploads are limited to ${MAX_UPLOAD_MB} MB`);
      return;
    }
    void run(async () => {
      const res = await blobRequest(`/api/blob?pathname=${FOLDER}${encodeURIComponent(file.name)}`, {
        method: "PUT",
        headers: {
          "x-add-random-suffix": "1",
          "x-vercel-blob-access": "public",
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      });
      const uploaded = (await res.json()) as { pathname: string };
      setFiles(await listFiles());
      await select(uploaded.pathname);
    });
  }

  function pickFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
    if (file) upload(file);
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && !pending) upload(file);
  }

  function remove(pathname: string) {
    void run(async () => {
      await blobRequest("/api/blob/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: [pathname] }),
      });
      if (selection?.pathname === pathname) {
        latest.current++;
        setSelection(null);
      }
      setFiles(await listFiles());
    });
  }

  const details = selection?.details ?? null;
  const rows: [string, string][] = details
    ? [
        ["Size", formatBytes(details.size)],
        ["Content type", details.contentType],
        ["Uploaded", formatDate(details.uploadedAt)],
        ["Cache control", details.cacheControl],
        ["ETag", details.etag],
      ]
    : [];

  return (
    <div data-flow-step="files" className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <input
          ref={inputRef}
          type="file"
          data-upload
          aria-label="Choose a file to upload"
          className="hidden"
          disabled={pending}
          onChange={(event) => pickFile(event.currentTarget)}
        />
        <button
          type="button"
          disabled={pending}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
          className="flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed border-neutral-300 px-6 py-10 text-center hover:border-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:hover:border-neutral-600"
        >
          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {pending ? "Working..." : "Drop a file here or choose one"}
          </span>
          <span className={hintClass}>Up to {MAX_UPLOAD_MB} MB. Stored in this browser only.</span>
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Recent uploads</h2>
        <div aria-live="polite">
          {files === null && <p className={mutedClass}>Loading files...</p>}
          {files?.length === 0 && <p className={mutedClass}>No uploads yet. Files you add appear here.</p>}
          {files && files.length > 0 && (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {files.map((file) => (
                <li key={file.pathname} data-file={file.pathname} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm text-neutral-900 dark:text-neutral-100">{file.pathname}</p>
                    <p className={hintClass}>
                      {formatBytes(file.size)} · {formatDate(file.uploadedAt)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      data-details
                      disabled={pending}
                      onClick={() => void run(() => select(file.pathname))}
                      className={secondaryButtonClass}
                    >
                      Details
                    </button>
                    <button
                      type="button"
                      data-delete
                      disabled={pending}
                      aria-label={`Delete ${file.pathname}`}
                      onClick={() => remove(file.pathname)}
                      className={secondaryButtonClass}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section
        aria-label="File details"
        data-flow-result
        aria-live="polite"
        className={`${cardClass} flex flex-col gap-4`}
      >
        {!selection && <p className={mutedClass}>Select a file to see its details.</p>}
        {selection && !details && <p className={mutedClass}>Loading {selection.pathname}...</p>}
        {selection && details && (
          <>
            <h2 className="break-all font-mono text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {details.pathname}
            </h2>
            {details.contentType.startsWith("image/") && (
              <img
                data-preview
                src={details.url}
                alt={details.pathname}
                className="max-h-80 max-w-full self-center rounded-md border border-neutral-200 dark:border-neutral-800"
              />
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
                  <dd
                    className="truncate font-mono text-xs leading-5 text-neutral-900 dark:text-neutral-100"
                    title={value}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap gap-3">
              <a
                data-share-link
                href={details.url}
                target="_blank"
                rel="noreferrer"
                className={`${secondaryButtonClass} self-start`}
              >
                Open the share link
              </a>
              <a href={details.url} download={details.pathname} className={`${secondaryButtonClass} self-start`}>
                Download
              </a>
            </div>
            <p className={hintClass}>
              The link opens in this browser, where the emulator keeps the file. Web pages open with scripts turned off.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
