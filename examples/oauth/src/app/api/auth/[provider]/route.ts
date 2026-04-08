import { redirect } from "next/navigation";
import { providers, getCallbackUrl } from "@/lib/providers";

export async function GET(_request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: slug } = await params;
  const provider = providers[slug];
  if (!provider) {
    return new Response("Unknown provider", { status: 404 });
  }

  const state = crypto.randomUUID();
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", getCallbackUrl(slug));
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");

  redirect(url.toString());
}
