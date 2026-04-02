import type { Entity } from "@emulators/core";

export interface HeyGenUser extends Entity {
  user_id: string;
  email: string;
  name: string;
  picture: string | null;
}

export interface HeyGenOAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}
