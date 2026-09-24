# @emulators/aws

S3, SQS, IAM, STS, and KMS emulation with AWS SDK-compatible S3 paths and query-style SQS/IAM/STS endpoints. S3 uploads and downloads preserve arbitrary binary payloads, including raw byte lengths and ETags. Query responses use AWS-compatible XML; KMS uses AWS JSON 1.1.

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
All operations via `POST /sts/` with `Action` parameter:
- `GetCallerIdentity`, `AssumeRole`

### KMS

KMS uses AWS JSON 1.1: send `POST /kms` or `POST /kms/` with an `X-Amz-Target: TrentService.Encrypt` or `TrentService.Decrypt` header and a JSON body.

- `Encrypt` accepts `KeyId`, base64 `Plaintext` (1 to 4096 bytes), and optional `EncryptionContext`.
- `Decrypt` accepts `CiphertextBlob` and the same encryption context. An optional `KeyId` must exactly match the identifier used for encryption.
- Only `SYMMETRIC_DEFAULT` is supported. Aliases, raw IDs, and ARNs up to 255 UTF-8 bytes are preserved as supplied; alias resolution is not modeled.

Ciphertext is self-contained and survives store resets and emulator restarts. The blob authenticates the key identity and encryption context using AES-256-GCM. Its wrapping key is fixed and public: use synthetic test data only. This emulates local key wrapping, without key creation, policies, grants, rotation, or access control.

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
