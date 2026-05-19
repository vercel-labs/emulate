package aws

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/core/ui"
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

func TestServiceHandlesS3ObjectLifecycleWithBinaryBodyAndMetadata(t *testing.T) {
	handler := newTestHandler()
	body := []byte{0, 1, 2, 3, 255, 'o', 'k'}

	res := executeAWSRequest(handler, http.MethodPut, "http://127.0.0.1/emulate-default/docs/data.bin", body, "s3", map[string]string{
		"Content-Type":      "application/octet-stream",
		"x-amz-meta-origin": "native-test",
	})
	if res.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("ETag"); got == "" || !strings.HasPrefix(got, `"`) {
		t.Fatalf("etag = %q", got)
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

func TestServiceReturnsQueryXMLNotImplemented(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/sqs/", strings.NewReader("Action=CreateQueue&QueueName=jobs"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	signAWSRequest(req, "sqs")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	if got := res.Header().Get("x-amzn-requestid"); got == "" {
		t.Fatal("missing x-amzn-requestid")
	}
	body := res.Body.String()
	if !strings.Contains(body, "<Code>NotImplemented</Code>") || !strings.Contains(body, "sqs.CreateQueue") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceAcceptsBearerTokenForQueryShell(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/sqs/", strings.NewReader("Action=CreateQueue&QueueName=jobs"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Bearer test_token_admin")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Content-Type"); got != "application/xml" {
		t.Fatalf("content type = %q", got)
	}
	if body := res.Body.String(); !strings.Contains(body, "sqs.CreateQueue") {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestServiceReturnsJSONRPCNotImplemented(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/", strings.NewReader(`{"TableName":"items"}`))
	req.Header.Set("X-Amz-Target", "DynamoDB_20120810.DescribeTable")
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
	if !strings.Contains(body["message"], "dynamodb.DescribeTable") {
		t.Fatalf("unexpected message: %#v", body)
	}
}

func TestServiceDoesNotTreatSignedNonS3ServicePathAsS3(t *testing.T) {
	handler := newTestHandler()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/lambda/2015-03-31/functions", nil)
	signAWSRequest(req, "lambda")

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
	if strings.Contains(res.Body.String(), "s3.GetObject") {
		t.Fatalf("unexpected S3 fallback response: %s", res.Body.String())
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

func TestServiceRendersEmptyInspector(t *testing.T) {
	handler := newTestHandler()
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/_inspector?tab=iam", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{"AWS Emulator", "S3", "SQS", "IAM", "IAM Users (0)", "IAM Roles (0)", "No users", "No roles"} {
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
	awsStore.IAMUsers.Insert(corestore.Record{"user_name": "developer", "user_id": "AIDAEXAMPLE"})

	snapshot := runtimeStore.Snapshot()
	for _, name := range []string{"aws.s3_buckets", "aws.s3_objects", "aws.sqs_queues", "aws.sqs_messages", "aws.iam_users", "aws.iam_roles"} {
		if _, ok := snapshot.Collections[name]; !ok {
			t.Fatalf("missing collection %s", name)
		}
	}
}

func newTestHandler() http.Handler {
	router := corehttp.NewRouter()
	ui.RegisterAssetRoutes(router)
	Register(router, Options{Store: corestore.New()})
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

func signAWSRequest(req *http.Request, service string) {
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260519/us-east-1/"+service+"/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef")
	req.Header.Set("X-Amz-Date", "20260519T000000Z")
}
