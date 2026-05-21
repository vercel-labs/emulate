package mongoatlas

import (
	"net/http"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerDataAPIRoutes(router *corehttp.Router) {
	router.Post("/app/data-api/v1/action/findOne", s.handleFindOne)
	router.Post("/app/data-api/v1/action/find", s.handleFind)
	router.Post("/app/data-api/v1/action/insertOne", s.handleInsertOne)
	router.Post("/app/data-api/v1/action/insertMany", s.handleInsertMany)
	router.Post("/app/data-api/v1/action/updateOne", s.handleUpdateOne)
	router.Post("/app/data-api/v1/action/updateMany", s.handleUpdateMany)
	router.Post("/app/data-api/v1/action/deleteOne", s.handleDeleteOne)
	router.Post("/app/data-api/v1/action/deleteMany", s.handleDeleteMany)
	router.Post("/app/data-api/v1/action/aggregate", s.handleAggregate)
}

func (s *Service) handleFindOne(c *corehttp.Context) {
	body := readJSONBody(c.Request)
	cluster, ok := s.resolveDataRequest(c, body, true)
	if !ok {
		return
	}
	records := filterRecords(recordsForCollection(s.store, stringField(cluster, "cluster_id"), stringValue(body["database"]), stringValue(body["collection"])), mapValue(body["filter"]))
	var document any
	if len(records) > 0 {
		document = applyProjection(recordData(records[0]), mapValue(body["projection"]))
	}
	mongoOK(c, http.StatusOK, map[string]any{"document": document})
}

func (s *Service) handleFind(c *corehttp.Context) {
	body := readJSONBody(c.Request)
	cluster, ok := s.resolveDataRequest(c, body, true)
	if !ok {
		return
	}
	records := filterRecords(recordsForCollection(s.store, stringField(cluster, "cluster_id"), stringValue(body["database"]), stringValue(body["collection"])), mapValue(body["filter"]))
	if sortSpec := mapValue(body["sort"]); len(sortSpec) > 0 {
		records = sortRecords(records, sortSpec)
	}
	skip := intValue(body["skip"])
	if skip > len(records) {
		skip = len(records)
	}
	records = records[skip:]
	limit := intValue(body["limit"])
	if limit > 0 && limit < len(records) {
		records = records[:limit]
	}
	documents := make([]map[string]any, 0, len(records))
	projection := mapValue(body["projection"])
	for _, record := range records {
		documents = append(documents, applyProjection(recordData(record), projection))
	}
	mongoOK(c, http.StatusOK, map[string]any{"documents": documents})
}

func (s *Service) handleInsertOne(c *corehttp.Context) {
	body := readJSONBody(c.Request)
	cluster, ok := s.resolveDataRequest(c, body, true)
	if !ok {
		return
	}
	document, ok := objectValue(body["document"])
	if !ok {
		mongoError(c, http.StatusBadRequest, "InvalidParameter", "dataSource, database, collection, and document are required")
		return
	}
	s.ensureCollection(stringField(cluster, "cluster_id"), stringValue(body["database"]), stringValue(body["collection"]))
	docID := firstNonEmpty(stringValue(document["_id"]), generateObjectID())
	document["_id"] = docID
	s.store.Documents.Insert(corestore.Record{
		"cluster_id": stringField(cluster, "cluster_id"),
		"database":   stringValue(body["database"]),
		"collection": stringValue(body["collection"]),
		"doc_id":     docID,
		"data":       document,
	})
	mongoOK(c, http.StatusCreated, map[string]any{"insertedId": docID})
}

func (s *Service) handleInsertMany(c *corehttp.Context) {
	body := readJSONBody(c.Request)
	cluster, ok := s.resolveDataRequest(c, body, true)
	if !ok {
		return
	}
	documents := mapSliceValue(body["documents"])
	if documents == nil {
		mongoError(c, http.StatusBadRequest, "InvalidParameter", "dataSource, database, collection, and documents are required")
		return
	}
	s.ensureCollection(stringField(cluster, "cluster_id"), stringValue(body["database"]), stringValue(body["collection"]))
	insertedIDs := make([]string, 0, len(documents))
	for _, document := range documents {
		docID := firstNonEmpty(stringValue(document["_id"]), generateObjectID())
		document["_id"] = docID
		s.store.Documents.Insert(corestore.Record{
			"cluster_id": stringField(cluster, "cluster_id"),
			"database":   stringValue(body["database"]),
			"collection": stringValue(body["collection"]),
			"doc_id":     docID,
			"data":       document,
		})
		insertedIDs = append(insertedIDs, docID)
	}
	mongoOK(c, http.StatusCreated, map[string]any{"insertedIds": insertedIDs})
}

func (s *Service) handleUpdateOne(c *corehttp.Context) {
	body := readJSONBody(c.Request)
	cluster, ok := s.resolveDataRequest(c, body, true)
	if !ok {
		return
	}
	update, ok := objectValue(body["update"])
	if !ok {
		mongoError(c, http.StatusBadRequest, "InvalidParameter", "dataSource, database, collection, and update are required")
		return
	}
	records := filterRecords(recordsForCollection(s.store, stringField(cluster, "cluster_id"), stringValue(body["database"]), stringValue(body["collection"])), mapValue(body["filter"]))
	if len(records) > 0 {
		data := applyUpdate(recordData(records[0]), update)
		s.store.Documents.Update(intField(records[0], "id"), corestore.Record{"data": data})
		mongoOK(c, http.StatusOK, map[string]any{"matchedCount": 1, "modifiedCount": 1})
		return
	}
	if boolValue(body["upsert"]) {
		docID := generateObjectID()
		data := applyUpdate(mapWithID(docID, extractEqualityFields(mapValue(body["filter"]))), update)
		s.ensureCollection(stringField(cluster, "cluster_id"), stringValue(body["database"]), stringValue(body["collection"]))
		s.store.Documents.Insert(corestore.Record{"cluster_id": stringField(cluster, "cluster_id"), "database": stringValue(body["database"]), "collection": stringValue(body["collection"]), "doc_id": docID, "data": data})
		mongoOK(c, http.StatusOK, map[string]any{"matchedCount": 0, "modifiedCount": 0, "upsertedId": docID})
		return
	}
	mongoOK(c, http.StatusOK, map[string]any{"matchedCount": 0, "modifiedCount": 0})
}

func (s *Service) handleUpdateMany(c *corehttp.Context) {
	body := readJSONBody(c.Request)
	cluster, ok := s.resolveDataRequest(c, body, true)
	if !ok {
		return
	}
	update, ok := objectValue(body["update"])
	if !ok {
		mongoError(c, http.StatusBadRequest, "InvalidParameter", "dataSource, database, collection, and update are required")
		return
	}
	records := filterRecords(recordsForCollection(s.store, stringField(cluster, "cluster_id"), stringValue(body["database"]), stringValue(body["collection"])), mapValue(body["filter"]))
	modified := 0
	for _, record := range records {
		s.store.Documents.Update(intField(record, "id"), corestore.Record{"data": applyUpdate(recordData(record), update)})
		modified++
	}
	if len(records) == 0 && boolValue(body["upsert"]) {
		docID := generateObjectID()
		data := applyUpdate(mapWithID(docID, extractEqualityFields(mapValue(body["filter"]))), update)
		s.ensureCollection(stringField(cluster, "cluster_id"), stringValue(body["database"]), stringValue(body["collection"]))
		s.store.Documents.Insert(corestore.Record{"cluster_id": stringField(cluster, "cluster_id"), "database": stringValue(body["database"]), "collection": stringValue(body["collection"]), "doc_id": docID, "data": data})
		mongoOK(c, http.StatusOK, map[string]any{"matchedCount": 0, "modifiedCount": 0, "upsertedId": docID})
		return
	}
	mongoOK(c, http.StatusOK, map[string]any{"matchedCount": len(records), "modifiedCount": modified})
}

func (s *Service) handleDeleteOne(c *corehttp.Context) {
	body := readJSONBody(c.Request)
	cluster, ok := s.resolveDataRequest(c, body, true)
	if !ok {
		return
	}
	records := filterRecords(recordsForCollection(s.store, stringField(cluster, "cluster_id"), stringValue(body["database"]), stringValue(body["collection"])), mapValue(body["filter"]))
	if len(records) > 0 {
		s.store.Documents.Delete(intField(records[0], "id"))
		mongoOK(c, http.StatusOK, map[string]any{"deletedCount": 1})
		return
	}
	mongoOK(c, http.StatusOK, map[string]any{"deletedCount": 0})
}

func (s *Service) handleDeleteMany(c *corehttp.Context) {
	body := readJSONBody(c.Request)
	cluster, ok := s.resolveDataRequest(c, body, true)
	if !ok {
		return
	}
	records := filterRecords(recordsForCollection(s.store, stringField(cluster, "cluster_id"), stringValue(body["database"]), stringValue(body["collection"])), mapValue(body["filter"]))
	for _, record := range records {
		s.store.Documents.Delete(intField(record, "id"))
	}
	mongoOK(c, http.StatusOK, map[string]any{"deletedCount": len(records)})
}

func (s *Service) handleAggregate(c *corehttp.Context) {
	body := readJSONBody(c.Request)
	cluster, ok := s.resolveDataRequest(c, body, true)
	if !ok {
		return
	}
	records := recordsForCollection(s.store, stringField(cluster, "cluster_id"), stringValue(body["database"]), stringValue(body["collection"]))
	results := make([]map[string]any, 0, len(records))
	for _, record := range records {
		results = append(results, recordData(record))
	}
	for _, stage := range mapSliceValue(body["pipeline"]) {
		switch {
		case stage["$match"] != nil:
			filter := mapValue(stage["$match"])
			next := make([]map[string]any, 0, len(results))
			for _, result := range results {
				if matchesFilter(result, filter) {
					next = append(next, result)
				}
			}
			results = next
		case stage["$limit"] != nil:
			limit := intValue(stage["$limit"])
			if limit < len(results) {
				results = results[:limit]
			}
		case stage["$skip"] != nil:
			skip := intValue(stage["$skip"])
			if skip > len(results) {
				skip = len(results)
			}
			results = results[skip:]
		case stage["$sort"] != nil:
			results = sortMaps(results, mapValue(stage["$sort"]))
		case stage["$project"] != nil:
			projection := mapValue(stage["$project"])
			for i, result := range results {
				results[i] = applyProjection(result, projection)
			}
		case stage["$count"] != nil:
			results = []map[string]any{{stringValue(stage["$count"]): len(results)}}
		}
	}
	mongoOK(c, http.StatusOK, map[string]any{"documents": results})
}

func (s *Service) resolveDataRequest(c *corehttp.Context, body map[string]any, requireCollection bool) (corestore.Record, bool) {
	if stringValue(body["dataSource"]) == "" || stringValue(body["database"]) == "" || (requireCollection && stringValue(body["collection"]) == "") {
		mongoError(c, http.StatusBadRequest, "InvalidParameter", "dataSource, database, and collection are required")
		return nil, false
	}
	cluster := firstRecord(s.store.Clusters.FindBy("name", stringValue(body["dataSource"])))
	if cluster == nil {
		mongoError(c, http.StatusNotFound, "ClusterNotFound", "Cluster '"+stringValue(body["dataSource"])+"' not found")
		return nil, false
	}
	return cluster, true
}

func (s *Service) ensureCollection(clusterID string, database string, collection string) {
	if database != "" && s.databaseByName(clusterID, database) == nil {
		s.store.Databases.Insert(corestore.Record{"cluster_id": clusterID, "name": database})
	}
	if collection != "" && s.collectionByName(clusterID, database, collection) == nil {
		s.store.Collections.Insert(corestore.Record{"cluster_id": clusterID, "database": database, "name": collection})
	}
}

func (s *Service) databaseByName(clusterID string, name string) corestore.Record {
	for _, db := range s.store.Databases.FindBy("cluster_id", clusterID) {
		if stringField(db, "name") == name {
			return db
		}
	}
	return nil
}

func (s *Service) collectionByName(clusterID string, database string, name string) corestore.Record {
	for _, collection := range s.store.Collections.FindBy("cluster_id", clusterID) {
		if stringField(collection, "database") == database && stringField(collection, "name") == name {
			return collection
		}
	}
	return nil
}

func mapWithID(id string, values map[string]any) map[string]any {
	out := map[string]any{"_id": id}
	for key, value := range values {
		out[key] = cloneValue(value)
	}
	return out
}
