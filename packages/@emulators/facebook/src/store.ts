import { Store, type Collection } from "@emulators/core";
import type { FacebookOAuthApp, FacebookPage, FacebookUser, FacebookVideo } from "./entities.js";

export interface FacebookStore {
  users: Collection<FacebookUser>;
  oauthApps: Collection<FacebookOAuthApp>;
  pages: Collection<FacebookPage>;
  videos: Collection<FacebookVideo>;
}

export function getFacebookStore(store: Store): FacebookStore {
  return {
    users: store.collection<FacebookUser>("facebook.users", ["user_id", "email"]),
    oauthApps: store.collection<FacebookOAuthApp>("facebook.oauth_apps", ["app_id"]),
    pages: store.collection<FacebookPage>("facebook.pages", ["page_id"]),
    videos: store.collection<FacebookVideo>("facebook.videos", ["video_id", "page_id"]),
  };
}
