package protocols

import (
	"encoding/json"
	"encoding/xml"
	"net/http"
	"strings"
)

type AWSError struct {
	Code       string
	Message    string
	Type       string
	RequestID  string
	Resource   string
	Service    string
	StatusCode int
}

type ErrorResponse struct {
	StatusCode   int
	ContentType  string
	Headers      map[string]string
	HeaderValues map[string][]string
	Body         []byte
}

func SerializeXMLError(awsError AWSError) ErrorResponse {
	awsError = normalizeAWSError(awsError)
	body, _ := xml.Marshal(queryXMLErrorResponse{
		Error: queryXMLError{
			Type:    awsError.Type,
			Code:    awsError.Code,
			Message: awsError.Message,
		},
		RequestID: awsError.RequestID,
	})
	return ErrorResponse{
		StatusCode:  awsError.StatusCode,
		ContentType: "application/xml",
		Headers:     errorHeaders(awsError, "application/xml"),
		Body:        append([]byte(xml.Header), body...),
	}
}

func SerializeRESTXMLError(awsError AWSError) ErrorResponse {
	awsError = normalizeAWSError(awsError)
	body, _ := xml.Marshal(restXMLError{
		Code:      awsError.Code,
		Message:   awsError.Message,
		Resource:  awsError.Resource,
		RequestID: awsError.RequestID,
	})
	headers := errorHeaders(awsError, "application/xml")
	if awsError.RequestID != "" {
		headers["x-amz-request-id"] = awsError.RequestID
	}
	return ErrorResponse{
		StatusCode:  awsError.StatusCode,
		ContentType: "application/xml",
		Headers:     headers,
		Body:        append([]byte(xml.Header), body...),
	}
}

func SerializeJSONError(awsError AWSError) ErrorResponse {
	awsError = normalizeAWSError(awsError)
	errorType := awsError.Code
	if awsError.Service != "" && !strings.Contains(errorType, "#") {
		errorType = awsError.Service + "#" + errorType
	}
	body, _ := json.Marshal(map[string]string{
		"__type":  errorType,
		"message": awsError.Message,
	})
	headers := errorHeaders(awsError, "application/x-amz-json-1.0")
	headers["x-amzn-errortype"] = awsError.Code
	return ErrorResponse{
		StatusCode:  awsError.StatusCode,
		ContentType: "application/x-amz-json-1.0",
		Headers:     headers,
		Body:        body,
	}
}

type queryXMLErrorResponse struct {
	XMLName   xml.Name      `xml:"ErrorResponse"`
	Error     queryXMLError `xml:"Error"`
	RequestID string        `xml:"RequestId,omitempty"`
}

type queryXMLError struct {
	Type    string `xml:"Type,omitempty"`
	Code    string `xml:"Code"`
	Message string `xml:"Message"`
}

type restXMLError struct {
	XMLName   xml.Name `xml:"Error"`
	Code      string   `xml:"Code"`
	Message   string   `xml:"Message"`
	Resource  string   `xml:"Resource,omitempty"`
	RequestID string   `xml:"RequestId,omitempty"`
}

func normalizeAWSError(awsError AWSError) AWSError {
	if awsError.Code == "" {
		awsError.Code = "InternalFailure"
	}
	if awsError.Message == "" {
		awsError.Message = "An internal error occurred."
	}
	if awsError.StatusCode == 0 {
		if awsError.Code == "InternalFailure" {
			awsError.StatusCode = http.StatusInternalServerError
		} else {
			awsError.StatusCode = http.StatusBadRequest
		}
	}
	if awsError.Type == "" {
		if awsError.StatusCode >= 500 {
			awsError.Type = "Receiver"
		} else {
			awsError.Type = "Sender"
		}
	}
	return awsError
}

func errorHeaders(awsError AWSError, contentType string) map[string]string {
	headers := map[string]string{
		"Content-Type": contentType,
	}
	if awsError.RequestID != "" {
		headers["x-amzn-requestid"] = awsError.RequestID
	}
	return headers
}
