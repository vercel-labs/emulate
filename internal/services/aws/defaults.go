package aws

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
)

var fallbackAWSIDCounter atomic.Uint64

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

func seedSQSDefaults(store Store, baseURL string, accountID string, region string) {
	if len(store.SQSQueues.FindBy("queue_name", "emulate-default-queue")) > 0 {
		return
	}
	if accountID == "" {
		accountID = gateway.DefaultAccountID
	}
	if region == "" {
		region = gateway.DefaultRegion
	}
	if baseURL == "" {
		baseURL = "http://127.0.0.1"
	}
	queueName := "emulate-default-queue"
	store.SQSQueues.Insert(corestore.Record{
		"queue_name":                queueName,
		"queue_url":                 strings.TrimRight(baseURL, "/") + "/sqs/" + accountID + "/" + queueName,
		"arn":                       "arn:aws:sqs:" + region + ":" + accountID + ":" + queueName,
		"visibility_timeout":        30,
		"delay_seconds":             0,
		"max_message_size":          262144,
		"message_retention_period":  345600,
		"receive_message_wait_time": 0,
		"fifo":                      false,
	})
}

func seedEventBridgeDefaults(store Store, accountID string, region string) {
	if len(store.EventBuses.FindBy("name", "default")) > 0 {
		return
	}
	if accountID == "" {
		accountID = gateway.DefaultAccountID
	}
	if region == "" {
		region = gateway.DefaultRegion
	}
	store.EventBuses.Insert(corestore.Record{
		"account_id": accountID,
		"region":     region,
		"name":       "default",
		"arn":        "arn:aws:events:" + region + ":" + accountID + ":event-bus/default",
		"tags":       []corestore.Record{},
	})
}

func seedIAMDefaults(store Store, credentialStore *auth.Store, accountID string) {
	if accountID == "" {
		accountID = gateway.DefaultAccountID
	}
	defaultAccessKeyID := "AKIAIOSFODNN7EXAMPLE"
	defaultSecretAccessKey := "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
	var user corestore.Record
	if existing := store.IAMUsers.FindBy("user_name", "admin"); len(existing) > 0 {
		user = existing[0]
	} else {
		user = store.IAMUsers.Insert(corestore.Record{
			"user_name": "admin",
			"user_id":   generateAWSID("AIDA"),
			"arn":       "arn:aws:iam::" + accountID + ":user/admin",
			"path":      "/",
			"access_keys": []corestore.Record{
				{
					"access_key_id":     defaultAccessKeyID,
					"secret_access_key": defaultSecretAccessKey,
					"status":            "Active",
				},
			},
		})
	}
	credentialStore.Put(auth.Credential{
		AccessKeyID:     defaultAccessKeyID,
		SecretAccessKey: defaultSecretAccessKey,
		AccountID:       accountID,
		PrincipalARN:    stringRecordField(user, "arn"),
	})
}

func generateAWSID(prefix string) string {
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return prefix + strings.ToUpper(hex.EncodeToString(bytes[:]))
	}
	return fmt.Sprintf("%s%016X", prefix, fallbackAWSIDCounter.Add(1))
}

func stringRecordField(record corestore.Record, name string) string {
	value, _ := record[name].(string)
	return value
}
