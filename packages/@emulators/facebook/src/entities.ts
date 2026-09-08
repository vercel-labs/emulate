import type { Entity } from "@emulators/core";

export interface FacebookUser extends Entity {
  user_id: string;
  name: string;
  email: string;
}
export interface FacebookOAuthApp extends Entity {
  app_id: string;
  app_secret: string;
  name: string;
  redirect_uris: string[];
}
export interface FacebookPage extends Entity {
  page_id: string;
  name: string;
  category: string;
  owner_user_ids: string[];
}
export interface FacebookVideo extends Entity {
  video_id: string;
  page_id: string;
  title: string;
  description: string;
  permalink_url: string;
  created_time: string;
  views: number;
  likes: number;
  comments: number;
}
