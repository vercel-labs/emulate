"use client";

import { useState, type ReactNode } from "react";
import { cardClass, labelClass, mutedClass, secondaryButtonClass } from "@/components/playground/ui";
import {
  callbackOrigin,
  clientCredentials,
  oauthProviders,
  redirectUri,
  type OAuthProvider,
} from "@/components/playground/flows/oauth-providers";
import { getEmulator, type Emulator } from "@/lib/playground/runtime";

interface Account {
  label: string;
  action: string;
  fields: [string, string][];
}

interface Profile {
  provider: OAuthProvider;
  accessToken: string;
  name: string;
  email: string;
  login: string;
}

type Flow =
  | { step: "providers" }
  | { step: "account"; provider: OAuthProvider; state: string; accounts: Account[] }
  | { step: "dashboard"; profile: Profile };

const formType = "application/x-www-form-urlencoded";

const providerButtonClass =
  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-neutral-200 px-4 text-sm font-medium text-neutral-900 hover:border-neutral-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-100 dark:hover:border-neutral-700";

const accountButtonClass =
  "flex w-full items-center rounded-md border border-neutral-200 px-4 py-3 text-left text-sm text-neutral-900 hover:border-neutral-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-100 dark:hover:border-neutral-700";

const icons: Record<NonNullable<OAuthProvider["icon"]>, ReactNode> = {
  github: (
    <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  ),
  google: (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  ),
  vercel: (
    <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden="true">
      <path d="M12 1L24 22H0L12 1Z" />
    </svg>
  ),
};

/** Turns a form action or redirect into the path the in-tab emulator expects. */
function toPath(href: string): string {
  const url = new URL(href, callbackOrigin);
  return `${url.pathname}${url.search}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Reads the consent page's account forms. Each form that posts fields is one account. */
function parseAccounts(html: string): Account[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("form"))
    .filter((form) => form.getAttribute("action") && form.querySelector("input[name]"))
    .map((form) => {
      const parts = Array.from(form.querySelectorAll(".user-login, .user-meta, .user-email"))
        .map((element) => element.textContent?.trim() ?? "")
        .filter(Boolean);
      const fallback = form.textContent?.replace(/\s+/g, " ").trim() ?? "";
      return {
        label: parts.join(" · ") || fallback || "Account",
        action: form.getAttribute("action") ?? "",
        fields: Array.from(form.querySelectorAll("input[name]")).map((input) => [
          input.getAttribute("name") ?? "",
          input.getAttribute("value") ?? "",
        ]),
      };
    });
}

/** Reads the claims of an id_token without verifying it. */
function decodeIdToken(idToken: string): Record<string, unknown> {
  const base64 = (idToken.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchProfile(emulator: Emulator, provider: OAuthProvider, code: string): Promise<Profile> {
  const body = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(provider.slug),
    ...clientCredentials(provider.slug),
  };
  const tokenRes = await emulator.fetch(provider.tokenPath, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": provider.tokenForm ? formType : "application/json" },
    body: provider.tokenForm ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  if (!tokenRes.ok) throw new Error(`${provider.name} rejected the authorization code (status ${tokenRes.status}).`);
  const token: Record<string, unknown> = await tokenRes.json();
  const accessToken = text(token.access_token);
  if (!accessToken) throw new Error(`${provider.name} returned no access token.`);

  let claims: Record<string, unknown>;
  if (provider.userinfoPath) {
    const userRes = await emulator.fetch(provider.userinfoPath, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) throw new Error(`${provider.name} refused the profile request (status ${userRes.status}).`);
    claims = await userRes.json();
  } else {
    if (!token.id_token) throw new Error(`${provider.name} returned no id_token.`);
    claims = decodeIdToken(text(token.id_token));
  }

  const email = text(claims[provider.emailField]);
  return {
    provider,
    accessToken,
    name: text(claims[provider.nameField]) || email || "Unknown",
    email,
    login: provider.loginField ? text(claims[provider.loginField]) : "",
  };
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** Runs the OAuth sign-in flow entirely in this tab, against the in-memory emulators. */
export function OAuthSignIn() {
  const [flow, setFlow] = useState<Flow>({ step: "providers" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(task: () => Promise<Flow>) {
    setPending(true);
    setError(null);
    try {
      setFlow(await task());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  }

  function startSignIn(provider: OAuthProvider) {
    void run(async () => {
      const emulator = await getEmulator(provider.slug);
      const state = crypto.randomUUID();
      const params = new URLSearchParams({
        ...clientCredentials(provider.slug),
        redirect_uri: redirectUri(provider.slug),
        scope: provider.scope,
        state,
        response_type: "code",
        ...provider.extraParams,
      });
      const res = await emulator.fetch(`${provider.authorizePath}?${params}`);
      if (!res.ok) throw new Error(`${provider.name} sign-in page failed with status ${res.status}.`);
      const accounts = parseAccounts(await res.text());
      if (accounts.length === 0) throw new Error(`${provider.name} showed no accounts to pick from.`);
      return { step: "account", provider, state, accounts };
    });
  }

  function chooseAccount(provider: OAuthProvider, state: string, account: Account) {
    void run(async () => {
      const emulator = await getEmulator(provider.slug);
      const res = await emulator.fetch(toPath(account.action), {
        method: "POST",
        headers: { "Content-Type": formType },
        body: new URLSearchParams(account.fields),
      });
      const location = res.headers.get("location");
      if (!location) throw new Error("Picking the account did not redirect back to the app.");
      const callback = new URL(location, callbackOrigin);
      const providerError = callback.searchParams.get("error");
      if (providerError) throw new Error(`${provider.name} returned an error: ${providerError}.`);
      if (callback.searchParams.get("state") !== state) {
        throw new Error("The state that came back does not match the one sent. Sign-in was stopped.");
      }
      const code = callback.searchParams.get("code");
      if (!code) throw new Error("The redirect did not include an authorization code.");
      return { step: "dashboard", profile: await fetchProfile(emulator, provider, code) };
    });
  }

  function goToProviders() {
    setError(null);
    setFlow({ step: "providers" });
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-200 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:text-red-400"
        >
          {error}
        </p>
      )}
      {(() => {
        switch (flow.step) {
          case "providers":
            return (
              <section data-flow-step="providers" aria-live="polite" className={`${cardClass} flex flex-col gap-3`}>
                <h2 className={labelClass}>Choose a provider</h2>
                {oauthProviders.map((provider) => (
                  <button
                    key={provider.slug}
                    type="button"
                    data-provider={provider.slug}
                    disabled={pending}
                    onClick={() => startSignIn(provider)}
                    className={providerButtonClass}
                  >
                    {provider.icon && icons[provider.icon]}
                    Continue with {provider.name}
                  </button>
                ))}
              </section>
            );
          case "account":
            return (
              <section data-flow-step="account" aria-live="polite" className={`${cardClass} flex flex-col gap-3`}>
                <h2 className={labelClass}>Pick an account</h2>
                <p className={mutedClass}>{flow.provider.name} lists these accounts for this app.</p>
                {flow.accounts.map((account, index) => (
                  <button
                    key={index}
                    type="button"
                    data-account={index}
                    disabled={pending}
                    onClick={() => chooseAccount(flow.provider, flow.state, account)}
                    className={accountButtonClass}
                  >
                    {account.label}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={pending}
                  onClick={goToProviders}
                  className={`${secondaryButtonClass} self-start`}
                >
                  Back
                </button>
              </section>
            );
          case "dashboard": {
            const { profile } = flow;
            const others = oauthProviders.filter((provider) => provider.slug !== profile.provider.slug);
            return (
              <section data-flow-step="dashboard" aria-live="polite" className={`${cardClass} flex flex-col gap-6`}>
                <div data-flow-result className="flex items-center gap-4">
                  <span
                    aria-hidden="true"
                    className="flex size-12 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
                  >
                    {initialsOf(profile.name)}
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">
                      Signed in with {profile.provider.name}
                    </p>
                    <p className="truncate text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                      {profile.name}
                    </p>
                    {profile.login && <p className={mutedClass}>@{profile.login}</p>}
                    {profile.email && profile.email !== profile.name && <p className={mutedClass}>{profile.email}</p>}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <p className={labelClass}>Access token</p>
                  <code className="block break-all rounded-md bg-neutral-100 p-3 font-mono text-xs text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
                    {profile.accessToken}
                  </code>
                </div>
                <div className="flex flex-wrap gap-2">
                  {others.map((provider) => (
                    <button
                      key={provider.slug}
                      type="button"
                      data-provider={provider.slug}
                      disabled={pending}
                      onClick={() => startSignIn(provider)}
                      className={secondaryButtonClass}
                    >
                      Switch to {provider.name}
                    </button>
                  ))}
                  <button type="button" disabled={pending} onClick={goToProviders} className={secondaryButtonClass}>
                    Sign out
                  </button>
                </div>
              </section>
            );
          }
        }
      })()}
    </div>
  );
}
