package vercel

import (
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerDeploymentRoutes(router *corehttp.Router) {
	router.Patch("/v12/deployments/:id/cancel", func(c *corehttp.Context) {
		if _, ok := s.currentUser(c); !ok {
			return
		}
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Could not resolve team or account scope")
			return
		}
		dep := firstRecord(s.store.Deployments.FindBy("uid", c.Param("id")))
		if dep == nil || !s.assertDeploymentAccess(dep, scoped.AccountID) {
			writeVercelError(c, http.StatusNotFound, "not_found", "Deployment not found")
			return
		}
		readyState := stringField(dep, "readyState")
		if readyState != "QUEUED" && readyState != "BUILDING" {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Deployment cannot be canceled in its current state")
			return
		}
		now := nowMillis()
		updated, ok := s.store.Deployments.Update(intField(dep, "id"), corestore.Record{
			"readyState": "CANCELED",
			"state":      "CANCELED",
			"canceledAt": now,
		})
		if !ok {
			updated = dep
		}
		s.store.DeploymentEvents.Insert(corestore.Record{
			"deploymentId": stringField(updated, "uid"),
			"type":         "canceled",
			"payload":      map[string]any{"text": "Deployment canceled"},
			"date":         now,
			"serial":       strconv.FormatInt(now, 10),
		})
		c.JSON(http.StatusOK, formatDeployment(updated, s.store, s.baseURL))
	})

	router.Get("/v2/deployments/:id/aliases", func(c *corehttp.Context) {
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusUnauthorized, "not_authenticated", "Authentication required")
			return
		}
		dep := firstRecord(s.store.Deployments.FindBy("uid", c.Param("id")))
		if dep == nil || !s.assertDeploymentAccess(dep, scoped.AccountID) {
			writeVercelError(c, http.StatusNotFound, "not_found", "Deployment not found")
			return
		}
		aliases := s.store.DeploymentAliases.FindBy("deploymentId", stringField(dep, "uid"))
		out := make([]map[string]any, 0, len(aliases))
		for _, alias := range aliases {
			out = append(out, map[string]any{
				"uid":          stringField(alias, "uid"),
				"alias":        stringField(alias, "alias"),
				"deploymentId": stringField(alias, "deploymentId"),
				"projectId":    stringField(alias, "projectId"),
			})
		}
		c.JSON(http.StatusOK, map[string]any{"aliases": out})
	})

	router.Get("/v3/deployments/:idOrUrl/events", func(c *corehttp.Context) {
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusUnauthorized, "not_authenticated", "Authentication required")
			return
		}
		dep := s.findDeploymentByIDOrURL(c.Param("idOrUrl"))
		if dep == nil || !s.assertDeploymentAccess(dep, scoped.AccountID) {
			writeVercelError(c, http.StatusNotFound, "not_found", "Deployment not found")
			return
		}
		direction := strings.ToLower(c.Query("direction"))
		if direction == "" {
			direction = "backward"
		}
		limit := 20
		if parsed, err := strconv.Atoi(c.Query("limit")); err == nil && parsed > 0 {
			limit = parsed
		}
		if limit > 100 {
			limit = 100
		}
		events := s.store.DeploymentEvents.FindBy("deploymentId", stringField(dep, "uid"))
		sort.SliceStable(events, func(i int, j int) bool {
			left := timeMillis(events[i]["date"])
			right := timeMillis(events[j]["date"])
			if direction == "backward" {
				return left > right
			}
			return left < right
		})
		if len(events) > limit {
			events = events[:limit]
		}
		out := make([]map[string]any, 0, len(events))
		for _, event := range events {
			out = append(out, map[string]any{
				"type":    event["type"],
				"payload": event["payload"],
				"date":    event["date"],
				"serial":  event["serial"],
			})
		}
		c.JSON(http.StatusOK, out)
	})

	router.Get("/v6/deployments/:id/files", func(c *corehttp.Context) {
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusUnauthorized, "not_authenticated", "Authentication required")
			return
		}
		dep := firstRecord(s.store.Deployments.FindBy("uid", c.Param("id")))
		if dep == nil || !s.assertDeploymentAccess(dep, scoped.AccountID) {
			writeVercelError(c, http.StatusNotFound, "not_found", "Deployment not found")
			return
		}
		files := s.store.DeploymentFiles.FindBy("deploymentId", stringField(dep, "uid"))
		c.JSON(http.StatusOK, map[string]any{"files": buildFileTree(files)})
	})

	router.Post("/v13/deployments", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Could not resolve team or account scope")
			return
		}
		body, err := parseJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		name := strings.TrimSpace(stringValue(body["name"]))
		if name == "" {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Missing required field: name")
			return
		}
		project := s.resolveOrCreateProject(scoped.AccountID, name, body["project"])
		uid := generateUID("dpl")
		urlValue := deploymentHostname(name, uid, s.baseURL)
		target := stringValue(body["target"])
		if target != "production" && target != "preview" && target != "staging" {
			target = "preview"
		}
		meta := stringMapValue(body["meta"])
		regions := stringSliceValue(body["regions"])
		if len(regions) == 0 {
			regions = []string{"iad1"}
		}
		now := nowMillis()
		gitSource := parseGitSource(body["gitSource"])
		source := "cli"
		if gitSource != nil {
			source = "git"
		}
		dep := s.store.Deployments.Insert(corestore.Record{
			"uid":           uid,
			"name":          name,
			"url":           urlValue,
			"projectId":     stringField(project, "uid"),
			"source":        source,
			"target":        target,
			"readyState":    "READY",
			"readySubstate": nil,
			"state":         "READY",
			"creatorId":     stringField(user, "uid"),
			"inspectorUrl":  s.baseURL + "/deployments/" + uid,
			"meta":          meta,
			"gitSource":     gitSource,
			"buildingAt":    now,
			"readyAt":       now,
			"canceledAt":    nil,
			"errorCode":     nil,
			"errorMessage":  nil,
			"regions":       regions,
			"functions":     nil,
			"routes":        nil,
			"plan":          "hobby",
			"aliasAssigned": true,
			"aliasError":    nil,
			"bootedAt":      now,
		})
		s.store.DeploymentAliases.Insert(corestore.Record{
			"uid":          generateUID("als"),
			"alias":        urlValue,
			"deploymentId": stringField(dep, "uid"),
			"projectId":    stringField(project, "uid"),
		})
		if target == "production" {
			s.store.DeploymentAliases.Insert(corestore.Record{
				"uid":          generateUID("als"),
				"alias":        productionProjectAlias(stringField(project, "name"), s.baseURL),
				"deploymentId": stringField(dep, "uid"),
				"projectId":    stringField(project, "uid"),
			})
		}
		s.upsertProjectDeploymentRefs(project, dep)
		s.store.Builds.Insert(corestore.Record{
			"uid":          generateUID("bld"),
			"deploymentId": stringField(dep, "uid"),
			"entrypoint":   "api/index.ts",
			"readyState":   "READY",
			"output":       []any{},
			"readyStateAt": now,
			"fingerprint":  generateUID("fgp"),
		})
		s.insertDeploymentEvent(dep, "created", "Deployment created", now, "1")
		s.insertDeploymentEvent(dep, "building", "Building", now, "2")
		s.insertDeploymentEvent(dep, "ready", "Deployment ready", now, "3")
		s.insertDeploymentFilesFromBody(dep, body["files"])
		c.JSON(http.StatusOK, formatDeployment(dep, s.store, s.baseURL))
	})

	router.Get("/v6/deployments", func(c *corehttp.Context) {
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusUnauthorized, "not_authenticated", "Authentication required")
			return
		}
		appName := strings.TrimSpace(c.Query("app"))
		projectIDFilter := strings.TrimSpace(c.Query("projectId"))
		targetFilter := c.Query("target")
		targetFilterValid := targetFilter == "production" || targetFilter == "preview" || targetFilter == "staging"
		stateFilter := c.Query("state")
		list := make([]corestore.Record, 0)
		for _, dep := range s.store.Deployments.All() {
			project := firstRecord(s.store.Projects.FindBy("uid", stringField(dep, "projectId")))
			if project == nil || stringField(project, "accountId") != scoped.AccountID {
				continue
			}
			if appName != "" && stringField(project, "name") != appName {
				continue
			}
			if projectIDFilter != "" && stringField(dep, "projectId") != projectIDFilter {
				continue
			}
			if targetFilterValid && stringField(dep, "target") != targetFilter {
				continue
			}
			if stateFilter != "" && stringField(dep, "state") != stateFilter && stringField(dep, "readyState") != stateFilter {
				continue
			}
			list = append(list, dep)
		}
		items, page := applyPagination(list, parsePagination(c))
		out := make([]map[string]any, 0, len(items))
		for _, dep := range items {
			out = append(out, formatDeploymentBrief(dep, s.store))
		}
		c.JSON(http.StatusOK, map[string]any{"deployments": out, "pagination": page})
	})

	router.Delete("/v13/deployments/:id", func(c *corehttp.Context) {
		if _, ok := s.currentUser(c); !ok {
			return
		}
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Could not resolve team or account scope")
			return
		}
		dep := firstRecord(s.store.Deployments.FindBy("uid", c.Param("id")))
		if dep == nil || !s.assertDeploymentAccess(dep, scoped.AccountID) {
			writeVercelError(c, http.StatusNotFound, "not_found", "Deployment not found")
			return
		}
		uid := stringField(dep, "uid")
		s.deleteDeploymentCascade(dep)
		c.JSON(http.StatusOK, map[string]any{"uid": uid, "state": "DELETED"})
	})

	router.Get("/v13/deployments/:idOrUrl", func(c *corehttp.Context) {
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusUnauthorized, "not_authenticated", "Authentication required")
			return
		}
		dep := s.findDeploymentByIDOrURL(c.Param("idOrUrl"))
		if dep == nil || !s.assertDeploymentAccess(dep, scoped.AccountID) {
			writeVercelError(c, http.StatusNotFound, "not_found", "Deployment not found")
			return
		}
		c.JSON(http.StatusOK, formatDeployment(dep, s.store, s.baseURL))
	})

	router.Post("/v2/files", func(c *corehttp.Context) {
		if _, ok := s.currentUser(c); !ok {
			return
		}
		digest := c.Header("x-vercel-digest")
		if digest == "" {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Missing x-vercel-digest header")
			return
		}
		size := 0
		if raw := c.Header("Content-Length"); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed < 0 {
				writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid Content-Length")
				return
			}
			size = parsed
		}
		_, _ = io.Copy(io.Discard, c.Request.Body)
		if firstRecord(s.store.Files.FindBy("digest", digest)) == nil {
			contentType := c.Header("Content-Type")
			if contentType == "" {
				contentType = "application/octet-stream"
			}
			s.store.Files.Insert(corestore.Record{
				"digest":      digest,
				"size":        size,
				"contentType": contentType,
			})
		}
		c.JSON(http.StatusOK, []any{})
	})
}

func (s *Service) assertDeploymentAccess(dep corestore.Record, accountID string) bool {
	project := firstRecord(s.store.Projects.FindBy("uid", stringField(dep, "projectId")))
	return project != nil && stringField(project, "accountId") == accountID
}

func (s *Service) findDeploymentByIDOrURL(idOrURL string) corestore.Record {
	raw := strings.TrimSpace(idOrURL)
	if dep := firstRecord(s.store.Deployments.FindBy("uid", raw)); dep != nil {
		return dep
	}
	host := normalizeURLParam(raw)
	if dep := firstRecord(s.store.Deployments.FindBy("url", host)); dep != nil {
		return dep
	}
	return firstRecord(s.store.Deployments.FindBy("url", raw))
}

func (s *Service) resolveOrCreateProject(accountID string, name string, rawProject any) corestore.Record {
	if projectID, ok := rawProject.(string); ok && strings.TrimSpace(projectID) != "" {
		if project := s.lookupProject(strings.TrimSpace(projectID), accountID); project != nil {
			return project
		}
	}
	if project := s.lookupProject(name, accountID); project != nil {
		return project
	}
	return s.store.Projects.Insert(defaultProjectRecord(name, accountID))
}

func parseGitSource(raw any) any {
	body, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	repoID := stringValue(body["repoId"])
	if repoID == "" {
		if number, ok := body["repoId"].(float64); ok {
			repoID = strconv.FormatInt(int64(number), 10)
		}
	}
	gitType := stringValue(body["type"])
	if gitType == "" {
		gitType = "github"
	}
	return map[string]any{
		"type":             gitType,
		"ref":              stringValue(body["ref"]),
		"sha":              stringValue(body["sha"]),
		"repoId":           repoID,
		"org":              stringValue(body["org"]),
		"repo":             stringValue(body["repo"]),
		"message":          stringValue(body["message"]),
		"authorName":       stringValue(body["authorName"]),
		"commitAuthorName": stringValue(body["commitAuthorName"]),
	}
}

func (s *Service) upsertProjectDeploymentRefs(project corestore.Record, dep corestore.Record) {
	entry := map[string]any{
		"id":        stringField(dep, "uid"),
		"url":       stringField(dep, "url"),
		"state":     stringField(dep, "state"),
		"createdAt": timeMillisField(dep, "created_at"),
	}
	latest := []any{entry}
	for _, raw := range anySlice(project["latestDeployments"]) {
		row, ok := raw.(map[string]any)
		if !ok || stringValue(row["id"]) == stringField(dep, "uid") {
			continue
		}
		latest = append(latest, row)
	}
	targets := map[string]any{}
	if existing, ok := project["targets"].(map[string]any); ok {
		for key, value := range existing {
			targets[key] = value
		}
	}
	targets[targetKey(stringField(dep, "target"))] = entry
	s.store.Projects.Update(intField(project, "id"), corestore.Record{"latestDeployments": latest, "targets": targets})
}

func targetKey(target string) string {
	switch target {
	case "production", "staging":
		return target
	default:
		return "preview"
	}
}

func (s *Service) insertDeploymentEvent(dep corestore.Record, eventType string, text string, date int64, serial string) {
	s.store.DeploymentEvents.Insert(corestore.Record{
		"deploymentId": stringField(dep, "uid"),
		"type":         eventType,
		"payload":      map[string]any{"text": text},
		"date":         date,
		"serial":       serial,
	})
}

func (s *Service) insertDeploymentFilesFromBody(dep corestore.Record, raw any) {
	files, ok := raw.([]any)
	if !ok {
		return
	}
	for _, item := range files {
		file, ok := item.(map[string]any)
		if !ok {
			continue
		}
		filePath := stringValue(file["file"])
		sha := stringValue(file["sha"])
		if filePath == "" || sha == "" {
			continue
		}
		size := 0
		if number, ok := numberToInt(file["size"]); ok {
			size = number
		}
		if firstRecord(s.store.Files.FindBy("digest", sha)) == nil {
			s.store.Files.Insert(corestore.Record{
				"digest":      sha,
				"size":        size,
				"contentType": "application/octet-stream",
			})
		}
		s.store.DeploymentFiles.Insert(corestore.Record{
			"deploymentId": stringField(dep, "uid"),
			"name":         filePath,
			"type":         "file",
			"uid":          generateUID("f"),
			"children":     []string{},
			"contentType":  "application/octet-stream",
			"mode":         0o644,
			"size":         size,
		})
	}
}

func (s *Service) deleteDeploymentCascade(dep corestore.Record) {
	uid := stringField(dep, "uid")
	for _, row := range s.store.Builds.FindBy("deploymentId", uid) {
		s.store.Builds.Delete(intField(row, "id"))
	}
	for _, row := range s.store.DeploymentEvents.FindBy("deploymentId", uid) {
		s.store.DeploymentEvents.Delete(intField(row, "id"))
	}
	for _, row := range s.store.DeploymentFiles.FindBy("deploymentId", uid) {
		s.store.DeploymentFiles.Delete(intField(row, "id"))
	}
	for _, row := range s.store.DeploymentAliases.FindBy("deploymentId", uid) {
		s.store.DeploymentAliases.Delete(intField(row, "id"))
	}
	s.store.Deployments.Delete(intField(dep, "id"))
	project := firstRecord(s.store.Projects.FindBy("uid", stringField(dep, "projectId")))
	if project == nil {
		return
	}
	latest := []any{}
	for _, raw := range anySlice(project["latestDeployments"]) {
		row, ok := raw.(map[string]any)
		if !ok || stringValue(row["id"]) == uid {
			continue
		}
		latest = append(latest, row)
	}
	targets := map[string]any{}
	if existing, ok := project["targets"].(map[string]any); ok {
		for key, value := range existing {
			row, ok := value.(map[string]any)
			if ok && stringValue(row["id"]) == uid {
				continue
			}
			targets[key] = value
		}
	}
	s.store.Projects.Update(intField(project, "id"), corestore.Record{"latestDeployments": latest, "targets": targets})
}

func buildFileTree(rows []corestore.Record) []map[string]any {
	root := fileTreeDirectory("/")
	if len(rows) == 0 {
		return []map[string]any{root}
	}
	for _, row := range rows {
		if stringField(row, "type") != "file" {
			continue
		}
		parts := strings.Split(strings.Trim(stringField(row, "name"), "/"), "/")
		if len(parts) == 0 || parts[0] == "" {
			continue
		}
		current := root
		for _, part := range parts[:len(parts)-1] {
			current = fileTreeChildDirectory(current, part)
		}
		children := current["children"].([]any)
		children = append(children, map[string]any{
			"uid":         stringField(row, "uid"),
			"name":        parts[len(parts)-1],
			"type":        "file",
			"mode":        intField(row, "mode"),
			"size":        intField(row, "size"),
			"contentType": row["contentType"],
			"children":    []any{},
		})
		current["children"] = children
	}
	return []map[string]any{root}
}

func fileTreeDirectory(name string) map[string]any {
	return map[string]any{
		"uid":         generateUID("file"),
		"name":        name,
		"type":        "directory",
		"mode":        0o40755,
		"size":        0,
		"contentType": nil,
		"children":    []any{},
	}
}

func fileTreeChildDirectory(parent map[string]any, name string) map[string]any {
	children := parent["children"].([]any)
	for _, child := range children {
		node, ok := child.(map[string]any)
		if ok && stringValue(node["name"]) == name && stringValue(node["type"]) == "directory" {
			return node
		}
	}
	node := fileTreeDirectory(name)
	parent["children"] = append(children, node)
	return node
}

func anySlice(raw any) []any {
	if raw == nil {
		return nil
	}
	if value, ok := raw.([]any); ok {
		return value
	}
	if values, ok := raw.([]map[string]any); ok {
		out := make([]any, 0, len(values))
		for _, value := range values {
			out = append(out, value)
		}
		return out
	}
	return nil
}
