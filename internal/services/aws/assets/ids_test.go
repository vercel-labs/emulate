package assets

import "testing"

func TestS3ObjectIDEscapesBucketAndKey(t *testing.T) {
	id := S3ObjectID("photos.archive", "raw/2026 05/image.bin")

	if id != "aws/s3/buckets/photos.archive/objects/raw%2F2026%2005%2Fimage.bin" {
		t.Fatalf("id = %q", id)
	}
}

func TestAWSAssetIDsSeparateServicePurposes(t *testing.T) {
	s3ID := S3ObjectID("function", "code.zip")
	packageID := LambdaPackageID("function", "code.zip")
	layerID := LambdaLayerID("function", "1")
	templateID := CloudFormationTemplateID("function", "code.zip")

	ids := map[string]bool{}
	for _, id := range []string{s3ID, packageID, layerID, templateID} {
		if ids[id] {
			t.Fatalf("duplicate id %q", id)
		}
		ids[id] = true
	}
}

func TestPurposeNamesAreStable(t *testing.T) {
	if PurposeS3Object != "aws.s3.object" {
		t.Fatalf("S3 purpose = %q", PurposeS3Object)
	}
	if PurposeLambdaPackage != "aws.lambda.package" {
		t.Fatalf("lambda package purpose = %q", PurposeLambdaPackage)
	}
}
