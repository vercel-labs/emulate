package mongoatlas

import (
	"net/http"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerAdminRoutes(router *corehttp.Router) {
	router.Get("/api/atlas/v2/groups", s.handleListProjects)
	router.Get("/api/atlas/v2/groups/:groupId", s.handleGetProject)
	router.Post("/api/atlas/v2/groups", s.handleCreateProject)
	router.Delete("/api/atlas/v2/groups/:groupId", s.handleDeleteProject)

	router.Get("/api/atlas/v2/groups/:groupId/clusters", s.handleListClusters)
	router.Get("/api/atlas/v2/groups/:groupId/clusters/:clusterName", s.handleGetCluster)
	router.Post("/api/atlas/v2/groups/:groupId/clusters", s.handleCreateCluster)
	router.Patch("/api/atlas/v2/groups/:groupId/clusters/:clusterName", s.handlePatchCluster)
	router.Delete("/api/atlas/v2/groups/:groupId/clusters/:clusterName", s.handleDeleteCluster)

	router.Get("/api/atlas/v2/groups/:groupId/databaseUsers", s.handleListDatabaseUsers)
	router.Get("/api/atlas/v2/groups/:groupId/databaseUsers/admin/:username", s.handleGetDatabaseUser)
	router.Post("/api/atlas/v2/groups/:groupId/databaseUsers", s.handleCreateDatabaseUser)
	router.Delete("/api/atlas/v2/groups/:groupId/databaseUsers/admin/:username", s.handleDeleteDatabaseUser)

	router.Get("/api/atlas/v2/groups/:groupId/clusters/:clusterName/databases", s.handleListDatabases)
	router.Get("/api/atlas/v2/groups/:groupId/clusters/:clusterName/databases/:databaseName/collections", s.handleListCollections)
}

func (s *Service) handleListProjects(c *corehttp.Context) {
	projects := s.store.Projects.All()
	results := make([]map[string]any, 0, len(projects))
	for _, project := range projects {
		results = append(results, formatProject(project))
	}
	mongoOK(c, http.StatusOK, map[string]any{"results": results, "totalCount": len(results)})
}

func (s *Service) handleGetProject(c *corehttp.Context) {
	groupID := c.Param("groupId")
	project := firstRecord(s.store.Projects.FindBy("group_id", groupID))
	if project == nil {
		mongoError(c, http.StatusNotFound, "GROUP_NOT_FOUND", "Group '"+groupID+"' not found.")
		return
	}
	mongoOK(c, http.StatusOK, formatProject(project))
}

func (s *Service) handleCreateProject(c *corehttp.Context) {
	body := readJSONBody(c.Request)
	name := stringValue(body["name"])
	if name == "" {
		mongoError(c, http.StatusBadRequest, "INVALID_PARAMETER", "name is required")
		return
	}
	if s.projectByName(name) != nil {
		mongoError(c, http.StatusConflict, "DUPLICATE_GROUP_NAME", "Group name '"+name+"' already exists.")
		return
	}
	project := s.store.Projects.Insert(corestore.Record{
		"group_id":      generateHexID(),
		"name":          name,
		"org_id":        firstNonEmpty(stringValue(body["orgId"]), "default_org"),
		"cluster_count": 0,
	})
	mongoOK(c, http.StatusCreated, formatProject(project))
}

func (s *Service) handleDeleteProject(c *corehttp.Context) {
	groupID := c.Param("groupId")
	project := firstRecord(s.store.Projects.FindBy("group_id", groupID))
	if project == nil {
		mongoError(c, http.StatusNotFound, "GROUP_NOT_FOUND", "Group '"+groupID+"' not found.")
		return
	}
	for _, cluster := range s.store.Clusters.FindBy("group_id", groupID) {
		s.deleteClusterData(stringField(cluster, "cluster_id"))
		s.store.Clusters.Delete(intField(cluster, "id"))
	}
	s.store.Projects.Delete(intField(project, "id"))
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleListClusters(c *corehttp.Context) {
	groupID := c.Param("groupId")
	if firstRecord(s.store.Projects.FindBy("group_id", groupID)) == nil {
		mongoError(c, http.StatusNotFound, "GROUP_NOT_FOUND", "Group '"+groupID+"' not found.")
		return
	}
	clusters := s.store.Clusters.FindBy("group_id", groupID)
	results := make([]map[string]any, 0, len(clusters))
	for _, cluster := range clusters {
		results = append(results, formatCluster(cluster))
	}
	mongoOK(c, http.StatusOK, map[string]any{"results": results, "totalCount": len(results)})
}

func (s *Service) handleGetCluster(c *corehttp.Context) {
	groupID := c.Param("groupId")
	clusterName := c.Param("clusterName")
	cluster := s.clusterByName(groupID, clusterName)
	if cluster == nil {
		mongoError(c, http.StatusNotFound, "CLUSTER_NOT_FOUND", "Cluster '"+clusterName+"' not found.")
		return
	}
	mongoOK(c, http.StatusOK, formatCluster(cluster))
}

func (s *Service) handleCreateCluster(c *corehttp.Context) {
	groupID := c.Param("groupId")
	project := firstRecord(s.store.Projects.FindBy("group_id", groupID))
	if project == nil {
		mongoError(c, http.StatusNotFound, "GROUP_NOT_FOUND", "Group '"+groupID+"' not found.")
		return
	}
	body := readJSONBody(c.Request)
	name := stringValue(body["name"])
	if name == "" {
		mongoError(c, http.StatusBadRequest, "INVALID_PARAMETER", "name is required")
		return
	}
	if s.clusterByName(groupID, name) != nil {
		mongoError(c, http.StatusConflict, "DUPLICATE_CLUSTER_NAME", "Cluster '"+name+"' already exists.")
		return
	}
	provider := mapValue(body["providerSettings"])
	clusterType := firstNonEmpty(stringValue(body["clusterType"]), "REPLICASET")
	record := clusterRecord(
		generateHexID(),
		name,
		groupID,
		firstNonEmpty(stringValue(provider["providerName"]), "AWS"),
		firstNonEmpty(stringValue(provider["instanceSizeName"]), "M10"),
		firstNonEmpty(stringValue(provider["regionName"]), "US_EAST_1"),
		firstNonZeroFloat(body["diskSizeGB"], 10),
		firstNonEmpty(stringValue(body["mongoDBMajorVersion"]), "8.0"),
	)
	record["cluster_type"] = clusterType
	cluster := s.store.Clusters.Insert(record)
	s.store.Projects.Update(intField(project, "id"), corestore.Record{"cluster_count": intField(project, "cluster_count") + 1})
	mongoOK(c, http.StatusCreated, formatCluster(cluster))
}

func (s *Service) handlePatchCluster(c *corehttp.Context) {
	groupID := c.Param("groupId")
	clusterName := c.Param("clusterName")
	cluster := s.clusterByName(groupID, clusterName)
	if cluster == nil {
		mongoError(c, http.StatusNotFound, "CLUSTER_NOT_FOUND", "Cluster '"+clusterName+"' not found.")
		return
	}
	body := readJSONBody(c.Request)
	patch := corestore.Record{}
	if provider := mapValue(body["providerSettings"]); len(provider) > 0 {
		current := mapValue(cluster["provider_settings"])
		if value := stringValue(provider["instanceSizeName"]); value != "" {
			current["instance_size_name"] = value
		}
		if value := stringValue(provider["regionName"]); value != "" {
			current["region_name"] = value
		}
		patch["provider_settings"] = current
	}
	if _, ok := body["diskSizeGB"]; ok {
		patch["disk_size_gb"] = firstNonZeroFloat(body["diskSizeGB"], 0)
	}
	updated, _ := s.store.Clusters.Update(intField(cluster, "id"), patch)
	mongoOK(c, http.StatusOK, formatCluster(updated))
}

func (s *Service) handleDeleteCluster(c *corehttp.Context) {
	groupID := c.Param("groupId")
	clusterName := c.Param("clusterName")
	cluster := s.clusterByName(groupID, clusterName)
	if cluster == nil {
		mongoError(c, http.StatusNotFound, "CLUSTER_NOT_FOUND", "Cluster '"+clusterName+"' not found.")
		return
	}
	s.deleteClusterData(stringField(cluster, "cluster_id"))
	s.store.Clusters.Delete(intField(cluster, "id"))
	if project := firstRecord(s.store.Projects.FindBy("group_id", groupID)); project != nil {
		count := intField(project, "cluster_count") - 1
		if count < 0 {
			count = 0
		}
		s.store.Projects.Update(intField(project, "id"), corestore.Record{"cluster_count": count})
	}
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleListDatabaseUsers(c *corehttp.Context) {
	groupID := c.Param("groupId")
	users := s.store.Users.FindBy("group_id", groupID)
	results := make([]map[string]any, 0, len(users))
	for _, user := range users {
		results = append(results, formatUser(user))
	}
	mongoOK(c, http.StatusOK, map[string]any{"results": results, "totalCount": len(results)})
}

func (s *Service) handleGetDatabaseUser(c *corehttp.Context) {
	groupID := c.Param("groupId")
	username := c.Param("username")
	user := s.userByName(groupID, username)
	if user == nil {
		mongoError(c, http.StatusNotFound, "USER_NOT_FOUND", "Database user '"+username+"' not found.")
		return
	}
	mongoOK(c, http.StatusOK, formatUser(user))
}

func (s *Service) handleCreateDatabaseUser(c *corehttp.Context) {
	groupID := c.Param("groupId")
	body := readJSONBody(c.Request)
	username := stringValue(body["username"])
	if username == "" {
		mongoError(c, http.StatusBadRequest, "INVALID_PARAMETER", "username is required")
		return
	}
	if s.userByName(groupID, username) != nil {
		mongoError(c, http.StatusConflict, "DUPLICATE_USER", "User '"+username+"' already exists.")
		return
	}
	roles := roleRecords(body["roles"])
	user := s.store.Users.Insert(corestore.Record{"user_id": generateHexID(), "username": username, "group_id": groupID, "roles": roles})
	mongoOK(c, http.StatusCreated, formatUser(user))
}

func (s *Service) handleDeleteDatabaseUser(c *corehttp.Context) {
	groupID := c.Param("groupId")
	username := c.Param("username")
	user := s.userByName(groupID, username)
	if user == nil {
		mongoError(c, http.StatusNotFound, "USER_NOT_FOUND", "Database user '"+username+"' not found.")
		return
	}
	s.store.Users.Delete(intField(user, "id"))
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleListDatabases(c *corehttp.Context) {
	cluster := s.clusterByName(c.Param("groupId"), c.Param("clusterName"))
	if cluster == nil {
		mongoError(c, http.StatusNotFound, "CLUSTER_NOT_FOUND", "Cluster '"+c.Param("clusterName")+"' not found.")
		return
	}
	databases := s.store.Databases.FindBy("cluster_id", stringField(cluster, "cluster_id"))
	results := make([]map[string]any, 0, len(databases))
	for _, db := range databases {
		results = append(results, map[string]any{"databaseName": stringField(db, "name")})
	}
	mongoOK(c, http.StatusOK, map[string]any{"results": results, "totalCount": len(results)})
}

func (s *Service) handleListCollections(c *corehttp.Context) {
	cluster := s.clusterByName(c.Param("groupId"), c.Param("clusterName"))
	if cluster == nil {
		mongoError(c, http.StatusNotFound, "CLUSTER_NOT_FOUND", "Cluster '"+c.Param("clusterName")+"' not found.")
		return
	}
	databaseName := c.Param("databaseName")
	collections := s.store.Collections.FindBy("cluster_id", stringField(cluster, "cluster_id"))
	results := make([]map[string]any, 0)
	for _, collection := range collections {
		if stringField(collection, "database") == databaseName {
			results = append(results, map[string]any{"collectionName": stringField(collection, "name"), "databaseName": databaseName})
		}
	}
	mongoOK(c, http.StatusOK, map[string]any{"results": results, "totalCount": len(results)})
}

func (s *Service) projectByName(name string) corestore.Record {
	for _, project := range s.store.Projects.All() {
		if stringField(project, "name") == name {
			return project
		}
	}
	return nil
}

func (s *Service) clusterByName(groupID string, name string) corestore.Record {
	for _, cluster := range s.store.Clusters.FindBy("group_id", groupID) {
		if stringField(cluster, "name") == name {
			return cluster
		}
	}
	return nil
}

func (s *Service) userByName(groupID string, username string) corestore.Record {
	for _, user := range s.store.Users.FindBy("group_id", groupID) {
		if stringField(user, "username") == username {
			return user
		}
	}
	return nil
}

func (s *Service) deleteClusterData(clusterID string) {
	for _, doc := range s.store.Documents.FindBy("cluster_id", clusterID) {
		s.store.Documents.Delete(intField(doc, "id"))
	}
	for _, collection := range s.store.Collections.FindBy("cluster_id", clusterID) {
		s.store.Collections.Delete(intField(collection, "id"))
	}
	for _, db := range s.store.Databases.FindBy("cluster_id", clusterID) {
		s.store.Databases.Delete(intField(db, "id"))
	}
}

func formatProject(project corestore.Record) map[string]any {
	return map[string]any{
		"id":           stringField(project, "group_id"),
		"name":         stringField(project, "name"),
		"orgId":        stringField(project, "org_id"),
		"clusterCount": intField(project, "cluster_count"),
		"created":      stringField(project, "created_at"),
	}
}

func formatCluster(cluster corestore.Record) map[string]any {
	connection := mapValue(cluster["connection_strings"])
	provider := mapValue(cluster["provider_settings"])
	return map[string]any{
		"id":        stringField(cluster, "cluster_id"),
		"name":      stringField(cluster, "name"),
		"groupId":   stringField(cluster, "group_id"),
		"stateName": stringField(cluster, "state"),
		"mongoURI":  stringField(cluster, "mongo_uri"),
		"connectionStrings": map[string]any{
			"standard":    stringValue(connection["standard"]),
			"standardSrv": stringValue(connection["standard_srv"]),
		},
		"providerSettings": map[string]any{
			"providerName":     stringValue(provider["provider_name"]),
			"instanceSizeName": stringValue(provider["instance_size_name"]),
			"regionName":       stringValue(provider["region_name"]),
		},
		"clusterType":    stringField(cluster, "cluster_type"),
		"diskSizeGB":     cluster["disk_size_gb"],
		"mongoDBVersion": stringField(cluster, "mongodb_version"),
		"created":        stringField(cluster, "created_at"),
	}
}

func formatUser(user corestore.Record) map[string]any {
	roles := make([]map[string]any, 0)
	for _, role := range mapSliceValue(user["roles"]) {
		roles = append(roles, map[string]any{"databaseName": stringValue(role["database_name"]), "roleName": stringValue(role["role_name"])})
	}
	return map[string]any{
		"username":     stringField(user, "username"),
		"groupId":      stringField(user, "group_id"),
		"databaseName": "admin",
		"roles":        roles,
	}
}

func firstNonZeroFloat(value any, fallback float64) float64 {
	if number, ok := floatValue(value); ok && number != 0 {
		return number
	}
	return fallback
}
