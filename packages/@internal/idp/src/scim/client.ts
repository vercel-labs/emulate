import { debug } from "@internal/core";
import type { ScimUser, ScimGroup, ScimPatchOp } from "./types.js";
import { SCIM_PATCH_OP_SCHEMA } from "./constants.js";

export interface ScimClientConfig {
  target_url: string;
  bearer_token: string;
  name?: string;
}

export class ScimClient {
  constructor(private config: ScimClientConfig) {}

  private async request(method: string, path: string, body?: unknown): Promise<Response | null> {
    const url = `${this.config.target_url}${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Authorization": `Bearer ${this.config.bearer_token}`,
          "Content-Type": "application/scim+json",
          "Accept": "application/scim+json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      debug("idp.scim", `[SCIM Client] ${method} ${url} -> ${res.status}`);
      return res;
    } catch (err) {
      debug("idp.scim", `[SCIM Client] ${method} ${url} FAILED: ${err}`);
      return null;
    }
  }

  async createUser(user: ScimUser): Promise<void> {
    await this.request("POST", "/Users", user);
  }

  async updateUser(id: string, user: ScimUser): Promise<void> {
    await this.request("PUT", `/Users/${id}`, user);
  }

  async patchUser(id: string, ops: ScimPatchOp[]): Promise<void> {
    await this.request("PATCH", `/Users/${id}`, {
      schemas: [SCIM_PATCH_OP_SCHEMA],
      Operations: ops,
    });
  }

  async deleteUser(id: string): Promise<void> {
    await this.request("DELETE", `/Users/${id}`);
  }

  async createGroup(group: ScimGroup): Promise<void> {
    await this.request("POST", "/Groups", group);
  }

  async updateGroup(id: string, group: ScimGroup): Promise<void> {
    await this.request("PUT", `/Groups/${id}`, group);
  }

  async patchGroup(id: string, ops: ScimPatchOp[]): Promise<void> {
    await this.request("PATCH", `/Groups/${id}`, {
      schemas: [SCIM_PATCH_OP_SCHEMA],
      Operations: ops,
    });
  }

  async deleteGroup(id: string): Promise<void> {
    await this.request("DELETE", `/Groups/${id}`);
  }
}

export function getScimClients(store: { getData<T>(key: string): T | undefined }): ScimClient[] {
  const configs = store.getData<ScimClientConfig[]>("idp.scim.clients");
  if (!configs || configs.length === 0) return [];
  return configs.map(c => new ScimClient(c));
}
