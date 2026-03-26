import type { Entity } from "@emulators/core";

export interface S3Bucket extends Entity {
  bucket_name: string;
  region: string;
  creation_date: string;
  acl: "private" | "public-read" | "public-read-write";
  versioning_enabled: boolean;
}

export interface S3Object extends Entity {
  bucket_name: string;
  key: string;
  body: string;
  content_type: string;
  content_length: number;
  etag: string;
  last_modified: string;
  metadata: Record<string, string>;
  version_id?: string;
}

export interface SqsQueue extends Entity {
  queue_name: string;
  queue_url: string;
  arn: string;
  visibility_timeout: number;
  delay_seconds: number;
  max_message_size: number;
  message_retention_period: number;
  receive_message_wait_time: number;
  fifo: boolean;
}

export interface SqsMessage extends Entity {
  queue_name: string;
  message_id: string;
  receipt_handle: string;
  body: string;
  md5_of_body: string;
  attributes: Record<string, string>;
  message_attributes: Record<string, { DataType: string; StringValue?: string; BinaryValue?: string }>;
  visible_after: number;
  sent_timestamp: number;
  receive_count: number;
}

export interface IamUser extends Entity {
  user_name: string;
  user_id: string;
  arn: string;
  path: string;
  access_keys: Array<{ access_key_id: string; secret_access_key: string; status: "Active" | "Inactive" }>;
}

export interface IamRole extends Entity {
  role_name: string;
  role_id: string;
  arn: string;
  path: string;
  assume_role_policy_document: string;
  description: string;
}
