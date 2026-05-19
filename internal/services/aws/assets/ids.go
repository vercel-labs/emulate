package assets

import (
	"net/url"
	"strings"
)

type Purpose string

const (
	PurposeS3Object               Purpose = "aws.s3.object"
	PurposeLambdaPackage          Purpose = "aws.lambda.package"
	PurposeLambdaLayer            Purpose = "aws.lambda.layer"
	PurposeCloudFormationTemplate Purpose = "aws.cloudformation.template"
)

func S3ObjectID(bucket string, key string) string {
	return join("aws", "s3", "buckets", bucket, "objects", key)
}

func LambdaPackageID(functionName string, revision string) string {
	return join("aws", "lambda", "functions", functionName, "packages", revision)
}

func LambdaLayerID(layerName string, version string) string {
	return join("aws", "lambda", "layers", layerName, "versions", version)
}

func CloudFormationTemplateID(stackName string, templateID string) string {
	return join("aws", "cloudformation", "stacks", stackName, "templates", templateID)
}

func join(parts ...string) string {
	escaped := make([]string, 0, len(parts))
	for _, part := range parts {
		escaped = append(escaped, url.PathEscape(part))
	}
	return strings.Join(escaped, "/")
}
