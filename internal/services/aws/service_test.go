package aws

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
	"github.com/vercel-labs/emulate/internal/services/aws/auth"
)

func TestServiceHandlesS3ListBuckets(t *testing.T) {
	handler := newTestHandler()
	res := executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/", nil, "s3", nil)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	if got := res.Header().Get("x-amz-request-id"); got == "" {
		t.Fatal("missing x-amz-request-id")
	}
	body := res.Body.String()
	if !strings.Contains(body, "<ListAllMyBucketsResult>") || !strings.Contains(body, "<Name>emulate-default</Name>") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceHandlesUnsignedPathStyleS3ListObjects(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/photos?list-type=2", nil)

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	body := res.Body.String()
	if !strings.Contains(body, "<Code>NoSuchBucket</Code>") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceHandlesLegacyS3PathStyleInConservativeMode(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/s3/emulate-default", nil)

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	body := res.Body.String()
	if !strings.Contains(body, "<ListBucketResult>") || !strings.Contains(body, "<Name>emulate-default</Name>") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceHandlesS3BucketLifecycle(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/photos", nil, "s3", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Location"); got != "/photos" {
		t.Fatalf("location = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodHead, "http://127.0.0.1/photos", nil, "s3", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("head status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("x-amz-bucket-region"); got != "us-east-1" {
		t.Fatalf("bucket region = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodDelete, "http://127.0.0.1/photos", nil, "s3", nil)
	if res.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodHead, "http://127.0.0.1/photos", nil, "s3", nil)
	if res.Code != http.StatusNotFound {
		t.Fatalf("missing head status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesS3BucketLocation(t *testing.T) {
	handler := newTestHandler()
	body := []byte(`<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>eu-west-1</LocationConstraint></CreateBucketConfiguration>`)

	res := executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/regional-bucket", body, "s3", map[string]string{
		"Content-Type": "application/xml",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/regional-bucket?location", nil, "s3", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("location status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">eu-west-1</LocationConstraint>`) {
		t.Fatalf("unexpected location body: %s", res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/missing-bucket?location", nil, "s3", nil)
	if res.Code != http.StatusNotFound || !strings.Contains(res.Body.String(), "<Code>NoSuchBucket</Code>") {
		t.Fatalf("missing location status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesS3ObjectLifecycleWithBinaryBodyAndMetadata(t *testing.T) {
	handler := newTestHandler()
	body := []byte{0, 1, 2, 3, 255, 'o', 'k'}

	res := executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/emulate-default/docs/data.bin", body, "s3", map[string]string{
		"Content-Type":                                "application/octet-stream",
		"x-amz-meta-origin":                           "native-test",
		"x-amz-server-side-encryption":                "aws:kms",
		"x-amz-server-side-encryption-aws-kms-key-id": "alias/local",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("ETag"); got == "" || !strings.HasPrefix(got, `"`) {
		t.Fatalf("etag = %q", got)
	}
	if got := res.Header().Get("x-amz-server-side-encryption"); got != "aws:kms" {
		t.Fatalf("put sse algorithm = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/data.bin", nil, "s3", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", res.Code, res.Body.String())
	}
	if !bytes.Equal(res.Body.Bytes(), body) {
		t.Fatalf("body = %v, want %v", res.Body.Bytes(), body)
	}
	if got := res.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("content type = %q", got)
	}
	if got := res.Header().Get("x-amz-meta-origin"); got != "native-test" {
		t.Fatalf("metadata = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodHead, "http://127.0.0.1/emulate-default/docs/data.bin", nil, "s3", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("head status = %d, body = %s", res.Code, res.Body.String())
	}
	if res.Body.Len() != 0 {
		t.Fatalf("head body length = %d", res.Body.Len())
	}
	if got := res.Header().Get("Content-Length"); got != "7" {
		t.Fatalf("content length = %q", got)
	}
	if got := res.Header().Get("x-amz-server-side-encryption"); got != "aws:kms" {
		t.Fatalf("head sse algorithm = %q", got)
	}
	if got := res.Header().Get("x-amz-server-side-encryption-aws-kms-key-id"); got != "alias/local" {
		t.Fatalf("head sse kms key id = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodDelete, "http://127.0.0.1/emulate-default/docs/data.bin", nil, "s3", nil)
	if res.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/data.bin", nil, "s3", nil)
	if res.Code != http.StatusNotFound {
		t.Fatalf("missing get status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<Code>NoSuchKey</Code>") {
		t.Fatalf("unexpected missing body: %s", res.Body.String())
	}
}

func TestServiceHandlesS3RangeAndConditionalReads(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/emulate-default/docs/range.txt", []byte("0123456789"), "s3", map[string]string{
		"Content-Type": "text/plain",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", res.Code, res.Body.String())
	}
	etag := res.Header().Get("ETag")
	if etag == "" {
		t.Fatal("missing etag")
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/range.txt", nil, "s3", map[string]string{
		"Range": "bytes=2-5",
	})
	if res.Code != http.StatusPartialContent {
		t.Fatalf("range status = %d, body = %s", res.Code, res.Body.String())
	}
	if res.Body.String() != "2345" {
		t.Fatalf("range body = %q", res.Body.String())
	}
	if got := res.Header().Get("Content-Range"); got != "bytes 2-5/10" {
		t.Fatalf("content range = %q", got)
	}
	if got := res.Header().Get("Content-Length"); got != "4" {
		t.Fatalf("content length = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/range.txt", nil, "s3", map[string]string{
		"Range": "bytes=-3",
	})
	if res.Code != http.StatusPartialContent || res.Body.String() != "789" {
		t.Fatalf("suffix range status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodHead, "http://127.0.0.1/emulate-default/docs/range.txt", nil, "s3", map[string]string{
		"Range": "bytes=0-2",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("head range status = %d, body = %s", res.Code, res.Body.String())
	}
	if res.Body.Len() != 0 {
		t.Fatalf("head range body length = %d", res.Body.Len())
	}
	if got := res.Header().Get("Content-Length"); got != "3" {
		t.Fatalf("head content length = %q", got)
	}
	if got := res.Header().Get("Content-Range"); got != "" {
		t.Fatalf("head content range = %q", got)
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/range.txt", nil, "s3", map[string]string{
		"Range": "bytes=99-100",
	})
	if res.Code != http.StatusRequestedRangeNotSatisfiable || !strings.Contains(res.Body.String(), "<Code>InvalidRange</Code>") {
		t.Fatalf("invalid range status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodHead, "http://127.0.0.1/emulate-default/docs/range.txt", nil, "s3", nil)
	lastModified := res.Header().Get("Last-Modified")
	if lastModified == "" {
		t.Fatal("missing last modified")
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/range.txt", nil, "s3", map[string]string{
		"If-None-Match": etag,
	})
	if res.Code != http.StatusNotModified {
		t.Fatalf("if-none-match status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/range.txt", nil, "s3", map[string]string{
		"If-None-Match":     `"does-not-match"`,
		"If-Modified-Since": lastModified,
	})
	if res.Code != http.StatusOK || res.Body.String() != "0123456789" {
		t.Fatalf("if-none-match precedence status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/range.txt", nil, "s3", map[string]string{
		"If-Match": `"does-not-match"`,
	})
	if res.Code != http.StatusPreconditionFailed || !strings.Contains(res.Body.String(), "<Code>PreconditionFailed</Code>") {
		t.Fatalf("if-match status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/range.txt", nil, "s3", map[string]string{
		"If-Match":            etag,
		"If-Unmodified-Since": "Wed, 21 Oct 2015 07:28:00 GMT",
	})
	if res.Code != http.StatusOK || res.Body.String() != "0123456789" {
		t.Fatalf("if-match precedence status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/range.txt", nil, "s3", map[string]string{
		"If-Modified-Since": lastModified,
	})
	if res.Code != http.StatusNotModified {
		t.Fatalf("if-modified-since status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/range.txt", nil, "s3", map[string]string{
		"If-Unmodified-Since": "Wed, 21 Oct 2015 07:28:00 GMT",
	})
	if res.Code != http.StatusPreconditionFailed {
		t.Fatalf("if-unmodified-since status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesS3CopyObject(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/emulate-default/docs/source.txt", []byte("copy me"), "s3", map[string]string{
		"Content-Type": "text/plain",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/emulate-default/docs/copy.txt", nil, "s3", map[string]string{
		"x-amz-copy-source": "/emulate-default/docs/source.txt",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("copy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<CopyObjectResult>") {
		t.Fatalf("unexpected copy body: %s", res.Body.String())
	}

	res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/docs/copy.txt", nil, "s3", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Body.String(); got != "copy me" {
		t.Fatalf("body = %q", got)
	}
}

func TestServicePaginatesS3CommonPrefixes(t *testing.T) {
	handler := newTestHandler()
	for _, key := range []string{"a/file.txt", "b/file.txt", "c.txt"} {
		res := executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/emulate-default/"+key, []byte(key), "s3", nil)
		if res.Code != http.StatusOK {
			t.Fatalf("put %s status = %d, body = %s", key, res.Code, res.Body.String())
		}
	}

	page1 := executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default?list-type=2&delimiter=/&max-keys=1", nil, "s3", nil)
	if page1.Code != http.StatusOK {
		t.Fatalf("page1 status = %d, body = %s", page1.Code, page1.Body.String())
	}
	body := page1.Body.String()
	for _, expected := range []string{"<IsTruncated>true</IsTruncated>", "<KeyCount>1</KeyCount>", "<Prefix>a/</Prefix>", "<NextContinuationToken>a/</NextContinuationToken>"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("page1 missing %q in %s", expected, body)
		}
	}
	if strings.Contains(body, "<Prefix>b/</Prefix>") || strings.Contains(body, "<Key>c.txt</Key>") {
		t.Fatalf("page1 contains entries beyond max-keys: %s", body)
	}

	page2 := executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default?list-type=2&delimiter=/&max-keys=1&continuation-token=a%2F", nil, "s3", nil)
	if page2.Code != http.StatusOK {
		t.Fatalf("page2 status = %d, body = %s", page2.Code, page2.Body.String())
	}
	body = page2.Body.String()
	if !strings.Contains(body, "<Prefix>b/</Prefix>") || strings.Contains(body, "<Prefix>a/</Prefix>") {
		t.Fatalf("unexpected page2 body: %s", body)
	}
}

func TestServiceRejectsS3PostObjectWhenPolicyExactMatchFails(t *testing.T) {
	tests := []struct {
		name       string
		conditions []any
	}{
		{
			name: "object condition",
			conditions: []any{
				map[string]string{"bucket": "emulate-default"},
				map[string]string{"key": "locked.txt"},
			},
		},
		{
			name: "eq condition",
			conditions: []any{
				[]any{"eq", "$key", "locked-eq.txt"},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handler := newTestHandler()
			res := executeS3MultipartPost(t, handler, "http://127.0.0.1/emulate-default", map[string]string{
				"key":    "tampered.txt",
				"Policy": encodePostPolicy(t, test.conditions),
			}, []byte("tampered"))

			if res.Code != http.StatusForbidden {
				t.Fatalf("post status = %d, body = %s", res.Code, res.Body.String())
			}
			if !strings.Contains(res.Body.String(), "<Code>AccessDenied</Code>") {
				t.Fatalf("unexpected body: %s", res.Body.String())
			}

			res = executeAWSRequest(handler, http.MethodGet, "http://127.0.0.1/emulate-default/tampered.txt", nil, "s3", nil)
			if res.Code != http.StatusNotFound {
				t.Fatalf("tampered object status = %d, body = %s", res.Code, res.Body.String())
			}
		})
	}
}

func TestServiceReturnsNoSuchBucketForDeleteObjectInMissingBucket(t *testing.T) {
	handler := newTestHandler()
	res := executeAWSRequest(handler, http.MethodDelete, "http://127.0.0.1/missing/docs/data.bin", nil, "s3", nil)

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<Code>NoSuchBucket</Code>") {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestServiceReturnsUnsignedS3SubresourceNotImplemented(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		target     string
		wantAction string
	}{
		{
			name:       "bucket lifecycle",
			method:     http.MethodGet,
			target:     "http://127.0.0.1/photos?lifecycle",
			wantAction: "s3.GetBucketLifecycleConfiguration",
		},
		{
			name:       "bucket notification",
			method:     http.MethodPut,
			target:     "http://127.0.0.1/photos?notification",
			wantAction: "s3.PutBucketNotificationConfiguration",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handler := newTestHandler()
			req := httptest.NewRequest(test.method, test.target, nil)

			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)

			if res.Code != http.StatusNotImplemented {
				t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
			}
			if got := res.Header().Get("Content-Type"); got != "application/xml" {
				t.Fatalf("content type = %q", got)
			}
			body := res.Body.String()
			if !strings.Contains(body, "<Code>NotImplemented</Code>") || !strings.Contains(body, test.wantAction) {
				t.Fatalf("unexpected body: %s", body)
			}
		})
	}
}

func TestServiceHandlesSQSCreateQueue(t *testing.T) {
	handler := newTestHandler()
	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=jobs")

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	if got := res.Header().Get("x-amzn-requestid"); got == "" {
		t.Fatal("missing x-amzn-requestid")
	}
	body := res.Body.String()
	if !strings.Contains(body, "<CreateQueueResponse>") || !strings.Contains(body, "<QueueUrl>") || !strings.Contains(body, "jobs") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceAcceptsBearerTokenForSQSQuery(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/sqs/", strings.NewReader("Action=CreateQueue&QueueName=jobs"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Bearer test_token_admin")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	if body := res.Body.String(); !strings.Contains(body, "<CreateQueueResponse>") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceHandlesSQSLifecycle(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=ListQueues")
	if res.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "emulate-default-queue") {
		t.Fatalf("list missing default queue: %s", body)
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=GetQueueUrl&QueueName=emulate-default-queue")
	if res.Code != http.StatusOK {
		t.Fatalf("get url status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	if queueURL == "" {
		t.Fatalf("missing queue url in %s", res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=GetQueueAttributes&QueueUrl="+url.QueryEscape(queueURL))
	if res.Code != http.StatusOK {
		t.Fatalf("attributes status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<Name>QueueArn</Name>") || !strings.Contains(body, "<Name>VisibilityTimeout</Name>") {
		t.Fatalf("unexpected attributes body: %s", body)
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=SendMessage&QueueUrl="+url.QueryEscape(queueURL)+"&MessageBody=test+message")
	if res.Code != http.StatusOK {
		t.Fatalf("send status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<SendMessageResponse>") || !strings.Contains(body, "<MessageId>") {
		t.Fatalf("unexpected send body: %s", body)
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=ReceiveMessage&QueueUrl="+url.QueryEscape(queueURL)+"&MaxNumberOfMessages=1")
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	if !strings.Contains(body, "<Body>test message</Body>") || !strings.Contains(body, "<ReceiptHandle>") {
		t.Fatalf("unexpected receive body: %s", body)
	}
	receiptHandle := xmlElement(body, "ReceiptHandle")
	if receiptHandle == "" {
		t.Fatalf("missing receipt handle in %s", body)
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=DeleteMessage&QueueUrl="+url.QueryEscape(queueURL)+"&ReceiptHandle="+url.QueryEscape(receiptHandle))
	if res.Code != http.StatusOK {
		t.Fatalf("delete message status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<DeleteMessageResponse>") {
		t.Fatalf("unexpected delete message body: %s", body)
	}
}

func TestServiceHandlesSQSPurgeAndDeleteQueue(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=jobs")
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	if queueURL == "" {
		t.Fatalf("missing queue url in %s", res.Body.String())
	}

	for _, body := range []string{"one", "two"} {
		res = executeAWSQueryRequest(handler, "sqs", "Action=SendMessage&QueueUrl="+url.QueryEscape(queueURL)+"&MessageBody="+url.QueryEscape(body))
		if res.Code != http.StatusOK {
			t.Fatalf("send %s status = %d, body = %s", body, res.Code, res.Body.String())
		}
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=PurgeQueue&QueueUrl="+url.QueryEscape(queueURL))
	if res.Code != http.StatusOK {
		t.Fatalf("purge status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=ReceiveMessage&QueueUrl="+url.QueryEscape(queueURL))
	if res.Code != http.StatusOK {
		t.Fatalf("receive after purge status = %d, body = %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "<Message>") {
		t.Fatalf("purged queue returned messages: %s", res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=DeleteQueue&QueueUrl="+url.QueryEscape(queueURL))
	if res.Code != http.StatusOK {
		t.Fatalf("delete queue status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=GetQueueUrl&QueueName=jobs")
	if res.Code != http.StatusBadRequest {
		t.Fatalf("get deleted queue status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<Code>AWS.SimpleQueueService.NonExistentQueue</Code>") {
		t.Fatalf("unexpected missing queue body: %s", res.Body.String())
	}
}

func TestServiceHonorsSQSMessageDelaySeconds(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=delayed-query")
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")

	values := url.Values{}
	values.Set("Action", "SendMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MessageBody", "wait for it")
	values.Set("DelaySeconds", "5")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("send status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "1")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "<Message>") {
		t.Fatalf("delayed message was visible immediately: %s", res.Body.String())
	}
}

func TestServiceReturnsSQSQueryMessageAttributes(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=query-attrs")
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")

	values := url.Values{}
	values.Set("Action", "SendMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MessageBody", "with attrs")
	values.Set("MessageAttribute.1.Name", "color")
	values.Set("MessageAttribute.1.Value.DataType", "String")
	values.Set("MessageAttribute.1.Value.StringValue", "blue")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("send status = %d, body = %s", res.Code, res.Body.String())
	}
	sentAttributesMD5 := xmlElement(res.Body.String(), "MD5OfMessageAttributes")
	if sentAttributesMD5 == "" {
		t.Fatalf("send missing MD5OfMessageAttributes in %s", res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MessageAttributeName.1", "All")
	values.Set("AttributeName.1", "All")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{"<MessageAttribute>", "<Name>color</Name>", "<DataType>String</DataType>", "<StringValue>blue</StringValue>", "<Name>SenderId</Name>", "<Value>123456789012</Value>"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("receive missing %q in %s", expected, body)
		}
	}
	if got := xmlElement(body, "MD5OfMessageAttributes"); got != sentAttributesMD5 {
		t.Fatalf("receive MD5OfMessageAttributes = %q, want %q in %s", got, sentAttributesMD5, body)
	}
}

func TestServiceHandlesSQSJSONMessageAttributes(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSJSONRequest(t, handler, "CreateQueue", map[string]any{"QueueName": "json-attrs"})
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	var created struct {
		QueueURL string `json:"QueueUrl"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	res = executeAWSJSONRequest(t, handler, "SendMessage", map[string]any{
		"QueueUrl":    created.QueueURL,
		"MessageBody": "with attrs",
		"MessageAttributes": map[string]any{
			"color": map[string]any{
				"DataType":    "String",
				"StringValue": "blue",
			},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("send status = %d, body = %s", res.Code, res.Body.String())
	}
	var sent struct {
		MD5OfMessageAttributes string `json:"MD5OfMessageAttributes"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &sent); err != nil {
		t.Fatal(err)
	}
	if sent.MD5OfMessageAttributes == "" {
		t.Fatalf("send missing MD5OfMessageAttributes in %s", res.Body.String())
	}

	res = executeAWSJSONRequest(t, handler, "ReceiveMessage", map[string]any{
		"QueueUrl":                    created.QueueURL,
		"MessageAttributeNames":       []string{"All"},
		"MessageSystemAttributeNames": []string{"All"},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	var received struct {
		Messages []struct {
			Attributes             map[string]string `json:"Attributes"`
			MD5OfMessageAttributes string            `json:"MD5OfMessageAttributes"`
			MessageAttributes      map[string]struct {
				DataType    string `json:"DataType"`
				StringValue string `json:"StringValue"`
			} `json:"MessageAttributes"`
		} `json:"Messages"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &received); err != nil {
		t.Fatal(err)
	}
	if len(received.Messages) != 1 {
		t.Fatalf("messages = %#v", received.Messages)
	}
	color := received.Messages[0].MessageAttributes["color"]
	if color.DataType != "String" || color.StringValue != "blue" {
		t.Fatalf("message attributes = %#v", received.Messages[0].MessageAttributes)
	}
	if received.Messages[0].MD5OfMessageAttributes != sent.MD5OfMessageAttributes {
		t.Fatalf("message attribute md5 = %q, want %q", received.Messages[0].MD5OfMessageAttributes, sent.MD5OfMessageAttributes)
	}
	if received.Messages[0].Attributes["SenderId"] != "123456789012" {
		t.Fatalf("system attributes = %#v", received.Messages[0].Attributes)
	}
}

func TestServiceHonorsSQSJSONMessageDelaySeconds(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSJSONRequest(t, handler, "CreateQueue", map[string]any{"QueueName": "json-delay"})
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	var created struct {
		QueueURL string `json:"QueueUrl"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	res = executeAWSJSONRequest(t, handler, "SendMessage", map[string]any{
		"QueueUrl":     created.QueueURL,
		"MessageBody":  "wait for it",
		"DelaySeconds": json.Number("5"),
	})
	if res.Code != http.StatusOK {
		t.Fatalf("send status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSJSONRequest(t, handler, "ReceiveMessage", map[string]any{
		"QueueUrl":            created.QueueURL,
		"MaxNumberOfMessages": json.Number("1"),
	})
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	var received struct {
		Messages []map[string]any `json:"Messages"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &received); err != nil {
		t.Fatal(err)
	}
	if len(received.Messages) != 0 {
		t.Fatalf("delayed message was visible immediately: %#v", received.Messages)
	}
}

func TestServiceHandlesSQSBatchVisibilityAttributesAndTags(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=query-batch")
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")

	values := url.Values{}
	values.Set("Action", "SetQueueAttributes")
	values.Set("QueueUrl", queueURL)
	values.Set("Attribute.1.Name", "VisibilityTimeout")
	values.Set("Attribute.1.Value", "12")
	values.Set("Attribute.2.Name", "ReceiveMessageWaitTimeSeconds")
	values.Set("Attribute.2.Value", "2")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("set attributes status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "GetQueueAttributes")
	values.Set("QueueUrl", queueURL)
	values.Set("AttributeName.1", "VisibilityTimeout")
	values.Set("AttributeName.2", "ReceiveMessageWaitTimeSeconds")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("get attributes status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<Name>VisibilityTimeout</Name><Value>12</Value>") || !strings.Contains(body, "<Name>ReceiveMessageWaitTimeSeconds</Name><Value>2</Value>") {
		t.Fatalf("unexpected attributes body: %s", body)
	}

	values = url.Values{}
	values.Set("Action", "TagQueue")
	values.Set("QueueUrl", queueURL)
	values.Set("Tag.1.Key", "env")
	values.Set("Tag.1.Value", "test")
	values.Set("Tag.2.Key", "team")
	values.Set("Tag.2.Value", "infra")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("tag status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ListQueueTags")
	values.Set("QueueUrl", queueURL)
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("list tags status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<Key>env</Key><Value>test</Value>") || !strings.Contains(body, "<Key>team</Key><Value>infra</Value>") {
		t.Fatalf("unexpected tags body: %s", body)
	}

	values = url.Values{}
	values.Set("Action", "UntagQueue")
	values.Set("QueueUrl", queueURL)
	values.Set("TagKey.1", "team")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("untag status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "SendMessageBatch")
	values.Set("QueueUrl", queueURL)
	values.Set("SendMessageBatchRequestEntry.1.Id", "one")
	values.Set("SendMessageBatchRequestEntry.1.MessageBody", "batch one")
	values.Set("SendMessageBatchRequestEntry.1.MessageAttribute.1.Name", "kind")
	values.Set("SendMessageBatchRequestEntry.1.MessageAttribute.1.Value.DataType", "String")
	values.Set("SendMessageBatchRequestEntry.1.MessageAttribute.1.Value.StringValue", "query")
	values.Set("SendMessageBatchRequestEntry.2.Id", "two")
	values.Set("SendMessageBatchRequestEntry.2.MessageBody", "batch two")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("send batch status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); strings.Count(body, "<SendMessageBatchResultEntry>") != 2 || !strings.Contains(body, "<MD5OfMessageAttributes>") {
		t.Fatalf("unexpected send batch body: %s", body)
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "2")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	receipts := xmlElements(res.Body.String(), "ReceiptHandle")
	if len(receipts) != 2 {
		t.Fatalf("receipts = %#v, body = %s", receipts, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ChangeMessageVisibility")
	values.Set("QueueUrl", queueURL)
	values.Set("ReceiptHandle", receipts[0])
	values.Set("VisibilityTimeout", "0")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("change visibility status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ChangeMessageVisibilityBatch")
	values.Set("QueueUrl", queueURL)
	values.Set("ChangeMessageVisibilityBatchRequestEntry.1.Id", "two")
	values.Set("ChangeMessageVisibilityBatchRequestEntry.1.ReceiptHandle", receipts[1])
	values.Set("ChangeMessageVisibilityBatchRequestEntry.1.VisibilityTimeout", "0")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("change visibility batch status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "2")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive after visibility status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	if !strings.Contains(body, "<Body>batch one</Body>") || !strings.Contains(body, "<Body>batch two</Body>") {
		t.Fatalf("messages were not visible after visibility change: %s", body)
	}
	receipts = xmlElements(body, "ReceiptHandle")
	if len(receipts) != 2 {
		t.Fatalf("new receipts = %#v, body = %s", receipts, body)
	}

	values = url.Values{}
	values.Set("Action", "DeleteMessageBatch")
	values.Set("QueueUrl", queueURL)
	values.Set("DeleteMessageBatchRequestEntry.1.Id", "one")
	values.Set("DeleteMessageBatchRequestEntry.1.ReceiptHandle", receipts[0])
	values.Set("DeleteMessageBatchRequestEntry.2.Id", "two")
	values.Set("DeleteMessageBatchRequestEntry.2.ReceiptHandle", receipts[1])
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("delete batch status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); strings.Count(body, "<DeleteMessageBatchResultEntry>") != 2 {
		t.Fatalf("unexpected delete batch body: %s", body)
	}
}

func TestServiceRejectsInvalidSQSQueryBatchRequestsBeforeMutating(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=query-invalid-batch")
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")

	values := url.Values{}
	values.Set("Action", "SendMessageBatch")
	values.Set("QueueUrl", queueURL)
	assertQueryBatchError(t, handler, values, "EmptyBatchRequest")

	values = url.Values{}
	values.Set("Action", "SendMessageBatch")
	values.Set("QueueUrl", queueURL)
	for index := 1; index <= 11; index++ {
		prefix := "SendMessageBatchRequestEntry." + strconv.Itoa(index)
		values.Set(prefix+".Id", "entry"+strconv.Itoa(index))
		values.Set(prefix+".MessageBody", "body")
	}
	assertQueryBatchError(t, handler, values, "TooManyEntriesInBatchRequest")

	values = url.Values{}
	values.Set("Action", "SendMessageBatch")
	values.Set("QueueUrl", queueURL)
	values.Set("SendMessageBatchRequestEntry.1.Id", "bad.id")
	values.Set("SendMessageBatchRequestEntry.1.MessageBody", "body")
	assertQueryBatchError(t, handler, values, "InvalidBatchEntryId")

	values = url.Values{}
	values.Set("Action", "SendMessageBatch")
	values.Set("QueueUrl", queueURL)
	values.Set("SendMessageBatchRequestEntry.1.Id", "dup")
	values.Set("SendMessageBatchRequestEntry.1.MessageBody", "one")
	values.Set("SendMessageBatchRequestEntry.2.Id", "dup")
	values.Set("SendMessageBatchRequestEntry.2.MessageBody", "two")
	assertQueryBatchError(t, handler, values, "BatchEntryIdsNotDistinct")

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "10")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	if bodies := xmlElements(res.Body.String(), "Body"); len(bodies) != 0 {
		t.Fatalf("invalid send batch mutated queue: %#v", bodies)
	}

	send := url.Values{}
	send.Set("Action", "SendMessage")
	send.Set("QueueUrl", queueURL)
	send.Set("MessageBody", "delete candidate")
	res = executeAWSQueryRequest(handler, "sqs", send.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("send status = %d, body = %s", res.Code, res.Body.String())
	}
	receipt := receiveOneQueryMessage(t, handler, queueURL, "delete candidate")

	values = url.Values{}
	values.Set("Action", "DeleteMessageBatch")
	values.Set("QueueUrl", queueURL)
	values.Set("DeleteMessageBatchRequestEntry.1.Id", "dup")
	values.Set("DeleteMessageBatchRequestEntry.1.ReceiptHandle", receipt)
	values.Set("DeleteMessageBatchRequestEntry.2.Id", "dup")
	values.Set("DeleteMessageBatchRequestEntry.2.ReceiptHandle", "missing")
	assertQueryBatchError(t, handler, values, "BatchEntryIdsNotDistinct")

	values = url.Values{}
	values.Set("Action", "ChangeMessageVisibility")
	values.Set("QueueUrl", queueURL)
	values.Set("ReceiptHandle", receipt)
	values.Set("VisibilityTimeout", "0")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("message was deleted by invalid delete batch, status = %d, body = %s", res.Code, res.Body.String())
	}
	receipt = receiveOneQueryMessage(t, handler, queueURL, "delete candidate")

	values = url.Values{}
	values.Set("Action", "ChangeMessageVisibilityBatch")
	values.Set("QueueUrl", queueURL)
	values.Set("ChangeMessageVisibilityBatchRequestEntry.1.Id", "dup")
	values.Set("ChangeMessageVisibilityBatchRequestEntry.1.ReceiptHandle", receipt)
	values.Set("ChangeMessageVisibilityBatchRequestEntry.1.VisibilityTimeout", "0")
	values.Set("ChangeMessageVisibilityBatchRequestEntry.2.Id", "dup")
	values.Set("ChangeMessageVisibilityBatchRequestEntry.2.ReceiptHandle", "missing")
	values.Set("ChangeMessageVisibilityBatchRequestEntry.2.VisibilityTimeout", "0")
	assertQueryBatchError(t, handler, values, "BatchEntryIdsNotDistinct")

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "1")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive after invalid visibility batch status = %d, body = %s", res.Code, res.Body.String())
	}
	if bodies := xmlElements(res.Body.String(), "Body"); len(bodies) != 0 {
		t.Fatalf("invalid visibility batch changed visibility: %#v", bodies)
	}
}

func TestServiceRejectsInvalidSQSJSONBatchRequests(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSJSONRequest(t, handler, "CreateQueue", map[string]any{"QueueName": "json-invalid-batch"})
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	var created struct {
		QueueURL string `json:"QueueUrl"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	assertJSONBatchError(t, executeAWSJSONRequest(t, handler, "DeleteMessageBatch", map[string]any{
		"QueueUrl": created.QueueURL,
		"Entries":  []any{},
	}), "EmptyBatchRequest")

	entries := make([]any, 0, 11)
	for index := 0; index < 11; index++ {
		entries = append(entries, map[string]any{"Id": "entry" + strconv.Itoa(index), "MessageBody": "body"})
	}
	assertJSONBatchError(t, executeAWSJSONRequest(t, handler, "SendMessageBatch", map[string]any{
		"QueueUrl": created.QueueURL,
		"Entries":  entries,
	}), "TooManyEntriesInBatchRequest")

	assertJSONBatchError(t, executeAWSJSONRequest(t, handler, "SendMessageBatch", map[string]any{
		"QueueUrl": created.QueueURL,
		"Entries": []any{
			map[string]any{"Id": "dup", "MessageBody": "one"},
			map[string]any{"Id": "dup", "MessageBody": "two"},
		},
	}), "BatchEntryIdsNotDistinct")

	res = executeAWSJSONRequest(t, handler, "ReceiveMessage", map[string]any{
		"QueueUrl":            created.QueueURL,
		"MaxNumberOfMessages": json.Number("10"),
	})
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	var received struct {
		Messages []map[string]any `json:"Messages"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &received); err != nil {
		t.Fatal(err)
	}
	if len(received.Messages) != 0 {
		t.Fatalf("invalid JSON batch mutated queue: %#v", received.Messages)
	}
}

func TestServiceHandlesSNSLifecycleAndSQSPublish(t *testing.T) {
	handler := newTestHandler()

	values := url.Values{}
	values.Set("Action", "CreateTopic")
	values.Set("Name", "app-events")
	values.Set("Attribute.1.Name", "DisplayName")
	values.Set("Attribute.1.Value", "App Events")
	values.Set("Tag.1.Key", "env")
	values.Set("Tag.1.Value", "test")
	res := executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create topic status = %d, body = %s", res.Code, res.Body.String())
	}
	topicARN := xmlElement(res.Body.String(), "TopicArn")
	if topicARN != "arn:aws:sns:us-east-1:123456789012:app-events" {
		t.Fatalf("topic arn = %q, body = %s", topicARN, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sns", "Action=ListTopics")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), topicARN) {
		t.Fatalf("list topics status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "GetTopicAttributes")
	values.Set("TopicArn", topicARN)
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("get attrs status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<key>DisplayName</key><value>App Events</value>") || !strings.Contains(body, "<key>SubscriptionsConfirmed</key><value>0</value>") {
		t.Fatalf("unexpected topic attrs: %s", body)
	}

	values = url.Values{}
	values.Set("Action", "SetTopicAttributes")
	values.Set("TopicArn", topicARN)
	values.Set("AttributeName", "DeliveryPolicy")
	values.Set("AttributeValue", `{"healthyRetryPolicy":{"numRetries":1}}`)
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("set attrs status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=app-events-queue")
	if res.Code != http.StatusOK {
		t.Fatalf("create queue status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	values = url.Values{}
	values.Set("Action", "GetQueueAttributes")
	values.Set("QueueUrl", queueURL)
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("queue attrs status = %d, body = %s", res.Code, res.Body.String())
	}
	queueARN := xmlValueForName(res.Body.String(), "QueueArn")
	if queueARN == "" {
		t.Fatalf("missing queue arn in %s", res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "Subscribe")
	values.Set("TopicArn", topicARN)
	values.Set("Protocol", "sqs")
	values.Set("Endpoint", queueARN)
	values.Set("Attributes.entry.1.key", "RawMessageDelivery")
	values.Set("Attributes.entry.1.value", "false")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("subscribe status = %d, body = %s", res.Code, res.Body.String())
	}
	subscriptionARN := xmlElement(res.Body.String(), "SubscriptionArn")
	if !strings.HasPrefix(subscriptionARN, topicARN+":") {
		t.Fatalf("subscription arn = %q, body = %s", subscriptionARN, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "Publish")
	values.Set("TopicArn", topicARN)
	values.Set("Subject", "created")
	values.Set("Message", "order created")
	values.Set("MessageAttributes.entry.1.Name", "trace")
	values.Set("MessageAttributes.entry.1.Value.DataType", "String")
	values.Set("MessageAttributes.entry.1.Value.StringValue", "abc123")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("publish status = %d, body = %s", res.Code, res.Body.String())
	}
	if xmlElement(res.Body.String(), "MessageId") == "" {
		t.Fatalf("missing message id in %s", res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "1")
	values.Set("MessageAttributeName.1", "All")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{
		"order created",
		topicARN,
		"&quot;Type&quot;:&quot;Notification&quot;",
		"&quot;MessageAttributes&quot;",
		"&quot;trace&quot;:{&quot;Type&quot;:&quot;String&quot;,&quot;Value&quot;:&quot;abc123&quot;}",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("receive missing %q in %s", expected, body)
		}
	}
	for _, unexpected := range []string{"&quot;DataType&quot;", "&quot;StringValue&quot;", "<MessageAttribute>", "<Name>trace</Name>", "<StringValue>abc123</StringValue>", "<MD5OfMessageAttributes>"} {
		if strings.Contains(body, unexpected) {
			t.Fatalf("receive included SNS envelope attribute shape %q in %s", unexpected, body)
		}
	}

	values = url.Values{}
	values.Set("Action", "Publish")
	values.Set("TopicArn", topicARN)
	values.Set("MessageStructure", "json")
	values.Set("Message", `{"default":"default payload","sqs":"sqs payload"}`)
	values.Set("MessageAttributes.entry.1.Name", "json-attrs")
	values.Set("MessageAttributes.entry.1.Value.DataType", "String")
	values.Set("MessageAttributes.entry.1.Value.StringValue", "not-delivered")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("publish json status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "1")
	values.Set("MessageAttributeName.1", "All")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive json status = %d, body = %s", res.Code, res.Body.String())
	}
	body = res.Body.String()
	if !strings.Contains(body, "sqs payload") {
		t.Fatalf("receive json missing SQS payload in %s", body)
	}
	for _, unexpected := range []string{"&quot;MessageAttributes&quot;", "<MessageAttribute>", "json-attrs", "not-delivered"} {
		if strings.Contains(body, unexpected) {
			t.Fatalf("receive json included message attributes %q in %s", unexpected, body)
		}
	}

	values = url.Values{}
	values.Set("Action", "ListSubscriptionsByTopic")
	values.Set("TopicArn", topicARN)
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), subscriptionARN) {
		t.Fatalf("list subscriptions status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "Unsubscribe")
	values.Set("SubscriptionArn", subscriptionARN)
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("unsubscribe status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "DeleteTopic")
	values.Set("TopicArn", topicARN)
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("delete topic status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesSNSUntagResourceTagKeys(t *testing.T) {
	handler := newTestHandler()

	values := url.Values{}
	values.Set("Action", "CreateTopic")
	values.Set("Name", "tagged")
	values.Set("Tag.1.Key", "keep")
	values.Set("Tag.1.Value", "yes")
	values.Set("Tag.2.Key", "remove")
	values.Set("Tag.2.Value", "yes")
	res := executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create topic status = %d, body = %s", res.Code, res.Body.String())
	}
	topicARN := xmlElement(res.Body.String(), "TopicArn")

	values = url.Values{}
	values.Set("Action", "UntagResource")
	values.Set("ResourceArn", topicARN)
	values.Set("TagKeys.member.1", "remove")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("untag status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ListTagsForResource")
	values.Set("ResourceArn", topicARN)
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("list tags status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	if !strings.Contains(body, "<Key>keep</Key><Value>yes</Value>") {
		t.Fatalf("list tags missing kept tag in %s", body)
	}
	if strings.Contains(body, "<Key>remove</Key>") {
		t.Fatalf("list tags included removed tag in %s", body)
	}
}

func TestServiceRejectsSNSInvalidJSONMessageStructure(t *testing.T) {
	handler := newTestHandler()

	values := url.Values{}
	values.Set("Action", "CreateTopic")
	values.Set("Name", "json-validation")
	res := executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create topic status = %d, body = %s", res.Code, res.Body.String())
	}
	topicARN := xmlElement(res.Body.String(), "TopicArn")

	tests := []struct {
		name    string
		message string
	}{
		{name: "malformed", message: "not json"},
		{name: "missing default", message: `{"sqs":"payload"}`},
		{name: "non string default", message: `{"default":123}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			values = url.Values{}
			values.Set("Action", "Publish")
			values.Set("TopicArn", topicARN)
			values.Set("MessageStructure", "json")
			values.Set("Message", test.message)
			res = executeAWSQueryRequest(handler, "sns", values.Encode())
			if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "<Code>InvalidParameter</Code>") {
				t.Fatalf("publish status = %d, body = %s", res.Code, res.Body.String())
			}
		})
	}
}

func TestServiceHandlesSNSRawSQSPublishWithJSONMessageStructure(t *testing.T) {
	handler := newTestHandler()

	values := url.Values{}
	values.Set("Action", "CreateTopic")
	values.Set("Name", "raw-json")
	res := executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create topic status = %d, body = %s", res.Code, res.Body.String())
	}
	topicARN := xmlElement(res.Body.String(), "TopicArn")

	res = executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=raw-json-queue")
	if res.Code != http.StatusOK {
		t.Fatalf("create queue status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	values = url.Values{}
	values.Set("Action", "GetQueueAttributes")
	values.Set("QueueUrl", queueURL)
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("queue attrs status = %d, body = %s", res.Code, res.Body.String())
	}
	queueARN := xmlValueForName(res.Body.String(), "QueueArn")
	if queueARN == "" {
		t.Fatalf("missing queue arn in %s", res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "Subscribe")
	values.Set("TopicArn", topicARN)
	values.Set("Protocol", "sqs")
	values.Set("Endpoint", queueARN)
	values.Set("Attributes.entry.1.key", "RawMessageDelivery")
	values.Set("Attributes.entry.1.value", "true")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("subscribe status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "Publish")
	values.Set("TopicArn", topicARN)
	values.Set("MessageStructure", "json")
	values.Set("Message", `{"default":"default payload","sqs":"sqs payload"}`)
	values.Set("MessageAttributes.entry.1.Name", "json-attrs")
	values.Set("MessageAttributes.entry.1.Value.DataType", "String")
	values.Set("MessageAttributes.entry.1.Value.StringValue", "not-delivered")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("publish status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "1")
	values.Set("MessageAttributeName.1", "All")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	if !strings.Contains(body, "<Body>sqs payload</Body>") {
		t.Fatalf("receive missing raw SQS payload in %s", body)
	}
	for _, unexpected := range []string{"default payload", "&quot;Type&quot;:&quot;Notification&quot;", "<MessageAttribute>", "json-attrs", "not-delivered"} {
		if strings.Contains(body, unexpected) {
			t.Fatalf("receive included unexpected value %q in %s", unexpected, body)
		}
	}
}

func TestServiceHandlesSNSRawSQSPublishWithStringAttributes(t *testing.T) {
	handler := newTestHandler()

	values := url.Values{}
	values.Set("Action", "CreateTopic")
	values.Set("Name", "raw-string")
	res := executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create topic status = %d, body = %s", res.Code, res.Body.String())
	}
	topicARN := xmlElement(res.Body.String(), "TopicArn")

	res = executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=raw-string-queue")
	if res.Code != http.StatusOK {
		t.Fatalf("create queue status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	values = url.Values{}
	values.Set("Action", "GetQueueAttributes")
	values.Set("QueueUrl", queueURL)
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("queue attrs status = %d, body = %s", res.Code, res.Body.String())
	}
	queueARN := xmlValueForName(res.Body.String(), "QueueArn")
	if queueARN == "" {
		t.Fatalf("missing queue arn in %s", res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "Subscribe")
	values.Set("TopicArn", topicARN)
	values.Set("Protocol", "sqs")
	values.Set("Endpoint", queueARN)
	values.Set("Attributes.entry.1.key", "RawMessageDelivery")
	values.Set("Attributes.entry.1.value", "true")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("subscribe status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "Publish")
	values.Set("TopicArn", topicARN)
	values.Set("Message", "raw payload")
	values.Set("MessageAttributes.entry.1.Name", "trace")
	values.Set("MessageAttributes.entry.1.Value.DataType", "String")
	values.Set("MessageAttributes.entry.1.Value.StringValue", "abc123")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("publish status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "1")
	values.Set("MessageAttributeName.1", "All")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{"<Body>raw payload</Body>", "<MessageAttribute><Name>trace</Name>", "<StringValue>abc123</StringValue>", "<MD5OfMessageAttributes>"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("receive missing %q in %s", expected, body)
		}
	}
	if strings.Contains(body, "&quot;Type&quot;:&quot;Notification&quot;") {
		t.Fatalf("receive included SNS envelope in %s", body)
	}
}

func TestServiceHonorsSNSDeliverySQSDelaySeconds(t *testing.T) {
	handler := newTestHandler()

	values := url.Values{}
	values.Set("Action", "CreateTopic")
	values.Set("Name", "delayed-sns")
	res := executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create topic status = %d, body = %s", res.Code, res.Body.String())
	}
	topicARN := xmlElement(res.Body.String(), "TopicArn")

	values = url.Values{}
	values.Set("Action", "CreateQueue")
	values.Set("QueueName", "delayed-sns-queue")
	values.Set("Attribute.1.Name", "DelaySeconds")
	values.Set("Attribute.1.Value", "5")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create queue status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	values = url.Values{}
	values.Set("Action", "GetQueueAttributes")
	values.Set("QueueUrl", queueURL)
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("queue attrs status = %d, body = %s", res.Code, res.Body.String())
	}
	queueARN := xmlValueForName(res.Body.String(), "QueueArn")

	values = url.Values{}
	values.Set("Action", "Subscribe")
	values.Set("TopicArn", topicARN)
	values.Set("Protocol", "sqs")
	values.Set("Endpoint", queueARN)
	values.Set("Attributes.entry.1.key", "RawMessageDelivery")
	values.Set("Attributes.entry.1.value", "true")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("subscribe status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "Publish")
	values.Set("TopicArn", topicARN)
	values.Set("Message", "delayed payload")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("publish status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "1")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "<Message>") {
		t.Fatalf("delayed SNS message was visible immediately: %s", res.Body.String())
	}
}

func TestServiceDropsOversizedSNSDeliveryToSQS(t *testing.T) {
	handler := newTestHandler()

	values := url.Values{}
	values.Set("Action", "CreateTopic")
	values.Set("Name", "oversized-sns")
	res := executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create topic status = %d, body = %s", res.Code, res.Body.String())
	}
	topicARN := xmlElement(res.Body.String(), "TopicArn")

	values = url.Values{}
	values.Set("Action", "CreateQueue")
	values.Set("QueueName", "oversized-sns-queue")
	values.Set("Attribute.1.Name", "MaximumMessageSize")
	values.Set("Attribute.1.Value", "8")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create queue status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	values = url.Values{}
	values.Set("Action", "GetQueueAttributes")
	values.Set("QueueUrl", queueURL)
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("queue attrs status = %d, body = %s", res.Code, res.Body.String())
	}
	queueARN := xmlValueForName(res.Body.String(), "QueueArn")

	values = url.Values{}
	values.Set("Action", "Subscribe")
	values.Set("TopicArn", topicARN)
	values.Set("Protocol", "sqs")
	values.Set("Endpoint", queueARN)
	values.Set("Attributes.entry.1.key", "RawMessageDelivery")
	values.Set("Attributes.entry.1.value", "true")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("subscribe status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "Publish")
	values.Set("TopicArn", topicARN)
	values.Set("Message", "too-large-body")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("publish status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "1")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "<Message>") {
		t.Fatalf("oversized SNS delivery reached SQS: %s", res.Body.String())
	}
}

func TestServiceHandlesEventBridgeRuleAndSQSTarget(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=eventbridge-target")
	if res.Code != http.StatusOK {
		t.Fatalf("create queue status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	values := url.Values{}
	values.Set("Action", "GetQueueAttributes")
	values.Set("QueueUrl", queueURL)
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("queue attrs status = %d, body = %s", res.Code, res.Body.String())
	}
	queueARN := xmlValueForName(res.Body.String(), "QueueArn")

	res = executeAWSEventBridgeRequest(t, handler, "PutRule", map[string]any{
		"Name":         "orders",
		"EventPattern": `{"source":["app.orders"],"detail-type":["OrderCreated"],"detail":{"tenant":["acme"]}}`,
	})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"RuleArn"`) {
		t.Fatalf("put rule status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "PutTargets", map[string]any{
		"Rule": "orders",
		"Targets": []map[string]any{{
			"Id":  "queue",
			"Arn": queueARN,
		}},
	})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"FailedEntryCount":0`) {
		t.Fatalf("put targets status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "PutEvents", map[string]any{
		"Entries": []map[string]any{
			{"Source": "app.orders", "DetailType": "OrderCreated", "Detail": `{"tenant":"acme","id":"ord_1"}`, "Time": 1577934245},
			{"Source": "app.orders", "DetailType": "OrderCreated", "Detail": `{"tenant":"other","id":"ord_2"}`},
		},
	})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"FailedEntryCount":0`) {
		t.Fatalf("put events status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "10")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	if !strings.Contains(body, "ord_1") || strings.Contains(body, "ord_2") || !strings.Contains(body, "OrderCreated") || !strings.Contains(body, "2020-01-02T03:04:05Z") {
		t.Fatalf("unexpected EventBridge delivery body: %s", body)
	}
}

func TestServiceHandlesEventBridgeCustomBusTagsAndSNSTarget(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSEventBridgeRequest(t, handler, "CreateEventBus", map[string]any{
		"Name": "custom",
		"Tags": []map[string]any{{"Key": "env", "Value": "test"}},
	})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"EventBusArn"`) {
		t.Fatalf("create bus status = %d, body = %s", res.Code, res.Body.String())
	}
	var busOut struct {
		EventBusArn string
	}
	decodeJSONBody(t, res, &busOut)

	res = executeAWSEventBridgeRequest(t, handler, "ListTagsForResource", map[string]any{"ResourceARN": busOut.EventBusArn})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"Key":"env"`) {
		t.Fatalf("list bus tags status = %d, body = %s", res.Code, res.Body.String())
	}

	topicValues := url.Values{}
	topicValues.Set("Action", "CreateTopic")
	topicValues.Set("Name", "eventbridge-topic")
	res = executeAWSQueryRequest(handler, "sns", topicValues.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create topic status = %d, body = %s", res.Code, res.Body.String())
	}
	topicARN := xmlElement(res.Body.String(), "TopicArn")

	res = executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=eventbridge-sns-target")
	if res.Code != http.StatusOK {
		t.Fatalf("create queue status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	queueValues := url.Values{}
	queueValues.Set("Action", "GetQueueAttributes")
	queueValues.Set("QueueUrl", queueURL)
	res = executeAWSQueryRequest(handler, "sqs", queueValues.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("queue attrs status = %d, body = %s", res.Code, res.Body.String())
	}
	queueARN := xmlValueForName(res.Body.String(), "QueueArn")

	subscribeValues := url.Values{}
	subscribeValues.Set("Action", "Subscribe")
	subscribeValues.Set("TopicArn", topicARN)
	subscribeValues.Set("Protocol", "sqs")
	subscribeValues.Set("Endpoint", queueARN)
	res = executeAWSQueryRequest(handler, "sns", subscribeValues.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("subscribe status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "PutRule", map[string]any{
		"Name":         "billing",
		"EventBusName": "custom",
		"EventPattern": `{"resources":["invoice"],"detail":{"status":["paid"]}}`,
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put rule status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSEventBridgeRequest(t, handler, "PutTargets", map[string]any{
		"Rule":         "billing",
		"EventBusName": "custom",
		"Targets":      []map[string]any{{"Id": "topic", "Arn": topicARN}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put targets status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSEventBridgeRequest(t, handler, "PutEvents", map[string]any{
		"Entries": []map[string]any{{
			"EventBusName": "custom",
			"Source":       "app.billing",
			"DetailType":   "InvoiceUpdated",
			"Resources":    []string{"invoice"},
			"Detail":       `{"status":"paid","id":"inv_1"}`,
		}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put events status = %d, body = %s", res.Code, res.Body.String())
	}

	receiveValues := url.Values{}
	receiveValues.Set("Action", "ReceiveMessage")
	receiveValues.Set("QueueUrl", queueURL)
	receiveValues.Set("MaxNumberOfMessages", "1")
	res = executeAWSQueryRequest(handler, "sqs", receiveValues.Encode())
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "inv_1") || !strings.Contains(res.Body.String(), "&quot;Type&quot;:&quot;Notification&quot;") {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceDoesNotDeliverEventBridgePutEventsToScheduleOnlyRule(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "sqs", "Action=CreateQueue&QueueName=eventbridge-scheduled")
	if res.Code != http.StatusOK {
		t.Fatalf("create queue status = %d, body = %s", res.Code, res.Body.String())
	}
	queueURL := xmlElement(res.Body.String(), "QueueUrl")
	values := url.Values{}
	values.Set("Action", "GetQueueAttributes")
	values.Set("QueueUrl", queueURL)
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("queue attrs status = %d, body = %s", res.Code, res.Body.String())
	}
	queueARN := xmlValueForName(res.Body.String(), "QueueArn")

	res = executeAWSEventBridgeRequest(t, handler, "PutRule", map[string]any{
		"Name":               "scheduled",
		"ScheduleExpression": "rate(5 minutes)",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put scheduled rule status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "PutTargets", map[string]any{
		"Rule":    "scheduled",
		"Targets": []map[string]any{{"Id": "queue", "Arn": queueARN}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put scheduled target status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "PutEvents", map[string]any{
		"Entries": []map[string]any{{
			"Source":     "app.timer",
			"DetailType": "Tick",
			"Detail":     `{"id":"tick_1"}`,
		}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put events status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "1")
	res = executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "<Message>") {
		t.Fatalf("schedule-only rule received a PutEvents delivery: %s", res.Body.String())
	}
}

func TestServicePreservesEventBridgeRuleTagsOnPutRuleUpdate(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSEventBridgeRequest(t, handler, "PutRule", map[string]any{
		"Name":         "tagged",
		"EventPattern": `{}`,
		"Tags":         []map[string]any{{"Key": "env", "Value": "initial"}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("create rule status = %d, body = %s", res.Code, res.Body.String())
	}
	var created struct {
		RuleArn string
	}
	decodeJSONBody(t, res, &created)

	res = executeAWSEventBridgeRequest(t, handler, "PutRule", map[string]any{
		"Name":         "tagged",
		"EventPattern": `{"source":["app.updated"]}`,
		"Tags":         []map[string]any{{"Key": "env", "Value": "changed"}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("update rule status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "ListTagsForResource", map[string]any{"ResourceARN": created.RuleArn})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"Value":"initial"`) || strings.Contains(res.Body.String(), `"Value":"changed"`) {
		t.Fatalf("rule tags were not preserved on update: status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceAcceptsEventBridgeCloudTrailManagementState(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSEventBridgeRequest(t, handler, "PutRule", map[string]any{
		"Name":         "cloudtrail",
		"EventPattern": `{}`,
		"State":        "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put rule status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "DescribeRule", map[string]any{"Name": "cloudtrail"})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"State":"ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"`) {
		t.Fatalf("describe rule status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServicePaginatesEventBridgeLists(t *testing.T) {
	handler := newTestHandler()
	type eventBusPage struct {
		NextToken  string
		EventBuses []struct {
			Name string
		}
	}
	type rulePage struct {
		NextToken string
		Rules     []struct {
			Name string
		}
	}

	for _, name := range []string{"page-bus-a", "page-bus-b", "page-bus-c"} {
		res := executeAWSEventBridgeRequest(t, handler, "CreateEventBus", map[string]any{"Name": name})
		if res.Code != http.StatusOK {
			t.Fatalf("create bus %s status = %d, body = %s", name, res.Code, res.Body.String())
		}
	}

	res := executeAWSEventBridgeRequest(t, handler, "ListEventBuses", map[string]any{
		"NamePrefix": "page-bus-",
		"Limit":      2,
	})
	if res.Code != http.StatusOK {
		t.Fatalf("list buses page 1 status = %d, body = %s", res.Code, res.Body.String())
	}
	var busesPage eventBusPage
	decodeJSONBody(t, res, &busesPage)
	if busesPage.NextToken == "" || len(busesPage.EventBuses) != 2 || busesPage.EventBuses[0].Name != "page-bus-a" || busesPage.EventBuses[1].Name != "page-bus-b" {
		t.Fatalf("unexpected event bus page 1: %#v", busesPage)
	}

	res = executeAWSEventBridgeRequest(t, handler, "ListEventBuses", map[string]any{
		"NamePrefix": "page-bus-",
		"Limit":      2,
		"NextToken":  busesPage.NextToken,
	})
	if res.Code != http.StatusOK {
		t.Fatalf("list buses page 2 status = %d, body = %s", res.Code, res.Body.String())
	}
	busesPage = eventBusPage{}
	decodeJSONBody(t, res, &busesPage)
	if busesPage.NextToken != "" || len(busesPage.EventBuses) != 1 || busesPage.EventBuses[0].Name != "page-bus-c" {
		t.Fatalf("unexpected event bus page 2: %#v", busesPage)
	}

	for _, name := range []string{"page-rule-a", "page-rule-b", "page-rule-c"} {
		res = executeAWSEventBridgeRequest(t, handler, "PutRule", map[string]any{
			"Name":         name,
			"EventPattern": `{}`,
		})
		if res.Code != http.StatusOK {
			t.Fatalf("put rule %s status = %d, body = %s", name, res.Code, res.Body.String())
		}
	}

	res = executeAWSEventBridgeRequest(t, handler, "ListRules", map[string]any{
		"NamePrefix": "page-rule-",
		"Limit":      2,
	})
	if res.Code != http.StatusOK {
		t.Fatalf("list rules page 1 status = %d, body = %s", res.Code, res.Body.String())
	}
	var rulesPage rulePage
	decodeJSONBody(t, res, &rulesPage)
	if rulesPage.NextToken == "" || len(rulesPage.Rules) != 2 || rulesPage.Rules[0].Name != "page-rule-a" || rulesPage.Rules[1].Name != "page-rule-b" {
		t.Fatalf("unexpected rule page 1: %#v", rulesPage)
	}

	res = executeAWSEventBridgeRequest(t, handler, "ListRules", map[string]any{
		"NamePrefix": "page-rule-",
		"Limit":      2,
		"NextToken":  rulesPage.NextToken,
	})
	if res.Code != http.StatusOK {
		t.Fatalf("list rules page 2 status = %d, body = %s", res.Code, res.Body.String())
	}
	rulesPage = rulePage{}
	decodeJSONBody(t, res, &rulesPage)
	if rulesPage.NextToken != "" || len(rulesPage.Rules) != 1 || rulesPage.Rules[0].Name != "page-rule-c" {
		t.Fatalf("unexpected rule page 2: %#v", rulesPage)
	}
}

func TestServiceRequiresEventBridgeTargetsRemovedBeforeDeleteRule(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSEventBridgeRequest(t, handler, "PutRule", map[string]any{
		"Name":         "targeted",
		"EventPattern": `{}`,
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put rule status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "PutTargets", map[string]any{
		"Rule": "targeted",
		"Targets": []map[string]any{{
			"Id":  "queue",
			"Arn": "arn:aws:sqs:us-east-1:123456789012:targeted",
		}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put target status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "DeleteRule", map[string]any{"Name": "targeted"})
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "ValidationException") || !strings.Contains(res.Body.String(), "targets") {
		t.Fatalf("delete rule with target status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "ListTargetsByRule", map[string]any{"Rule": "targeted"})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"Id":"queue"`) {
		t.Fatalf("target was removed by failed delete: status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "RemoveTargets", map[string]any{
		"Rule": "targeted",
		"Ids":  []string{"queue"},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("remove target status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "DeleteRule", map[string]any{"Name": "targeted"})
	if res.Code != http.StatusOK {
		t.Fatalf("delete rule after removing target status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceRejectsEventBridgeNonObjectJSON(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSEventBridgeRequest(t, handler, "PutRule", map[string]any{
		"Name":         "null-pattern",
		"EventPattern": `null`,
	})
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "ValidationException") {
		t.Fatalf("put null pattern status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "PutEvents", map[string]any{
		"Entries": []map[string]any{{
			"Source":     "app.test",
			"DetailType": "NonObject",
			"Detail":     `null`,
		}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put null detail status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		FailedEntryCount int
		Entries          []struct {
			ErrorCode string
		}
	}
	decodeJSONBody(t, res, &body)
	if body.FailedEntryCount != 1 || len(body.Entries) != 1 || body.Entries[0].ErrorCode != "MalformedDetail" {
		t.Fatalf("unexpected null detail response: %#v", body)
	}
}

func TestServiceValidatesEventBridgePutEventsEntries(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSEventBridgeRequest(t, handler, "PutEvents", map[string]any{
		"Entries": []map[string]any{{
			"Source":     "app.missing",
			"DetailType": "MissingDetail",
		}},
	})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"FailedEntryCount":1`) || !strings.Contains(res.Body.String(), "Detail, DetailType, and Source are required") {
		t.Fatalf("missing detail status = %d, body = %s", res.Code, res.Body.String())
	}

	entries := make([]map[string]any, 11)
	for i := range entries {
		entries[i] = map[string]any{
			"Source":     "app.batch",
			"DetailType": "Batch",
			"Detail":     `{}`,
		}
	}
	res = executeAWSEventBridgeRequest(t, handler, "PutEvents", map[string]any{"Entries": entries})
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "ValidationException") {
		t.Fatalf("oversized batch status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceReturnsEventBridgeModeledErrors(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSEventBridgeRequest(t, handler, "PutRule", map[string]any{"Name": "bad"})
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "ValidationException") {
		t.Fatalf("validation status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequest(t, handler, "PutEvents", map[string]any{
		"Entries": []map[string]any{{"EventBusName": "missing", "Source": "app", "DetailType": "Test", "Detail": `{}`}},
	})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"FailedEntryCount":1`) || !strings.Contains(res.Body.String(), "ResourceNotFoundException") {
		t.Fatalf("missing bus status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceScopesEventBridgeTargetsByAccount(t *testing.T) {
	handler := newTestHandlerWithCredentialStore(auth.NewStore(
		auth.Credential{AccessKeyID: "AKIAEVENTSA", AccountID: "111111111111", PrincipalARN: "arn:aws:iam::111111111111:user/a"},
		auth.Credential{AccessKeyID: "AKIAEVENTSB", AccountID: "222222222222", PrincipalARN: "arn:aws:iam::222222222222:user/b"},
	))

	for _, accessKeyID := range []string{"AKIAEVENTSA", "AKIAEVENTSB"} {
		res := executeAWSEventBridgeRequestWithAccessKey(t, handler, "CreateEventBus", map[string]any{"Name": "shared"}, accessKeyID)
		if res.Code != http.StatusOK {
			t.Fatalf("create bus for %s status = %d, body = %s", accessKeyID, res.Code, res.Body.String())
		}
		res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "PutRule", map[string]any{
			"Name":         "same-rule",
			"EventBusName": "shared",
			"EventPattern": `{}`,
		}, accessKeyID)
		if res.Code != http.StatusOK {
			t.Fatalf("put rule for %s status = %d, body = %s", accessKeyID, res.Code, res.Body.String())
		}
	}

	res := executeAWSEventBridgeRequestWithAccessKey(t, handler, "PutTargets", map[string]any{
		"Rule":         "same-rule",
		"EventBusName": "shared",
		"Targets": []map[string]any{{
			"Id":  "target",
			"Arn": "arn:aws:sqs:us-east-1:111111111111:queue-a",
		}},
	}, "AKIAEVENTSA")
	if res.Code != http.StatusOK {
		t.Fatalf("put target for account A status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "ListTargetsByRule", map[string]any{
		"Rule":         "same-rule",
		"EventBusName": "shared",
	}, "AKIAEVENTSB")
	if res.Code != http.StatusOK {
		t.Fatalf("list targets for account B status = %d, body = %s", res.Code, res.Body.String())
	}
	var listed struct {
		Targets []struct {
			ID  string `json:"Id"`
			Arn string `json:"Arn"`
		}
	}
	decodeJSONBody(t, res, &listed)
	if len(listed.Targets) != 0 {
		t.Fatalf("account B saw account A targets: %#v", listed.Targets)
	}

	res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "RemoveTargets", map[string]any{
		"Rule":         "same-rule",
		"EventBusName": "shared",
		"Ids":          []string{"target"},
	}, "AKIAEVENTSB")
	if res.Code != http.StatusOK {
		t.Fatalf("remove target for account B status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "ListTargetsByRule", map[string]any{
		"Rule":         "same-rule",
		"EventBusName": "shared",
	}, "AKIAEVENTSA")
	if res.Code != http.StatusOK {
		t.Fatalf("list targets for account A status = %d, body = %s", res.Code, res.Body.String())
	}
	decodeJSONBody(t, res, &listed)
	if len(listed.Targets) != 1 || listed.Targets[0].Arn != "arn:aws:sqs:us-east-1:111111111111:queue-a" {
		t.Fatalf("account A target was not preserved: %#v", listed.Targets)
	}

	res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "PutTargets", map[string]any{
		"Rule":         "same-rule",
		"EventBusName": "shared",
		"Targets": []map[string]any{{
			"Id":  "target",
			"Arn": "arn:aws:sqs:us-east-1:222222222222:queue-b",
		}},
	}, "AKIAEVENTSB")
	if res.Code != http.StatusOK {
		t.Fatalf("put target for account B status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "ListTargetsByRule", map[string]any{
		"Rule":         "same-rule",
		"EventBusName": "shared",
	}, "AKIAEVENTSA")
	if res.Code != http.StatusOK {
		t.Fatalf("list targets for account A after account B put status = %d, body = %s", res.Code, res.Body.String())
	}
	decodeJSONBody(t, res, &listed)
	if len(listed.Targets) != 1 || listed.Targets[0].Arn != "arn:aws:sqs:us-east-1:111111111111:queue-a" {
		t.Fatalf("account B target update affected account A: %#v", listed.Targets)
	}
}

func TestServiceProvidesEventBridgeDefaultBusPerAccount(t *testing.T) {
	handler := newTestHandlerWithCredentialStore(auth.NewStore(
		auth.Credential{AccessKeyID: "AKIAEVENTSA", AccountID: "111111111111", PrincipalARN: "arn:aws:iam::111111111111:user/a"},
		auth.Credential{AccessKeyID: "AKIAEVENTSB", AccountID: "222222222222", PrincipalARN: "arn:aws:iam::222222222222:user/b"},
	))

	for _, test := range []struct {
		accessKeyID string
		accountID   string
	}{
		{accessKeyID: "AKIAEVENTSA", accountID: "111111111111"},
		{accessKeyID: "AKIAEVENTSB", accountID: "222222222222"},
	} {
		res := executeAWSEventBridgeRequestWithAccessKey(t, handler, "PutRule", map[string]any{
			"Name":         "default-rule",
			"EventPattern": `{}`,
		}, test.accessKeyID)
		if res.Code != http.StatusOK {
			t.Fatalf("put default rule for %s status = %d, body = %s", test.accountID, res.Code, res.Body.String())
		}
		if !strings.Contains(res.Body.String(), `"RuleArn":"arn:aws:events:us-east-1:`+test.accountID+`:rule/default-rule"`) {
			t.Fatalf("put default rule for %s returned wrong ARN: %s", test.accountID, res.Body.String())
		}

		res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "ListEventBuses", map[string]any{}, test.accessKeyID)
		if res.Code != http.StatusOK {
			t.Fatalf("list buses for %s status = %d, body = %s", test.accountID, res.Code, res.Body.String())
		}
		if !strings.Contains(res.Body.String(), `"Arn":"arn:aws:events:us-east-1:`+test.accountID+`:event-bus/default"`) {
			t.Fatalf("list buses for %s missing scoped default bus: %s", test.accountID, res.Body.String())
		}
	}
}

func TestServiceDoesNotResolveForeignEventBridgeBusARNToLocalBus(t *testing.T) {
	handler := newTestHandlerWithCredentialStore(auth.NewStore(
		auth.Credential{AccessKeyID: "AKIAEVENTSA", AccountID: "111111111111", PrincipalARN: "arn:aws:iam::111111111111:user/a"},
		auth.Credential{AccessKeyID: "AKIAEVENTSB", AccountID: "222222222222", PrincipalARN: "arn:aws:iam::222222222222:user/b"},
	))

	for _, accessKeyID := range []string{"AKIAEVENTSA", "AKIAEVENTSB"} {
		res := executeAWSEventBridgeRequestWithAccessKey(t, handler, "CreateEventBus", map[string]any{"Name": "shared"}, accessKeyID)
		if res.Code != http.StatusOK {
			t.Fatalf("create shared bus for %s status = %d, body = %s", accessKeyID, res.Code, res.Body.String())
		}
	}

	foreignARN := "arn:aws:events:us-east-1:222222222222:event-bus/shared"
	res := executeAWSEventBridgeRequestWithAccessKey(t, handler, "DeleteEventBus", map[string]any{"Name": foreignARN}, "AKIAEVENTSA")
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "ResourceNotFoundException") {
		t.Fatalf("delete foreign ARN status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "ListEventBuses", map[string]any{"NamePrefix": "shared"}, "AKIAEVENTSA")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"Arn":"arn:aws:events:us-east-1:111111111111:event-bus/shared"`) {
		t.Fatalf("local same-name bus was not preserved: status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "PutRule", map[string]any{
		"Name":         "foreign-rule",
		"EventBusName": foreignARN,
		"EventPattern": `{}`,
	}, "AKIAEVENTSA")
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "ResourceNotFoundException") {
		t.Fatalf("put rule with foreign ARN status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "ListRules", map[string]any{"EventBusName": "shared"}, "AKIAEVENTSA")
	if res.Code != http.StatusOK || strings.Contains(res.Body.String(), "foreign-rule") {
		t.Fatalf("foreign ARN created or exposed a local rule: status = %d, body = %s", res.Code, res.Body.String())
	}

	localARN := "arn:aws:events:us-east-1:111111111111:event-bus/shared"
	res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "PutRule", map[string]any{
		"Name":         "local-rule",
		"EventBusName": localARN,
		"EventPattern": `{}`,
	}, "AKIAEVENTSA")
	if res.Code != http.StatusOK {
		t.Fatalf("put rule with local ARN status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSEventBridgeRequestWithAccessKey(t, handler, "PutEvents", map[string]any{
		"Entries": []map[string]any{{
			"EventBusName": foreignARN,
			"Source":       "app.test",
			"DetailType":   "Foreign",
			"Detail":       `{}`,
		}},
	}, "AKIAEVENTSA")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"FailedEntryCount":1`) || !strings.Contains(res.Body.String(), "ResourceNotFoundException") {
		t.Fatalf("put events with foreign ARN status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceRejectsUnsupportedEventBridgeTargetInputShaping(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSEventBridgeRequest(t, handler, "PutRule", map[string]any{
		"Name":         "input-shaping",
		"EventPattern": `{}`,
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put rule status = %d, body = %s", res.Code, res.Body.String())
	}

	for _, test := range []struct {
		name   string
		target map[string]any
	}{
		{
			name: "input path",
			target: map[string]any{
				"Id":        "path",
				"Arn":       "arn:aws:sqs:us-east-1:123456789012:queue",
				"InputPath": "$.detail",
			},
		},
		{
			name: "input transformer",
			target: map[string]any{
				"Id":  "transformer",
				"Arn": "arn:aws:sqs:us-east-1:123456789012:queue",
				"InputTransformer": map[string]any{
					"InputTemplate": `"transformed"`,
				},
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			res := executeAWSEventBridgeRequest(t, handler, "PutTargets", map[string]any{
				"Rule":    "input-shaping",
				"Targets": []map[string]any{test.target},
			})
			if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "ValidationException") || !strings.Contains(res.Body.String(), "not supported") {
				t.Fatalf("put target status = %d, body = %s", res.Code, res.Body.String())
			}
		})
	}
}

func TestServiceHandlesSNSTagsPermissionsAndErrors(t *testing.T) {
	handler := newTestHandler()

	values := url.Values{}
	values.Set("Action", "CreateTopic")
	values.Set("Name", "ops")
	res := executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create topic status = %d, body = %s", res.Code, res.Body.String())
	}
	topicARN := xmlElement(res.Body.String(), "TopicArn")

	values = url.Values{}
	values.Set("Action", "Subscribe")
	values.Set("TopicArn", topicARN)
	values.Set("Protocol", "email")
	values.Set("Endpoint", "ops@example.com")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("subscribe status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ConfirmSubscription")
	values.Set("TopicArn", topicARN)
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "<Code>InvalidParameter</Code>") {
		t.Fatalf("confirm missing token status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "TagResource")
	values.Set("ResourceArn", topicARN)
	values.Set("Tags.member.1.Key", "team")
	values.Set("Tags.member.1.Value", "platform")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("tag status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "ListTagsForResource")
	values.Set("ResourceArn", topicARN)
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "<Key>team</Key><Value>platform</Value>") {
		t.Fatalf("list tags status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "AddPermission")
	values.Set("TopicArn", topicARN)
	values.Set("Label", "publishers")
	values.Set("AWSAccountId.member.1", "111122223333")
	values.Set("ActionName.member.1", "Publish")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("add permission status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "GetTopicAttributes")
	values.Set("TopicArn", topicARN)
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "publishers") || !strings.Contains(res.Body.String(), "111122223333") {
		t.Fatalf("policy status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "RemovePermission")
	values.Set("TopicArn", topicARN)
	values.Set("Label", "publishers")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("remove permission status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "Publish")
	values.Set("TopicArn", "arn:aws:sns:us-east-1:123456789012:missing")
	values.Set("Message", "hello")
	res = executeAWSQueryRequest(handler, "sns", values.Encode())
	if res.Code != http.StatusNotFound || !strings.Contains(res.Body.String(), "<Code>NotFound</Code>") {
		t.Fatalf("missing topic status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesIAMLifecycleAndAccessKeys(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSQueryRequest(handler, "iam", "Action=ListUsers")
	if res.Code != http.StatusOK {
		t.Fatalf("list users status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<ListUsersResponse>") || !strings.Contains(body, "admin") {
		t.Fatalf("unexpected list users body: %s", body)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=developer&Path=/team/")
	if res.Code != http.StatusOK {
		t.Fatalf("create user status = %d, body = %s", res.Code, res.Body.String())
	}
	developerARN := xmlElement(res.Body.String(), "Arn")
	if !strings.Contains(developerARN, ":user/team/developer") {
		t.Fatalf("developer arn = %q", developerARN)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=developer")
	if res.Code != http.StatusConflict {
		t.Fatalf("duplicate create status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=GetUser&UserName=developer")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "<GetUserResponse>") {
		t.Fatalf("get user status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=CreateAccessKey&UserName=developer")
	if res.Code != http.StatusOK {
		t.Fatalf("create key status = %d, body = %s", res.Code, res.Body.String())
	}
	accessKeyID := xmlElement(res.Body.String(), "AccessKeyId")
	if !strings.HasPrefix(accessKeyID, "AKIA") {
		t.Fatalf("access key id = %q", accessKeyID)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListAccessKeys&UserName=developer")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), accessKeyID) {
		t.Fatalf("list keys status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequestWithAccessKey(handler, "sts", "Action=GetCallerIdentity", accessKeyID)
	if res.Code != http.StatusOK {
		t.Fatalf("caller identity status = %d, body = %s", res.Code, res.Body.String())
	}
	if arn := xmlElement(res.Body.String(), "Arn"); arn != developerARN {
		t.Fatalf("caller arn = %q, want %q", arn, developerARN)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteAccessKey&UserName=developer&AccessKeyId="+url.QueryEscape(accessKeyID))
	if res.Code != http.StatusOK {
		t.Fatalf("delete key status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteUser&UserName=developer")
	if res.Code != http.StatusOK {
		t.Fatalf("delete user status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=GetUser&UserName=developer")
	if res.Code != http.StatusNotFound {
		t.Fatalf("get deleted user status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesIAMRolesAndSTS(t *testing.T) {
	handler := newTestHandler()
	policy := `{"Version":"2012-10-17","Statement":[]}`

	res := executeAWSQueryRequest(handler, "iam", "Action=CreateRole&RoleName=worker&Description=Worker+role&AssumeRolePolicyDocument="+url.QueryEscape(policy))
	if res.Code != http.StatusOK {
		t.Fatalf("create role status = %d, body = %s", res.Code, res.Body.String())
	}
	roleARN := xmlElement(res.Body.String(), "Arn")
	if !strings.Contains(roleARN, ":role/worker") {
		t.Fatalf("role arn = %q", roleARN)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=GetRole&RoleName=worker")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "Worker role") {
		t.Fatalf("get role status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListRoles")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "worker") {
		t.Fatalf("list roles status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "sts", "Action=GetCallerIdentity")
	if res.Code != http.StatusOK {
		t.Fatalf("caller identity status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<GetCallerIdentityResponse>") || !strings.Contains(body, "<Account>123456789012</Account>") {
		t.Fatalf("unexpected caller identity body: %s", body)
	}

	res = executeAWSQueryRequest(handler, "sts", "Action=AssumeRole&RoleArn="+url.QueryEscape(roleARN)+"&RoleSessionName=test-session")
	if res.Code != http.StatusOK {
		t.Fatalf("assume role status = %d, body = %s", res.Code, res.Body.String())
	}
	assumedAccessKey := xmlElement(res.Body.String(), "AccessKeyId")
	sessionToken := xmlElement(res.Body.String(), "SessionToken")
	if !strings.HasPrefix(assumedAccessKey, "ASIA") || !strings.Contains(res.Body.String(), "<SessionToken>") {
		t.Fatalf("unexpected assume role body: %s", res.Body.String())
	}

	res = executeAWSQueryRequestWithAccessKeyAndToken(handler, "sts", "Action=GetCallerIdentity", assumedAccessKey, sessionToken)
	if res.Code != http.StatusOK {
		t.Fatalf("assumed caller status = %d, body = %s", res.Code, res.Body.String())
	}
	expectedAssumedARN := "arn:aws:sts::123456789012:assumed-role/worker/test-session"
	if arn := xmlElement(res.Body.String(), "Arn"); arn != expectedAssumedARN {
		t.Fatalf("assumed arn = %q, want %q", arn, expectedAssumedARN)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteRole&RoleName=worker")
	if res.Code != http.StatusOK {
		t.Fatalf("delete role status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesIAMPoliciesAndSTSSessionMetadata(t *testing.T) {
	handler := newTestHandler()
	policyDocument := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListBucket","Resource":"*"}]}`

	res := executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=policy-user")
	if res.Code != http.StatusOK {
		t.Fatalf("create user status = %d, body = %s", res.Code, res.Body.String())
	}

	values := url.Values{}
	values.Set("Action", "PutUserPolicy")
	values.Set("UserName", "policy-user")
	values.Set("PolicyName", "inline-user")
	values.Set("PolicyDocument", policyDocument)
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("put user policy status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListUserPolicies&UserName=policy-user")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "<member>inline-user</member>") {
		t.Fatalf("list user policies status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=GetUserPolicy&UserName=policy-user&PolicyName=inline-user")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), url.QueryEscape(policyDocument)) {
		t.Fatalf("get user policy status = %d, body = %s", res.Code, res.Body.String())
	}

	assumePolicy := `{"Version":"2012-10-17","Statement":[]}`
	res = executeAWSQueryRequest(handler, "iam", "Action=CreateRole&RoleName=policy-role&AssumeRolePolicyDocument="+url.QueryEscape(assumePolicy))
	if res.Code != http.StatusOK {
		t.Fatalf("create role status = %d, body = %s", res.Code, res.Body.String())
	}
	roleARN := xmlElement(res.Body.String(), "Arn")

	values = url.Values{}
	values.Set("Action", "PutRolePolicy")
	values.Set("RoleName", "policy-role")
	values.Set("PolicyName", "inline-role")
	values.Set("PolicyDocument", policyDocument)
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("put role policy status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListRolePolicies&RoleName=policy-role")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "<member>inline-role</member>") {
		t.Fatalf("list role policies status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "CreatePolicy")
	values.Set("PolicyName", "managed-policy")
	values.Set("Path", "/team/")
	values.Set("Description", "Managed policy")
	values.Set("PolicyDocument", policyDocument)
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create policy status = %d, body = %s", res.Code, res.Body.String())
	}
	policyARN := xmlElement(res.Body.String(), "Arn")
	if policyARN != "arn:aws:iam::123456789012:policy/team/managed-policy" {
		t.Fatalf("policy arn = %q, body = %s", policyARN, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=GetPolicy&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "<AttachmentCount>0</AttachmentCount>") {
		t.Fatalf("get policy status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=GetPolicyVersion&PolicyArn="+url.QueryEscape(policyARN)+"&VersionId=v1")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), url.QueryEscape(policyDocument)) {
		t.Fatalf("get policy version status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=GetPolicyVersion&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "ValidationError") {
		t.Fatalf("get policy version without version status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=AttachUserPolicy&UserName=policy-user&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("attach user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=AttachRolePolicy&RoleName=policy-role&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("attach role policy status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListAttachedUserPolicies&UserName=policy-user")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "<PolicyArn>"+policyARN+"</PolicyArn>") {
		t.Fatalf("list attached user policies status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=ListAttachedRolePolicies&RoleName=policy-role")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "<PolicyArn>"+policyARN+"</PolicyArn>") {
		t.Fatalf("list attached role policies status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=GetPolicy&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "<AttachmentCount>2</AttachmentCount>") {
		t.Fatalf("get attached policy status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "AssumeRole")
	values.Set("RoleArn", roleARN)
	values.Set("RoleSessionName", "tagged-session")
	values.Set("DurationSeconds", "1800")
	values.Set("Tags.member.1.Key", "env")
	values.Set("Tags.member.1.Value", "test")
	values.Set("TransitiveTagKeys.member.1", "env")
	res = executeAWSQueryRequest(handler, "sts", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("assume role with tags status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<PackedPolicySize>0</PackedPolicySize>") || !strings.Contains(body, "<Expiration>") {
		t.Fatalf("unexpected assume role metadata body: %s", body)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DetachUserPolicy&UserName=policy-user&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("detach user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DetachRolePolicy&RoleName=policy-role&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("detach role policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeletePolicy&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("delete policy status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesAWSManagedPolicyAttachments(t *testing.T) {
	handler := newTestHandler()
	assumePolicy := `{"Version":"2012-10-17","Statement":[]}`
	managedPolicyARN := "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

	res := executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=aws-managed-policy-user")
	if res.Code != http.StatusOK {
		t.Fatalf("create user status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=CreateRole&RoleName=aws-managed-policy-role&AssumeRolePolicyDocument="+url.QueryEscape(assumePolicy))
	if res.Code != http.StatusOK {
		t.Fatalf("create role status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=AttachUserPolicy&UserName=aws-managed-policy-user&PolicyArn="+url.QueryEscape(managedPolicyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("attach user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=AttachRolePolicy&RoleName=aws-managed-policy-role&PolicyArn="+url.QueryEscape(managedPolicyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("attach role policy status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListAttachedUserPolicies&UserName=aws-managed-policy-user&PathPrefix=%2Fservice-role%2F")
	if res.Code != http.StatusOK {
		t.Fatalf("list attached user policies status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<PolicyName>AWSLambdaBasicExecutionRole</PolicyName>") || !strings.Contains(body, "<PolicyArn>"+managedPolicyARN+"</PolicyArn>") {
		t.Fatalf("unexpected user attached policy body: %s", body)
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=ListAttachedRolePolicies&RoleName=aws-managed-policy-role&PathPrefix=%2Fservice-role%2F")
	if res.Code != http.StatusOK {
		t.Fatalf("list attached role policies status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "<PolicyName>AWSLambdaBasicExecutionRole</PolicyName>") || !strings.Contains(body, "<PolicyArn>"+managedPolicyARN+"</PolicyArn>") {
		t.Fatalf("unexpected role attached policy body: %s", body)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DetachUserPolicy&UserName=aws-managed-policy-user&PolicyArn="+url.QueryEscape(managedPolicyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("detach user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DetachRolePolicy&RoleName=aws-managed-policy-role&PolicyArn="+url.QueryEscape(managedPolicyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("detach role policy status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceRejectsDuplicateManagedPolicyNames(t *testing.T) {
	handler := newTestHandler()
	policyDocument := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListBucket","Resource":"*"}]}`

	values := url.Values{}
	values.Set("Action", "CreatePolicy")
	values.Set("PolicyName", "duplicate-managed-policy")
	values.Set("Path", "/team-a/")
	values.Set("PolicyDocument", policyDocument)
	res := executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create first policy status = %d, body = %s", res.Code, res.Body.String())
	}

	values.Set("Path", "/team-b/")
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusConflict {
		t.Fatalf("create duplicate policy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "EntityAlreadyExists") {
		t.Fatalf("create duplicate policy body = %s", res.Body.String())
	}

	values.Set("PolicyName", "DUPLICATE-MANAGED-POLICY")
	values.Set("Path", "/team-c/")
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusConflict {
		t.Fatalf("create case duplicate policy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "EntityAlreadyExists") {
		t.Fatalf("create case duplicate policy body = %s", res.Body.String())
	}
}

func TestServiceFiltersManagedPolicies(t *testing.T) {
	handler := newTestHandler()
	policyDocument := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListBucket","Resource":"*"}]}`

	res := executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=list-policy-filter-user")
	if res.Code != http.StatusOK {
		t.Fatalf("create user status = %d, body = %s", res.Code, res.Body.String())
	}

	values := url.Values{}
	values.Set("Action", "CreatePolicy")
	values.Set("PolicyName", "attached-filter-policy")
	values.Set("PolicyDocument", policyDocument)
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create attached policy status = %d, body = %s", res.Code, res.Body.String())
	}
	attachedARN := xmlElement(res.Body.String(), "Arn")

	values.Set("PolicyName", "unattached-filter-policy")
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create unattached policy status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=AttachUserPolicy&UserName=list-policy-filter-user&PolicyArn="+url.QueryEscape(attachedARN))
	if res.Code != http.StatusOK {
		t.Fatalf("attach policy status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListPolicies&Scope=AWS")
	if res.Code != http.StatusOK {
		t.Fatalf("list aws scoped policies status = %d, body = %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "attached-filter-policy") || strings.Contains(res.Body.String(), "unattached-filter-policy") {
		t.Fatalf("aws scoped policies included local policies: %s", res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListPolicies&Scope=Local")
	if res.Code != http.StatusOK {
		t.Fatalf("list local policies status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "attached-filter-policy") || !strings.Contains(res.Body.String(), "unattached-filter-policy") {
		t.Fatalf("local scoped policies missing local policies: %s", res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListPolicies&OnlyAttached=true")
	if res.Code != http.StatusOK {
		t.Fatalf("list attached policies status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "attached-filter-policy") || strings.Contains(res.Body.String(), "unattached-filter-policy") {
		t.Fatalf("attached-only policies were not filtered: %s", res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListPolicies&Scope=Invalid")
	if res.Code != http.StatusBadRequest {
		t.Fatalf("invalid scope status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "InvalidInput") {
		t.Fatalf("invalid scope body = %s", res.Body.String())
	}
}

func TestServiceFiltersAttachedManagedPolicyPathPrefixes(t *testing.T) {
	handler := newTestHandler()
	policyDocument := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListBucket","Resource":"*"}]}`
	assumePolicy := `{"Version":"2012-10-17","Statement":[]}`

	res := executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=attached-path-user")
	if res.Code != http.StatusOK {
		t.Fatalf("create user status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=CreateRole&RoleName=attached-path-role&AssumeRolePolicyDocument="+url.QueryEscape(assumePolicy))
	if res.Code != http.StatusOK {
		t.Fatalf("create role status = %d, body = %s", res.Code, res.Body.String())
	}

	values := url.Values{}
	values.Set("Action", "CreatePolicy")
	values.Set("PolicyName", "team-attached-path-policy")
	values.Set("Path", "/team/")
	values.Set("PolicyDocument", policyDocument)
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create team policy status = %d, body = %s", res.Code, res.Body.String())
	}
	teamARN := xmlElement(res.Body.String(), "Arn")

	values.Set("PolicyName", "other-attached-path-policy")
	values.Set("Path", "/other/")
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create other policy status = %d, body = %s", res.Code, res.Body.String())
	}
	otherARN := xmlElement(res.Body.String(), "Arn")

	for _, policyARN := range []string{teamARN, otherARN} {
		res = executeAWSQueryRequest(handler, "iam", "Action=AttachUserPolicy&UserName=attached-path-user&PolicyArn="+url.QueryEscape(policyARN))
		if res.Code != http.StatusOK {
			t.Fatalf("attach user policy %s status = %d, body = %s", policyARN, res.Code, res.Body.String())
		}
		res = executeAWSQueryRequest(handler, "iam", "Action=AttachRolePolicy&RoleName=attached-path-role&PolicyArn="+url.QueryEscape(policyARN))
		if res.Code != http.StatusOK {
			t.Fatalf("attach role policy %s status = %d, body = %s", policyARN, res.Code, res.Body.String())
		}
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListAttachedUserPolicies&UserName=attached-path-user&PathPrefix=%2Fteam%2F")
	if res.Code != http.StatusOK {
		t.Fatalf("list attached user policies status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "team-attached-path-policy") || strings.Contains(body, "other-attached-path-policy") {
		t.Fatalf("user path prefix filter body = %s", body)
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=ListAttachedRolePolicies&RoleName=attached-path-role&PathPrefix=%2Fteam%2F")
	if res.Code != http.StatusOK {
		t.Fatalf("list attached role policies status = %d, body = %s", res.Code, res.Body.String())
	}
	if body := res.Body.String(); !strings.Contains(body, "team-attached-path-policy") || strings.Contains(body, "other-attached-path-policy") {
		t.Fatalf("role path prefix filter body = %s", body)
	}
}

func TestServiceRejectsMalformedIAMPolicyDocuments(t *testing.T) {
	handler := newTestHandler()
	assumePolicy := `{"Version":"2012-10-17","Statement":[]}`

	res := executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=malformed-policy-user")
	if res.Code != http.StatusOK {
		t.Fatalf("create user status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=CreateRole&RoleName=malformed-policy-role&AssumeRolePolicyDocument="+url.QueryEscape(assumePolicy))
	if res.Code != http.StatusOK {
		t.Fatalf("create role status = %d, body = %s", res.Code, res.Body.String())
	}

	tests := []struct {
		name   string
		values url.Values
	}{
		{
			name: "inline user policy",
			values: url.Values{
				"Action":         {"PutUserPolicy"},
				"UserName":       {"malformed-policy-user"},
				"PolicyName":     {"bad-inline-user"},
				"PolicyDocument": {"{"},
			},
		},
		{
			name: "inline role policy",
			values: url.Values{
				"Action":         {"PutRolePolicy"},
				"RoleName":       {"malformed-policy-role"},
				"PolicyName":     {"bad-inline-role"},
				"PolicyDocument": {"[]"},
			},
		},
		{
			name: "managed policy",
			values: url.Values{
				"Action":         {"CreatePolicy"},
				"PolicyName":     {"bad-managed-policy"},
				"PolicyDocument": {""},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			res := executeAWSQueryRequest(handler, "iam", test.values.Encode())
			if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "MalformedPolicyDocument") {
				t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
			}
		})
	}
}

func TestServiceRejectsPolicyDeleteAndDetachInconsistentState(t *testing.T) {
	handler := newTestHandler()
	policyDocument := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListBucket","Resource":"*"}]}`
	assumePolicy := `{"Version":"2012-10-17","Statement":[]}`

	res := executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=attached-policy-user")
	if res.Code != http.StatusOK {
		t.Fatalf("create user status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=CreateRole&RoleName=attached-policy-role&AssumeRolePolicyDocument="+url.QueryEscape(assumePolicy))
	if res.Code != http.StatusOK {
		t.Fatalf("create role status = %d, body = %s", res.Code, res.Body.String())
	}

	values := url.Values{}
	values.Set("Action", "CreatePolicy")
	values.Set("PolicyName", "attached-managed-policy")
	values.Set("PolicyDocument", policyDocument)
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create policy status = %d, body = %s", res.Code, res.Body.String())
	}
	policyARN := xmlElement(res.Body.String(), "Arn")

	res = executeAWSQueryRequest(handler, "iam", "Action=AttachUserPolicy&UserName=attached-policy-user&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("attach user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=AttachRolePolicy&RoleName=attached-policy-role&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("attach role policy status = %d, body = %s", res.Code, res.Body.String())
	}

	missingPolicyARN := "arn:aws:iam::123456789012:policy/missing"
	res = executeAWSQueryRequest(handler, "iam", "Action=DetachUserPolicy&UserName=attached-policy-user&PolicyArn="+url.QueryEscape(missingPolicyARN))
	if res.Code != http.StatusNotFound || !strings.Contains(res.Body.String(), "NoSuchEntity") {
		t.Fatalf("detach missing user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DetachRolePolicy&RoleName=attached-policy-role&PolicyArn="+url.QueryEscape(missingPolicyARN))
	if res.Code != http.StatusNotFound || !strings.Contains(res.Body.String(), "NoSuchEntity") {
		t.Fatalf("detach missing role policy status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DeletePolicy&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusConflict || !strings.Contains(res.Body.String(), "DeleteConflict") {
		t.Fatalf("delete attached policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=GetPolicy&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "<AttachmentCount>2</AttachmentCount>") {
		t.Fatalf("get attached policy status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DetachUserPolicy&UserName=attached-policy-user&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("detach user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeletePolicy&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusConflict || !strings.Contains(res.Body.String(), "DeleteConflict") {
		t.Fatalf("delete policy with role attachment status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DetachRolePolicy&RoleName=attached-policy-role&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("detach role policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeletePolicy&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("delete detached policy status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceRejectsIAMOwnerDeleteWithPolicies(t *testing.T) {
	handler := newTestHandler()
	policyDocument := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListBucket","Resource":"*"}]}`
	assumePolicy := `{"Version":"2012-10-17","Statement":[]}`

	res := executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=delete-policy-user")
	if res.Code != http.StatusOK {
		t.Fatalf("create user status = %d, body = %s", res.Code, res.Body.String())
	}
	values := url.Values{}
	values.Set("Action", "PutUserPolicy")
	values.Set("UserName", "delete-policy-user")
	values.Set("PolicyName", "inline-user")
	values.Set("PolicyDocument", policyDocument)
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("put user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteUser&UserName=delete-policy-user")
	if res.Code != http.StatusConflict {
		t.Fatalf("delete user with inline policy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "DeleteConflict") {
		t.Fatalf("delete user with inline policy body = %s", res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteUserPolicy&UserName=delete-policy-user&PolicyName=inline-user")
	if res.Code != http.StatusOK {
		t.Fatalf("delete user policy status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=CreateRole&RoleName=delete-policy-role&AssumeRolePolicyDocument="+url.QueryEscape(assumePolicy))
	if res.Code != http.StatusOK {
		t.Fatalf("create role status = %d, body = %s", res.Code, res.Body.String())
	}
	values = url.Values{}
	values.Set("Action", "PutRolePolicy")
	values.Set("RoleName", "delete-policy-role")
	values.Set("PolicyName", "inline-role")
	values.Set("PolicyDocument", policyDocument)
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("put role policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteRole&RoleName=delete-policy-role")
	if res.Code != http.StatusConflict {
		t.Fatalf("delete role with inline policy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "DeleteConflict") {
		t.Fatalf("delete role with inline policy body = %s", res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteRolePolicy&RoleName=delete-policy-role&PolicyName=inline-role")
	if res.Code != http.StatusOK {
		t.Fatalf("delete role policy status = %d, body = %s", res.Code, res.Body.String())
	}

	values = url.Values{}
	values.Set("Action", "CreatePolicy")
	values.Set("PolicyName", "delete-owner-managed-policy")
	values.Set("PolicyDocument", policyDocument)
	res = executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create managed policy status = %d, body = %s", res.Code, res.Body.String())
	}
	policyARN := xmlElement(res.Body.String(), "Arn")

	res = executeAWSQueryRequest(handler, "iam", "Action=AttachUserPolicy&UserName=delete-policy-user&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("attach user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=AttachRolePolicy&RoleName=delete-policy-role&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("attach role policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteUser&UserName=delete-policy-user")
	if res.Code != http.StatusConflict {
		t.Fatalf("delete user with attached policy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "DeleteConflict") {
		t.Fatalf("delete user with attached policy body = %s", res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteRole&RoleName=delete-policy-role")
	if res.Code != http.StatusConflict {
		t.Fatalf("delete role with attached policy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "DeleteConflict") {
		t.Fatalf("delete role with attached policy body = %s", res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DetachUserPolicy&UserName=delete-policy-user&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("detach user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DetachRolePolicy&RoleName=delete-policy-role&PolicyArn="+url.QueryEscape(policyARN))
	if res.Code != http.StatusOK {
		t.Fatalf("detach role policy status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteUser&UserName=delete-policy-user")
	if res.Code != http.StatusOK {
		t.Fatalf("delete cleaned user status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteRole&RoleName=delete-policy-role")
	if res.Code != http.StatusOK {
		t.Fatalf("delete cleaned role status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceRejectsMissingInlinePolicyDeletes(t *testing.T) {
	handler := newTestHandler()
	assumePolicy := `{"Version":"2012-10-17","Statement":[]}`

	res := executeAWSQueryRequest(handler, "iam", "Action=CreateUser&UserName=missing-inline-policy-user")
	if res.Code != http.StatusOK {
		t.Fatalf("create user status = %d, body = %s", res.Code, res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=CreateRole&RoleName=missing-inline-policy-role&AssumeRolePolicyDocument="+url.QueryEscape(assumePolicy))
	if res.Code != http.StatusOK {
		t.Fatalf("create role status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteUserPolicy&UserName=missing-inline-policy-user&PolicyName=missing")
	if res.Code != http.StatusNotFound {
		t.Fatalf("delete missing user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "NoSuchEntity") {
		t.Fatalf("delete missing user policy body = %s", res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteRolePolicy&RoleName=missing-inline-policy-role&PolicyName=missing")
	if res.Code != http.StatusNotFound {
		t.Fatalf("delete missing role policy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "NoSuchEntity") {
		t.Fatalf("delete missing role policy body = %s", res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteUserPolicy&UserName=missing-inline-policy-user")
	if res.Code != http.StatusBadRequest {
		t.Fatalf("delete unnamed user policy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "ValidationError") {
		t.Fatalf("delete unnamed user policy body = %s", res.Body.String())
	}
	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteRolePolicy&RoleName=missing-inline-policy-role")
	if res.Code != http.StatusBadRequest {
		t.Fatalf("delete unnamed role policy status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "ValidationError") {
		t.Fatalf("delete unnamed role policy body = %s", res.Body.String())
	}
}

func TestServiceRejectsInvalidAssumeRoleDuration(t *testing.T) {
	handler := newTestHandler()
	assumePolicy := `{"Version":"2012-10-17","Statement":[]}`

	res := executeAWSQueryRequest(handler, "iam", "Action=CreateRole&RoleName=duration-role&AssumeRolePolicyDocument="+url.QueryEscape(assumePolicy))
	if res.Code != http.StatusOK {
		t.Fatalf("create role status = %d, body = %s", res.Code, res.Body.String())
	}
	roleARN := xmlElement(res.Body.String(), "Arn")

	for _, duration := range []string{"abc", "899", "3601", "43201"} {
		values := url.Values{}
		values.Set("Action", "AssumeRole")
		values.Set("RoleArn", roleARN)
		values.Set("RoleSessionName", "bad-duration")
		values.Set("DurationSeconds", duration)
		res = executeAWSQueryRequest(handler, "sts", values.Encode())
		if res.Code != http.StatusBadRequest {
			t.Fatalf("duration %q status = %d, body = %s", duration, res.Code, res.Body.String())
		}
		if !strings.Contains(res.Body.String(), "ValidationError") {
			t.Fatalf("duration %q body = %s", duration, res.Body.String())
		}
	}
}

func TestServiceEnforcesRoleMaxSessionDurationAndChaining(t *testing.T) {
	handler := newTestHandler()
	assumePolicy := `{"Version":"2012-10-17","Statement":[]}`

	values := url.Values{}
	values.Set("Action", "CreateRole")
	values.Set("RoleName", "long-duration-role")
	values.Set("AssumeRolePolicyDocument", assumePolicy)
	values.Set("MaxSessionDuration", "7200")
	res := executeAWSQueryRequest(handler, "iam", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("create role status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "<MaxSessionDuration>7200</MaxSessionDuration>") {
		t.Fatalf("create role missing max session duration: %s", res.Body.String())
	}
	roleARN := xmlElement(res.Body.String(), "Arn")

	values = url.Values{}
	values.Set("Action", "AssumeRole")
	values.Set("RoleArn", roleARN)
	values.Set("RoleSessionName", "long-session")
	values.Set("DurationSeconds", "7200")
	res = executeAWSQueryRequest(handler, "sts", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("assume long role status = %d, body = %s", res.Code, res.Body.String())
	}
	assumedAccessKey := xmlElement(res.Body.String(), "AccessKeyId")
	sessionToken := xmlElement(res.Body.String(), "SessionToken")

	values.Set("RoleSessionName", "too-long-chain")
	values.Set("DurationSeconds", "3601")
	res = executeAWSQueryRequestWithAccessKeyAndToken(handler, "sts", values.Encode(), assumedAccessKey, sessionToken)
	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "ValidationError") {
		t.Fatalf("chained assume role status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceReturnsJSONRPCNotImplemented(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/", strings.NewReader(`{"TableName":"items"}`))
	req.Header.Set("X-Amz-Target", "DynamoDB_20120810.UpdateItem")
	signAWSRequest(req, "dynamodb")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/x-amz-json-1.0" {
		t.Fatalf("content type = %q", got)
	}
	if got := res.Header().Get("x-amzn-errortype"); got != "NotImplementedException" {
		t.Fatalf("error type = %q", got)
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["__type"] != "com.amazonaws.dynamodb.v20120810#NotImplementedException" {
		t.Fatalf("unexpected body: %#v", body)
	}
	if !strings.Contains(body["message"], "dynamodb.UpdateItem") {
		t.Fatalf("unexpected message: %#v", body)
	}
}

func TestServiceHandlesCloudWatchLogsLifecycle(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSLogsRequest(t, handler, "CreateLogGroup", map[string]any{"logGroupName": "app"})
	if res.Code != http.StatusOK {
		t.Fatalf("create group status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/x-amz-json-1.1" {
		t.Fatalf("content type = %q", got)
	}

	res = executeAWSLogsRequest(t, handler, "CreateLogStream", map[string]any{"logGroupName": "app", "logStreamName": "web"})
	if res.Code != http.StatusOK {
		t.Fatalf("create stream status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSLogsRequest(t, handler, "PutLogEvents", map[string]any{
		"logGroupName":  "app",
		"logStreamName": "web",
		"logEvents": []map[string]any{
			{"timestamp": 1700000000000, "message": "first error"},
			{"timestamp": 1700000001000, "message": "second info"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put events status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSLogsRequest(t, handler, "FilterLogEvents", map[string]any{"logGroupName": "app", "filterPattern": "error"})
	if res.Code != http.StatusOK {
		t.Fatalf("filter events status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Events []struct {
			EventID string `json:"eventId"`
			Message string `json:"message"`
		} `json:"events"`
	}
	decodeJSONBody(t, res, &body)
	if len(body.Events) != 1 || body.Events[0].Message != "first error" || body.Events[0].EventID == "" {
		t.Fatalf("unexpected filtered body: %#v", body)
	}

	res = executeAWSLogsRequest(t, handler, "DeleteLogGroup", map[string]any{"logGroupName": "app"})
	if res.Code != http.StatusOK {
		t.Fatalf("delete group status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesSSMParameterStoreJSONRPC(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSSSMRequest(t, handler, "PutParameter", map[string]any{
		"Name":        "/app/database/url",
		"Description": "database URL",
		"Type":        "SecureString",
		"Value":       "postgres://local",
		"KeyId":       "alias/local",
		"Tags":        []map[string]any{{"Key": "env", "Value": "test"}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/x-amz-json-1.1" {
		t.Fatalf("content type = %q", got)
	}

	res = executeAWSSSMRequest(t, handler, "GetParameter", map[string]any{"Name": "/app/database/url", "WithDecryption": true})
	if res.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", res.Code, res.Body.String())
	}
	var got struct {
		Parameter struct {
			Name    string `json:"Name"`
			Type    string `json:"Type"`
			Value   string `json:"Value"`
			Version int64  `json:"Version"`
		} `json:"Parameter"`
	}
	decodeJSONBody(t, res, &got)
	if got.Parameter.Name != "/app/database/url" || got.Parameter.Type != "SecureString" || got.Parameter.Value != "postgres://local" || got.Parameter.Version != 1 {
		t.Fatalf("unexpected parameter: %#v", got.Parameter)
	}

	res = executeAWSSSMRequest(t, handler, "GetParametersByPath", map[string]any{"Path": "/app", "Recursive": true})
	if res.Code != http.StatusOK {
		t.Fatalf("path status = %d, body = %s", res.Code, res.Body.String())
	}
	var byPath struct {
		Parameters []struct {
			Name string `json:"Name"`
		} `json:"Parameters"`
	}
	decodeJSONBody(t, res, &byPath)
	if len(byPath.Parameters) != 1 || byPath.Parameters[0].Name != "/app/database/url" {
		t.Fatalf("unexpected path body: %#v", byPath.Parameters)
	}
}

func TestServiceHandlesKMSJSONRPC(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSKMSRequest(t, handler, "CreateKey", map[string]any{"Description": "app key"})
	if res.Code != http.StatusOK {
		t.Fatalf("create key status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/x-amz-json-1.1" {
		t.Fatalf("content type = %q", got)
	}
	var created struct {
		KeyMetadata struct {
			KeyID string `json:"KeyId"`
			Arn   string `json:"Arn"`
		} `json:"KeyMetadata"`
	}
	decodeJSONBody(t, res, &created)
	if created.KeyMetadata.KeyID == "" || !strings.Contains(created.KeyMetadata.Arn, ":key/") {
		t.Fatalf("unexpected key metadata: %#v", created.KeyMetadata)
	}

	res = executeAWSKMSRequest(t, handler, "CreateAlias", map[string]any{"AliasName": "alias/app", "TargetKeyId": created.KeyMetadata.KeyID})
	if res.Code != http.StatusOK {
		t.Fatalf("create alias status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSKMSRequest(t, handler, "Encrypt", map[string]any{
		"KeyId":     "alias/app",
		"Plaintext": base64.StdEncoding.EncodeToString([]byte("hello kms")),
	})
	if res.Code != http.StatusOK {
		t.Fatalf("encrypt status = %d, body = %s", res.Code, res.Body.String())
	}
	var encrypted struct {
		CiphertextBlob string `json:"CiphertextBlob"`
	}
	decodeJSONBody(t, res, &encrypted)
	if encrypted.CiphertextBlob == "" {
		t.Fatalf("missing ciphertext: %#v", encrypted)
	}

	res = executeAWSKMSRequest(t, handler, "Decrypt", map[string]any{"CiphertextBlob": encrypted.CiphertextBlob, "KeyId": created.KeyMetadata.Arn})
	if res.Code != http.StatusOK {
		t.Fatalf("decrypt status = %d, body = %s", res.Code, res.Body.String())
	}
	var decrypted struct {
		Plaintext string `json:"Plaintext"`
	}
	decodeJSONBody(t, res, &decrypted)
	raw, err := base64.StdEncoding.DecodeString(decrypted.Plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "hello kms" {
		t.Fatalf("plaintext = %q", raw)
	}
}

func TestServiceHandlesDynamoDBTableAndItemLifecycle(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSDynamoDBRequest(t, handler, "CreateTable", map[string]any{
		"TableName": "items",
		"AttributeDefinitions": []map[string]any{
			{"AttributeName": "pk", "AttributeType": "S"},
			{"AttributeName": "sk", "AttributeType": "S"},
		},
		"KeySchema": []map[string]any{
			{"AttributeName": "pk", "KeyType": "HASH"},
			{"AttributeName": "sk", "KeyType": "RANGE"},
		},
		"BillingMode": "PAY_PER_REQUEST",
		"Tags": []map[string]any{
			{"Key": "env", "Value": "test"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("create table status = %d, body = %s", res.Code, res.Body.String())
	}
	var createBody map[string]any
	decodeJSONBody(t, res, &createBody)
	tableDescription := createBody["TableDescription"].(map[string]any)
	if tableDescription["TableName"] != "items" || tableDescription["TableStatus"] != "ACTIVE" {
		t.Fatalf("unexpected table description: %#v", tableDescription)
	}
	tableARN := tableDescription["TableArn"].(string)
	if !strings.Contains(tableARN, ":table/items") {
		t.Fatalf("table arn = %q", tableARN)
	}

	res = executeAWSDynamoDBRequest(t, handler, "UpdateTable", map[string]any{
		"TableName":   "items",
		"BillingMode": "PROVISIONED",
		"ProvisionedThroughput": map[string]any{
			"ReadCapacityUnits":  2,
			"WriteCapacityUnits": 1,
		},
	})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"PROVISIONED"`) {
		t.Fatalf("update table status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "PutItem", map[string]any{
		"TableName": "items",
		"Item": map[string]any{
			"pk":      map[string]any{"S": "acct#1"},
			"sk":      map[string]any{"S": "profile"},
			"name":    map[string]any{"S": "Ada"},
			"enabled": map[string]any{"BOOL": true},
			"count":   map[string]any{"N": "3"},
			"nested":  map[string]any{"M": map[string]any{"role": map[string]any{"S": "admin"}}},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put item status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "GetItem", map[string]any{
		"TableName": "items",
		"Key": map[string]any{
			"pk": map[string]any{"S": "acct#1"},
			"sk": map[string]any{"S": "profile"},
		},
		"ProjectionExpression": "#name, enabled",
		"ExpressionAttributeNames": map[string]any{
			"#name": "name",
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("get item status = %d, body = %s", res.Code, res.Body.String())
	}
	var getBody map[string]map[string]map[string]any
	decodeJSONBody(t, res, &getBody)
	item := getBody["Item"]
	if item["name"]["S"] != "Ada" || item["enabled"]["BOOL"] != true {
		t.Fatalf("unexpected item: %#v", item)
	}
	if _, ok := item["pk"]; ok {
		t.Fatalf("projection included pk: %#v", item)
	}

	res = executeAWSDynamoDBRequest(t, handler, "Query", map[string]any{
		"TableName":              "items",
		"KeyConditionExpression": "#pk = :pk AND #sk = :sk",
		"ExpressionAttributeNames": map[string]any{
			"#pk": "pk",
			"#sk": "sk",
		},
		"ExpressionAttributeValues": map[string]any{
			":pk": map[string]any{"S": "acct#1"},
			":sk": map[string]any{"S": "profile"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("query status = %d, body = %s", res.Code, res.Body.String())
	}
	var queryBody struct {
		Count int                         `json:"Count"`
		Items []map[string]map[string]any `json:"Items"`
	}
	decodeJSONBody(t, res, &queryBody)
	if queryBody.Count != 1 || queryBody.Items[0]["name"]["S"] != "Ada" {
		t.Fatalf("unexpected query body: %#v", queryBody)
	}

	res = executeAWSDynamoDBRequest(t, handler, "ListTagsOfResource", map[string]any{"ResourceArn": tableARN})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"env"`) {
		t.Fatalf("list tags status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "DeleteItem", map[string]any{
		"TableName": "items",
		"Key": map[string]any{
			"pk": map[string]any{"S": "acct#1"},
			"sk": map[string]any{"S": "profile"},
		},
		"ReturnValues": "ALL_OLD",
	})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"Ada"`) {
		t.Fatalf("delete item status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesDynamoDBNumericKeyIdentityAndOrdering(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSDynamoDBRequest(t, handler, "CreateTable", map[string]any{
		"TableName": "metrics",
		"AttributeDefinitions": []map[string]any{
			{"AttributeName": "account", "AttributeType": "N"},
			{"AttributeName": "rank", "AttributeType": "N"},
		},
		"KeySchema": []map[string]any{
			{"AttributeName": "account", "KeyType": "HASH"},
			{"AttributeName": "rank", "KeyType": "RANGE"},
		},
		"BillingMode": "PAY_PER_REQUEST",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("create numeric table status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "PutItem", map[string]any{
		"TableName": "metrics",
		"Item": map[string]any{
			"account": map[string]any{"N": "01.0"},
			"rank":    map[string]any{"N": "10"},
			"label":   map[string]any{"S": "ten"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put rank ten status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "PutItem", map[string]any{
		"TableName": "metrics",
		"Item": map[string]any{
			"account": map[string]any{"N": "1"},
			"rank":    map[string]any{"N": "2.0"},
			"label":   map[string]any{"S": "two"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put rank two status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "GetItem", map[string]any{
		"TableName": "metrics",
		"Key": map[string]any{
			"account": map[string]any{"N": "1.00"},
			"rank":    map[string]any{"N": "1e1"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("get equivalent numeric key status = %d, body = %s", res.Code, res.Body.String())
	}
	var getBody map[string]map[string]map[string]any
	decodeJSONBody(t, res, &getBody)
	if getBody["Item"]["label"]["S"] != "ten" {
		t.Fatalf("unexpected get body: %#v", getBody)
	}

	res = executeAWSDynamoDBRequest(t, handler, "PutItem", map[string]any{
		"TableName":    "metrics",
		"ReturnValues": "ALL_OLD",
		"Item": map[string]any{
			"account": map[string]any{"N": "1"},
			"rank":    map[string]any{"N": "10.0"},
			"label":   map[string]any{"S": "ten-updated"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("overwrite equivalent numeric key status = %d, body = %s", res.Code, res.Body.String())
	}
	var putBody map[string]map[string]map[string]any
	decodeJSONBody(t, res, &putBody)
	if putBody["Attributes"]["label"]["S"] != "ten" {
		t.Fatalf("overwrite did not return old item: %#v", putBody)
	}

	res = executeAWSDynamoDBRequest(t, handler, "Query", map[string]any{
		"TableName":              "metrics",
		"KeyConditionExpression": "#account = :account",
		"ExpressionAttributeNames": map[string]any{
			"#account": "account",
		},
		"ExpressionAttributeValues": map[string]any{
			":account": map[string]any{"N": "1.000"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("query numeric partition status = %d, body = %s", res.Code, res.Body.String())
	}
	var queryBody struct {
		Count int                         `json:"Count"`
		Items []map[string]map[string]any `json:"Items"`
	}
	decodeJSONBody(t, res, &queryBody)
	if queryBody.Count != 2 {
		t.Fatalf("query count = %d, body = %#v", queryBody.Count, queryBody)
	}
	if queryBody.Items[0]["label"]["S"] != "two" || queryBody.Items[1]["label"]["S"] != "ten-updated" {
		t.Fatalf("query did not use numeric sort order: %#v", queryBody.Items)
	}
}

func TestServiceRejectsDynamoDBUnsupportedExpressionsWithoutMutation(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSDynamoDBRequest(t, handler, "CreateTable", map[string]any{
		"TableName": "guards",
		"AttributeDefinitions": []map[string]any{
			{"AttributeName": "pk", "AttributeType": "S"},
		},
		"KeySchema": []map[string]any{
			{"AttributeName": "pk", "KeyType": "HASH"},
		},
		"BillingMode": "PAY_PER_REQUEST",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "PutItem", map[string]any{
		"TableName": "guards",
		"Item": map[string]any{
			"pk":   map[string]any{"S": "acct#1"},
			"name": map[string]any{"S": "Ada"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("seed put status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "PutItem", map[string]any{
		"TableName":           "guards",
		"ConditionExpression": "attribute_not_exists(pk)",
		"Item": map[string]any{
			"pk":   map[string]any{"S": "acct#1"},
			"name": map[string]any{"S": "Grace"},
		},
	})
	if res.Code != http.StatusBadRequest || res.Header().Get("x-amzn-errortype") != "ValidationException" || !strings.Contains(res.Body.String(), "ConditionExpression") {
		t.Fatalf("condition put status = %d, headers = %#v, body = %s", res.Code, res.Header(), res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "GetItem", map[string]any{
		"TableName": "guards",
		"Key": map[string]any{
			"pk": map[string]any{"S": "acct#1"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("get after condition put status = %d, body = %s", res.Code, res.Body.String())
	}
	var getBody map[string]map[string]map[string]any
	decodeJSONBody(t, res, &getBody)
	if getBody["Item"]["name"]["S"] != "Ada" {
		t.Fatalf("condition put mutated item: %#v", getBody)
	}

	res = executeAWSDynamoDBRequest(t, handler, "DeleteItem", map[string]any{
		"TableName":           "guards",
		"ConditionExpression": "attribute_exists(missing)",
		"Key": map[string]any{
			"pk": map[string]any{"S": "acct#1"},
		},
	})
	if res.Code != http.StatusBadRequest || res.Header().Get("x-amzn-errortype") != "ValidationException" || !strings.Contains(res.Body.String(), "ConditionExpression") {
		t.Fatalf("condition delete status = %d, headers = %#v, body = %s", res.Code, res.Header(), res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "GetItem", map[string]any{
		"TableName": "guards",
		"Key": map[string]any{
			"pk": map[string]any{"S": "acct#1"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("get after condition delete status = %d, body = %s", res.Code, res.Body.String())
	}
	getBody = nil
	decodeJSONBody(t, res, &getBody)
	if getBody["Item"]["name"]["S"] != "Ada" {
		t.Fatalf("condition delete mutated item: %#v", getBody)
	}

	res = executeAWSDynamoDBRequest(t, handler, "Scan", map[string]any{
		"TableName":        "guards",
		"FilterExpression": "#name = :name",
		"ExpressionAttributeNames": map[string]any{
			"#name": "name",
		},
		"ExpressionAttributeValues": map[string]any{
			":name": map[string]any{"S": "Ada"},
		},
	})
	if res.Code != http.StatusBadRequest || res.Header().Get("x-amzn-errortype") != "ValidationException" || !strings.Contains(res.Body.String(), "FilterExpression") {
		t.Fatalf("scan filter status = %d, headers = %#v, body = %s", res.Code, res.Header(), res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "Query", map[string]any{
		"TableName":              "guards",
		"KeyConditionExpression": "#pk = :pk",
		"FilterExpression":       "#name = :name",
		"ExpressionAttributeNames": map[string]any{
			"#pk":   "pk",
			"#name": "name",
		},
		"ExpressionAttributeValues": map[string]any{
			":pk":   map[string]any{"S": "acct#1"},
			":name": map[string]any{"S": "Ada"},
		},
	})
	if res.Code != http.StatusBadRequest || res.Header().Get("x-amzn-errortype") != "ValidationException" || !strings.Contains(res.Body.String(), "FilterExpression") {
		t.Fatalf("query filter status = %d, headers = %#v, body = %s", res.Code, res.Header(), res.Body.String())
	}
}

func TestServiceRejectsDynamoDBInvalidKeySchemasAndKeyTypes(t *testing.T) {
	handler := newTestHandler()

	tests := []struct {
		name    string
		payload map[string]any
	}{
		{
			name: "missing hash key",
			payload: map[string]any{
				"TableName": "missing-hash",
				"AttributeDefinitions": []map[string]any{
					{"AttributeName": "sk", "AttributeType": "S"},
				},
				"KeySchema": []map[string]any{
					{"AttributeName": "sk", "KeyType": "RANGE"},
				},
				"BillingMode": "PAY_PER_REQUEST",
			},
		},
		{
			name: "missing key attribute definition",
			payload: map[string]any{
				"TableName": "missing-definition",
				"AttributeDefinitions": []map[string]any{
					{"AttributeName": "id", "AttributeType": "S"},
				},
				"KeySchema": []map[string]any{
					{"AttributeName": "pk", "KeyType": "HASH"},
				},
				"BillingMode": "PAY_PER_REQUEST",
			},
		},
		{
			name: "unsupported key attribute type",
			payload: map[string]any{
				"TableName": "unsupported-type",
				"AttributeDefinitions": []map[string]any{
					{"AttributeName": "pk", "AttributeType": "BOOL"},
				},
				"KeySchema": []map[string]any{
					{"AttributeName": "pk", "KeyType": "HASH"},
				},
				"BillingMode": "PAY_PER_REQUEST",
			},
		},
		{
			name: "unused attribute definition",
			payload: map[string]any{
				"TableName": "unused-definition",
				"AttributeDefinitions": []map[string]any{
					{"AttributeName": "pk", "AttributeType": "S"},
					{"AttributeName": "extra", "AttributeType": "S"},
				},
				"KeySchema": []map[string]any{
					{"AttributeName": "pk", "KeyType": "HASH"},
				},
				"BillingMode": "PAY_PER_REQUEST",
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			res := executeAWSDynamoDBRequest(t, handler, "CreateTable", test.payload)
			if res.Code != http.StatusBadRequest || res.Header().Get("x-amzn-errortype") != "ValidationException" {
				t.Fatalf("create status = %d, headers = %#v, body = %s", res.Code, res.Header(), res.Body.String())
			}
		})
	}

	res := executeAWSDynamoDBRequest(t, handler, "CreateTable", map[string]any{
		"TableName": "typed-keys",
		"AttributeDefinitions": []map[string]any{
			{"AttributeName": "pk", "AttributeType": "S"},
		},
		"KeySchema": []map[string]any{
			{"AttributeName": "pk", "KeyType": "HASH"},
		},
		"BillingMode": "PAY_PER_REQUEST",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("create typed table status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "PutItem", map[string]any{
		"TableName": "typed-keys",
		"Item": map[string]any{
			"pk": map[string]any{"N": "1"},
		},
	})
	if res.Code != http.StatusBadRequest || res.Header().Get("x-amzn-errortype") != "ValidationException" || !strings.Contains(res.Body.String(), "key attribute pk must be type S") {
		t.Fatalf("wrong key type status = %d, headers = %#v, body = %s", res.Code, res.Header(), res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "Query", map[string]any{
		"TableName":              "typed-keys",
		"KeyConditionExpression": "#pk = :pk",
		"ExpressionAttributeNames": map[string]any{
			"#pk": "pk",
		},
		"ExpressionAttributeValues": map[string]any{
			":pk": map[string]any{"N": "1"},
		},
	})
	if res.Code != http.StatusBadRequest || res.Header().Get("x-amzn-errortype") != "ValidationException" || !strings.Contains(res.Body.String(), "key attribute pk must be type S") {
		t.Fatalf("wrong query key type status = %d, headers = %#v, body = %s", res.Code, res.Header(), res.Body.String())
	}
}

func TestServiceHandlesDynamoDBBatchOperations(t *testing.T) {
	handler := newTestHandler()
	res := executeAWSDynamoDBRequest(t, handler, "CreateTable", map[string]any{
		"TableName": "events",
		"AttributeDefinitions": []map[string]any{
			{"AttributeName": "id", "AttributeType": "S"},
		},
		"KeySchema": []map[string]any{
			{"AttributeName": "id", "KeyType": "HASH"},
		},
		"BillingMode": "PAY_PER_REQUEST",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "BatchWriteItem", map[string]any{
		"RequestItems": map[string]any{
			"events": []map[string]any{
				{"PutRequest": map[string]any{"Item": map[string]any{"id": map[string]any{"S": "evt#1"}, "type": map[string]any{"S": "push"}}}},
				{"PutRequest": map[string]any{"Item": map[string]any{"id": map[string]any{"S": "evt#2"}, "type": map[string]any{"S": "pull_request"}}}},
			},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("batch write status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "BatchGetItem", map[string]any{
		"RequestItems": map[string]any{
			"events": map[string]any{
				"Keys": []map[string]any{
					{"id": map[string]any{"S": "evt#1"}},
					{"id": map[string]any{"S": "evt#2"}},
				},
			},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("batch get status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Responses map[string][]map[string]map[string]any `json:"Responses"`
	}
	decodeJSONBody(t, res, &body)
	if len(body.Responses["events"]) != 2 {
		t.Fatalf("unexpected batch get body: %#v", body)
	}
}

func TestServiceRejectsDynamoDBInvalidBatchWriteWithoutMutation(t *testing.T) {
	handler := newTestHandler()
	res := executeAWSDynamoDBRequest(t, handler, "CreateTable", map[string]any{
		"TableName": "atomic-events",
		"AttributeDefinitions": []map[string]any{
			{"AttributeName": "id", "AttributeType": "S"},
		},
		"KeySchema": []map[string]any{
			{"AttributeName": "id", "KeyType": "HASH"},
		},
		"BillingMode": "PAY_PER_REQUEST",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "BatchWriteItem", map[string]any{
		"RequestItems": map[string]any{
			"atomic-events": []map[string]any{
				{"PutRequest": map[string]any{"Item": map[string]any{"id": map[string]any{"S": "evt#1"}, "type": map[string]any{"S": "push"}}}},
				{},
			},
		},
	})
	if res.Code != http.StatusBadRequest || res.Header().Get("x-amzn-errortype") != "ValidationException" {
		t.Fatalf("batch write status = %d, headers = %#v, body = %s", res.Code, res.Header(), res.Body.String())
	}

	res = executeAWSDynamoDBRequest(t, handler, "GetItem", map[string]any{
		"TableName": "atomic-events",
		"Key": map[string]any{
			"id": map[string]any{"S": "evt#1"},
		},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("get after failed batch status = %d, body = %s", res.Code, res.Body.String())
	}
	var body map[string]any
	decodeJSONBody(t, res, &body)
	if _, ok := body["Item"]; ok {
		t.Fatalf("failed batch write mutated item: %#v", body)
	}
}

func TestServiceReturnsDynamoDBModeledErrors(t *testing.T) {
	handler := newTestHandler()
	res := executeAWSDynamoDBRequest(t, handler, "DescribeTable", map[string]any{"TableName": "missing"})
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("x-amzn-errortype"); got != "ResourceNotFoundException" {
		t.Fatalf("error type = %q", got)
	}
	var body map[string]string
	decodeJSONBody(t, res, &body)
	if body["__type"] != "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException" {
		t.Fatalf("unexpected body: %#v", body)
	}
}

func TestServiceRoutesSignedLambdaRESTJSON(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/lambda/2015-03-31/functions", nil)
	signAWSRequest(req, "lambda")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content type = %q", got)
	}
	var body struct {
		Functions []map[string]any `json:"Functions"`
	}
	decodeJSONBody(t, res, &body)
	if body.Functions == nil {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
	if strings.Contains(res.Body.String(), "s3.GetObject") {
		t.Fatalf("unexpected S3 fallback response: %s", res.Body.String())
	}
}

func TestServiceRoutesRootLambdaRESTJSONWithoutSigV4(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/2015-03-31/functions", nil)
	req.Header.Set("Authorization", "Bearer test_token_admin")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Functions []map[string]any `json:"Functions"`
	}
	decodeJSONBody(t, res, &body)
	if body.Functions == nil {
		t.Fatalf("unexpected body: %s", res.Body.String())
	}
}

func TestServiceHandlesLambdaControlPlaneAndInvoke(t *testing.T) {
	handler := newTestHandler()

	create := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions", map[string]any{
		"FunctionName": "sdk-lambda-control",
		"Runtime":      "nodejs22.x",
		"Role":         "arn:aws:iam::123456789012:role/lambda-execution-role",
		"Handler":      "index.handler",
		"Code":         map[string]any{"ZipFile": base64.StdEncoding.EncodeToString([]byte("exports.handler = async () => ({ ok: true })"))},
		"Environment":  map[string]any{"Variables": map[string]any{"MODE": "test"}},
		"Tags":         map[string]any{"team": "platform"},
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}
	var created struct {
		FunctionName string `json:"FunctionName"`
		FunctionArn  string `json:"FunctionArn"`
		State        string `json:"State"`
	}
	decodeJSONBody(t, create, &created)
	if created.FunctionName != "sdk-lambda-control" || created.State != "Active" || !strings.Contains(created.FunctionArn, ":function:sdk-lambda-control") {
		t.Fatalf("unexpected create body: %#v", created)
	}

	list := executeAWSLambdaRequest(t, handler, http.MethodGet, "/2015-03-31/functions", nil)
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", list.Code, list.Body.String())
	}
	var listed struct {
		Functions []struct {
			FunctionName string `json:"FunctionName"`
		} `json:"Functions"`
	}
	decodeJSONBody(t, list, &listed)
	if len(listed.Functions) != 1 || listed.Functions[0].FunctionName != "sdk-lambda-control" {
		t.Fatalf("unexpected functions: %#v", listed.Functions)
	}

	update := executeAWSLambdaRequest(t, handler, http.MethodPut, "/2015-03-31/functions/sdk-lambda-control/configuration", map[string]any{
		"Timeout":    9,
		"MemorySize": 256,
		"Environment": map[string]any{"Variables": map[string]any{
			"MODE": "updated",
		}},
	})
	if update.Code != http.StatusOK {
		t.Fatalf("update config status = %d, body = %s", update.Code, update.Body.String())
	}
	var updated struct {
		Timeout     int `json:"Timeout"`
		MemorySize  int `json:"MemorySize"`
		Environment struct {
			Variables map[string]string `json:"Variables"`
		} `json:"Environment"`
	}
	decodeJSONBody(t, update, &updated)
	if updated.Timeout != 9 || updated.MemorySize != 256 || updated.Environment.Variables["MODE"] != "updated" {
		t.Fatalf("unexpected updated config: %#v", updated)
	}

	code := executeAWSLambdaRequest(t, handler, http.MethodPut, "/2015-03-31/functions/sdk-lambda-control/code", map[string]any{
		"ZipFile": base64.StdEncoding.EncodeToString([]byte("exports.handler = async () => ({ ok: 'updated' })")),
	})
	if code.Code != http.StatusOK {
		t.Fatalf("update code status = %d, body = %s", code.Code, code.Body.String())
	}
	var codeBody struct {
		CodeSize int `json:"CodeSize"`
	}
	decodeJSONBody(t, code, &codeBody)
	if codeBody.CodeSize == 0 {
		t.Fatalf("missing code size: %#v", codeBody)
	}

	malformed := executeAWSLambdaRawRequest(t, handler, http.MethodPut, "/2015-03-31/functions/sdk-lambda-control/code", []byte(`{`))
	if malformed.Code != http.StatusBadRequest {
		t.Fatalf("malformed update code status = %d, body = %s", malformed.Code, malformed.Body.String())
	}
	if !strings.Contains(malformed.Body.String(), "InvalidRequestException") {
		t.Fatalf("unexpected malformed update body: %s", malformed.Body.String())
	}

	invoke := executeAWSLambdaRawRequest(t, handler, http.MethodPost, "/2015-03-31/functions/sdk-lambda-control/invocations?LogType=Tail", []byte(`{"hello":"world"}`))
	if invoke.Code != http.StatusOK {
		t.Fatalf("invoke status = %d, body = %s", invoke.Code, invoke.Body.String())
	}
	if invoke.Body.String() != "{}" {
		t.Fatalf("invoke body = %s", invoke.Body.String())
	}
	if got := invoke.Header().Get("x-amz-log-result"); got == "" {
		t.Fatal("missing tail log result")
	}

	missingQualifier := executeAWSLambdaRequest(t, handler, http.MethodGet, "/2015-03-31/functions/sdk-lambda-control/configuration?Qualifier=missing", nil)
	if missingQualifier.Code != http.StatusNotFound || !strings.Contains(missingQualifier.Body.String(), "ResourceNotFoundException") {
		t.Fatalf("missing qualifier status = %d, body = %s", missingQualifier.Code, missingQualifier.Body.String())
	}

	missingInvoke := executeAWSLambdaRawRequest(t, handler, http.MethodPost, "/2015-03-31/functions/sdk-lambda-control/invocations?Qualifier=missing", []byte(`"payload"`))
	if missingInvoke.Code != http.StatusNotFound || !strings.Contains(missingInvoke.Body.String(), "ResourceNotFoundException") {
		t.Fatalf("missing invoke qualifier status = %d, body = %s", missingInvoke.Code, missingInvoke.Body.String())
	}

	groups := executeAWSLogsRequest(t, handler, "DescribeLogGroups", map[string]any{"logGroupNamePrefix": "/aws/lambda/sdk-lambda-control"})
	if groups.Code != http.StatusOK {
		t.Fatalf("describe log groups status = %d, body = %s", groups.Code, groups.Body.String())
	}
	var groupBody struct {
		LogGroups []struct {
			LogGroupName string `json:"logGroupName"`
		} `json:"logGroups"`
	}
	decodeJSONBody(t, groups, &groupBody)
	if len(groupBody.LogGroups) != 1 || groupBody.LogGroups[0].LogGroupName != "/aws/lambda/sdk-lambda-control" {
		t.Fatalf("unexpected log groups: %#v", groupBody.LogGroups)
	}

	deleted := executeAWSLambdaRequest(t, handler, http.MethodDelete, "/2015-03-31/functions/sdk-lambda-control", nil)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", deleted.Code, deleted.Body.String())
	}
}

func TestServiceRunsLocalNodeLambdaHandler(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for local Lambda Node.js runner coverage")
	}
	handler := newTestHandlerWithOptions(Options{LambdaLocalCodeExecution: true})
	const accessKeyID = "AKIAIOSFODNN7EXAMPLE"
	zipFile := zipLambdaSource(t, map[string]string{"index.js": `exports.handler = async (event, context) => {
  console.log("node runner", event.name, process.env.MODE, context.functionName);
  return {
    message: "hello " + event.name,
    mode: process.env.MODE,
    requestId: context.awsRequestId,
    remaining: context.getRemainingTimeInMillis() > 0,
  };
};
`})

	create := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions", map[string]any{
		"FunctionName": "node-runner",
		"Runtime":      "nodejs22.x",
		"Role":         "arn:aws:iam::123456789012:role/lambda-execution-role",
		"Handler":      "index.handler",
		"Code":         map[string]any{"ZipFile": zipFile},
		"Environment":  map[string]any{"Variables": map[string]any{"MODE": "test"}},
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}

	invoke := executeAWSLambdaRawRequestWithAccessKey(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner/invocations?LogType=Tail", []byte(`{"name":"Ada"}`), accessKeyID)
	if invoke.Code != http.StatusOK {
		t.Fatalf("invoke status = %d, body = %s", invoke.Code, invoke.Body.String())
	}
	var body struct {
		Message   string `json:"message"`
		Mode      string `json:"mode"`
		RequestID string `json:"requestId"`
		Remaining bool   `json:"remaining"`
	}
	decodeJSONBody(t, invoke, &body)
	if body.Message != "hello Ada" || body.Mode != "test" || body.RequestID == "" || !body.Remaining {
		t.Fatalf("unexpected invoke body: %#v", body)
	}
	logTail, err := base64.StdEncoding.DecodeString(invoke.Header().Get("x-amz-log-result"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(logTail), "node runner Ada test node-runner") {
		t.Fatalf("tail log missing runner output: %s", string(logTail))
	}

	contextSucceedZip := zipLambdaSource(t, map[string]string{"index.js": `exports.handler = (event, context) => {
  setTimeout(() => context.succeed({ message: "context " + event.name }), 10);
};
`})
	contextSucceedUpdate := executeAWSLambdaRequest(t, handler, http.MethodPut, "/2015-03-31/functions/node-runner/code", map[string]any{"ZipFile": contextSucceedZip})
	if contextSucceedUpdate.Code != http.StatusOK {
		t.Fatalf("update context succeed code status = %d, body = %s", contextSucceedUpdate.Code, contextSucceedUpdate.Body.String())
	}
	contextSucceedInvoke := executeAWSLambdaRawRequestWithAccessKey(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner/invocations", []byte(`{"name":"Ada"}`), accessKeyID)
	if contextSucceedInvoke.Code != http.StatusOK {
		t.Fatalf("context succeed invoke status = %d, body = %s", contextSucceedInvoke.Code, contextSucceedInvoke.Body.String())
	}
	var contextSucceedBody struct {
		Message string `json:"message"`
	}
	decodeJSONBody(t, contextSucceedInvoke, &contextSucceedBody)
	if contextSucceedBody.Message != "context Ada" {
		t.Fatalf("unexpected context succeed body: %#v", contextSucceedBody)
	}

	callbackReturnZip := zipLambdaSource(t, map[string]string{"index.js": `exports.handler = (event, context, callback) => {
  setTimeout(() => callback(null, { message: "callback " + event.name }), 10);
  return { message: "returned " + event.name };
};
`})
	callbackReturnUpdate := executeAWSLambdaRequest(t, handler, http.MethodPut, "/2015-03-31/functions/node-runner/code", map[string]any{"ZipFile": callbackReturnZip})
	if callbackReturnUpdate.Code != http.StatusOK {
		t.Fatalf("update callback return code status = %d, body = %s", callbackReturnUpdate.Code, callbackReturnUpdate.Body.String())
	}
	callbackReturnInvoke := executeAWSLambdaRawRequestWithAccessKey(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner/invocations", []byte(`{"name":"Ada"}`), accessKeyID)
	if callbackReturnInvoke.Code != http.StatusOK {
		t.Fatalf("callback return invoke status = %d, body = %s", callbackReturnInvoke.Code, callbackReturnInvoke.Body.String())
	}
	var callbackReturnBody struct {
		Message string `json:"message"`
	}
	decodeJSONBody(t, callbackReturnInvoke, &callbackReturnBody)
	if callbackReturnBody.Message != "callback Ada" {
		t.Fatalf("unexpected callback return body: %#v", callbackReturnBody)
	}

	logs := executeAWSLogsRequest(t, handler, "FilterLogEvents", map[string]any{"logGroupName": "/aws/lambda/node-runner", "filterPattern": "node runner"})
	if logs.Code != http.StatusOK {
		t.Fatalf("filter logs status = %d, body = %s", logs.Code, logs.Body.String())
	}
	var logBody struct {
		Events []struct {
			Message string `json:"message"`
		} `json:"events"`
	}
	decodeJSONBody(t, logs, &logBody)
	if len(logBody.Events) != 1 || !strings.Contains(logBody.Events[0].Message, "node runner Ada test node-runner") {
		t.Fatalf("unexpected log events: %#v", logBody.Events)
	}

	openHandleZip := zipLambdaSource(t, map[string]string{"index.js": `exports.handler = async () => {
  setInterval(() => {}, 1000);
  return { ok: true };
};
`})
	openHandleUpdate := executeAWSLambdaRequest(t, handler, http.MethodPut, "/2015-03-31/functions/node-runner/code", map[string]any{"ZipFile": openHandleZip})
	if openHandleUpdate.Code != http.StatusOK {
		t.Fatalf("update open handle code status = %d, body = %s", openHandleUpdate.Code, openHandleUpdate.Body.String())
	}
	openHandleInvoke := executeAWSLambdaRawRequestWithAccessKey(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner/invocations", []byte(`{}`), accessKeyID)
	if openHandleInvoke.Code != http.StatusOK {
		t.Fatalf("open handle invoke status = %d, body = %s", openHandleInvoke.Code, openHandleInvoke.Body.String())
	}
	var openHandleBody struct {
		OK bool `json:"ok"`
	}
	decodeJSONBody(t, openHandleInvoke, &openHandleBody)
	if !openHandleBody.OK {
		t.Fatalf("unexpected open handle body: %#v", openHandleBody)
	}

	largePayloadZip := zipLambdaSource(t, map[string]string{"index.js": `exports.handler = async (event) => ({ size: event.data.length });`})
	largePayloadUpdate := executeAWSLambdaRequest(t, handler, http.MethodPut, "/2015-03-31/functions/node-runner/code", map[string]any{"ZipFile": largePayloadZip})
	if largePayloadUpdate.Code != http.StatusOK {
		t.Fatalf("update large payload code status = %d, body = %s", largePayloadUpdate.Code, largePayloadUpdate.Body.String())
	}
	largePayloadSize := 2 * 1024 * 1024
	largePayloadInvoke := executeAWSLambdaRawRequestWithAccessKey(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner/invocations", []byte(`{"data":"`+strings.Repeat("x", largePayloadSize)+`"}`), accessKeyID)
	if largePayloadInvoke.Code != http.StatusOK {
		t.Fatalf("large payload invoke status = %d, body = %s", largePayloadInvoke.Code, largePayloadInvoke.Body.String())
	}
	var largePayloadBody struct {
		Size int `json:"size"`
	}
	decodeJSONBody(t, largePayloadInvoke, &largePayloadBody)
	if largePayloadBody.Size != largePayloadSize {
		t.Fatalf("large payload size = %d, want %d, body = %s", largePayloadBody.Size, largePayloadSize, largePayloadInvoke.Body.String())
	}

	initErrorZip := zipLambdaSource(t, map[string]string{"index.js": `throw new Error("init boom");
exports.handler = async () => ({ ok: true });
`})
	initErrorUpdate := executeAWSLambdaRequest(t, handler, http.MethodPut, "/2015-03-31/functions/node-runner/code", map[string]any{"ZipFile": initErrorZip})
	if initErrorUpdate.Code != http.StatusOK {
		t.Fatalf("update init error code status = %d, body = %s", initErrorUpdate.Code, initErrorUpdate.Body.String())
	}
	initFailed := executeAWSLambdaRawRequestWithAccessKey(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner/invocations", []byte(`{}`), accessKeyID)
	if initFailed.Code != http.StatusOK {
		t.Fatalf("init error invoke status = %d, body = %s", initFailed.Code, initFailed.Body.String())
	}
	if got := initFailed.Header().Get("x-amz-function-error"); got != "Unhandled" {
		t.Fatalf("init error function error = %q, want Unhandled", got)
	}
	var initFailedBody struct {
		ErrorMessage string `json:"errorMessage"`
	}
	decodeJSONBody(t, initFailed, &initFailedBody)
	if initFailedBody.ErrorMessage != "init boom" {
		t.Fatalf("unexpected init error body: %#v", initFailedBody)
	}

	errorZip := zipLambdaSource(t, map[string]string{"index.js": `exports.handler = async () => {
  console.error("before boom");
  throw new Error("boom");
};
`})
	updated := executeAWSLambdaRequest(t, handler, http.MethodPut, "/2015-03-31/functions/node-runner/code", map[string]any{"ZipFile": errorZip})
	if updated.Code != http.StatusOK {
		t.Fatalf("update code status = %d, body = %s", updated.Code, updated.Body.String())
	}
	failed := executeAWSLambdaRawRequestWithAccessKey(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner/invocations?LogType=Tail", []byte(`{}`), accessKeyID)
	if failed.Code != http.StatusOK {
		t.Fatalf("failed invoke status = %d, body = %s", failed.Code, failed.Body.String())
	}
	if got := failed.Header().Get("x-amz-function-error"); got != "Unhandled" {
		t.Fatalf("function error = %q, want Unhandled", got)
	}
	var failedBody struct {
		ErrorMessage string `json:"errorMessage"`
	}
	decodeJSONBody(t, failed, &failedBody)
	if failedBody.ErrorMessage != "boom" {
		t.Fatalf("unexpected error body: %#v", failedBody)
	}
	failedTail, err := base64.StdEncoding.DecodeString(failed.Header().Get("x-amz-log-result"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(failedTail), "before boom") {
		t.Fatalf("tail log missing error output: %s", string(failedTail))
	}
}

func TestServiceDoesNotRunLocalNodeLambdaHandlerWithoutOptIn(t *testing.T) {
	handler := newTestHandler()
	zipFile := zipLambdaSource(t, map[string]string{"index.js": `exports.handler = async () => ({ executed: true });`})

	create := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions", map[string]any{
		"FunctionName": "node-runner-disabled",
		"Runtime":      "nodejs22.x",
		"Role":         "arn:aws:iam::123456789012:role/lambda-execution-role",
		"Handler":      "index.handler",
		"Code":         map[string]any{"ZipFile": zipFile},
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}

	invoke := executeAWSLambdaRawRequest(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner-disabled/invocations", []byte(`{}`))
	if invoke.Code != http.StatusOK {
		t.Fatalf("invoke status = %d, body = %s", invoke.Code, invoke.Body.String())
	}
	if invoke.Body.String() != "{}" {
		t.Fatalf("invoke body = %s", invoke.Body.String())
	}
	if got := invoke.Header().Get("x-amz-function-error"); got != "" {
		t.Fatalf("function error = %q", got)
	}
}

func TestServiceDoesNotRunLocalNodeLambdaHandlerWithoutKnownCredential(t *testing.T) {
	handler := newTestHandlerWithOptions(Options{LambdaLocalCodeExecution: true})
	zipFile := zipLambdaSource(t, map[string]string{"index.js": `exports.handler = async () => ({ executed: true });`})

	create := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions", map[string]any{
		"FunctionName": "node-runner-unknown-key",
		"Runtime":      "nodejs22.x",
		"Role":         "arn:aws:iam::123456789012:role/lambda-execution-role",
		"Handler":      "index.handler",
		"Code":         map[string]any{"ZipFile": zipFile},
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}

	invoke := executeAWSLambdaRawRequest(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner-unknown-key/invocations", []byte(`{}`))
	if invoke.Code != http.StatusOK {
		t.Fatalf("invoke status = %d, body = %s", invoke.Code, invoke.Body.String())
	}
	if invoke.Body.String() != "{}" {
		t.Fatalf("invoke body = %s", invoke.Body.String())
	}
}

func TestServiceDoesNotRunLocalNodeLambdaHandlerFromNonLoopback(t *testing.T) {
	handler := newTestHandlerWithOptions(Options{LambdaLocalCodeExecution: true})
	zipFile := zipLambdaSource(t, map[string]string{"index.js": `exports.handler = async () => ({ executed: true });`})

	create := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions", map[string]any{
		"FunctionName": "node-runner-remote",
		"Runtime":      "nodejs22.x",
		"Role":         "arn:aws:iam::123456789012:role/lambda-execution-role",
		"Handler":      "index.handler",
		"Code":         map[string]any{"ZipFile": zipFile},
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}

	invoke := executeAWSLambdaRawRequestWithAccessKeyAndRemoteAddr(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner-remote/invocations", []byte(`{}`), "AKIAIOSFODNN7EXAMPLE", "203.0.113.10:1234")
	if invoke.Code != http.StatusOK {
		t.Fatalf("invoke status = %d, body = %s", invoke.Code, invoke.Body.String())
	}
	if invoke.Body.String() != "{}" {
		t.Fatalf("invoke body = %s", invoke.Body.String())
	}
	if got := invoke.Header().Get("x-amz-function-error"); got != "" {
		t.Fatalf("function error = %q", got)
	}
}

func TestServiceDoesNotRunLocalNodeLambdaHandlerThroughProxyHost(t *testing.T) {
	handler := newTestHandlerWithOptions(Options{LambdaLocalCodeExecution: true})
	zipFile := zipLambdaSource(t, map[string]string{"index.js": `exports.handler = async () => ({ executed: true });`})

	create := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions", map[string]any{
		"FunctionName": "node-runner-proxy",
		"Runtime":      "nodejs22.x",
		"Role":         "arn:aws:iam::123456789012:role/lambda-execution-role",
		"Handler":      "index.handler",
		"Code":         map[string]any{"ZipFile": zipFile},
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}

	proxyHostInvoke := executeAWSLambdaRawRequestWithAccessKeyRemoteAddrHostAndHeaders(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner-proxy/invocations", []byte(`{}`), "AKIAIOSFODNN7EXAMPLE", "127.0.0.1:1234", "lambda.example.test", nil)
	if proxyHostInvoke.Code != http.StatusOK {
		t.Fatalf("proxy host invoke status = %d, body = %s", proxyHostInvoke.Code, proxyHostInvoke.Body.String())
	}
	if proxyHostInvoke.Body.String() != "{}" {
		t.Fatalf("proxy host invoke body = %s", proxyHostInvoke.Body.String())
	}

	forwardedInvoke := executeAWSLambdaRawRequestWithAccessKeyRemoteAddrHostAndHeaders(t, handler, http.MethodPost, "/2015-03-31/functions/node-runner-proxy/invocations", []byte(`{}`), "AKIAIOSFODNN7EXAMPLE", "127.0.0.1:1234", "127.0.0.1", map[string]string{"X-Forwarded-For": "203.0.113.10"})
	if forwardedInvoke.Code != http.StatusOK {
		t.Fatalf("forwarded invoke status = %d, body = %s", forwardedInvoke.Code, forwardedInvoke.Body.String())
	}
	if forwardedInvoke.Body.String() != "{}" {
		t.Fatalf("forwarded invoke body = %s", forwardedInvoke.Body.String())
	}
	if got := forwardedInvoke.Header().Get("x-amz-function-error"); got != "" {
		t.Fatalf("function error = %q", got)
	}
}

func TestServiceHandlesLambdaVersionsAliasesTagsAndPolicy(t *testing.T) {
	handler := newTestHandler()
	create := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions", map[string]any{
		"FunctionName": "sdk-lambda-release",
		"Runtime":      "nodejs22.x",
		"Role":         "arn:aws:iam::123456789012:role/lambda-execution-role",
		"Handler":      "index.handler",
		"Code":         map[string]any{"ZipFile": base64.StdEncoding.EncodeToString([]byte("exports.handler = async () => ({ ok: true })"))},
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}
	var created struct {
		FunctionArn string `json:"FunctionArn"`
	}
	decodeJSONBody(t, create, &created)

	version := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions/sdk-lambda-release/versions", map[string]any{"Description": "first"})
	if version.Code != http.StatusCreated {
		t.Fatalf("publish version status = %d, body = %s", version.Code, version.Body.String())
	}
	var versionBody struct {
		Version string `json:"Version"`
	}
	decodeJSONBody(t, version, &versionBody)
	if versionBody.Version != "1" {
		t.Fatalf("version = %q", versionBody.Version)
	}

	listAll := executeAWSLambdaRequest(t, handler, http.MethodGet, "/2015-03-31/functions?FunctionVersion=ALL", nil)
	if listAll.Code != http.StatusOK {
		t.Fatalf("list all versions status = %d, body = %s", listAll.Code, listAll.Body.String())
	}
	var listAllBody struct {
		Functions []struct {
			FunctionName string `json:"FunctionName"`
			FunctionArn  string `json:"FunctionArn"`
			Version      string `json:"Version"`
		} `json:"Functions"`
	}
	decodeJSONBody(t, listAll, &listAllBody)
	seenLatest := false
	seenPublished := false
	for _, fn := range listAllBody.Functions {
		if fn.FunctionName != "sdk-lambda-release" {
			continue
		}
		if fn.Version == "$LATEST" && fn.FunctionArn == created.FunctionArn {
			seenLatest = true
		}
		if fn.Version == "1" && fn.FunctionArn == created.FunctionArn+":1" {
			seenPublished = true
		}
	}
	if !seenLatest || !seenPublished {
		t.Fatalf("list all versions missing expected entries: %#v", listAllBody.Functions)
	}

	alias := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions/sdk-lambda-release/aliases", map[string]any{"Name": "live", "FunctionVersion": "1"})
	if alias.Code != http.StatusCreated {
		t.Fatalf("create alias status = %d, body = %s", alias.Code, alias.Body.String())
	}
	var aliasBody struct {
		Name            string `json:"Name"`
		FunctionVersion string `json:"FunctionVersion"`
	}
	decodeJSONBody(t, alias, &aliasBody)
	if aliasBody.Name != "live" || aliasBody.FunctionVersion != "1" {
		t.Fatalf("unexpected alias: %#v", aliasBody)
	}

	versionTwo := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions/sdk-lambda-release/versions", map[string]any{"Description": "second"})
	if versionTwo.Code != http.StatusCreated {
		t.Fatalf("publish second version status = %d, body = %s", versionTwo.Code, versionTwo.Body.String())
	}
	var versionTwoBody struct {
		Version string `json:"Version"`
	}
	decodeJSONBody(t, versionTwo, &versionTwoBody)
	if versionTwoBody.Version != "2" {
		t.Fatalf("second version = %q", versionTwoBody.Version)
	}

	betaAlias := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions/sdk-lambda-release/aliases", map[string]any{"Name": "beta", "FunctionVersion": "2"})
	if betaAlias.Code != http.StatusCreated {
		t.Fatalf("create beta alias status = %d, body = %s", betaAlias.Code, betaAlias.Body.String())
	}

	filteredAliases := executeAWSLambdaRequest(t, handler, http.MethodGet, "/2015-03-31/functions/sdk-lambda-release/aliases?FunctionVersion=1", nil)
	if filteredAliases.Code != http.StatusOK {
		t.Fatalf("filtered aliases status = %d, body = %s", filteredAliases.Code, filteredAliases.Body.String())
	}
	var filteredAliasesBody struct {
		Aliases []struct {
			Name            string `json:"Name"`
			FunctionVersion string `json:"FunctionVersion"`
		} `json:"Aliases"`
	}
	decodeJSONBody(t, filteredAliases, &filteredAliasesBody)
	if len(filteredAliasesBody.Aliases) != 1 || filteredAliasesBody.Aliases[0].Name != "live" || filteredAliasesBody.Aliases[0].FunctionVersion != "1" {
		t.Fatalf("unexpected filtered aliases: %#v", filteredAliasesBody.Aliases)
	}

	aliasInvoke := executeAWSLambdaRawRequest(t, handler, http.MethodPost, "/2015-03-31/functions/sdk-lambda-release/invocations?Qualifier=live", []byte(`"payload"`))
	if aliasInvoke.Code != http.StatusOK {
		t.Fatalf("alias invoke status = %d, body = %s", aliasInvoke.Code, aliasInvoke.Body.String())
	}
	if got := aliasInvoke.Header().Get("x-amz-executed-version"); got != "1" {
		t.Fatalf("executed version = %q, want 1", got)
	}

	qualifiedPath := "/2015-03-31/functions/" + url.PathEscape(created.FunctionArn+":live")
	qualifiedInvoke := executeAWSLambdaRawRequest(t, handler, http.MethodPost, qualifiedPath+"/invocations", []byte(`"payload"`))
	if qualifiedInvoke.Code != http.StatusOK {
		t.Fatalf("qualified arn invoke status = %d, body = %s", qualifiedInvoke.Code, qualifiedInvoke.Body.String())
	}
	if got := qualifiedInvoke.Header().Get("x-amz-executed-version"); got != "1" {
		t.Fatalf("qualified arn executed version = %q, want 1", got)
	}

	qualifiedConfig := executeAWSLambdaRequest(t, handler, http.MethodGet, qualifiedPath+"/configuration", nil)
	if qualifiedConfig.Code != http.StatusOK {
		t.Fatalf("qualified arn config status = %d, body = %s", qualifiedConfig.Code, qualifiedConfig.Body.String())
	}
	var qualifiedConfigBody struct {
		Version string `json:"Version"`
	}
	decodeJSONBody(t, qualifiedConfig, &qualifiedConfigBody)
	if qualifiedConfigBody.Version != "1" {
		t.Fatalf("qualified arn version = %q, want 1", qualifiedConfigBody.Version)
	}

	wrongAccountARN := strings.Replace(created.FunctionArn, ":123456789012:", ":999999999999:", 1)
	wrongAccount := executeAWSLambdaRequest(t, handler, http.MethodGet, "/2015-03-31/functions/"+url.PathEscape(wrongAccountARN)+"/configuration", nil)
	if wrongAccount.Code != http.StatusNotFound {
		t.Fatalf("wrong account arn status = %d, body = %s", wrongAccount.Code, wrongAccount.Body.String())
	}

	tagPath := "/2017-03-31/tags/" + url.PathEscape(created.FunctionArn)
	tagged := executeAWSLambdaRequest(t, handler, http.MethodPost, tagPath, map[string]any{"Tags": map[string]any{"stage": "dev"}})
	if tagged.Code != http.StatusNoContent {
		t.Fatalf("tag status = %d, body = %s", tagged.Code, tagged.Body.String())
	}
	tags := executeAWSLambdaRequest(t, handler, http.MethodGet, tagPath, nil)
	if tags.Code != http.StatusOK {
		t.Fatalf("list tags status = %d, body = %s", tags.Code, tags.Body.String())
	}
	var tagsBody struct {
		Tags map[string]string `json:"Tags"`
	}
	decodeJSONBody(t, tags, &tagsBody)
	if tagsBody.Tags["stage"] != "dev" {
		t.Fatalf("unexpected tags: %#v", tagsBody.Tags)
	}

	permission := executeAWSLambdaRequest(t, handler, http.MethodPost, "/2015-03-31/functions/sdk-lambda-release/policy", map[string]any{
		"StatementId": "allow-events",
		"Action":      "lambda:InvokeFunction",
		"Principal":   "events.amazonaws.com",
		"SourceArn":   "arn:aws:events:us-east-1:123456789012:rule/app",
	})
	if permission.Code != http.StatusCreated {
		t.Fatalf("add permission status = %d, body = %s", permission.Code, permission.Body.String())
	}
	var permissionBody struct {
		Statement string `json:"Statement"`
	}
	decodeJSONBody(t, permission, &permissionBody)
	var statement struct {
		Resource string `json:"Resource"`
	}
	if err := json.Unmarshal([]byte(permissionBody.Statement), &statement); err != nil {
		t.Fatal(err)
	}
	if statement.Resource != created.FunctionArn {
		t.Fatalf("permission resource = %q, want %q", statement.Resource, created.FunctionArn)
	}

	qualifiedPermission := executeAWSLambdaRequest(t, handler, http.MethodPost, qualifiedPath+"/policy", map[string]any{
		"StatementId": "allow-live",
		"Action":      "lambda:InvokeFunction",
		"Principal":   "events.amazonaws.com",
	})
	if qualifiedPermission.Code != http.StatusCreated {
		t.Fatalf("add qualified permission status = %d, body = %s", qualifiedPermission.Code, qualifiedPermission.Body.String())
	}
	var qualifiedPermissionBody struct {
		Statement string `json:"Statement"`
	}
	decodeJSONBody(t, qualifiedPermission, &qualifiedPermissionBody)
	var qualifiedStatement struct {
		Resource string `json:"Resource"`
	}
	if err := json.Unmarshal([]byte(qualifiedPermissionBody.Statement), &qualifiedStatement); err != nil {
		t.Fatal(err)
	}
	if qualifiedStatement.Resource != created.FunctionArn+":live" {
		t.Fatalf("qualified permission resource = %q, want %q", qualifiedStatement.Resource, created.FunctionArn+":live")
	}

	policy := executeAWSLambdaRequest(t, handler, http.MethodGet, "/2015-03-31/functions/sdk-lambda-release/policy", nil)
	if policy.Code != http.StatusOK {
		t.Fatalf("get policy status = %d, body = %s", policy.Code, policy.Body.String())
	}
	var policyBody struct {
		Policy string `json:"Policy"`
	}
	decodeJSONBody(t, policy, &policyBody)
	if !strings.Contains(policyBody.Policy, "allow-events") || !strings.Contains(policyBody.Policy, created.FunctionArn) || !strings.Contains(policyBody.Policy, created.FunctionArn+":live") {
		t.Fatalf("unexpected policy: %s", policyBody.Policy)
	}

	referencedVersionDelete := executeAWSLambdaRequest(t, handler, http.MethodDelete, "/2015-03-31/functions/"+url.PathEscape(created.FunctionArn+":1"), nil)
	if referencedVersionDelete.Code != http.StatusConflict {
		t.Fatalf("delete referenced version status = %d, body = %s", referencedVersionDelete.Code, referencedVersionDelete.Body.String())
	}
	aliasAfterRejectedDelete := executeAWSLambdaRawRequest(t, handler, http.MethodPost, qualifiedPath+"/invocations", []byte(`"payload"`))
	if aliasAfterRejectedDelete.Code != http.StatusOK || aliasAfterRejectedDelete.Header().Get("x-amz-executed-version") != "1" {
		t.Fatalf("alias after rejected version delete status = %d, headers = %#v, body = %s", aliasAfterRejectedDelete.Code, aliasAfterRejectedDelete.Header(), aliasAfterRejectedDelete.Body.String())
	}

	removedLive := executeAWSLambdaRequest(t, handler, http.MethodDelete, qualifiedPath+"/policy/allow-live", nil)
	if removedLive.Code != http.StatusNoContent {
		t.Fatalf("remove qualified permission status = %d, body = %s", removedLive.Code, removedLive.Body.String())
	}

	removed := executeAWSLambdaRequest(t, handler, http.MethodDelete, "/2015-03-31/functions/sdk-lambda-release/policy/allow-events", nil)
	if removed.Code != http.StatusNoContent {
		t.Fatalf("remove permission status = %d, body = %s", removed.Code, removed.Body.String())
	}

	deletedAlias := executeAWSLambdaRequest(t, handler, http.MethodDelete, "/2015-03-31/functions/sdk-lambda-release/aliases/live", nil)
	if deletedAlias.Code != http.StatusNoContent {
		t.Fatalf("delete alias status = %d, body = %s", deletedAlias.Code, deletedAlias.Body.String())
	}

	deletedVersion := executeAWSLambdaRequest(t, handler, http.MethodDelete, "/2015-03-31/functions/"+url.PathEscape(created.FunctionArn+":1"), nil)
	if deletedVersion.Code != http.StatusNoContent {
		t.Fatalf("delete version arn status = %d, body = %s", deletedVersion.Code, deletedVersion.Body.String())
	}
	latestConfig := executeAWSLambdaRequest(t, handler, http.MethodGet, "/2015-03-31/functions/sdk-lambda-release/configuration", nil)
	if latestConfig.Code != http.StatusOK {
		t.Fatalf("latest config after version delete status = %d, body = %s", latestConfig.Code, latestConfig.Body.String())
	}
	missingVersion := executeAWSLambdaRequest(t, handler, http.MethodGet, "/2015-03-31/functions/sdk-lambda-release/configuration?Qualifier=1", nil)
	if missingVersion.Code != http.StatusNotFound {
		t.Fatalf("deleted version status = %d, body = %s", missingVersion.Code, missingVersion.Body.String())
	}
}

func TestServiceRejectsLambdaARNOutsideCallerScope(t *testing.T) {
	credentialStore := auth.NewStore(auth.Credential{
		AccessKeyID:     "AKIAFOREIGN",
		SecretAccessKey: "secret",
		AccountID:       "999999999999",
		PrincipalARN:    "arn:aws:iam::999999999999:user/foreign",
	})
	handler := newTestHandlerWithCredentialStore(credentialStore)

	create := executeAWSLambdaRequestWithAccessKey(t, handler, http.MethodPost, "/2015-03-31/functions", map[string]any{
		"FunctionName": "foreign-lambda",
		"Runtime":      "nodejs22.x",
		"Role":         "arn:aws:iam::999999999999:role/lambda-execution-role",
		"Handler":      "index.handler",
		"Code":         map[string]any{"ZipFile": base64.StdEncoding.EncodeToString([]byte("exports.handler = async () => ({ ok: true })"))},
	}, "AKIAFOREIGN")
	if create.Code != http.StatusCreated {
		t.Fatalf("foreign create status = %d, body = %s", create.Code, create.Body.String())
	}
	var created struct {
		FunctionArn string `json:"FunctionArn"`
	}
	decodeJSONBody(t, create, &created)
	if !strings.Contains(created.FunctionArn, ":999999999999:") {
		t.Fatalf("foreign arn = %q", created.FunctionArn)
	}

	foreignARNPath := "/2015-03-31/functions/" + url.PathEscape(created.FunctionArn) + "/configuration"
	callerGet := executeAWSLambdaRequest(t, handler, http.MethodGet, foreignARNPath, nil)
	if callerGet.Code != http.StatusNotFound {
		t.Fatalf("default caller foreign arn status = %d, body = %s", callerGet.Code, callerGet.Body.String())
	}

	ownerGet := executeAWSLambdaRequestWithAccessKey(t, handler, http.MethodGet, foreignARNPath, nil, "AKIAFOREIGN")
	if ownerGet.Code != http.StatusOK {
		t.Fatalf("owner foreign arn status = %d, body = %s", ownerGet.Code, ownerGet.Body.String())
	}
}

func TestServiceDoesNotTreatKnownNonS3ServiceRootAsS3(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/lambda", nil)

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/x-amz-json-1.0" {
		t.Fatalf("content type = %q", got)
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["__type"] != "com.amazonaws.lambda#NotImplemented" {
		t.Fatalf("unexpected body: %#v", body)
	}
	if strings.Contains(res.Body.String(), "s3.ListObjects") {
		t.Fatalf("unexpected S3 fallback response: %s", res.Body.String())
	}
}

func TestServicePassesThroughNonAWSNotFound(t *testing.T) {
	handler := newTestHandler()
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/missing", nil))

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["message"] != "Not Found" {
		t.Fatalf("unexpected body: %#v", body)
	}
}

func TestServicePassesThroughNestedKnownServicePathWithoutAWSHints(t *testing.T) {
	handler := newTestHandler()
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/sqs/foo", nil))

	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["message"] != "Not Found" {
		t.Fatalf("unexpected body: %#v", body)
	}
	if strings.Contains(res.Body.String(), "s3.GetObject") {
		t.Fatalf("unexpected S3 fallback response: %s", res.Body.String())
	}
}

func TestServicePassesThroughGenericListQueryParams(t *testing.T) {
	handler := newTestHandler()
	for _, target := range []string{
		"/users?continuation-token=abc",
		"/users?delimiter=/",
		"/users?list-type=1",
		"/users?max-keys=10",
		"/users?partNumber=1",
		"/users?prefix=a",
		"/users?start-after=a",
	} {
		t.Run(target, func(t *testing.T) {
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, target, nil))

			if res.Code != http.StatusNotFound {
				t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
			}
			var body map[string]string
			if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["message"] != "Not Found" {
				t.Fatalf("unexpected body: %#v", body)
			}
		})
	}
}

func TestServiceRendersInspectorWithDefaultIAMUser(t *testing.T) {
	handler := newTestHandler()
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/_inspector?tab=iam", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{"AWS Emulator", "S3", "SQS", "IAM", "SSM", "KMS", "IAM Users (1)", "IAM Roles (0)", "admin", "Access Keys", "No roles"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("inspector missing %q in %s", expected, body)
		}
	}
}

func TestNewStoreCreatesAWSCollections(t *testing.T) {
	runtimeStore := corestore.New()
	awsStore := NewStore(runtimeStore)

	awsStore.S3Buckets.Insert(corestore.Record{"bucket_name": "photos"})
	awsStore.SQSQueues.Insert(corestore.Record{"queue_name": "jobs", "queue_url": "http://localhost/sqs/jobs"})
	awsStore.SNSTopics.Insert(corestore.Record{"topic_name": "events", "arn": "arn:aws:sns:us-east-1:123456789012:events"})
	awsStore.IAMUsers.Insert(corestore.Record{"user_name": "developer", "user_id": "AIDAEXAMPLE"})
	awsStore.SSMParameters.Insert(corestore.Record{"account_id": "123456789012", "region": "us-east-1", "name": "/app/value", "arn": "arn:aws:ssm:us-east-1:123456789012:parameter/app/value"})
	awsStore.KMSKeys.Insert(corestore.Record{"account_id": "123456789012", "region": "us-east-1", "key_id": "key-1", "arn": "arn:aws:kms:us-east-1:123456789012:key/key-1"})

	snapshot := runtimeStore.Snapshot()
	for _, name := range []string{"aws.s3_buckets", "aws.s3_objects", "aws.sqs_queues", "aws.sqs_messages", "aws.sns_topics", "aws.sns_subscriptions", "aws.sns_deliveries", "aws.event_buses", "aws.event_rules", "aws.event_targets", "aws.event_deliveries", "aws.log_groups", "aws.log_streams", "aws.log_events", "aws.secretsmanager_secrets", "aws.secretsmanager_versions", "aws.ssm_parameters", "aws.ssm_parameter_versions", "aws.kms_keys", "aws.kms_aliases", "aws.iam_users", "aws.iam_roles", "aws.iam_policies", "aws.dynamodb_tables", "aws.dynamodb_items"} {
		if _, ok := snapshot.Collections[name]; !ok {
			t.Fatalf("missing collection %s", name)
		}
	}
}

func TestServiceSeedsAWSConfig(t *testing.T) {
	router := corehttp.NewRouter()
	Register(router, Options{
		Store:           corestore.New(),
		CredentialStore: auth.NewStore(),
		BaseURL:         "http://localhost:4017",
		Seed: &SeedConfig{
			Region:    "us-west-2",
			AccountID: "999999999999",
			S3:        S3Seed{Buckets: []S3BucketSeed{{Name: "seeded-bucket", Region: "eu-west-1"}}},
			SQS:       SQSSeed{Queues: []SQSQueueSeed{{Name: "seeded-queue", VisibilityTimeout: 45}}},
			Secrets:   SecretsManagerSeed{Secrets: []SecretSeed{{Name: "seeded/secret", SecretString: "seeded-value", KMSKeyID: "alias/seed"}}},
			SSM:       SSMSeed{Parameters: []SSMParameterSeed{{Name: "/seeded/config", Type: "SecureString", Value: "seeded-parameter", KeyID: "alias/seed"}}},
			KMS:       KMSSeed{Keys: []KMSKeySeed{{KeyID: "11111111-1111-1111-1111-111111111111", Description: "Seeded key", Aliases: []string{"alias/seed"}}}},
			IAM: IAMSeed{
				Users: []IAMUserSeed{{UserName: "developer", CreateAccessKey: true}},
				Roles: []IAMRoleSeed{{RoleName: "worker", Description: "Worker role", AssumeRolePolicy: `{"Version":"2012-10-17","Statement":[]}`}},
			},
		},
	})

	res := executeAWSRequest(router, http.MethodHead, "http://127.0.0.1/seeded-bucket", nil, "s3", nil)
	if res.Code != http.StatusOK || res.Header().Get("x-amz-bucket-region") != "eu-west-1" {
		t.Fatalf("head bucket status = %d, headers = %#v, body = %s", res.Code, res.Header(), res.Body.String())
	}

	res = executeAWSQueryRequest(router, "sqs", "Action=GetQueueUrl&QueueName=seeded-queue")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "http://localhost:4017/sqs/999999999999/seeded-queue") {
		t.Fatalf("get seeded queue status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(router, "iam", "Action=GetUser&UserName=developer")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "arn:aws:iam::999999999999:user/developer") {
		t.Fatalf("get seeded user status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSQueryRequest(router, "iam", "Action=GetRole&RoleName=worker")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "Worker role") {
		t.Fatalf("get seeded role status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSSecretsManagerRequestWithRegion(t, router, "GetSecretValue", map[string]any{"SecretId": "seeded/secret"}, "us-west-2")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "seeded-value") {
		t.Fatalf("get seeded secret status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSSSMRequestWithRegion(t, router, "GetParameter", map[string]any{"Name": "/seeded/config", "WithDecryption": true}, "us-west-2")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "seeded-parameter") {
		t.Fatalf("get seeded parameter status = %d, body = %s", res.Code, res.Body.String())
	}

	res = executeAWSKMSRequestWithRegion(t, router, "DescribeKey", map[string]any{"KeyId": "alias/seed"}, "us-west-2")
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "Seeded key") {
		t.Fatalf("describe seeded key status = %d, body = %s", res.Code, res.Body.String())
	}
}

func TestServiceHandlesSecretsManagerJSONRPC(t *testing.T) {
	handler := newTestHandler()

	res := executeAWSSecretsManagerRequest(t, handler, "CreateSecret", map[string]any{
		"Name":         "app/secret",
		"SecretString": "initial",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", res.Code, res.Body.String())
	}
	var created struct {
		ARN string `json:"ARN"`
	}
	decodeJSONBody(t, res, &created)
	if !strings.Contains(created.ARN, ":secret:app/secret-") {
		t.Fatalf("arn = %q", created.ARN)
	}

	res = executeAWSSecretsManagerRequest(t, handler, "GetSecretValue", map[string]any{"SecretId": "app/secret"})
	if res.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", res.Code, res.Body.String())
	}
	var got struct {
		SecretString string `json:"SecretString"`
	}
	decodeJSONBody(t, res, &got)
	if got.SecretString != "initial" {
		t.Fatalf("secret string = %q", got.SecretString)
	}
}

func newTestHandler() http.Handler {
	return newTestHandlerWithCredentialStore(nil)
}

func newTestHandlerWithCredentialStore(credentialStore *auth.Store) http.Handler {
	return newTestHandlerWithOptions(Options{CredentialStore: credentialStore})
}

func newTestHandlerWithOptions(options Options) http.Handler {
	router := corehttp.NewRouter()
	ui.RegisterAssetRoutes(router)
	options.Store = corestore.New()
	Register(router, options)
	router.NotFound(func(c *corehttp.Context) {
		c.JSON(http.StatusNotFound, map[string]any{"message": "Not Found"})
	})
	return router
}

func executeAWSRequest(handler http.Handler, method string, target string, body []byte, service string, headers map[string]string) *httptest.ResponseRecorder {
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if service != "" {
		signAWSRequest(req, service)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func executeAWSQueryRequest(handler http.Handler, service string, body string) *httptest.ResponseRecorder {
	return executeAWSQueryRequestWithAccessKey(handler, service, body, "AKIAEXAMPLE")
}

func executeAWSQueryRequestWithAccessKey(handler http.Handler, service string, body string, accessKeyID string) *httptest.ResponseRecorder {
	return executeAWSQueryRequestWithAccessKeyAndToken(handler, service, body, accessKeyID, "")
}

func executeAWSQueryRequestWithAccessKeyAndToken(handler http.Handler, service string, body string, accessKeyID string, sessionToken string) *httptest.ResponseRecorder {
	headers := map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
		"X-Access-Key": accessKeyID,
	}
	if sessionToken != "" {
		headers["X-Amz-Security-Token"] = sessionToken
	}
	return executeAWSRequest(handler, http.MethodPost, "http://127.0.0.1/"+service+"/", []byte(body), service, headers)
}

func executeAWSJSONRequest(t *testing.T, handler http.Handler, action string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/sqs/", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/x-amz-json-1.0")
	req.Header.Set("X-Amz-Target", "AmazonSQS."+action)
	signAWSRequest(req, "sqs")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func executeAWSDynamoDBRequest(t *testing.T, handler http.Handler, action string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/dynamodb/", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/x-amz-json-1.0")
	req.Header.Set("X-Amz-Target", "DynamoDB_20120810."+action)
	signAWSRequest(req, "dynamodb")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func executeAWSEventBridgeRequest(t *testing.T, handler http.Handler, action string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	return executeAWSEventBridgeRequestWithAccessKey(t, handler, action, payload, "AKIAEXAMPLE")
}

func executeAWSEventBridgeRequestWithAccessKey(t *testing.T, handler http.Handler, action string, payload map[string]any, accessKeyID string) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/events/", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/x-amz-json-1.1")
	req.Header.Set("X-Amz-Target", "AWSEvents."+action)
	req.Header.Set("X-Access-Key", accessKeyID)
	signAWSRequest(req, "events")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func executeAWSLogsRequest(t *testing.T, handler http.Handler, action string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/logs/", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/x-amz-json-1.1")
	req.Header.Set("X-Amz-Target", "Logs_20140328."+action)
	signAWSRequest(req, "logs")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func executeAWSSecretsManagerRequest(t *testing.T, handler http.Handler, action string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	return executeAWSSecretsManagerRequestWithRegion(t, handler, action, payload, "us-east-1")
}

func executeAWSSecretsManagerRequestWithRegion(t *testing.T, handler http.Handler, action string, payload map[string]any, region string) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/secretsmanager/", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/x-amz-json-1.1")
	req.Header.Set("X-Amz-Target", "secretsmanager."+action)
	signAWSRequestWithRegion(req, "secretsmanager", region)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func executeAWSSSMRequest(t *testing.T, handler http.Handler, action string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	return executeAWSSSMRequestWithRegion(t, handler, action, payload, "us-east-1")
}

func executeAWSSSMRequestWithRegion(t *testing.T, handler http.Handler, action string, payload map[string]any, region string) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/ssm/", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/x-amz-json-1.1")
	req.Header.Set("X-Amz-Target", "AmazonSSM."+action)
	signAWSRequestWithRegion(req, "ssm", region)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func executeAWSKMSRequest(t *testing.T, handler http.Handler, action string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	return executeAWSKMSRequestWithRegion(t, handler, action, payload, "us-east-1")
}

func executeAWSKMSRequestWithRegion(t *testing.T, handler http.Handler, action string, payload map[string]any, region string) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/kms/", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/x-amz-json-1.1")
	req.Header.Set("X-Amz-Target", "TrentService."+action)
	signAWSRequestWithRegion(req, "kms", region)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func zipLambdaSource(t *testing.T, files map[string]string) string {
	t.Helper()
	var buf bytes.Buffer
	archive := zip.NewWriter(&buf)
	for name, source := range files {
		file, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(source)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func executeAWSLambdaRequest(t *testing.T, handler http.Handler, method string, path string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	return executeAWSLambdaRequestWithAccessKey(t, handler, method, path, payload, "")
}

func executeAWSLambdaRequestWithAccessKey(t *testing.T, handler http.Handler, method string, path string, payload map[string]any, accessKeyID string) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	if payload != nil {
		var err error
		raw, err = json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
	}
	return executeAWSLambdaRawRequestWithAccessKey(t, handler, method, path, raw, accessKeyID)
}

func executeAWSLambdaRawRequest(t *testing.T, handler http.Handler, method string, path string, raw []byte) *httptest.ResponseRecorder {
	t.Helper()
	return executeAWSLambdaRawRequestWithAccessKey(t, handler, method, path, raw, "")
}

func executeAWSLambdaRawRequestWithAccessKey(t *testing.T, handler http.Handler, method string, path string, raw []byte, accessKeyID string) *httptest.ResponseRecorder {
	t.Helper()
	return executeAWSLambdaRawRequestWithAccessKeyAndRemoteAddr(t, handler, method, path, raw, accessKeyID, "127.0.0.1:1234")
}

func executeAWSLambdaRawRequestWithAccessKeyAndRemoteAddr(t *testing.T, handler http.Handler, method string, path string, raw []byte, accessKeyID string, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()
	return executeAWSLambdaRawRequestWithAccessKeyRemoteAddrHostAndHeaders(t, handler, method, path, raw, accessKeyID, remoteAddr, "127.0.0.1", nil)
}

func executeAWSLambdaRawRequestWithAccessKeyRemoteAddrHostAndHeaders(t *testing.T, handler http.Handler, method string, path string, raw []byte, accessKeyID string, remoteAddr string, host string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	if raw == nil {
		raw = []byte{}
	}
	if host == "" {
		host = "127.0.0.1"
	}
	req := httptest.NewRequest(method, "http://"+host+path, bytes.NewReader(raw))
	req.RemoteAddr = remoteAddr
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if accessKeyID != "" {
		req.Header.Set("X-Access-Key", accessKeyID)
	}
	signAWSRequest(req, "lambda")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func decodeJSONBody(t *testing.T, res *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(res.Body.Bytes(), target); err != nil {
		t.Fatalf("decode body %s: %v", res.Body.String(), err)
	}
}

func executeS3MultipartPost(t *testing.T, handler http.Handler, target string, fields map[string]string, fileBody []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("file", "upload.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(fileBody); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return executeAWSRequest(handler, http.MethodPost, target, body.Bytes(), "s3", map[string]string{
		"Content-Type": writer.FormDataContentType(),
	})
}

func encodePostPolicy(t *testing.T, conditions []any) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"expiration": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		"conditions": conditions,
	})
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func xmlElement(body string, name string) string {
	startToken := "<" + name + ">"
	endToken := "</" + name + ">"
	start := strings.Index(body, startToken)
	if start < 0 {
		return ""
	}
	start += len(startToken)
	end := strings.Index(body[start:], endToken)
	if end < 0 {
		return ""
	}
	return body[start : start+end]
}

func xmlElements(body string, name string) []string {
	values := []string{}
	startToken := "<" + name + ">"
	endToken := "</" + name + ">"
	for {
		start := strings.Index(body, startToken)
		if start < 0 {
			return values
		}
		start += len(startToken)
		end := strings.Index(body[start:], endToken)
		if end < 0 {
			return values
		}
		values = append(values, body[start:start+end])
		body = body[start+end+len(endToken):]
	}
}

func xmlValueForName(body string, name string) string {
	nameToken := "<Name>" + name + "</Name>"
	nameIndex := strings.Index(body, nameToken)
	if nameIndex < 0 {
		return ""
	}
	return xmlElement(body[nameIndex:], "Value")
}

func assertQueryBatchError(t *testing.T, handler http.Handler, values url.Values, code string) {
	t.Helper()
	res := executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusBadRequest {
		t.Fatalf("batch error status = %d, body = %s", res.Code, res.Body.String())
	}
	want := "AWS.SimpleQueueService." + code
	if got := xmlElement(res.Body.String(), "Code"); got != want {
		t.Fatalf("batch error code = %q, want %q, body = %s", got, want, res.Body.String())
	}
}

func assertJSONBatchError(t *testing.T, res *httptest.ResponseRecorder, code string) {
	t.Helper()
	if res.Code != http.StatusBadRequest {
		t.Fatalf("batch error status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("x-amzn-errortype"); got != code {
		t.Fatalf("batch error header = %q, want %q", got, code)
	}
	var parsed map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("decode batch error %s: %v", res.Body.String(), err)
	}
	if got := parsed["__type"]; got != "com.amazonaws.sqs#"+code {
		t.Fatalf("batch error type = %q, want %q", got, "com.amazonaws.sqs#"+code)
	}
}

func receiveOneQueryMessage(t *testing.T, handler http.Handler, queueURL string, body string) string {
	t.Helper()
	values := url.Values{}
	values.Set("Action", "ReceiveMessage")
	values.Set("QueueUrl", queueURL)
	values.Set("MaxNumberOfMessages", "1")
	res := executeAWSQueryRequest(handler, "sqs", values.Encode())
	if res.Code != http.StatusOK {
		t.Fatalf("receive status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := xmlElement(res.Body.String(), "Body"); got != body {
		t.Fatalf("message body = %q, want %q, response = %s", got, body, res.Body.String())
	}
	receipt := xmlElement(res.Body.String(), "ReceiptHandle")
	if receipt == "" {
		t.Fatalf("missing receipt in %s", res.Body.String())
	}
	return receipt
}

func signAWSRequest(req *http.Request, service string) {
	signAWSRequestWithRegion(req, service, "us-east-1")
}

func signAWSRequestWithRegion(req *http.Request, service string, region string) {
	accessKeyID := req.Header.Get("X-Access-Key")
	if accessKeyID == "" {
		accessKeyID = "AKIAEXAMPLE"
	}
	req.Header.Del("X-Access-Key")
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+accessKeyID+"/20260519/"+region+"/"+service+"/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef")
	req.Header.Set("X-Amz-Date", "20260519T000000Z")
}
