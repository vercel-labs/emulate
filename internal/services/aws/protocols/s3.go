package protocols

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

type S3AddressingStyle string

const (
	S3AddressingUnknown     S3AddressingStyle = ""
	S3AddressingPathStyle   S3AddressingStyle = "path"
	S3AddressingVirtualHost S3AddressingStyle = "virtual_host"
)

type S3Route struct {
	Method          string
	Bucket          string
	Key             string
	Action          string
	Subresource     string
	CopySource      string
	Query           map[string]string
	AddressingStyle S3AddressingStyle
}

func ParseS3RESTRequest(req *http.Request) (S3Route, error) {
	query, err := ParseQueryString(req.URL.RawQuery)
	if err != nil {
		return S3Route{}, err
	}

	host := normalizeHost(req.Host)
	bucket, style := virtualHostBucket(host)
	key := ""
	if bucket != "" {
		key = cleanS3Path(req.URL.EscapedPath())
	} else {
		bucket, key = pathStyleBucketAndKey(req.URL.EscapedPath())
		if bucket != "" {
			style = S3AddressingPathStyle
		}
	}

	route := S3Route{
		Method:          req.Method,
		Bucket:          bucket,
		Key:             key,
		Query:           query,
		Subresource:     firstS3Subresource(query),
		CopySource:      req.Header.Get("x-amz-copy-source"),
		AddressingStyle: style,
	}
	route.Action = DetectS3Action(route)
	return route, nil
}

func DetectS3Action(route S3Route) string {
	if route.Bucket == "" {
		if route.Method == http.MethodGet {
			return "ListBuckets"
		}
		return ""
	}

	if route.Key == "" {
		switch route.Method {
		case http.MethodGet:
			switch {
			case hasQueryKey(route.Query, "location"):
				return "GetBucketLocation"
			case hasQueryKey(route.Query, "acl"):
				return "GetBucketAcl"
			case hasQueryKey(route.Query, "lifecycle"):
				return "GetBucketLifecycleConfiguration"
			case hasQueryKey(route.Query, "notification"):
				return "GetBucketNotificationConfiguration"
			case hasQueryKey(route.Query, "policy"):
				return "GetBucketPolicy"
			case hasQueryKey(route.Query, "tagging"):
				return "GetBucketTagging"
			case hasQueryKey(route.Query, "versioning"):
				return "GetBucketVersioning"
			case hasQueryKey(route.Query, "website"):
				return "GetBucketWebsite"
			case hasQueryKey(route.Query, "uploads"):
				return "ListMultipartUploads"
			case route.Query["list-type"] == "2":
				return "ListObjectsV2"
			default:
				return "ListObjects"
			}
		case http.MethodHead:
			return "HeadBucket"
		case http.MethodPut:
			switch {
			case hasQueryKey(route.Query, "acl"):
				return "PutBucketAcl"
			case hasQueryKey(route.Query, "lifecycle"):
				return "PutBucketLifecycleConfiguration"
			case hasQueryKey(route.Query, "notification"):
				return "PutBucketNotificationConfiguration"
			case hasQueryKey(route.Query, "policy"):
				return "PutBucketPolicy"
			case hasQueryKey(route.Query, "tagging"):
				return "PutBucketTagging"
			case hasQueryKey(route.Query, "versioning"):
				return "PutBucketVersioning"
			case hasQueryKey(route.Query, "website"):
				return "PutBucketWebsite"
			}
			return "CreateBucket"
		case http.MethodDelete:
			switch {
			case hasQueryKey(route.Query, "lifecycle"):
				return "DeleteBucketLifecycle"
			case hasQueryKey(route.Query, "policy"):
				return "DeleteBucketPolicy"
			case hasQueryKey(route.Query, "tagging"):
				return "DeleteBucketTagging"
			case hasQueryKey(route.Query, "website"):
				return "DeleteBucketWebsite"
			}
			return "DeleteBucket"
		case http.MethodPost:
			switch {
			case hasQueryKey(route.Query, "delete"):
				return "DeleteObjects"
			default:
				return "PostObject"
			}
		}
		return ""
	}

	switch route.Method {
	case http.MethodGet:
		switch {
		case hasQueryKey(route.Query, "acl"):
			return "GetObjectAcl"
		case hasQueryKey(route.Query, "tagging"):
			return "GetObjectTagging"
		}
		return "GetObject"
	case http.MethodHead:
		return "HeadObject"
	case http.MethodPut:
		switch {
		case hasQueryKey(route.Query, "acl"):
			return "PutObjectAcl"
		case hasQueryKey(route.Query, "tagging"):
			return "PutObjectTagging"
		}
		if hasQueryKey(route.Query, "partNumber") || hasQueryKey(route.Query, "uploadId") {
			if route.CopySource != "" {
				return "UploadPartCopy"
			}
			return "UploadPart"
		}
		if route.CopySource != "" {
			return "CopyObject"
		}
		return "PutObject"
	case http.MethodDelete:
		if hasQueryKey(route.Query, "tagging") {
			return "DeleteObjectTagging"
		}
		if hasQueryKey(route.Query, "uploadId") {
			return "AbortMultipartUpload"
		}
		return "DeleteObject"
	case http.MethodPost:
		if hasQueryKey(route.Query, "uploads") {
			return "CreateMultipartUpload"
		}
		if hasQueryKey(route.Query, "uploadId") {
			return "CompleteMultipartUpload"
		}
		return "PostObject"
	}
	return ""
}

func cleanS3Path(escapedPath string) string {
	trimmed := strings.TrimPrefix(escapedPath, "/")
	if trimmed == "" {
		return ""
	}
	value, err := url.PathUnescape(trimmed)
	if err != nil {
		return trimmed
	}
	return value
}

func pathStyleBucketAndKey(escapedPath string) (string, string) {
	pathValue := cleanS3Path(escapedPath)
	if pathValue == "" {
		return "", ""
	}
	parts := strings.Split(pathValue, "/")
	if parts[0] == "s3" {
		parts = parts[1:]
	}
	if len(parts) == 0 || parts[0] == "" {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}

func virtualHostBucket(host string) (string, S3AddressingStyle) {
	labels := strings.Split(host, ".")
	for index := len(labels) - 1; index >= 0; index-- {
		label := labels[index]
		if label == "s3" || strings.HasPrefix(label, "s3-") {
			if index == 0 {
				return "", S3AddressingUnknown
			}
			return strings.Join(labels[:index], "."), S3AddressingVirtualHost
		}
	}
	return "", S3AddressingUnknown
}

func firstS3Subresource(query map[string]string) string {
	for _, key := range []string{
		"acl",
		"delete",
		"lifecycle",
		"location",
		"notification",
		"policy",
		"tagging",
		"uploadId",
		"uploads",
		"versioning",
		"website",
	} {
		if hasQueryKey(query, key) {
			return key
		}
	}
	return ""
}

func hasQueryKey(query map[string]string, key string) bool {
	_, ok := query[key]
	return ok
}

func normalizeHost(host string) string {
	if value, _, err := net.SplitHostPort(host); err == nil {
		host = value
	}
	return strings.TrimSuffix(strings.ToLower(host), ".")
}
