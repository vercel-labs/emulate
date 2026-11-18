"use client";

import { useState, type FormEvent } from "react";
import {
  cardClass,
  fieldClass,
  hintClass,
  labelClass,
  mutedClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/playground/ui";
import { getEmulator } from "@/lib/playground/runtime";

type Step = "email" | "verify" | "dashboard";

interface PendingCode {
  email: string;
  code: string;
  expiresAt: number;
}

interface InboxEmail {
  id: string;
  to: string[];
  subject: string;
  text: string | null;
}

const auth = { Authorization: "Bearer re_emulated_key" };
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const codeLifetimeMs = 10 * 60 * 1000;

/** Makes a random six-digit code from the browser's secure random source. */
function generateCode(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return String(random[0] % 1_000_000).padStart(6, "0");
}

/** Reads the emulator's error message, falling back to the HTTP status. */
async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? body.message : `Resend returned status ${response.status}.`;
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** Emails a one-time code through the Resend emulator and signs the visitor in with it. */
export function MagicLinkFlow() {
  const [step, setStep] = useState<Step>("email");
  const [emailInput, setEmailInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [pending, setPending] = useState<PendingCode | null>(null);
  const [signedInAs, setSignedInAs] = useState("");
  const [inbox, setInbox] = useState<InboxEmail[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadInbox() {
    setError("");
    setBusy(true);
    try {
      const emulator = await getEmulator("resend");
      const response = await emulator.fetch("/emails", { headers: auth });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = (await response.json()) as { data: InboxEmail[] };
      setInbox([...body.data].reverse());
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = emailInput.trim().toLowerCase();
    if (!email) return setError("Email is required");
    if (!emailPattern.test(email)) return setError("Enter a valid email address");

    const code = generateCode();
    setError("");
    setBusy(true);
    try {
      const emulator = await getEmulator("resend");
      const response = await emulator.fetch("/emails", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "auth@example.com",
          to: email,
          subject: "Your sign-in code",
          text: `Use the code below to complete your sign-in. It expires in 10 minutes.\n\n${code}\n\nIf you did not request this code, you can safely ignore this email.`,
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setPending({ email, code, expiresAt: Date.now() + codeLifetimeMs });
      setCodeInput("");
      setStep("verify");
      setNotice(`Code sent to ${email}.`);
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
      return;
    }
    await loadInbox();
  }

  function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) return;
    const entered = codeInput.trim();
    if (!entered) return setError("Code is required");
    if (Date.now() > pending.expiresAt)
      return setError("This code has expired. Use a different email to get a new one.");
    if (entered !== pending.code) return setError("Invalid code. Please try again.");

    setError("");
    setSignedInAs(pending.email);
    setPending(null);
    setCodeInput("");
    setStep("dashboard");
    setNotice(`Signed in as ${pending.email}.`);
  }

  function useDifferentEmail() {
    setError("");
    setPending(null);
    setCodeInput("");
    setStep("email");
    setNotice("");
  }

  function signOut() {
    setError("");
    setSignedInAs("");
    setEmailInput("");
    setStep("email");
    setNotice("Signed out.");
  }

  return (
    <div data-flow-step={step} className="flex flex-col gap-6">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:text-red-400"
        >
          {error}
        </p>
      )}
      <p aria-live="polite" className={hintClass}>
        {notice}
      </p>

      {step === "email" && (
        <form noValidate onSubmit={sendCode} className={`${cardClass} flex flex-col gap-4`}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="magic-email" className={labelClass}>
              Email address
            </label>
            <input
              id="magic-email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={emailInput}
              onChange={(event) => setEmailInput(event.target.value)}
              className={fieldClass}
            />
          </div>
          <button type="submit" disabled={busy} className={`${primaryButtonClass} self-start`}>
            Send sign-in code
          </button>
        </form>
      )}

      {step === "verify" && pending && (
        <div className="grid gap-6 md:grid-cols-2">
          <form noValidate onSubmit={verifyCode} className={`${cardClass} flex flex-col gap-4`}>
            <p className={mutedClass}>
              We sent a six-digit code to{" "}
              <span className="font-medium text-neutral-900 dark:text-neutral-100">{pending.email}</span>. Read it in
              the inbox and enter it here.
            </p>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="magic-code" className={labelClass}>
                Six-digit code
              </label>
              <input
                id="magic-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={codeInput}
                onChange={(event) => setCodeInput(event.target.value)}
                className={`${fieldClass} font-mono tracking-[0.3em]`}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={primaryButtonClass}>
                Verify
              </button>
              <button type="button" onClick={useDifferentEmail} className={secondaryButtonClass}>
                Use a different email
              </button>
            </div>
          </form>

          <section data-inbox aria-labelledby="magic-inbox-title" className={`${cardClass} flex flex-col gap-4`}>
            <div className="flex items-center justify-between gap-2">
              <h2 id="magic-inbox-title" className={labelClass}>
                Inbox
              </h2>
              <button type="button" disabled={busy} onClick={() => void loadInbox()} className={secondaryButtonClass}>
                Refresh
              </button>
            </div>
            {inbox.length === 0 && <p className={mutedClass}>No emails yet.</p>}
            <ul aria-label="Emails" className="flex flex-col gap-3">
              {inbox.map((email) => (
                <li
                  key={email.id}
                  data-email={email.id}
                  className="flex flex-col gap-1 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
                >
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{email.subject}</p>
                  <p className={hintClass}>To {email.to.join(", ")}</p>
                  <p className="whitespace-pre-wrap font-mono text-xs text-neutral-700 dark:text-neutral-300">
                    {email.text}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {step === "dashboard" && (
        <div className={`${cardClass} flex flex-col items-start gap-4`}>
          <p data-flow-result className="text-sm text-neutral-700 dark:text-neutral-300">
            Signed in as <span className="font-medium text-neutral-900 dark:text-neutral-100">{signedInAs}</span>
          </p>
          <button type="button" onClick={signOut} className={secondaryButtonClass}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
