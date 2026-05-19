package protocols

import (
	"encoding/json"
	"encoding/xml"
	"net/http"
	"testing"
)

func TestSerializeXMLErrorUsesQueryShape(t *testing.T) {
	response := SerializeXMLError(AWSError{
		Code:       "AccessDenied",
		Message:    "denied",
		RequestID:  "req-123",
		StatusCode: http.StatusForbidden,
	})

	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusForbidden)
	}
	if response.ContentType != "application/xml" || response.Headers["Content-Type"] != "application/xml" {
		t.Fatalf("unexpected content type: %#v", response)
	}
	if response.Headers["x-amzn-requestid"] != "req-123" {
		t.Fatalf("request header = %q, want req-123", response.Headers["x-amzn-requestid"])
	}

	var parsed struct {
		Error struct {
			Type    string `xml:"Type"`
			Code    string `xml:"Code"`
			Message string `xml:"Message"`
		} `xml:"Error"`
		RequestID string `xml:"RequestId"`
	}
	if err := xml.Unmarshal(response.Body, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Error.Type != "Sender" || parsed.Error.Code != "AccessDenied" || parsed.Error.Message != "denied" {
		t.Fatalf("unexpected parsed error: %#v", parsed.Error)
	}
	if parsed.RequestID != "req-123" {
		t.Fatalf("request id = %q, want req-123", parsed.RequestID)
	}
}

func TestSerializeRESTXMLErrorUsesS3Shape(t *testing.T) {
	response := SerializeRESTXMLError(AWSError{
		Code:       "NoSuchBucket",
		Message:    "missing bucket",
		RequestID:  "req-s3",
		Resource:   "/photos",
		StatusCode: http.StatusNotFound,
	})

	if response.Headers["x-amz-request-id"] != "req-s3" {
		t.Fatalf("S3 request header = %q, want req-s3", response.Headers["x-amz-request-id"])
	}

	var parsed struct {
		Code      string `xml:"Code"`
		Message   string `xml:"Message"`
		Resource  string `xml:"Resource"`
		RequestID string `xml:"RequestId"`
	}
	if err := xml.Unmarshal(response.Body, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Code != "NoSuchBucket" || parsed.Message != "missing bucket" || parsed.Resource != "/photos" {
		t.Fatalf("unexpected parsed error: %#v", parsed)
	}
}

func TestSerializeJSONErrorIncludesSDKErrorType(t *testing.T) {
	response := SerializeJSONError(AWSError{
		Code:       "ResourceNotFoundException",
		Message:    "missing table",
		RequestID:  "req-json",
		Service:    "com.amazonaws.dynamodb.v20120810",
		StatusCode: http.StatusBadRequest,
	})

	if response.ContentType != "application/x-amz-json-1.0" {
		t.Fatalf("content type = %q", response.ContentType)
	}
	if response.Headers["x-amzn-errortype"] != "ResourceNotFoundException" {
		t.Fatalf("error type header = %q", response.Headers["x-amzn-errortype"])
	}
	if response.Headers["x-amzn-requestid"] != "req-json" {
		t.Fatalf("request id header = %q", response.Headers["x-amzn-requestid"])
	}

	var parsed map[string]string
	if err := json.Unmarshal(response.Body, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["__type"] != "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException" {
		t.Fatalf("__type = %q", parsed["__type"])
	}
	if parsed["message"] != "missing table" {
		t.Fatalf("message = %q", parsed["message"])
	}
}
