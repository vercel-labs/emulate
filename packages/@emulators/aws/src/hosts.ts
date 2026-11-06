import type { ServiceHost } from "@emulators/core";

/** Maps an S3 path onto the emulator's `/s3` routes, which have no trailing slash bucket variant. */
function s3Path(bucket: string | undefined, pathname: string): string {
  const path = bucket ? `/${bucket}${pathname === "/" ? "" : pathname}` : pathname;
  const trimmed = /^\/[^/]+\/$/.test(path) ? path.slice(0, -1) : path;
  return trimmed === "/" ? "/s3/" : `/s3${trimmed}`;
}

function virtualHostedBucket(url: URL): string {
  return url.hostname.slice(0, url.hostname.toLowerCase().indexOf(".s3."));
}

/**
 * Real AWS hosts. S3 supports path-style and virtual-hosted URLs. SQS, STS,
 * and IAM use the Query protocol, which the emulator serves at one endpoint
 * per service and routes by the `Action` and `QueueUrl` parameters.
 */
export const hosts: readonly ServiceHost[] = [
  { host: "s3.amazonaws.com", toPath: (url) => s3Path(undefined, url.pathname) },
  { host: "s3.*.amazonaws.com", toPath: (url) => s3Path(undefined, url.pathname) },
  { host: "*.s3.amazonaws.com", toPath: (url) => s3Path(virtualHostedBucket(url), url.pathname) },
  { host: "*.s3.*.amazonaws.com", toPath: (url) => s3Path(virtualHostedBucket(url), url.pathname) },
  { host: "sqs.amazonaws.com", toPath: () => "/sqs/" },
  { host: "sqs.*.amazonaws.com", toPath: () => "/sqs/" },
  { host: "sts.amazonaws.com", toPath: () => "/sts/" },
  { host: "sts.*.amazonaws.com", toPath: () => "/sts/" },
  { host: "iam.amazonaws.com", toPath: () => "/iam/" },
];
