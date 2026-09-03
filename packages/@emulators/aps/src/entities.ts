import type { Entity } from "@emulators/core";

export type ApsClientType = "confidential" | "public";

export interface ApsClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  type: ApsClientType;
  redirect_uris: string[];
}

export interface ApsUser extends Entity {
  user_id: string;
  email: string;
  name: string;
  first_name: string;
  last_name: string;
  picture: string | null;
}
