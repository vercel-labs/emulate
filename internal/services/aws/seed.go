package aws

import (
	"strings"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/auth"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
)

type SeedConfig struct {
	Port      int                `json:"port"`
	BaseURL   string             `json:"baseUrl"`
	Region    string             `json:"region"`
	AccountID string             `json:"account_id"`
	S3        S3Seed             `json:"s3"`
	SQS       SQSSeed            `json:"sqs"`
	IAM       IAMSeed            `json:"iam"`
	Secrets   SecretsManagerSeed `json:"secretsmanager"`
	SSM       SSMSeed            `json:"ssm"`
	KMS       KMSSeed            `json:"kms"`
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

type SecretsManagerSeed struct {
	Secrets []SecretSeed `json:"secrets"`
}

type SecretSeed struct {
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	KMSKeyID     string            `json:"kms_key_id"`
	SecretString string            `json:"secret_string"`
	SecretBinary string            `json:"secret_binary"`
	Tags         map[string]string `json:"tags"`
}

type SSMSeed struct {
	Parameters []SSMParameterSeed `json:"parameters"`
}

type SSMParameterSeed struct {
	Name        string            `json:"name"`
	Type        string            `json:"type"`
	Value       string            `json:"value"`
	Description string            `json:"description"`
	KeyID       string            `json:"key_id"`
	Tier        string            `json:"tier"`
	DataType    string            `json:"data_type"`
	Tags        map[string]string `json:"tags"`
}

type KMSSeed struct {
	Keys []KMSKeySeed `json:"keys"`
}

type KMSKeySeed struct {
	KeyID       string            `json:"key_id"`
	Description string            `json:"description"`
	Aliases     []string          `json:"aliases"`
	Enabled     *bool             `json:"enabled"`
	KeyUsage    string            `json:"key_usage"`
	KeySpec     string            `json:"key_spec"`
	Origin      string            `json:"origin"`
	Tags        map[string]string `json:"tags"`
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
	seedSecretsManagerFromConfig(store, accountID, region, config.Secrets)
	seedSSMFromConfig(store, accountID, region, config.SSM)
	seedKMSFromConfig(store, accountID, region, config.KMS)
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
			"tags":                      corestore.Record{},
			"extra_attributes":          corestore.Record{},
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

func seedSecretsManagerFromConfig(store Store, accountID string, region string, config SecretsManagerSeed) {
	if accountID == "" {
		accountID = gateway.DefaultAccountID
	}
	if region == "" {
		region = gateway.DefaultRegion
	}
	for _, secret := range config.Secrets {
		name := strings.TrimSpace(secret.Name)
		if name == "" || len(store.Secrets.FindBy("name", name)) > 0 {
			continue
		}
		suffix := strings.ToLower(generateAWSID(""))[:6]
		arn := "arn:aws:secretsmanager:" + region + ":" + accountID + ":secret:" + name + "-" + suffix
		now := time.Now().UTC().Unix()
		tags := corestore.Record{}
		for key, value := range secret.Tags {
			tags[key] = value
		}
		store.Secrets.Insert(corestore.Record{
			"account_id":           accountID,
			"region":               region,
			"name":                 name,
			"arn":                  arn,
			"arn_suffix":           suffix,
			"description":          secret.Description,
			"kms_key_id":           secret.KMSKeyID,
			"created_date":         now,
			"last_changed_date":    now,
			"last_accessed_date":   int64(0),
			"deleted_date":         int64(0),
			"recovery_window_days": 0,
			"force_deleted":        false,
			"tags":                 tags,
		})
		if secret.SecretString == "" && secret.SecretBinary == "" {
			continue
		}
		versionID := strings.ToLower(generateAWSID("") + generateAWSID(""))
		store.SecretVersions.Insert(corestore.Record{
			"account_id":         accountID,
			"region":             region,
			"secret_arn":         arn,
			"secret_name":        name,
			"version_id":         versionID,
			"secret_string":      secret.SecretString,
			"has_secret_string":  secret.SecretString != "",
			"secret_binary":      secret.SecretBinary,
			"has_secret_binary":  secret.SecretString == "" && secret.SecretBinary != "",
			"version_stages":     []string{"AWSCURRENT"},
			"created_date":       now,
			"last_accessed_date": int64(0),
		})
	}
}

func seedSSMFromConfig(store Store, accountID string, region string, config SSMSeed) {
	if accountID == "" {
		accountID = gateway.DefaultAccountID
	}
	if region == "" {
		region = gateway.DefaultRegion
	}
	for _, parameter := range config.Parameters {
		name := strings.TrimSpace(parameter.Name)
		if name == "" || len(store.SSMParameters.FindBy("name", name)) > 0 {
			continue
		}
		parameterType := firstNonEmpty(parameter.Type, "String")
		if parameterType != "String" && parameterType != "StringList" && parameterType != "SecureString" {
			parameterType = "String"
		}
		tier := firstNonEmpty(parameter.Tier, "Standard")
		dataType := firstNonEmpty(parameter.DataType, "text")
		now := time.Now().UTC().Unix()
		tags := corestore.Record{}
		for key, value := range parameter.Tags {
			tags[key] = value
		}
		arn := "arn:aws:ssm:" + region + ":" + accountID + ":parameter/" + strings.TrimPrefix(name, "/")
		record := corestore.Record{
			"account_id":          accountID,
			"region":              region,
			"name":                name,
			"arn":                 arn,
			"path":                ssmParameterPath(name),
			"type":                parameterType,
			"value":               parameter.Value,
			"version":             int64(1),
			"description":         parameter.Description,
			"key_id":              parameter.KeyID,
			"tier":                tier,
			"data_type":           dataType,
			"last_modified_date":  now,
			"last_accessed_date":  int64(0),
			"tags":                tags,
			"allowed_pattern":     "",
			"policies":            []string{},
			"selector_labels":     []string{},
			"source_result":       "",
			"has_secure_material": parameterType == "SecureString",
		}
		store.SSMParameters.Insert(record)
		store.SSMParamVersions.Insert(corestore.Record{
			"account_id":          accountID,
			"region":              region,
			"name":                name,
			"arn":                 arn,
			"version":             int64(1),
			"type":                parameterType,
			"value":               parameter.Value,
			"description":         parameter.Description,
			"key_id":              parameter.KeyID,
			"tier":                tier,
			"data_type":           dataType,
			"last_modified_date":  now,
			"has_secure_material": parameterType == "SecureString",
		})
	}
}

func seedKMSDefaults(store Store, accountID string, region string) {
	if accountID == "" {
		accountID = gateway.DefaultAccountID
	}
	if region == "" {
		region = gateway.DefaultRegion
	}
	seedKMSKey(store, accountID, region, KMSKeySeed{
		KeyID:       "00000000-0000-0000-0000-000000000001",
		Description: "Default local KMS key",
		Aliases:     []string{"alias/local"},
	})
}

func seedKMSFromConfig(store Store, accountID string, region string, config KMSSeed) {
	if accountID == "" {
		accountID = gateway.DefaultAccountID
	}
	if region == "" {
		region = gateway.DefaultRegion
	}
	for _, key := range config.Keys {
		seedKMSKey(store, accountID, region, key)
	}
}

func seedKMSKey(store Store, accountID string, region string, key KMSKeySeed) {
	keyID := strings.TrimSpace(key.KeyID)
	if keyID == "" {
		keyID = strings.ToLower(generateAWSID("")[:8] + "-" + generateAWSID("")[:4] + "-" + generateAWSID("")[:4] + "-" + generateAWSID("")[:4] + "-" + generateAWSID("")[:12])
	}
	if len(store.KMSKeys.FindBy("key_id", keyID)) > 0 {
		for _, alias := range key.Aliases {
			seedKMSAlias(store, accountID, region, keyID, alias)
		}
		return
	}
	enabled := true
	if key.Enabled != nil {
		enabled = *key.Enabled
	}
	keyState := "Enabled"
	if !enabled {
		keyState = "Disabled"
	}
	now := time.Now().UTC().Unix()
	tags := corestore.Record{}
	for tagKey, value := range key.Tags {
		tags[tagKey] = value
	}
	store.KMSKeys.Insert(corestore.Record{
		"account_id":               accountID,
		"region":                   region,
		"key_id":                   keyID,
		"arn":                      "arn:aws:kms:" + region + ":" + accountID + ":key/" + keyID,
		"description":              key.Description,
		"enabled":                  enabled,
		"key_state":                keyState,
		"key_usage":                firstNonEmpty(key.KeyUsage, "ENCRYPT_DECRYPT"),
		"key_spec":                 firstNonEmpty(key.KeySpec, "SYMMETRIC_DEFAULT"),
		"customer_master_key_spec": firstNonEmpty(key.KeySpec, "SYMMETRIC_DEFAULT"),
		"origin":                   firstNonEmpty(key.Origin, "AWS_KMS"),
		"key_manager":              "CUSTOMER",
		"creation_date":            now,
		"deletion_date":            int64(0),
		"multi_region":             false,
		"tags":                     tags,
	})
	for _, alias := range key.Aliases {
		seedKMSAlias(store, accountID, region, keyID, alias)
	}
}

func seedKMSAlias(store Store, accountID string, region string, keyID string, alias string) {
	alias = normalizeKMSAlias(alias)
	if alias == "" || len(store.KMSAliases.FindBy("alias_name", alias)) > 0 {
		return
	}
	now := time.Now().UTC().Unix()
	store.KMSAliases.Insert(corestore.Record{
		"account_id":        accountID,
		"region":            region,
		"alias_name":        alias,
		"alias_arn":         "arn:aws:kms:" + region + ":" + accountID + ":" + alias,
		"target_key_id":     keyID,
		"creation_date":     now,
		"last_updated_date": now,
	})
}

func normalizeKMSAlias(alias string) string {
	alias = strings.TrimSpace(alias)
	if alias == "" {
		return ""
	}
	if !strings.HasPrefix(alias, "alias/") {
		alias = "alias/" + alias
	}
	return alias
}

func ssmParameterPath(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || !strings.HasPrefix(name, "/") {
		return "/"
	}
	trimmed := strings.TrimSuffix(name, "/")
	index := strings.LastIndex(trimmed, "/")
	if index <= 0 {
		return "/"
	}
	return trimmed[:index]
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
