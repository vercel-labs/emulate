package mongoatlas

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func TestAdminAPIs(t *testing.T) {
	_, router := newTestService(t)

	projects := mongoJSON(router, http.MethodGet, "/api/atlas/v2/groups", "")
	if projects.Code != http.StatusOK || !strings.Contains(projects.Body.String(), `"name":"Project0"`) {
		t.Fatalf("projects status = %d, body = %s", projects.Code, projects.Body.String())
	}
	groupID := stringFromJSON(t, projects.Body.Bytes(), "results.0.id")

	duplicate := mongoJSON(router, http.MethodPost, "/api/atlas/v2/groups", `{"name":"Project0"}`)
	if duplicate.Code != http.StatusConflict || !strings.Contains(duplicate.Body.String(), "DUPLICATE_GROUP_NAME") {
		t.Fatalf("duplicate project status = %d, body = %s", duplicate.Code, duplicate.Body.String())
	}

	cluster := mongoJSON(router, http.MethodGet, "/api/atlas/v2/groups/"+groupID+"/clusters/Cluster0", "")
	if cluster.Code != http.StatusOK || !strings.Contains(cluster.Body.String(), `"stateName":"IDLE"`) || !strings.Contains(cluster.Body.String(), `"connectionStrings"`) {
		t.Fatalf("cluster status = %d, body = %s", cluster.Code, cluster.Body.String())
	}

	createCluster := mongoJSON(router, http.MethodPost, "/api/atlas/v2/groups/"+groupID+"/clusters", `{"name":"NewCluster","clusterType":"REPLICASET"}`)
	if createCluster.Code != http.StatusCreated || !strings.Contains(createCluster.Body.String(), `"name":"NewCluster"`) {
		t.Fatalf("create cluster status = %d, body = %s", createCluster.Code, createCluster.Body.String())
	}

	user := mongoJSON(router, http.MethodPost, "/api/atlas/v2/groups/"+groupID+"/databaseUsers", `{"username":"app","roles":[{"databaseName":"test","roleName":"readWrite"}]}`)
	if user.Code != http.StatusCreated || !strings.Contains(user.Body.String(), `"username":"app"`) || !strings.Contains(user.Body.String(), `"roleName":"readWrite"`) {
		t.Fatalf("create user status = %d, body = %s", user.Code, user.Body.String())
	}

	databases := mongoJSON(router, http.MethodGet, "/api/atlas/v2/groups/"+groupID+"/clusters/Cluster0/databases", "")
	if databases.Code != http.StatusOK || !strings.Contains(databases.Body.String(), `"databaseName":"test"`) {
		t.Fatalf("databases status = %d, body = %s", databases.Code, databases.Body.String())
	}

	collections := mongoJSON(router, http.MethodGet, "/api/atlas/v2/groups/"+groupID+"/clusters/Cluster0/databases/test/collections", "")
	if collections.Code != http.StatusOK || !strings.Contains(collections.Body.String(), `"collectionName":"items"`) {
		t.Fatalf("collections status = %d, body = %s", collections.Code, collections.Body.String())
	}
}

func TestDataAPIs(t *testing.T) {
	_, router := newTestService(t)

	emptyDocument := mongoJSON(router, http.MethodPost, "/app/data-api/v1/action/insertOne", `{"dataSource":"Cluster0","database":"test","collection":"items","document":{}}`)
	if emptyDocument.Code != http.StatusCreated || !strings.Contains(emptyDocument.Body.String(), `"insertedId"`) {
		t.Fatalf("empty document insert status = %d, body = %s", emptyDocument.Code, emptyDocument.Body.String())
	}

	insert := mongoJSON(router, http.MethodPost, "/app/data-api/v1/action/insertOne", `{"dataSource":"Cluster0","database":"test","collection":"items","document":{"name":"Widget","price":9.99,"nested":{"tag":"a"}}}`)
	if insert.Code != http.StatusCreated || !strings.Contains(insert.Body.String(), `"insertedId"`) {
		t.Fatalf("insert status = %d, body = %s", insert.Code, insert.Body.String())
	}

	findOne := mongoJSON(router, http.MethodPost, "/app/data-api/v1/action/findOne", `{"dataSource":"Cluster0","database":"test","collection":"items","filter":{"nested.tag":"a"}}`)
	if findOne.Code != http.StatusOK || !strings.Contains(findOne.Body.String(), `"name":"Widget"`) {
		t.Fatalf("findOne status = %d, body = %s", findOne.Code, findOne.Body.String())
	}

	mongoJSON(router, http.MethodPost, "/app/data-api/v1/action/insertMany", `{"dataSource":"Cluster0","database":"test","collection":"items","documents":[{"name":"A","price":10},{"name":"B","price":20},{"name":"C","price":30}]}`)
	find := mongoJSON(router, http.MethodPost, "/app/data-api/v1/action/find", `{"dataSource":"Cluster0","database":"test","collection":"items","filter":{"price":{"$gte":20}},"sort":{"price":-1},"projection":{"name":1,"_id":0}}`)
	if find.Code != http.StatusOK || !strings.Contains(find.Body.String(), `"documents":[{"name":"C"},{"name":"B"}]`) {
		t.Fatalf("find status = %d, body = %s", find.Code, find.Body.String())
	}

	update := mongoJSON(router, http.MethodPost, "/app/data-api/v1/action/updateOne", `{"dataSource":"Cluster0","database":"test","collection":"items","filter":{"name":"A"},"update":{"$inc":{"price":5}}}`)
	if update.Code != http.StatusOK || !strings.Contains(update.Body.String(), `"matchedCount":1`) {
		t.Fatalf("update status = %d, body = %s", update.Code, update.Body.String())
	}

	emptyUpdate := mongoJSON(router, http.MethodPost, "/app/data-api/v1/action/updateOne", `{"dataSource":"Cluster0","database":"test","collection":"items","filter":{"name":"A"},"update":{}}`)
	if emptyUpdate.Code != http.StatusOK || !strings.Contains(emptyUpdate.Body.String(), `"matchedCount":1`) {
		t.Fatalf("empty update status = %d, body = %s", emptyUpdate.Code, emptyUpdate.Body.String())
	}

	upsert := mongoJSON(router, http.MethodPost, "/app/data-api/v1/action/updateOne", `{"dataSource":"Cluster0","database":"test","collection":"items","filter":{"name":"Upserted"},"update":{"$set":{"value":42}},"upsert":true}`)
	if upsert.Code != http.StatusOK || !strings.Contains(upsert.Body.String(), `"upsertedId"`) {
		t.Fatalf("upsert status = %d, body = %s", upsert.Code, upsert.Body.String())
	}

	aggregate := mongoJSON(router, http.MethodPost, "/app/data-api/v1/action/aggregate", `{"dataSource":"Cluster0","database":"test","collection":"items","pipeline":[{"$match":{"price":{"$gte":20}}},{"$count":"total"}]}`)
	if aggregate.Code != http.StatusOK || !strings.Contains(aggregate.Body.String(), `"total":2`) {
		t.Fatalf("aggregate status = %d, body = %s", aggregate.Code, aggregate.Body.String())
	}

	deleteMany := mongoJSON(router, http.MethodPost, "/app/data-api/v1/action/deleteMany", `{"dataSource":"Cluster0","database":"test","collection":"items","filter":{"price":{"$gte":20}}}`)
	if deleteMany.Code != http.StatusOK || !strings.Contains(deleteMany.Body.String(), `"deletedCount":2`) {
		t.Fatalf("deleteMany status = %d, body = %s", deleteMany.Code, deleteMany.Body.String())
	}
}

func TestSeedFromConfig(t *testing.T) {
	service, _ := newTestService(t)
	service.SeedFromConfig(SeedConfig{
		Projects: []ProjectSeed{{Name: "CustomProject"}},
		Clusters: []ClusterSeed{{Name: "CustomCluster", Project: "CustomProject"}},
		DatabaseUsers: []DatabaseUserSeed{{
			Username: "appuser",
			Project:  "CustomProject",
			Roles:    []RoleSeed{{DatabaseName: "mydb", RoleName: "readWrite"}},
		}},
		Databases: []DatabaseSeed{{Cluster: "CustomCluster", Name: "mydb", Collections: []string{"users", "orders"}}},
	})
	if service.projectByName("CustomProject") == nil || firstRecord(service.store.Clusters.FindBy("name", "CustomCluster")) == nil {
		t.Fatal("seed did not create project and cluster")
	}
	cluster := firstRecord(service.store.Clusters.FindBy("name", "CustomCluster"))
	if service.collectionByName(stringField(cluster, "cluster_id"), "mydb", "orders") == nil {
		t.Fatal("seed did not create collection")
	}
}

func newTestService(t *testing.T) (*Service, *corehttp.Router) {
	t.Helper()
	service := New(Options{Store: corestore.New()})
	router := corehttp.NewRouter()
	service.RegisterRoutes(router)
	return service, router
}

func mongoJSON(router *corehttp.Router, method string, path string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-api-key")
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	return res
}

func stringFromJSON(t *testing.T, raw []byte, path string) string {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	current := value
	for _, part := range strings.Split(path, ".") {
		if index, err := strconv.Atoi(part); err == nil {
			items, ok := current.([]any)
			if !ok || index >= len(items) {
				t.Fatalf("missing JSON path %s", path)
			}
			current = items[index]
			continue
		}
		object, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("missing JSON path %s", path)
		}
		current = object[part]
	}
	return stringValue(current)
}
