package aws

import (
	"fmt"
	"io"
	"net/http"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

func readRequestBody(req *http.Request) ([]byte, error) {
	if req.Body == nil {
		return nil, nil
	}
	defer req.Body.Close()
	return io.ReadAll(req.Body)
}

func awsAuthError(ctx gateway.AwsRequestContext) protocols.AWSError {
	return protocols.AWSError{
		Code:       ctx.Auth.Error.Code,
		Message:    ctx.Auth.Error.Message,
		RequestID:  ctx.RequestID,
		Service:    jsonErrorService(ctx.Service),
		StatusCode: ctx.Auth.Error.StatusCode,
	}
}

func notImplementedError(ctx gateway.AwsRequestContext) protocols.AWSError {
	message := "AWS operation is not implemented in the native Go runtime yet."
	if ctx.Service != "" && ctx.Action != "" {
		message = fmt.Sprintf("%s.%s is not implemented in the native Go runtime yet.", ctx.Service, ctx.Action)
	}
	code := "NotImplemented"
	if ctx.Protocol == protocols.ProtocolJSONRPC {
		code = "NotImplementedException"
	}
	return protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  ctx.RequestID,
		Resource:   requestResource(ctx),
		Service:    jsonErrorService(ctx.Service),
		StatusCode: http.StatusNotImplemented,
	}
}

func (s *Service) writeParseError(c *corehttp.Context, err error) {
	response := protocols.SerializeJSONError(protocols.AWSError{
		Code:       "InvalidRequestException",
		Message:    err.Error(),
		RequestID:  gateway.NewRequestID(),
		StatusCode: http.StatusBadRequest,
	})
	writeErrorResponse(c, response)
}

func (s *Service) writeAWSError(c *corehttp.Context, ctx gateway.AwsRequestContext, awsError protocols.AWSError) {
	var response protocols.ErrorResponse
	switch ctx.Protocol {
	case protocols.ProtocolRESTXML:
		response = protocols.SerializeRESTXMLError(awsError)
	case protocols.ProtocolQuery:
		response = protocols.SerializeXMLError(awsError)
	case protocols.ProtocolJSONRPC:
		response = protocols.SerializeJSONError(awsError)
	default:
		response = protocols.SerializeJSONError(awsError)
	}
	writeErrorResponse(c, response)
}

func writeErrorResponse(c *corehttp.Context, response protocols.ErrorResponse) {
	for key, value := range response.Headers {
		c.Writer.Header().Set(key, value)
	}
	for key, values := range response.HeaderValues {
		if len(values) == 0 {
			continue
		}
		c.Writer.Header().Del(key)
		for _, value := range values {
			c.Writer.Header().Add(key, value)
		}
	}
	c.Binary(response.StatusCode, response.ContentType, response.Body)
}

func requestResource(ctx gateway.AwsRequestContext) string {
	if ctx.S3 == nil {
		return ""
	}
	var parts []string
	if ctx.S3.Bucket != "" {
		parts = append(parts, ctx.S3.Bucket)
	}
	if ctx.S3.Key != "" {
		parts = append(parts, ctx.S3.Key)
	}
	if len(parts) == 0 {
		return "/"
	}
	return "/" + strings.Join(parts, "/")
}

func jsonErrorService(service string) string {
	switch service {
	case "apigatewayv2":
		return "com.amazonaws.apigatewayv2"
	case "dynamodb":
		return "com.amazonaws.dynamodb.v20120810"
	case "events":
		return "com.amazonaws.events"
	case "lambda":
		return "com.amazonaws.lambda"
	case "kms":
		return "com.amazonaws.kms"
	case "logs":
		return "com.amazonaws.logs"
	case "secretsmanager":
		return "com.amazonaws.secretsmanager"
	case "ssm":
		return "com.amazonaws.ssm"
	case "states":
		return "com.amazonaws.stepfunctions"
	default:
		return service
	}
}
