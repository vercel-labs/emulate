# @emulators/aws

S3, SQS, IAM, and STS emulation with AWS SDK-compatible S3 paths and query-style SQS/IAM/STS endpoints. S3 uploads and downloads preserve arbitrary binary payloads, including raw byte lengths and ETags. All responses use AWS-compatible XML.

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

### SQS
All operations via `POST /sqs/` with `Action` parameter:
- `CreateQueue`, `ListQueues`, `GetQueueUrl`, `GetQueueAttributes`
- `SendMessage`, `ReceiveMessage`, `DeleteMessage`
- `PurgeQueue`, `DeleteQueue`

### IAM
All operations via `POST /iam/` with `Action` parameter:
- `CreateUser`, `GetUser`, `ListUsers`, `DeleteUser`
- `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`
- `CreateRole`, `GetRole`, `ListRoles`, `DeleteRole`

### STS
All operations via `POST /sts` or `POST /sts/` with `Action` parameter:
- `GetCallerIdentity`, `AssumeRole`, `AssumeRoleWithWebIdentity`

`AssumeRoleWithWebIdentity` accepts a non-empty token and an IAM role ARN without requiring a seeded role. Requests may be unsigned. `RoleSessionName` is required; `DurationSeconds` defaults to 3600 and accepts 900 through 43200. JWT-shaped tokens supply the response subject, audience, and issuer; opaque tokens get a stable subject digest. Token signatures, expiry, role trust, policies, and role-specific session limits are not enforced. This is response emulation for local tests.

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
