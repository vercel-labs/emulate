package aws

import corestore "github.com/vercel-labs/emulate/internal/core/store"

type Store struct {
	S3Buckets        *corestore.Collection
	S3Objects        *corestore.Collection
	SQSQueues        *corestore.Collection
	SQSMessages      *corestore.Collection
	SNSTopics        *corestore.Collection
	SNSSubscriptions *corestore.Collection
	SNSDeliveries    *corestore.Collection
	EventBuses       *corestore.Collection
	EventRules       *corestore.Collection
	EventTargets     *corestore.Collection
	EventDeliveries  *corestore.Collection
	LogGroups        *corestore.Collection
	LogStreams       *corestore.Collection
	LogEvents        *corestore.Collection
	Secrets          *corestore.Collection
	SecretVersions   *corestore.Collection
	SSMParameters    *corestore.Collection
	SSMParamVersions *corestore.Collection
	KMSKeys          *corestore.Collection
	KMSAliases       *corestore.Collection
	IAMUsers         *corestore.Collection
	IAMRoles         *corestore.Collection
	IAMPolicies      *corestore.Collection
	DynamoDBTables   *corestore.Collection
	DynamoDBItems    *corestore.Collection
}

func NewStore(runtimeStore *corestore.Store) Store {
	return Store{
		S3Buckets:        runtimeStore.MustCollection("aws.s3_buckets", "bucket_name"),
		S3Objects:        runtimeStore.MustCollection("aws.s3_objects", "key", "bucket_name"),
		SQSQueues:        runtimeStore.MustCollection("aws.sqs_queues", "queue_name", "queue_url"),
		SQSMessages:      runtimeStore.MustCollection("aws.sqs_messages", "message_id", "queue_name"),
		SNSTopics:        runtimeStore.MustCollection("aws.sns_topics", "topic_name", "arn"),
		SNSSubscriptions: runtimeStore.MustCollection("aws.sns_subscriptions", "subscription_arn", "topic_arn", "protocol", "endpoint"),
		SNSDeliveries:    runtimeStore.MustCollection("aws.sns_deliveries", "message_id", "topic_arn", "subscription_arn"),
		EventBuses:       runtimeStore.MustCollection("aws.event_buses", "name", "arn"),
		EventRules:       runtimeStore.MustCollection("aws.event_rules", "name", "arn", "event_bus_name"),
		EventTargets:     runtimeStore.MustCollection("aws.event_targets", "rule_name", "event_bus_name", "target_id", "arn"),
		EventDeliveries:  runtimeStore.MustCollection("aws.event_deliveries", "event_id", "rule_name", "target_id"),
		LogGroups:        runtimeStore.MustCollection("aws.log_groups", "account_id", "region", "log_group_name", "arn"),
		LogStreams:       runtimeStore.MustCollection("aws.log_streams", "account_id", "region", "log_group_name", "log_stream_name", "arn"),
		LogEvents:        runtimeStore.MustCollection("aws.log_events", "account_id", "region", "log_group_name", "log_stream_name", "event_id"),
		Secrets:          runtimeStore.MustCollection("aws.secretsmanager_secrets", "account_id", "region", "name", "arn"),
		SecretVersions:   runtimeStore.MustCollection("aws.secretsmanager_versions", "account_id", "region", "secret_arn", "secret_name", "version_id"),
		SSMParameters:    runtimeStore.MustCollection("aws.ssm_parameters", "account_id", "region", "name", "arn", "path"),
		SSMParamVersions: runtimeStore.MustCollection("aws.ssm_parameter_versions", "account_id", "region", "name", "version"),
		KMSKeys:          runtimeStore.MustCollection("aws.kms_keys", "account_id", "region", "key_id", "arn"),
		KMSAliases:       runtimeStore.MustCollection("aws.kms_aliases", "account_id", "region", "alias_name", "alias_arn", "target_key_id"),
		IAMUsers:         runtimeStore.MustCollection("aws.iam_users", "user_name", "user_id"),
		IAMRoles:         runtimeStore.MustCollection("aws.iam_roles", "role_name", "role_id"),
		IAMPolicies:      runtimeStore.MustCollection("aws.iam_policies", "policy_name", "arn"),
		DynamoDBTables:   runtimeStore.MustCollection("aws.dynamodb_tables", "table_name", "arn"),
		DynamoDBItems:    runtimeStore.MustCollection("aws.dynamodb_items", "table_name", "table_arn", "pk", "sk"),
	}
}
