import { Store, type Collection } from "@emulators/core";
import type {
  S3Bucket,
  S3BucketNotification,
  S3Object,
  SqsQueue,
  SqsMessage,
  SnsTopic,
  SnsSubscription,
  IamUser,
  IamRole,
} from "./entities.js";

export interface AwsStore {
  s3Buckets: Collection<S3Bucket>;
  s3BucketNotifications: Collection<S3BucketNotification>;
  s3Objects: Collection<S3Object>;
  sqsQueues: Collection<SqsQueue>;
  sqsMessages: Collection<SqsMessage>;
  snsTopics: Collection<SnsTopic>;
  snsSubscriptions: Collection<SnsSubscription>;
  iamUsers: Collection<IamUser>;
  iamRoles: Collection<IamRole>;
}

export function getAwsStore(store: Store): AwsStore {
  return {
    s3Buckets: store.collection<S3Bucket>("aws.s3_buckets", ["bucket_name"]),
    s3BucketNotifications: store.collection<S3BucketNotification>("aws.s3_bucket_notifications", ["bucket_name"]),
    s3Objects: store.collection<S3Object>("aws.s3_objects", ["key", "bucket_name"]),
    sqsQueues: store.collection<SqsQueue>("aws.sqs_queues", ["queue_name", "queue_url"]),
    sqsMessages: store.collection<SqsMessage>("aws.sqs_messages", ["message_id", "queue_name"]),
    snsTopics: store.collection<SnsTopic>("aws.sns_topics", ["topic_name", "arn"]),
    snsSubscriptions: store.collection<SnsSubscription>("aws.sns_subscriptions", [
      "subscription_arn",
      "topic_arn",
      "endpoint",
    ]),
    iamUsers: store.collection<IamUser>("aws.iam_users", ["user_name", "user_id"]),
    iamRoles: store.collection<IamRole>("aws.iam_roles", ["role_name", "role_id"]),
  };
}
