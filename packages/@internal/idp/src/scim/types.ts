export interface ScimMeta {
  resourceType: string;
  created: string;
  lastModified: string;
  location: string;
}

export interface ScimName {
  formatted?: string;
  familyName?: string;
  givenName?: string;
}

export interface ScimMultiValue {
  value: string;
  type?: string;
  primary?: boolean;
  display?: string;
  $ref?: string;
}

export interface ScimEnterpriseUser {
  department?: string;
  employeeNumber?: string;
  manager?: {
    value?: string;
    displayName?: string;
  };
}

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: ScimName;
  displayName?: string;
  emails?: ScimMultiValue[];
  phoneNumbers?: ScimMultiValue[];
  photos?: ScimMultiValue[];
  active?: boolean;
  locale?: string;
  groups?: ScimMultiValue[];
  meta?: ScimMeta;
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"?: ScimEnterpriseUser;
}

export interface ScimGroup {
  schemas: string[];
  id: string;
  displayName: string;
  members?: ScimMultiValue[];
  meta?: ScimMeta;
}

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export interface ScimErrorResponse {
  schemas: string[];
  status: string;
  scimType?: string;
  detail: string;
}

export interface ScimPatchOp {
  op: "add" | "replace" | "remove";
  path?: string;
  value?: unknown;
}

export interface ScimPatchRequest {
  schemas: string[];
  Operations: ScimPatchOp[];
}
