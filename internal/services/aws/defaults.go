package aws

import (
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func seedS3Defaults(store Store, region string) {
	if len(store.S3Buckets.FindBy("bucket_name", "emulate-default")) > 0 {
		return
	}
	store.S3Buckets.Insert(corestore.Record{
		"bucket_name":        "emulate-default",
		"region":             region,
		"creation_date":      time.Now().UTC().Format(time.RFC3339Nano),
		"acl":                "private",
		"versioning_enabled": false,
	})
}
