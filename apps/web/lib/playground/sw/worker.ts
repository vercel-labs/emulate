import "@/lib/emulator-browser/buffer";
import { createAdapterRuntime, type AdapterEmulatorModule, type PersistenceAdapter } from "@emulators/core";
import * as ai from "@emulators/ai";
import * as apple from "@emulators/apple";
import * as aws from "@emulators/aws";
import * as clerk from "@emulators/clerk";
import * as github from "@emulators/github";
import * as google from "@emulators/google";
import * as linear from "@emulators/linear";
import * as microsoft from "@emulators/microsoft";
import * as mongoatlas from "@emulators/mongoatlas";
import * as okta from "@emulators/okta";
import * as resend from "@emulators/resend";
import * as slack from "@emulators/slack";
import * as stripe from "@emulators/stripe";
import * as twilio from "@emulators/twilio";
import * as vercel from "@emulators/vercel";
import {
  BUILD_HEADER,
  CLAIM_MESSAGE,
  EMULATOR_MOUNT,
  PING_SEGMENT,
  RAW_REDIRECT_HEADER,
  RESET_SEGMENT,
} from "./protocol";
import { fallbackUsers, seeds } from "../seeds";

interface FetchEventLike {
  request: Request;
  respondWith(response: Promise<Response>): void;
}

interface WorkerScope {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install", listener: () => void): void;
  addEventListener(type: "activate", listener: (event: { waitUntil(work: Promise<unknown>): void }) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

type Runtime = ReturnType<typeof createAdapterRuntime>;

const worker = self as unknown as WorkerScope;
const emulators: Record<string, AdapterEmulatorModule> = {
  ai,
  apple,
  aws,
  clerk,
  github,
  google,
  linear,
  microsoft,
  mongoatlas,
  okta,
  resend,
  slack,
  stripe,
  twilio,
  vercel,
};
const DATABASE = "emulate-playground";
const STORE = "state";
const BUILD = process.env.NEXT_PUBLIC_PLAYGROUND_BUILD ?? "";
const runtimes = new Map<string, Runtime>();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

/**
 * Keeps one emulator's state in IndexedDB, because the browser stops an idle worker and its memory goes with it.
 * State saved by another build of the site is ignored, so a deploy or a dev server restart starts every emulator from its seed.
 */
function persistenceFor(name: string): PersistenceAdapter {
  return {
    async load() {
      const saved = await withStore<{ build: string; data: string } | undefined>("readonly", (store) =>
        store.get(name),
      );
      return saved && saved.build === BUILD ? saved.data : null;
    },
    async save(data) {
      await withStore("readwrite", (store) => store.put({ build: BUILD, data }, name));
    },
  };
}

/**
 * Returns the runtime for one emulator, creating it on first use so a request only pays for the emulator it reaches.
 * To add an emulator, import it above, add it to `emulators`, and give it a seed and a fallback user in `seeds.ts`.
 * The site's own origin is named as the public address, so an emulator that only answers on hosts it trusts answers here.
 */
function runtimeFor(name: string): Runtime {
  let runtime = runtimes.get(name);
  if (!runtime) {
    runtime = createAdapterRuntime(
      {
        services: { [name]: { emulator: emulators[name], seed: seeds[name], fallbackUser: fallbackUsers[name] } },
        persistence: persistenceFor(name),
        publicUrl: worker.location.origin,
      },
      (mountPath, service) => `${mountPath}/${service}`,
    );
    runtimes.set(name, runtime);
  }
  return runtime;
}

/** Drops one emulator and its saved state, so its next request starts from fresh seed data. */
async function reset(name: string): Promise<Response> {
  const runtime = runtimes.get(name);
  runtimes.delete(name);
  await runtime?.close();
  await withStore("readwrite", (store) => store.delete(name));
  return new Response(null, { status: 204 });
}

/**
 * A page cannot read the status or Location of a redirect it fetched, so a request that asks for it gets the redirect
 * back as a 200 that names both in headers.
 */
function describeRedirect(response: Response): Response {
  if (response.status < 300 || response.status > 399) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Emulate-Status", String(response.status));
  headers.set("X-Emulate-Status-Text", response.statusText);
  headers.set("X-Emulate-Location", response.headers.get("location") ?? "");
  headers.delete("location");
  return new Response(response.body, { status: 200, headers });
}

/** Who sent a request: a page this worker controls, a navigation started on this site, or a navigation started anywhere else. */
type Sender = "page" | "site-navigation" | "outside-navigation";

/**
 * Only pages on this site are controlled by the worker, so a request that is not a navigation comes from one of them.
 * A navigation can be started by any website, with a link or a form, and its referrer says where it started.
 */
function senderOf(request: Request): Sender {
  if (request.mode !== "navigate") return "page";
  try {
    return new URL(request.referrer).origin === worker.location.origin ? "site-navigation" : "outside-navigation";
  } catch {
    return "outside-navigation";
  }
}

/** Answers one request for an emulator URL from the emulator running in this worker. A navigation from outside this site is refused whatever its method, because some emulator GET routes change state. */
async function answer(request: Request, url: URL): Promise<Response> {
  if (senderOf(request) === "outside-navigation") {
    return new Response("Only the playground can send this request.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const segments = url.pathname.slice(EMULATOR_MOUNT.length + 1).split("/");
  const [name, target] = segments;
  if (name === PING_SEGMENT) return new Response(null, { status: 204, headers: { [BUILD_HEADER]: BUILD } });
  if (name === RESET_SEGMENT && request.method === "POST" && Object.hasOwn(emulators, target ?? "")) {
    return reset(target);
  }
  if (!Object.hasOwn(emulators, name)) return new Response(`Unknown service: ${name}`, { status: 404 });

  const headers = new Headers(request.headers);
  const raw = headers.has(RAW_REDIRECT_HEADER);
  headers.delete(RAW_REDIRECT_HEADER);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const plain = new Request(url, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
  });
  const response = await runtimeFor(name).handle(plain, segments, EMULATOR_MOUNT);
  return raw ? describeRedirect(response) : response;
}

worker.addEventListener("install", () => {
  void worker.skipWaiting();
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener("message", (event) => {
  if (event.data === CLAIM_MESSAGE) void worker.clients.claim();
});

worker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin || !url.pathname.startsWith(`${EMULATOR_MOUNT}/`)) return;
  event.respondWith(answer(event.request, url));
});
