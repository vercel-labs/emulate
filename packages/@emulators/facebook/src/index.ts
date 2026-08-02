import type { Hono } from "hono";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { facebookRoutes } from "./routes/facebook.js";
import { getFacebookStore } from "./store.js";

export { getFacebookStore, type FacebookStore } from "./store.js";
export * from "./entities.js";

export interface FacebookSeedConfig {
  users?: Array<{ id?: string; name: string; email?: string }>;
  oauth_apps?: Array<{ app_id: string; app_secret: string; name: string; redirect_uris: string[] }>;
  pages?: Array<{ id?: string; name: string; category?: string; owner_user_ids?: string[] }>;
  page_videos?: Array<{
    id?: string;
    page_id: string;
    title?: string;
    description?: string;
    permalink_url?: string;
    created_time?: string;
    views?: number;
    likes?: number;
    comments?: number;
  }>;
}

function seedDefaults(store: Store): void {
  const fs = getFacebookStore(store);
  fs.users.insert({ user_id: "100000000000001", name: "Test User", email: "testuser@example.com" });
  fs.oauthApps.insert({
    app_id: "123456789012345",
    app_secret: "example_app_secret",
    name: "Emulate Facebook App",
    redirect_uris: ["http://localhost:3000/api/auth/callback/facebook"],
  });
  fs.pages.insert({
    page_id: "200000000000001",
    name: "Emulate Page",
    category: "Digital creator",
    owner_user_ids: ["100000000000001"],
  });
  fs.videos.insert({
    video_id: "300000000000001",
    page_id: "200000000000001",
    title: "Welcome video",
    description: "A seeded Facebook Page video",
    permalink_url: "https://www.facebook.com/200000000000001/videos/300000000000001",
    created_time: "2025-01-01T00:00:00+0000",
    views: 1200,
    likes: 80,
    comments: 12,
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: FacebookSeedConfig): void {
  const fs = getFacebookStore(store);
  for (const [index, user] of (config.users ?? []).entries()) {
    const userId = user.id ?? String(100000000000002 + index);
    if (!fs.users.findOneBy("user_id", userId)) {
      fs.users.insert({ user_id: userId, name: user.name, email: user.email ?? "user" + index + "@example.com" });
    }
  }
  for (const oauthApp of config.oauth_apps ?? []) {
    if (!fs.oauthApps.findOneBy("app_id", oauthApp.app_id)) fs.oauthApps.insert(oauthApp);
  }
  for (const [index, page] of (config.pages ?? []).entries()) {
    const pageId = page.id ?? String(200000000000002 + index);
    const ownerUserIds =
      page.owner_user_ids ??
      fs.users
        .all()
        .slice(0, 1)
        .map((user) => user.user_id);
    const missingOwner = ownerUserIds.find((userId) => !fs.users.findOneBy("user_id", userId));
    if (missingOwner) {
      throw new Error('Facebook Page "' + pageId + '" references unknown owner user ID "' + missingOwner + '".');
    }
    if (!fs.pages.findOneBy("page_id", pageId)) {
      fs.pages.insert({
        page_id: pageId,
        name: page.name,
        category: page.category ?? "Digital creator",
        owner_user_ids: ownerUserIds,
      });
    }
  }
  for (const [index, video] of (config.page_videos ?? []).entries()) {
    const videoId = video.id ?? String(300000000000002 + index);
    if (!fs.pages.findOneBy("page_id", video.page_id)) {
      throw new Error('Facebook Page video "' + videoId + '" references unknown Page ID "' + video.page_id + '".');
    }
    if (!fs.videos.findOneBy("video_id", videoId)) {
      fs.videos.insert({
        video_id: videoId,
        page_id: video.page_id,
        title: video.title ?? "Untitled video",
        description: video.description ?? "",
        permalink_url: video.permalink_url ?? "https://www.facebook.com/" + video.page_id + "/videos/" + videoId,
        created_time: video.created_time ?? "2025-01-01T00:00:00+0000",
        views: video.views ?? 0,
        likes: video.likes ?? 0,
        comments: video.comments ?? 0,
      });
    }
  }
}

export const facebookPlugin: ServicePlugin = {
  name: "facebook",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const context: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    facebookRoutes(context);
  },
  seed(store: Store): void {
    seedDefaults(store);
  },
};

export default facebookPlugin;
