import {
  BUILD_HEADER,
  CLAIM_MESSAGE,
  EMULATOR_MOUNT,
  PING_SEGMENT,
  RAW_REDIRECT_HEADER,
  RESET_SEGMENT,
} from "./sw/protocol";

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
const START_TIMEOUT_MS = 15000;
const BUILD = process.env.NEXT_PUBLIC_PLAYGROUND_BUILD ?? "";

/** True when the worker that answers emulator URLs for this page was built with it. False while no worker, or an older one, answers. */
async function workerAnswers(): Promise<boolean> {
  try {
    const response = await fetch(`${EMULATOR_MOUNT}/${PING_SEGMENT}`, { cache: "no-store" });
    return response.headers.get(BUILD_HEADER) === BUILD;
  } catch {
    return false;
  }
}

/**
 * Registers the playground service worker, which runs every emulator, and waits until this build's worker answers
 * this page. Until it does, the page asks an active worker to take control and asks the browser to fetch the newest
 * one, which covers a first visit, a hard reload, and a worker left over from an earlier build.
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
    const deadline = Date.now() + START_TIMEOUT_MS;
    let askedForUpdate = false;
    while (!(await workerAnswers())) {
      if (Date.now() > deadline) throw new Error(START_FAILED);
      registration.active?.postMessage(CLAIM_MESSAGE);
      if (!askedForUpdate) {
        askedForUpdate = true;
        void registration.update().catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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
