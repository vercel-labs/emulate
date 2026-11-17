import { CLAIM_MESSAGE, EMULATOR_MOUNT, RAW_REDIRECT_HEADER, RESET_SEGMENT } from "./sw/protocol";

export interface EmulatorRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface EmulatorResponse {
  status: number;
  statusText: string;
  body: string;
  location: string | null;
}

export interface Emulator {
  /** The emulator's base URL on this origin. The browser can open any of its pages from here. */
  baseUrl: string;
  /** Sends a request and reports a redirect's status and Location instead of following it. */
  send(request: EmulatorRequest): Promise<EmulatorResponse>;
  /** Sends any request to the emulator and returns the raw response, for callers that need headers or bytes. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

const running = new Map<string, Promise<Emulator>>();
let workerReady: Promise<void> | undefined;

const START_FAILED = "The playground could not start its emulators. Reload the page.";

/** Resolves once a service worker is active, and rejects if the browser discards it first. */
function activated(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (worker.state === "activated") resolve();
      else if (worker.state === "redundant") reject(new Error(START_FAILED));
    };
    worker.addEventListener("statechange", check);
    check();
  });
}

/** Resolves once the given service worker controls this page, asking it to take control if it has not. */
function controls(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(START_FAILED)), 5000);
    const check = () => {
      if (navigator.serviceWorker.controller !== worker) return;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", check);
      resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", check);
    check();
    worker.postMessage(CLAIM_MESSAGE);
  });
}

/**
 * Registers the playground service worker, which runs every emulator, and waits until its newest version controls
 * this page. Throws when the browser has no service workers or the worker cannot take control.
 */
function workerControlsPage(): Promise<void> {
  workerReady ??= (async () => {
    if (!("serviceWorker" in navigator)) {
      throw new Error("The playground needs service workers, and this browser has them turned off.");
    }
    const registration = await navigator.serviceWorker.register(new URL("./sw/worker.ts", import.meta.url), {
      scope: "/playground/",
      updateViaCache: "none",
    });
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (!worker) throw new Error(START_FAILED);
    await activated(worker);
    await controls(worker);
  })();
  workerReady.catch(() => {
    workerReady = undefined;
  });
  return workerReady;
}

async function create(name: string): Promise<Emulator> {
  await workerControlsPage();
  const mount = `${EMULATOR_MOUNT}/${name}`;
  return {
    baseUrl: `${window.location.origin}${mount}`,
    fetch: (path, init) => fetch(mount + path, init),
    async send({ method, path, headers, body }) {
      const response = await fetch(mount + path, {
        method,
        headers: { ...headers, [RAW_REDIRECT_HEADER]: "1" },
        body,
      });
      const redirect = response.headers.get("X-Emulate-Status");
      return {
        status: redirect ? Number(redirect) : response.status,
        statusText: redirect ? (response.headers.get("X-Emulate-Status-Text") ?? "") : response.statusText,
        body: await response.text(),
        location: redirect ? response.headers.get("X-Emulate-Location") : null,
      };
    },
  };
}

/** Returns the emulator for a service once the service worker that runs it controls this page. */
export function getEmulator(name: string): Promise<Emulator> {
  let emulator = running.get(name);
  if (!emulator) {
    emulator = create(name);
    emulator.catch(() => running.delete(name));
    running.set(name, emulator);
  }
  return emulator;
}

/** Resets a service's emulator to fresh seed data. Requests made after this call wait for the reset. */
export function resetEmulator(name: string): void {
  const reset = getEmulator(name).then(async (emulator) => {
    await fetch(`${EMULATOR_MOUNT}/${RESET_SEGMENT}/${name}`, { method: "POST" });
    return emulator;
  });
  reset.catch(() => running.delete(name));
  running.set(name, reset);
}
