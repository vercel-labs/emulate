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

const SERVICE_SID = "VA00000000000000000000000000000000";
const VERIFY = `/verify/v2/Services/${SERVICE_SID}`;
const AUTH = { Authorization: "Basic QUMwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDp0d2lsaW9fdGVzdF9hdXRoX3Rva2Vu" };
const FORM = { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" };
const E164 = /^\+[1-9]\d{6,14}$/;
const SIX_DIGITS = /^\d{6}$/;

type Step = "phone" | "verify" | "verified";

/** Sends a request to the in-tab Twilio emulator and returns its JSON body, throwing with Twilio's message on a non-2xx response. */
async function emulatorJson<T>(path: string, init?: RequestInit): Promise<T> {
  const twilio = await getEmulator("twilio");
  const response = await twilio.fetch(path, init);
  const body = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!response.ok) throw new Error(body?.message ?? `The emulator returned ${response.status}.`);
  return body as T;
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** Guided SMS verification: starts a Twilio Verify check, reads the code from the emulator, and checks it. */
export function SmsVerificationFlow() {
  const [step, setStep] = useState<Step>("phone");
  const [phoneInput, setPhoneInput] = useState("+15555550123");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [readCode, setReadCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The emulator could not complete the request.");
    } finally {
      setBusy(false);
    }
  }

  function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const number = phoneInput.trim();
    if (!number) {
      setError("Phone number is required");
      return;
    }
    if (!E164.test(number)) {
      setError("Enter the number with a plus sign and country code, such as +15555550123.");
      return;
    }
    void run(async () => {
      await emulatorJson(`${VERIFY}/Verifications`, {
        method: "POST",
        headers: FORM,
        body: formBody({ To: number, Channel: "sms" }),
      });
      setPhone(number);
      setCode("");
      setReadCode(null);
      setStep("verify");
    });
  }

  function checkCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const digits = code.trim();
    if (!SIX_DIGITS.test(digits)) {
      setError("Enter the six-digit code.");
      return;
    }
    void run(async () => {
      const check = await emulatorJson<{ status?: string }>(`${VERIFY}/VerificationCheck`, {
        method: "POST",
        headers: FORM,
        body: formBody({ To: phone, Code: digits }),
      });
      if (check.status === "approved") {
        setCode("");
        setStep("verified");
        return;
      }
      setError(
        check.status === "max_attempts_reached"
          ? "Too many wrong codes. Use a different number to get a new code."
          : "Invalid code. Please try again.",
      );
    });
  }

  function readVerificationCode() {
    void run(async () => {
      const lookup = await emulatorJson<{ code: string }>(
        `/_twilio/simulate/verification-code?To=${encodeURIComponent(phone)}&ServiceSid=${SERVICE_SID}`,
        { headers: AUTH },
      );
      setReadCode(lookup.code);
    });
  }

  function useDifferentNumber() {
    setStep("phone");
    setCode("");
    setReadCode(null);
    setError(null);
  }

  function signOut() {
    setStep("phone");
    setPhone("");
    setCode("");
    setReadCode(null);
    setError(null);
  }

  return (
    <div data-flow-step={step} aria-live="polite" className={`${cardClass} flex flex-col gap-5`}>
      {step === "phone" && (
        <form onSubmit={sendCode} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Enter your phone number</h2>
            <p className={mutedClass}>We will start a Twilio Verify check that sends a code by SMS.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sms-phone" className={labelClass}>
              Phone number
            </label>
            <input
              id="sms-phone"
              type="tel"
              autoComplete="tel"
              value={phoneInput}
              onChange={(event) => setPhoneInput(event.target.value)}
              disabled={busy}
              className={fieldClass}
            />
          </div>
          <div>
            <button type="submit" disabled={busy} className={primaryButtonClass}>
              Send verification code
            </button>
          </div>
        </form>
      )}

      {step === "verify" && (
        <form onSubmit={checkCode} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Enter the code</h2>
            <p className={mutedClass}>
              We sent a six-digit code to <strong className="text-neutral-900 dark:text-neutral-100">{phone}</strong>.
            </p>
            <p className={hintClass}>
              No SMS is sent. The seeded Verify service accepts a fixed code, which you can read from the emulator
              below.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sms-code" className={labelClass}>
              Verification code
            </label>
            <input
              id="sms-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={busy}
              className={`${fieldClass} font-mono tracking-[0.3em]`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={busy} className={primaryButtonClass}>
              Verify
            </button>
            <button type="button" onClick={readVerificationCode} disabled={busy} className={secondaryButtonClass}>
              Read the code from the emulator
            </button>
            <button type="button" onClick={useDifferentNumber} disabled={busy} className={secondaryButtonClass}>
              Use a different number
            </button>
          </div>
          {readCode !== null && (
            <p className="text-sm text-neutral-700 dark:text-neutral-300">
              Code from the emulator:{" "}
              <span data-code className="font-mono font-medium tracking-[0.2em] text-neutral-900 dark:text-neutral-100">
                {readCode}
              </span>
            </p>
          )}
        </form>
      )}

      {step === "verified" && (
        <div className="flex flex-col gap-4">
          <div data-flow-result className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Phone verified</h2>
            <p className={mutedClass}>
              Verified as <strong className="text-neutral-900 dark:text-neutral-100">{phone}</strong>
            </p>
          </div>
          <div>
            <button type="button" onClick={signOut} disabled={busy} className={secondaryButtonClass}>
              Sign out
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
