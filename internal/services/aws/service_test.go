package aws

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	if arn := xmlElement(res.Body.String(), "Arn"); arn != roleARN+"/test-session" {
		t.Fatalf("assumed arn = %q, want %q", arn, roleARN+"/test-session")
	}

	res = executeAWSQueryRequest(handler, "iam", "Action=DeleteRole&RoleName=worker")
	if res.Code != http.StatusOK {
		t.Fatalf("delete role status = %d, body = %s", res.Code, res.Body.String())
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

func TestServiceRendersInspectorWithDefaultIAMUser(t *testing.T) {
	handler := newTestHandler()
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/_inspector?tab=iam", nil))

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{"AWS Emulator", "S3", "SQS", "IAM", "IAM Users (1)", "IAM Roles (0)", "admin", "Access Keys", "No roles"} {
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

	snapshot := runtimeStore.Snapshot()
	for _, name := range []string{"aws.s3_buckets", "aws.s3_objects", "aws.sqs_queues", "aws.sqs_messages", "aws.sns_topics", "aws.sns_subscriptions", "aws.sns_deliveries", "aws.event_buses", "aws.event_rules", "aws.event_targets", "aws.event_deliveries", "aws.iam_users", "aws.iam_roles", "aws.dynamodb_tables", "aws.dynamodb_items"} {
		if _, ok := snapshot.Collections[name]; !ok {
			t.Fatalf("missing collection %s", name)
		}
	}
}

func newTestHandler() http.Handler {
	return newTestHandlerWithCredentialStore(nil)
}

func newTestHandlerWithCredentialStore(credentialStore *auth.Store) http.Handler {
	router := corehttp.NewRouter()
	ui.RegisterAssetRoutes(router)
	Register(router, Options{Store: corestore.New(), CredentialStore: credentialStore})
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

func xmlValueForName(body string, name string) string {
	nameToken := "<Name>" + name + "</Name>"
	nameIndex := strings.Index(body, nameToken)
	if nameIndex < 0 {
		return ""
	}
	return xmlElement(body[nameIndex:], "Value")
}

func signAWSRequest(req *http.Request, service string) {
	accessKeyID := req.Header.Get("X-Access-Key")
	if accessKeyID == "" {
		accessKeyID = "AKIAEXAMPLE"
	}
	req.Header.Del("X-Access-Key")
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+accessKeyID+"/20260519/us-east-1/"+service+"/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef")
	req.Header.Set("X-Amz-Date", "20260519T000000Z")
}
