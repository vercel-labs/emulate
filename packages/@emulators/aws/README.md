# @emulators/aws

S3, SQS, SNS, IAM, and STS emulation with AWS SDK-compatible S3 paths and query-style SQS/SNS/IAM/STS endpoints. Query responses use AWS-compatible XML.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/aws
```

## Endpoints

### S3

S3 routes use root paths matching the real AWS S3 wire format, so the official AWS SDK works out of the box with `forcePathStyle: true`. Legacy `/s3/` prefixed paths are also supported for backward compatibility.

- `GET /` — list all buckets
- `PUT /:bucket` — create bucket
- `DELETE /:bucket` — delete bucket
- `HEAD /:bucket` — check existence
- `GET /:bucket` — list objects (prefix, delimiter, max-keys, continuation-token, start-after)
- `POST /:bucket` — presigned POST upload (browser-style multipart form with policy validation)
- `PUT /:bucket/:key` — put object (supports copy via `x-amz-copy-source`)
- `GET /:bucket/:key` — get object
- `HEAD /:bucket/:key` — head object
- `DELETE /:bucket/:key` — delete object
- `PUT /:bucket?notification` — set bucket notification XML with `TopicConfiguration`
- `GET /:bucket?notification` — get bucket notification XML

### SQS
All operations via `POST /sqs/` with `Action` parameter:
- `CreateQueue`, `ListQueues`, `GetQueueUrl`, `GetQueueAttributes`
- `SendMessage`, `ReceiveMessage`, `DeleteMessage`
- `PurgeQueue`, `DeleteQueue`

### SNS
All operations via `POST /sns/` with `Action` parameter:
- `CreateTopic`, `ListTopics`, `DeleteTopic`
- `Subscribe`, `Unsubscribe`
- `Publish`
- `GetTopicAttributes`, `SetTopicAttributes`
- `GetSubscriptionAttributes`, `SetSubscriptionAttributes`

SNS supports `sqs`, `http`, and `https` subscriptions. SQS subscriptions receive either the SNS notification envelope JSON or the raw message when `RawMessageDelivery` is `true`. HTTP and HTTPS subscriptions receive an SNS-shaped JSON notification body with fake signature fields; the emulator does not implement AWS-real signature verification fidelity.

For HTTP delivery failures, a subscription `RedrivePolicy` with `deadLetterTargetArn` sends the failed notification envelope immediately to the target SQS queue. The emulator does not schedule AWS-style retry backoff.

S3 bucket notifications can fan out `s3:ObjectCreated:Put` events to SNS topic configurations, including simple prefix and suffix filters.

### IAM
All operations via `POST /iam/` with `Action` parameter:
- `CreateUser`, `GetUser`, `ListUsers`, `DeleteUser`
- `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`
- `CreateRole`, `GetRole`, `ListRoles`, `DeleteRole`

### STS
All operations via `POST /sts/` with `Action` parameter:
- `GetCallerIdentity`, `AssumeRole`

## Auth

Bearer tokens or IAM access key credentials. Default key pair always seeded: `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`.

## Seed Configuration

```yaml
aws:
  region: us-east-1
  s3:
    buckets:
      - name: my-app-bucket
      - name: my-app-uploads
  sqs:
    queues:
      - name: my-app-events
      - name: my-app-dlq
  sns:
    topics:
      - name: my-app-object-created
  iam:
    users:
      - user_name: developer
        create_access_key: true
    roles:
      - role_name: lambda-execution-role
        description: Role for Lambda function execution
```

## Links

- [Full documentation](https://emulate.dev/aws)
- [GitHub](https://github.com/vercel-labs/emulate)
