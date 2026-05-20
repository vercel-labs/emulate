package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

func TestBuildContextS3PathStyleListObjects(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/photos?list-type=2&prefix=raw%2F", nil)
	ctx, err := BuildContext(req, nil, fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "s3" {
		t.Fatalf("service = %q, want s3", ctx.Service)
	}
	if ctx.Protocol != protocols.ProtocolRESTXML {
		t.Fatalf("protocol = %q, want %q", ctx.Protocol, protocols.ProtocolRESTXML)
	}
	if ctx.Action != "ListObjectsV2" {
		t.Fatalf("action = %q, want ListObjectsV2", ctx.Action)
	}
	if ctx.S3 == nil || ctx.S3.Bucket != "photos" || ctx.S3.Key != "" {
		t.Fatalf("unexpected S3 route: %#v", ctx.S3)
	}
	if ctx.S3.AddressingStyle != protocols.S3AddressingPathStyle {
		t.Fatalf("addressing style = %q, want path", ctx.S3.AddressingStyle)
	}
	if ctx.Query["prefix"] != "raw/" {
		t.Fatalf("prefix = %q, want raw/", ctx.Query["prefix"])
	}
	if ctx.RequestID != "req-test" {
		t.Fatalf("request id = %q, want req-test", ctx.RequestID)
	}
}

func TestBuildContextS3VirtualHostPutObject(t *testing.T) {
	req := httptest.NewRequest(http.MethodPut, "http://photos.s3.us-west-2.amazonaws.com/docs/readme.txt", nil)
	ctx, err := BuildContext(req, []byte("hello"), fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "s3" || ctx.Action != "PutObject" {
		t.Fatalf("service/action = %q/%q, want s3/PutObject", ctx.Service, ctx.Action)
	}
	if ctx.Region != "us-west-2" {
		t.Fatalf("region = %q, want us-west-2", ctx.Region)
	}
	if ctx.S3 == nil || ctx.S3.Bucket != "photos" || ctx.S3.Key != "docs/readme.txt" {
		t.Fatalf("unexpected S3 route: %#v", ctx.S3)
	}
	if ctx.S3.AddressingStyle != protocols.S3AddressingVirtualHost {
		t.Fatalf("addressing style = %q, want virtual_host", ctx.S3.AddressingStyle)
	}
}

func TestBuildContextS3PathStylePutObjectBodyLooksLikeQuery(t *testing.T) {
	body := []byte("Action=CreateQueue&QueueName=not-a-query")
	req := httptest.NewRequest(http.MethodPut, "http://127.0.0.1/photos/docs/readme.txt", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	ctx, err := BuildContext(req, body, fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "s3" || ctx.Action != "PutObject" {
		t.Fatalf("service/action = %q/%q, want s3/PutObject", ctx.Service, ctx.Action)
	}
	if ctx.Protocol != protocols.ProtocolRESTXML {
		t.Fatalf("protocol = %q, want %q", ctx.Protocol, protocols.ProtocolRESTXML)
	}
	if ctx.S3 == nil || ctx.S3.Bucket != "photos" || ctx.S3.Key != "docs/readme.txt" {
		t.Fatalf("unexpected S3 route: %#v", ctx.S3)
	}
}

func TestBuildContextS3PathStyleBucketNameCanMatchKnownService(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		url        string
		wantBucket string
		wantKey    string
		wantAction string
	}{
		{
			name:       "object in logs bucket",
			method:     http.MethodPut,
			url:        "http://127.0.0.1/logs/app.txt",
			wantBucket: "logs",
			wantKey:    "app.txt",
			wantAction: "PutObject",
		},
		{
			name:       "list sqs bucket",
			method:     http.MethodGet,
			url:        "http://127.0.0.1/sqs?list-type=2",
			wantBucket: "sqs",
			wantKey:    "",
			wantAction: "ListObjectsV2",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(test.method, test.url, nil)
			ctx, err := BuildContext(req, nil, fixedOptions())
			if err != nil {
				t.Fatal(err)
			}

			if ctx.Service != "s3" || ctx.Action != test.wantAction {
				t.Fatalf("service/action = %q/%q, want s3/%s", ctx.Service, ctx.Action, test.wantAction)
			}
			if ctx.S3 == nil || ctx.S3.Bucket != test.wantBucket || ctx.S3.Key != test.wantKey {
				t.Fatalf("unexpected S3 route: %#v", ctx.S3)
			}
		})
	}
}

func TestBuildContextSignedS3PathStyleBucketNameCanMatchKnownService(t *testing.T) {
	req := httptest.NewRequest(http.MethodPut, "http://127.0.0.1/logs/app.txt", nil)
	signRequestForService(req, "s3")

	ctx, err := BuildContext(req, nil, fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "s3" || ctx.Action != "PutObject" {
		t.Fatalf("service/action = %q/%q, want s3/PutObject", ctx.Service, ctx.Action)
	}
	if ctx.S3 == nil || ctx.S3.Bucket != "logs" || ctx.S3.Key != "app.txt" {
		t.Fatalf("unexpected S3 route: %#v", ctx.S3)
	}
}

func TestBuildContextSignedNonS3ServicePathDoesNotFallBackToS3(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/lambda/2015-03-31/functions", nil)
	signRequestForService(req, "lambda")

	ctx, err := BuildContext(req, nil, fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "lambda" {
		t.Fatalf("service = %q, want lambda", ctx.Service)
	}
	if ctx.Protocol != protocols.ProtocolUnknown {
		t.Fatalf("protocol = %q, want %q", ctx.Protocol, protocols.ProtocolUnknown)
	}
	if ctx.Action != "" {
		t.Fatalf("action = %q, want empty", ctx.Action)
	}
	if ctx.S3 != nil {
		t.Fatalf("S3 route = %#v, want nil", ctx.S3)
	}
}

func TestBuildContextKnownNonS3ServiceRootDoesNotFallBackToS3(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/lambda", nil)

	ctx, err := BuildContext(req, nil, fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "lambda" {
		t.Fatalf("service = %q, want lambda", ctx.Service)
	}
	if ctx.Protocol != protocols.ProtocolUnknown {
		t.Fatalf("protocol = %q, want %q", ctx.Protocol, protocols.ProtocolUnknown)
	}
	if ctx.Action != "" {
		t.Fatalf("action = %q, want empty", ctx.Action)
	}
	if ctx.S3 != nil {
		t.Fatalf("S3 route = %#v, want nil", ctx.S3)
	}
}

func TestBuildContextS3CopyObject(t *testing.T) {
	req := httptest.NewRequest(http.MethodPut, "http://127.0.0.1/photos/docs/copy.txt", nil)
	req.Header.Set("x-amz-copy-source", "/photos/docs/source.txt")

	ctx, err := BuildContext(req, nil, fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "s3" || ctx.Action != "CopyObject" {
		t.Fatalf("service/action = %q/%q, want s3/CopyObject", ctx.Service, ctx.Action)
	}
	if ctx.S3 == nil || ctx.S3.Bucket != "photos" || ctx.S3.Key != "docs/copy.txt" {
		t.Fatalf("unexpected S3 route: %#v", ctx.S3)
	}
	if ctx.S3.CopySource != "/photos/docs/source.txt" {
		t.Fatalf("copy source = %q, want /photos/docs/source.txt", ctx.S3.CopySource)
	}
	if ctx.Input["copySource"] != "/photos/docs/source.txt" {
		t.Fatalf("input copySource = %#v, want /photos/docs/source.txt", ctx.Input["copySource"])
	}
}

func TestBuildContextS3SubresourceActions(t *testing.T) {
	tests := []struct {
		name            string
		method          string
		url             string
		wantAction      string
		wantBucket      string
		wantKey         string
		wantSubresource string
	}{
		{
			name:            "get object acl",
			method:          http.MethodGet,
			url:             "http://127.0.0.1/photos/docs/readme.txt?acl",
			wantAction:      "GetObjectAcl",
			wantBucket:      "photos",
			wantKey:         "docs/readme.txt",
			wantSubresource: "acl",
		},
		{
			name:            "put object tagging",
			method:          http.MethodPut,
			url:             "http://127.0.0.1/photos/docs/readme.txt?tagging",
			wantAction:      "PutObjectTagging",
			wantBucket:      "photos",
			wantKey:         "docs/readme.txt",
			wantSubresource: "tagging",
		},
		{
			name:            "delete object tagging",
			method:          http.MethodDelete,
			url:             "http://127.0.0.1/photos/docs/readme.txt?tagging",
			wantAction:      "DeleteObjectTagging",
			wantBucket:      "photos",
			wantKey:         "docs/readme.txt",
			wantSubresource: "tagging",
		},
		{
			name:            "put bucket acl",
			method:          http.MethodPut,
			url:             "http://127.0.0.1/photos?acl",
			wantAction:      "PutBucketAcl",
			wantBucket:      "photos",
			wantKey:         "",
			wantSubresource: "acl",
		},
		{
			name:            "get bucket tagging",
			method:          http.MethodGet,
			url:             "http://127.0.0.1/photos?tagging",
			wantAction:      "GetBucketTagging",
			wantBucket:      "photos",
			wantKey:         "",
			wantSubresource: "tagging",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(test.method, test.url, nil)
			ctx, err := BuildContext(req, nil, fixedOptions())
			if err != nil {
				t.Fatal(err)
			}

			if ctx.Service != "s3" || ctx.Action != test.wantAction {
				t.Fatalf("service/action = %q/%q, want s3/%s", ctx.Service, ctx.Action, test.wantAction)
			}
			if ctx.S3 == nil || ctx.S3.Bucket != test.wantBucket || ctx.S3.Key != test.wantKey {
				t.Fatalf("unexpected S3 route: %#v", ctx.S3)
			}
			if ctx.S3.Subresource != test.wantSubresource {
				t.Fatalf("subresource = %q, want %q", ctx.S3.Subresource, test.wantSubresource)
			}
		})
	}
}

func TestBuildContextS3VirtualHostDashRegion(t *testing.T) {
	req := httptest.NewRequest(http.MethodPut, "http://photos.s3-us-west-2.amazonaws.com/docs/readme.txt", nil)
	ctx, err := BuildContext(req, nil, fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "s3" || ctx.Action != "PutObject" {
		t.Fatalf("service/action = %q/%q, want s3/PutObject", ctx.Service, ctx.Action)
	}
	if ctx.Region != "us-west-2" {
		t.Fatalf("region = %q, want us-west-2", ctx.Region)
	}
	if ctx.S3 == nil || ctx.S3.Bucket != "photos" || ctx.S3.Key != "docs/readme.txt" {
		t.Fatalf("unexpected S3 route: %#v", ctx.S3)
	}
}

func TestBuildContextS3EndpointVariantRegionDetection(t *testing.T) {
	tests := []struct {
		name       string
		url        string
		wantRegion string
	}{
		{
			name:       "accelerate has no host region",
			url:        "http://photos.s3-accelerate.amazonaws.com/docs/readme.txt",
			wantRegion: DefaultRegion,
		},
		{
			name:       "accelerate dualstack has no host region",
			url:        "http://photos.s3-accelerate.dualstack.amazonaws.com/docs/readme.txt",
			wantRegion: DefaultRegion,
		},
		{
			name:       "access point host region",
			url:        "http://photos.s3-accesspoint.us-west-2.amazonaws.com/docs/readme.txt",
			wantRegion: "us-west-2",
		},
		{
			name:       "fips host region",
			url:        "http://photos.s3-fips.us-gov-west-1.amazonaws.com/docs/readme.txt",
			wantRegion: "us-gov-west-1",
		},
		{
			name:       "local s3 host uses default region",
			url:        "http://photos.s3.localhost.example.test/docs/readme.txt",
			wantRegion: DefaultRegion,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, test.url, nil)
			ctx, err := BuildContext(req, nil, fixedOptions())
			if err != nil {
				t.Fatal(err)
			}

			if ctx.Service != "s3" || ctx.Action != "PutObject" {
				t.Fatalf("service/action = %q/%q, want s3/PutObject", ctx.Service, ctx.Action)
			}
			if ctx.Region != test.wantRegion {
				t.Fatalf("region = %q, want %q", ctx.Region, test.wantRegion)
			}
			if ctx.S3 == nil || ctx.S3.Bucket != "photos" || ctx.S3.Key != "docs/readme.txt" {
				t.Fatalf("unexpected S3 route: %#v", ctx.S3)
			}
		})
	}
}

func TestBuildContextS3VirtualHostDottedBucketContainingS3Label(t *testing.T) {
	req := httptest.NewRequest(http.MethodPut, "http://my.s3.bucket.s3.us-west-2.amazonaws.com/docs/readme.txt", nil)
	ctx, err := BuildContext(req, nil, fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "s3" || ctx.Action != "PutObject" {
		t.Fatalf("service/action = %q/%q, want s3/PutObject", ctx.Service, ctx.Action)
	}
	if ctx.Region != "us-west-2" {
		t.Fatalf("region = %q, want us-west-2", ctx.Region)
	}
	if ctx.S3 == nil || ctx.S3.Bucket != "my.s3.bucket" || ctx.S3.Key != "docs/readme.txt" {
		t.Fatalf("unexpected S3 route: %#v", ctx.S3)
	}
	if ctx.S3.AddressingStyle != protocols.S3AddressingVirtualHost {
		t.Fatalf("addressing style = %q, want virtual_host", ctx.S3.AddressingStyle)
	}
}

func TestBuildContextS3CreateMultipartUploadForObjectKey(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://photos.s3.us-west-2.amazonaws.com/docs/readme.txt?uploads", nil)
	ctx, err := BuildContext(req, nil, fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "s3" || ctx.Action != "CreateMultipartUpload" {
		t.Fatalf("service/action = %q/%q, want s3/CreateMultipartUpload", ctx.Service, ctx.Action)
	}
	if ctx.S3 == nil || ctx.S3.Bucket != "photos" || ctx.S3.Key != "docs/readme.txt" {
		t.Fatalf("unexpected S3 route: %#v", ctx.S3)
	}
}

func TestBuildContextS3MultipartActions(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		url        string
		wantBucket string
		wantKey    string
		wantAction string
	}{
		{
			name:       "list multipart uploads",
			method:     http.MethodGet,
			url:        "http://photos.s3.us-west-2.amazonaws.com/?uploads",
			wantBucket: "photos",
			wantKey:    "",
			wantAction: "ListMultipartUploads",
		},
		{
			name:       "bucket post uploads is not create multipart upload",
			method:     http.MethodPost,
			url:        "http://photos.s3.us-west-2.amazonaws.com/?uploads",
			wantBucket: "photos",
			wantKey:    "",
			wantAction: "PostObject",
		},
		{
			name:       "abort multipart upload",
			method:     http.MethodDelete,
			url:        "http://photos.s3.us-west-2.amazonaws.com/docs/readme.txt?uploadId=upload-123",
			wantBucket: "photos",
			wantKey:    "docs/readme.txt",
			wantAction: "AbortMultipartUpload",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(test.method, test.url, nil)
			ctx, err := BuildContext(req, nil, fixedOptions())
			if err != nil {
				t.Fatal(err)
			}

			if ctx.Service != "s3" || ctx.Action != test.wantAction {
				t.Fatalf("service/action = %q/%q, want s3/%s", ctx.Service, ctx.Action, test.wantAction)
			}
			if ctx.S3 == nil || ctx.S3.Bucket != test.wantBucket || ctx.S3.Key != test.wantKey {
				t.Fatalf("unexpected S3 route: %#v", ctx.S3)
			}
		})
	}
}

func TestBuildContextSQSQueryRequest(t *testing.T) {
	body := "Action=CreateQueue&Version=2012-11-05&QueueName=jobs&Attribute.1.Name=VisibilityTimeout&Attribute.1.Value=45"
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/sqs/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260518/us-west-2/sqs/aws4_request, SignedHeaders=host, Signature=abc")

	ctx, err := BuildContext(req, []byte(body), fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "sqs" || ctx.Action != "CreateQueue" {
		t.Fatalf("service/action = %q/%q, want sqs/CreateQueue", ctx.Service, ctx.Action)
	}
	if ctx.Protocol != protocols.ProtocolQuery {
		t.Fatalf("protocol = %q, want %q", ctx.Protocol, protocols.ProtocolQuery)
	}
	if ctx.Region != "us-west-2" {
		t.Fatalf("region = %q, want us-west-2", ctx.Region)
	}
	if ctx.Credentials.AccessKeyID != "AKIAEXAMPLE" || ctx.Credentials.Scope.Service != "sqs" {
		t.Fatalf("unexpected credentials: %#v", ctx.Credentials)
	}
	if ctx.Query["Attribute.1.Value"] != "45" {
		t.Fatalf("attribute value = %q, want 45", ctx.Query["Attribute.1.Value"])
	}
}

func TestBuildContextIAMQueryActionFallbacks(t *testing.T) {
	tests := []string{
		"CreateAccessKey",
		"DeleteAccessKey",
		"DeleteRole",
		"DeleteUser",
	}

	for _, action := range tests {
		t.Run(action, func(t *testing.T) {
			body := "Action=" + action + "&Version=2010-05-08"
			req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

			ctx, err := BuildContext(req, []byte(body), fixedOptions())
			if err != nil {
				t.Fatal(err)
			}

			if ctx.Service != "iam" || ctx.Action != action {
				t.Fatalf("service/action = %q/%q, want iam/%s", ctx.Service, ctx.Action, action)
			}
		})
	}
}

func TestBuildContextDisambiguatesPermissionQueryActions(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		service string
		action  string
	}{
		{
			name:    "sns add permission",
			body:    "Action=AddPermission&TopicArn=arn:aws:sns:us-east-1:123456789012:events",
			service: "sns",
			action:  "AddPermission",
		},
		{
			name:    "sns remove permission",
			body:    "Action=RemovePermission&TopicArn=arn:aws:sns:us-east-1:123456789012:events",
			service: "sns",
			action:  "RemovePermission",
		},
		{
			name:    "sqs add permission",
			body:    "Action=AddPermission&QueueUrl=http://127.0.0.1/sqs/123456789012/events",
			service: "sqs",
			action:  "AddPermission",
		},
		{
			name:    "sqs remove permission",
			body:    "Action=RemovePermission&QueueUrl=http://127.0.0.1/sqs/123456789012/events",
			service: "sqs",
			action:  "RemovePermission",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/", strings.NewReader(test.body))
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

			ctx, err := BuildContext(req, []byte(test.body), fixedOptions())
			if err != nil {
				t.Fatal(err)
			}

			if ctx.Service != test.service || ctx.Action != test.action {
				t.Fatalf("service/action = %q/%q, want %s/%s", ctx.Service, ctx.Action, test.service, test.action)
			}
		})
	}
}

func TestBuildContextIAMQueryRequest(t *testing.T) {
	body := "Action=ListUsers&Version=2010-05-08"
	req := httptest.NewRequest(http.MethodPost, "https://iam.amazonaws.com/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	ctx, err := BuildContext(req, []byte(body), fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "iam" || ctx.Action != "ListUsers" {
		t.Fatalf("service/action = %q/%q, want iam/ListUsers", ctx.Service, ctx.Action)
	}
	if ctx.Region != DefaultRegion {
		t.Fatalf("region = %q, want %q", ctx.Region, DefaultRegion)
	}
}

func TestBuildContextSTSQueryRequest(t *testing.T) {
	body := "Action=GetCallerIdentity&Version=2011-06-15"
	req := httptest.NewRequest(http.MethodPost, "https://sts.amazonaws.com/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIASTS/20260518/eu-central-1/sts/aws4_request, SignedHeaders=host, Signature=abc")

	ctx, err := BuildContext(req, []byte(body), fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "sts" || ctx.Action != "GetCallerIdentity" {
		t.Fatalf("service/action = %q/%q, want sts/GetCallerIdentity", ctx.Service, ctx.Action)
	}
	if ctx.Region != "eu-central-1" {
		t.Fatalf("region = %q, want eu-central-1", ctx.Region)
	}
}

func TestBuildContextKnownKeyAuthContext(t *testing.T) {
	body := "Action=GetCallerIdentity&Version=2011-06-15"
	req := httptest.NewRequest(http.MethodPost, "https://sts.amazonaws.com/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAKNOWN/20260519/ap-southeast-2/sts/aws4_request, SignedHeaders=host, Signature=abc")
	options := fixedOptions()
	options.AuthMode = auth.ModeKnownKeys
	options.CredentialStore = auth.NewStore(auth.Credential{
		AccessKeyID:  "AKIAKNOWN",
		AccountID:    "210987654321",
		PrincipalARN: "arn:aws:iam::210987654321:user/tester",
	})

	ctx, err := BuildContext(req, []byte(body), options)
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Auth.Status != auth.StatusKnown {
		t.Fatalf("auth status = %q, want %q", ctx.Auth.Status, auth.StatusKnown)
	}
	if ctx.AccountID != "210987654321" || ctx.Principal.AccountID != "210987654321" {
		t.Fatalf("account context = %#v/%#v", ctx.AccountID, ctx.Principal)
	}
	if ctx.Principal.ARN != "arn:aws:iam::210987654321:user/tester" {
		t.Fatalf("principal ARN = %q", ctx.Principal.ARN)
	}
	if ctx.Region != "ap-southeast-2" {
		t.Fatalf("region = %q, want ap-southeast-2", ctx.Region)
	}
	if ctx.Credentials.AccessKeyID != "AKIAKNOWN" || ctx.Credentials.Scope.Service != "sts" {
		t.Fatalf("unexpected credentials: %#v", ctx.Credentials)
	}
}

func TestBuildContextKnownKeyMissingAuthIsExplicit(t *testing.T) {
	body := "Action=ListUsers&Version=2010-05-08"
	req := httptest.NewRequest(http.MethodPost, "https://iam.amazonaws.com/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	options := fixedOptions()
	options.AuthMode = auth.ModeKnownKeys

	ctx, err := BuildContext(req, []byte(body), options)
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Auth.Status != auth.StatusMissing {
		t.Fatalf("auth status = %q, want %q", ctx.Auth.Status, auth.StatusMissing)
	}
	if ctx.Auth.Error == nil || ctx.Auth.Error.Code != "MissingAuthenticationToken" {
		t.Fatalf("auth error = %#v, want MissingAuthenticationToken", ctx.Auth.Error)
	}
	if ctx.AccountID != DefaultAccountID || ctx.Principal.AccountID != DefaultAccountID {
		t.Fatalf("account context = %#v/%#v", ctx.AccountID, ctx.Principal)
	}
}

func TestBuildContextNonS3HostRegionDetection(t *testing.T) {
	tests := []struct {
		name        string
		url         string
		body        string
		target      string
		contentType string
		wantService string
		wantAction  string
		wantRegion  string
	}{
		{
			name:        "localhost suffix falls back to default region",
			url:         "http://sqs.localhost/",
			body:        "Action=ListQueues&Version=2012-11-05",
			contentType: "application/x-www-form-urlencoded",
			wantService: "sqs",
			wantAction:  "ListQueues",
			wantRegion:  DefaultRegion,
		},
		{
			name:        "dualstack host skips to aws region label",
			url:         "https://dynamodb.dualstack.us-west-2.amazonaws.com/",
			body:        `{"Limit":1}`,
			target:      "DynamoDB_20120810.ListTables",
			contentType: "application/x-amz-json-1.0",
			wantService: "dynamodb",
			wantAction:  "ListTables",
			wantRegion:  "us-west-2",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := []byte(test.body)
			req := httptest.NewRequest(http.MethodPost, test.url, strings.NewReader(test.body))
			req.Header.Set("Content-Type", test.contentType)
			if test.target != "" {
				req.Header.Set("X-Amz-Target", test.target)
			}

			ctx, err := BuildContext(req, body, fixedOptions())
			if err != nil {
				t.Fatal(err)
			}

			if ctx.Service != test.wantService || ctx.Action != test.wantAction {
				t.Fatalf("service/action = %q/%q, want %s/%s", ctx.Service, ctx.Action, test.wantService, test.wantAction)
			}
			if ctx.Region != test.wantRegion {
				t.Fatalf("region = %q, want %q", ctx.Region, test.wantRegion)
			}
		})
	}
}

func TestBuildContextJSONRPCRequest(t *testing.T) {
	body := []byte(`{"Limit":10}`)
	req := httptest.NewRequest(http.MethodPost, "https://dynamodb.us-east-1.amazonaws.com/", strings.NewReader(string(body)))
	req.Header.Set("X-Amz-Target", "DynamoDB_20120810.ListTables")
	req.Header.Set("Content-Type", "application/x-amz-json-1.0")

	ctx, err := BuildContext(req, body, fixedOptions())
	if err != nil {
		t.Fatal(err)
	}

	if ctx.Service != "dynamodb" || ctx.Action != "ListTables" {
		t.Fatalf("service/action = %q/%q, want dynamodb/ListTables", ctx.Service, ctx.Action)
	}
	if ctx.Protocol != protocols.ProtocolJSONRPC {
		t.Fatalf("protocol = %q, want %q", ctx.Protocol, protocols.ProtocolJSONRPC)
	}
	limit, ok := ctx.Input["Limit"].(json.Number)
	if !ok || limit.String() != "10" {
		t.Fatalf("Limit = %#v, want json.Number(10)", ctx.Input["Limit"])
	}
}

func TestBuildContextJSONRPCTargetOnlyServicePrefixes(t *testing.T) {
	tests := []struct {
		name       string
		target     string
		want       string
		wantAction string
	}{
		{
			name:       "cloudwatch logs",
			target:     "Logs_20140328.DescribeLogGroups",
			want:       "logs",
			wantAction: "DescribeLogGroups",
		},
		{
			name:       "secrets manager",
			target:     "secretsmanager.GetSecretValue",
			want:       "secretsmanager",
			wantAction: "GetSecretValue",
		},
		{
			name:       "sqs",
			target:     "AmazonSQS.ListQueues",
			want:       "sqs",
			wantAction: "ListQueues",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/", strings.NewReader(`{}`))
			req.Header.Set("X-Amz-Target", test.target)
			req.Header.Set("Content-Type", "application/x-amz-json-1.1")

			ctx, err := BuildContext(req, []byte(`{}`), fixedOptions())
			if err != nil {
				t.Fatal(err)
			}

			if ctx.Service != test.want || ctx.Action != test.wantAction {
				t.Fatalf("service/action = %q/%q, want %s/%s", ctx.Service, ctx.Action, test.want, test.wantAction)
			}
			if ctx.Protocol != protocols.ProtocolJSONRPC {
				t.Fatalf("protocol = %q, want %q", ctx.Protocol, protocols.ProtocolJSONRPC)
			}
		})
	}
}

func TestNewRequestIDReturnsAWSStyleOpaqueID(t *testing.T) {
	id := NewRequestID()
	if matched := regexp.MustCompile(`^[A-F0-9]{32}$`).MatchString(id); !matched {
		t.Fatalf("request id = %q, want 32 uppercase hex characters", id)
	}
}

func fixedOptions() Options {
	return Options{
		DefaultAccountID: DefaultAccountID,
		DefaultRegion:    DefaultRegion,
		RequestIDGenerator: func() string {
			return "req-test"
		},
	}
}

func signRequestForService(req *http.Request, service string) {
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260519/us-east-1/"+service+"/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef")
	req.Header.Set("X-Amz-Date", "20260519T000000Z")
}
