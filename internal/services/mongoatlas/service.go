package mongoatlas

import (
	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

type Options struct {
	Store *corestore.Store
	Seed  *SeedConfig
}

type SeedConfig struct {
	Port          int                `json:"port,omitempty"`
	Projects      []ProjectSeed      `json:"projects"`
	Clusters      []ClusterSeed      `json:"clusters"`
	DatabaseUsers []DatabaseUserSeed `json:"database_users"`
	Databases     []DatabaseSeed     `json:"databases"`
}

type ProjectSeed struct {
	Name  string `json:"name"`
	OrgID string `json:"org_id"`
}

type ClusterSeed struct {
	Name           string  `json:"name"`
	Project        string  `json:"project"`
	Provider       string  `json:"provider"`
	InstanceSize   string  `json:"instance_size"`
	Region         string  `json:"region"`
	DiskSizeGB     float64 `json:"disk_size_gb"`
	MongoDBVersion string  `json:"mongodb_version"`
}

type DatabaseUserSeed struct {
	Username string     `json:"username"`
	Project  string     `json:"project"`
	Roles    []RoleSeed `json:"roles"`
}

type RoleSeed struct {
	DatabaseName string `json:"database_name"`
	RoleName     string `json:"role_name"`
}

type DatabaseSeed struct {
	Cluster     string   `json:"cluster"`
	Name        string   `json:"name"`
	Collections []string `json:"collections"`
}

type Service struct {
	store Store
}

func Register(router *corehttp.Router, options Options) {
	service := New(options)
	service.RegisterRoutes(router)
}

func New(options Options) *Service {
	runtimeStore := options.Store
	if runtimeStore == nil {
		runtimeStore = corestore.New()
	}
	service := &Service{store: NewStore(runtimeStore)}
	service.SeedDefaults()
	if options.Seed != nil {
		service.SeedFromConfig(*options.Seed)
	}
	return service
}

func SeedFromConfig(runtimeStore *corestore.Store, config SeedConfig) {
	New(Options{Store: runtimeStore, Seed: &config})
}

func (s *Service) RegisterRoutes(router *corehttp.Router) {
	s.registerAdminRoutes(router)
	s.registerDataAPIRoutes(router)
}

func (s *Service) SeedDefaults() {
	if s.store.Projects.Count() > 0 {
		return
	}
	groupID := generateHexID()
	s.store.Projects.Insert(corestore.Record{
		"group_id":      groupID,
		"name":          "Project0",
		"org_id":        "default_org",
		"cluster_count": 1,
	})
	clusterID := generateHexID()
	s.store.Clusters.Insert(clusterRecord(clusterID, "Cluster0", groupID, "AWS", "M10", "US_EAST_1", 10, "8.0"))
	s.store.Users.Insert(corestore.Record{
		"user_id":  generateHexID(),
		"username": "admin",
		"group_id": groupID,
		"roles": []map[string]any{{
			"database_name": "admin",
			"role_name":     "atlasAdmin",
		}},
	})
	s.store.Databases.Insert(corestore.Record{"cluster_id": clusterID, "name": "test"})
	s.store.Collections.Insert(corestore.Record{"cluster_id": clusterID, "database": "test", "name": "items"})
}

func (s *Service) SeedFromConfig(config SeedConfig) {
	projectIDs := map[string]string{}
	for _, project := range s.store.Projects.All() {
		projectIDs[stringField(project, "name")] = stringField(project, "group_id")
	}
	for _, seed := range config.Projects {
		if seed.Name == "" {
			continue
		}
		if existing := s.projectByName(seed.Name); existing != nil {
			projectIDs[seed.Name] = stringField(existing, "group_id")
			continue
		}
		groupID := generateHexID()
		s.store.Projects.Insert(corestore.Record{
			"group_id":      groupID,
			"name":          seed.Name,
			"org_id":        firstNonEmpty(seed.OrgID, "default_org"),
			"cluster_count": 0,
		})
		projectIDs[seed.Name] = groupID
	}

	clusterIDs := map[string]string{}
	for _, cluster := range s.store.Clusters.All() {
		clusterIDs[stringField(cluster, "name")] = stringField(cluster, "cluster_id")
	}
	for _, seed := range config.Clusters {
		groupID := projectIDs[seed.Project]
		if seed.Name == "" || groupID == "" {
			continue
		}
		if existing := s.clusterByName(groupID, seed.Name); existing != nil {
			clusterIDs[seed.Name] = stringField(existing, "cluster_id")
			continue
		}
		disk := seed.DiskSizeGB
		if disk == 0 {
			disk = 10
		}
		clusterID := generateHexID()
		s.store.Clusters.Insert(clusterRecord(clusterID, seed.Name, groupID, firstNonEmpty(seed.Provider, "AWS"), firstNonEmpty(seed.InstanceSize, "M10"), firstNonEmpty(seed.Region, "US_EAST_1"), disk, firstNonEmpty(seed.MongoDBVersion, "8.0")))
		clusterIDs[seed.Name] = clusterID
		if project := firstRecord(s.store.Projects.FindBy("group_id", groupID)); project != nil {
			s.store.Projects.Update(intField(project, "id"), corestore.Record{"cluster_count": intField(project, "cluster_count") + 1})
		}
	}

	for _, seed := range config.DatabaseUsers {
		groupID := projectIDs[seed.Project]
		if seed.Username == "" || groupID == "" || s.userByName(groupID, seed.Username) != nil {
			continue
		}
		roles := make([]map[string]any, 0, len(seed.Roles))
		for _, role := range seed.Roles {
			roles = append(roles, map[string]any{"database_name": role.DatabaseName, "role_name": role.RoleName})
		}
		if len(roles) == 0 {
			roles = []map[string]any{{"database_name": "admin", "role_name": "readWriteAnyDatabase"}}
		}
		s.store.Users.Insert(corestore.Record{"user_id": generateHexID(), "username": seed.Username, "group_id": groupID, "roles": roles})
	}

	for _, seed := range config.Databases {
		clusterID := clusterIDs[seed.Cluster]
		if seed.Name == "" || clusterID == "" {
			continue
		}
		s.ensureCollection(clusterID, seed.Name, "")
		for _, collection := range seed.Collections {
			s.ensureCollection(clusterID, seed.Name, collection)
		}
	}
}

func clusterRecord(clusterID string, name string, groupID string, provider string, size string, region string, disk float64, version string) corestore.Record {
	return corestore.Record{
		"cluster_id": clusterID,
		"name":       name,
		"group_id":   groupID,
		"state":      "IDLE",
		"mongo_uri":  "mongodb+srv://" + name + ".emulate.mongodb.net",
		"connection_strings": map[string]any{
			"standard":     "mongodb://" + name + ".emulate.mongodb.net:27017",
			"standard_srv": "mongodb+srv://" + name + ".emulate.mongodb.net",
		},
		"provider_settings": map[string]any{
			"provider_name":      provider,
			"instance_size_name": size,
			"region_name":        region,
		},
		"cluster_type":    "REPLICASET",
		"disk_size_gb":    disk,
		"mongodb_version": version,
	}
}
