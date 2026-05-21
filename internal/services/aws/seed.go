package aws

import (
	"strings"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
)

type SeedConfig struct {
	Port      int     `json:"port"`
	BaseURL   string  `json:"baseUrl"`
	Region    string  `json:"region"`
	AccountID string  `json:"account_id"`
	S3        S3Seed  `json:"s3"`
	SQS       SQSSeed `json:"sqs"`
	IAM       IAMSeed `json:"iam"`
}

type S3Seed struct {
	Buckets []S3BucketSeed `json:"buckets"`
}

type S3BucketSeed struct {
	Name   string `json:"name"`
	Region string `json:"region"`
}

type SQSSeed struct {
	Queues []SQSQueueSeed `json:"queues"`
}

type SQSQueueSeed struct {
	Name              string `json:"name"`
	FIFO              bool   `json:"fifo"`
	VisibilityTimeout int    `json:"visibility_timeout"`
}

type IAMSeed struct {
	Users []IAMUserSeed `json:"users"`
	Roles []IAMRoleSeed `json:"roles"`
}

type IAMUserSeed struct {
	UserName        string `json:"user_name"`
	Path            string `json:"path"`
	CreateAccessKey bool   `json:"create_access_key"`
}

type IAMRoleSeed struct {
	RoleName         string `json:"role_name"`
	Path             string `json:"path"`
	Description      string `json:"description"`
	AssumeRolePolicy string `json:"assume_role_policy"`
}

func seedFromConfig(store Store, credentialStore *auth.Store, baseURL string, defaultAccountID string, defaultRegion string, config SeedConfig) {
	accountID := firstNonEmpty(config.AccountID, defaultAccountID, gateway.DefaultAccountID)
	region := firstNonEmpty(config.Region, defaultRegion, gateway.DefaultRegion)
	if config.BaseURL != "" {
		baseURL = config.BaseURL
	}
	seedS3FromConfig(store, region, config.S3)
	seedSQSFromConfig(store, baseURL, accountID, region, config.SQS)
	seedIAMFromConfig(store, credentialStore, accountID, config.IAM)
}

func seedS3FromConfig(store Store, defaultRegion string, config S3Seed) {
	for _, bucket := range config.Buckets {
		name := strings.TrimSpace(bucket.Name)
		if name == "" || len(store.S3Buckets.FindBy("bucket_name", name)) > 0 {
			continue
		}
		store.S3Buckets.Insert(corestore.Record{
			"bucket_name":        name,
			"region":             firstNonEmpty(bucket.Region, defaultRegion, gateway.DefaultRegion),
			"creation_date":      time.Now().UTC().Format(time.RFC3339Nano),
			"acl":                "private",
			"versioning_enabled": false,
		})
	}
}

func seedSQSFromConfig(store Store, baseURL string, accountID string, region string, config SQSSeed) {
	if accountID == "" {
		accountID = gateway.DefaultAccountID
	}
	if region == "" {
		region = gateway.DefaultRegion
	}
	if baseURL == "" {
		baseURL = "http://127.0.0.1"
	}
	for _, queue := range config.Queues {
		name := strings.TrimSpace(queue.Name)
		if name == "" || len(store.SQSQueues.FindBy("queue_name", name)) > 0 {
			continue
		}
		visibilityTimeout := queue.VisibilityTimeout
		if visibilityTimeout == 0 {
			visibilityTimeout = 30
		}
		store.SQSQueues.Insert(corestore.Record{
			"queue_name":                name,
			"queue_url":                 strings.TrimRight(baseURL, "/") + "/sqs/" + accountID + "/" + name,
			"arn":                       "arn:aws:sqs:" + region + ":" + accountID + ":" + name,
			"visibility_timeout":        visibilityTimeout,
			"delay_seconds":             0,
			"max_message_size":          262144,
			"message_retention_period":  345600,
			"receive_message_wait_time": 0,
			"fifo":                      queue.FIFO || strings.HasSuffix(name, ".fifo"),
		})
	}
}

func seedIAMFromConfig(store Store, credentialStore *auth.Store, accountID string, config IAMSeed) {
	if accountID == "" {
		accountID = gateway.DefaultAccountID
	}
	for _, user := range config.Users {
		userName := strings.TrimSpace(user.UserName)
		if userName == "" || len(store.IAMUsers.FindBy("user_name", userName)) > 0 {
			continue
		}
		path := firstNonEmpty(user.Path, "/")
		accessKeys := []corestore.Record{}
		arn := "arn:aws:iam::" + accountID + ":user" + path + userName
		if user.CreateAccessKey {
			accessKeyID := "AKIA" + generateAWSID("")
			secretAccessKey := generateAWSID("") + generateAWSID("")
			accessKeys = append(accessKeys, corestore.Record{
				"access_key_id":     accessKeyID,
				"secret_access_key": secretAccessKey,
				"status":            "Active",
			})
			credentialStore.Put(auth.Credential{
				AccessKeyID:     accessKeyID,
				SecretAccessKey: secretAccessKey,
				AccountID:       accountID,
				PrincipalARN:    arn,
			})
		}
		store.IAMUsers.Insert(corestore.Record{
			"user_name":   userName,
			"user_id":     generateAWSID("AIDA"),
			"arn":         arn,
			"path":        path,
			"access_keys": accessKeys,
		})
	}
	for _, role := range config.Roles {
		roleName := strings.TrimSpace(role.RoleName)
		if roleName == "" || len(store.IAMRoles.FindBy("role_name", roleName)) > 0 {
			continue
		}
		path := firstNonEmpty(role.Path, "/")
		store.IAMRoles.Insert(corestore.Record{
			"role_name":                   roleName,
			"role_id":                     generateAWSID("AROA"),
			"arn":                         "arn:aws:iam::" + accountID + ":role" + path + roleName,
			"path":                        path,
			"assume_role_policy_document": firstNonEmpty(role.AssumeRolePolicy, "{}"),
			"description":                 role.Description,
		})
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
