package protocols

import (
	"net/http"
	"net/url"
	"strings"
)

type Protocol string

const (
	ProtocolUnknown  Protocol = "unknown"
	ProtocolRESTXML  Protocol = "rest_xml"
	ProtocolRESTJSON Protocol = "rest_json"
	ProtocolQuery    Protocol = "query"
	ProtocolJSONRPC  Protocol = "json_rpc"
)

type QueryRequest struct {
	Parameters map[string]string
	Action     string
	Version    string
}

func ParseQueryString(raw string) (map[string]string, error) {
	raw = strings.TrimPrefix(raw, "?")
	values, err := url.ParseQuery(raw)
	if err != nil {
		return nil, err
	}
	return flattenValues(values), nil
}

func ParseQueryRequest(req *http.Request, body []byte) (QueryRequest, error) {
	params := map[string]string{}
	queryParams, err := ParseQueryString(req.URL.RawQuery)
	if err != nil {
		return QueryRequest{}, err
	}
	mergeParams(params, queryParams)

	if shouldParseQueryBody(req, body) {
		bodyParams, err := ParseQueryString(string(body))
		if err != nil {
			return QueryRequest{}, err
		}
		mergeParams(params, bodyParams)
	}

	return QueryRequest{
		Parameters: params,
		Action:     params["Action"],
		Version:    params["Version"],
	}, nil
}

func flattenValues(values url.Values) map[string]string {
	params := make(map[string]string, len(values))
	for key, value := range values {
		if len(value) == 0 {
			params[key] = ""
			continue
		}
		params[key] = value[0]
	}
	return params
}

func mergeParams(target map[string]string, source map[string]string) {
	for key, value := range source {
		target[key] = value
	}
}

func shouldParseQueryBody(req *http.Request, body []byte) bool {
	if len(body) == 0 {
		return false
	}
	if req.Method != http.MethodPost {
		return false
	}
	contentType := strings.ToLower(req.Header.Get("Content-Type"))
	return strings.Contains(contentType, "application/x-www-form-urlencoded")
}
