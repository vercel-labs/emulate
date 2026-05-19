package vercel

import (
	"net/http"
	"strings"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerProjectRoutes(router *corehttp.Router) {
	router.Post("/v11/projects", func(c *corehttp.Context) {
		if _, ok := s.currentUser(c); !ok {
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
		if s.lookupProject(name, scoped.AccountID) != nil {
			writeVercelError(c, http.StatusConflict, "project_already_exists", "A project with this name already exists")
			return
		}
		project := defaultProjectRecord(name, scoped.AccountID)
		copyStringPatch(body, project, "framework")
		copyStringPatch(body, project, "buildCommand")
		copyStringPatch(body, project, "devCommand")
		copyStringPatch(body, project, "installCommand")
		copyStringPatch(body, project, "outputDirectory")
		copyStringPatch(body, project, "rootDirectory")
		if nodeVersion, ok := body["nodeVersion"].(string); ok {
			project["nodeVersion"] = nodeVersion
		}
		if region, ok := body["serverlessFunctionRegion"].(string); ok {
			project["serverlessFunctionRegion"] = region
		}
		if publicSource, ok := body["publicSource"].(bool); ok {
			project["publicSource"] = publicSource
		}
		project["link"] = parseGitLink(body)
		inserted := s.store.Projects.Insert(project)
		s.insertProjectEnvFromBody(inserted, body["environmentVariables"])
		c.JSON(http.StatusOK, formatProject(inserted, s.baseURL))
	})

	router.Get("/v10/projects", func(c *corehttp.Context) {
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusUnauthorized, "not_authenticated", "Authentication required")
			return
		}
		search := strings.ToLower(strings.TrimSpace(c.Query("search")))
		projects := make([]corestore.Record, 0)
		for _, project := range s.store.Projects.All() {
			if stringField(project, "accountId") != scoped.AccountID {
				continue
			}
			if search != "" && !strings.Contains(strings.ToLower(stringField(project, "name")), search) {
				continue
			}
			projects = append(projects, project)
		}
		items, page := applyPagination(projects, parsePagination(c))
		out := make([]map[string]any, 0, len(items))
		for _, project := range items {
			out = append(out, formatProject(project, s.baseURL))
		}
		c.JSON(http.StatusOK, map[string]any{"projects": out, "pagination": page})
	})

	router.Get("/v9/projects/:idOrName", func(c *corehttp.Context) {
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusUnauthorized, "not_authenticated", "Authentication required")
			return
		}
		project := s.lookupProject(c.Param("idOrName"), scoped.AccountID)
		if project == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Project not found")
			return
		}
		out := formatProject(project, s.baseURL)
		envs := s.store.EnvVars.FindBy("projectId", stringField(project, "uid"))
		formatted := make([]map[string]any, 0, len(envs))
		for _, env := range envs {
			formatted = append(formatted, formatEnvVar(env, false))
		}
		out["env"] = formatted
		c.JSON(http.StatusOK, out)
	})

	router.Patch("/v9/projects/:idOrName", func(c *corehttp.Context) {
		if _, ok := s.currentUser(c); !ok {
			return
		}
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Could not resolve team or account scope")
			return
		}
		project := s.lookupProject(c.Param("idOrName"), scoped.AccountID)
		if project == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Project not found")
			return
		}
		body, err := parseJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		patch := corestore.Record{}
		copyTrimmedNamePatch(body, patch)
		copyNullableStringPatch(body, patch, project, "buildCommand")
		copyNullableStringPatch(body, patch, project, "devCommand")
		copyNullableStringPatch(body, patch, project, "installCommand")
		copyNullableStringPatch(body, patch, project, "outputDirectory")
		copyNullableStringPatch(body, patch, project, "framework")
		copyNullableStringPatch(body, patch, project, "rootDirectory")
		copyNullableStringPatch(body, patch, project, "serverlessFunctionRegion")
		copyNullableStringPatch(body, patch, project, "commandForIgnoringBuildStep")
		for _, key := range []string{"gitForkProtection", "publicSource", "autoAssignCustomDomains"} {
			if value, ok := body[key].(bool); ok {
				patch[key] = value
			}
		}
		if nodeVersion, ok := body["nodeVersion"].(string); ok {
			patch["nodeVersion"] = nodeVersion
		}
		updated, ok := s.store.Projects.Update(intField(project, "id"), patch)
		if !ok {
			writeVercelError(c, http.StatusInternalServerError, "internal_error", "Failed to update project")
			return
		}
		c.JSON(http.StatusOK, formatProject(updated, s.baseURL))
	})

	router.Delete("/v9/projects/:idOrName", func(c *corehttp.Context) {
		if _, ok := s.currentUser(c); !ok {
			return
		}
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Could not resolve team or account scope")
			return
		}
		project := s.lookupProject(c.Param("idOrName"), scoped.AccountID)
		if project == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Project not found")
			return
		}
		s.deleteProjectCascade(project)
		c.Writer.WriteHeader(http.StatusNoContent)
	})

	router.Get("/v1/projects/:projectId/promote/aliases", func(c *corehttp.Context) {
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusUnauthorized, "not_authenticated", "Authentication required")
			return
		}
		project := s.lookupProject(c.Param("projectId"), scoped.AccountID)
		if project == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Project not found")
			return
		}
		var production corestore.Record
		for _, dep := range s.store.Deployments.FindBy("projectId", stringField(project, "uid")) {
			if stringField(dep, "target") != "production" {
				continue
			}
			if production == nil || timeMillisField(dep, "created_at") > timeMillisField(production, "created_at") {
				production = dep
			}
		}
		if production == nil {
			c.JSON(http.StatusOK, map[string]any{"status": "PENDING", "alias": []string{}})
			return
		}
		aliases := s.store.DeploymentAliases.FindBy("deploymentId", stringField(production, "uid"))
		out := make([]string, 0, len(aliases))
		for _, alias := range aliases {
			out = append(out, stringField(alias, "alias"))
		}
		status := "PENDING"
		if stringField(production, "readySubstate") == "PROMOTED" || stringField(production, "readyState") == "READY" {
			status = "PROMOTED"
		}
		c.JSON(http.StatusOK, map[string]any{"status": status, "alias": out})
	})

	router.Patch("/v1/projects/:idOrName/protection-bypass", func(c *corehttp.Context) {
		user, ok := s.currentUser(c)
		if !ok {
			return
		}
		scoped, ok := s.resolveScope(c)
		if !ok {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Could not resolve team or account scope")
			return
		}
		project := s.lookupProject(c.Param("idOrName"), scoped.AccountID)
		if project == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Project not found")
			return
		}
		body, err := parseJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		createdBy := stringField(user, "uid")
		if generated, ok := body["generate"].(map[string]any); ok {
			scopeValue := stringValue(generated["scope"])
			if scopeValue == "" {
				scopeValue = "deployment"
			}
			s.store.ProtectionBypasses.Insert(corestore.Record{
				"projectId": stringField(project, "uid"),
				"secret":    generateSecret(),
				"note":      nullableString(stringValue(generated["note"])),
				"scope":     scopeValue,
				"createdBy": createdBy,
			})
			project = s.syncProtectionRecord(project)
		}
		if revoke, ok := body["revoke"].([]any); ok {
			for _, rawSecret := range revoke {
				secret, ok := rawSecret.(string)
				if !ok {
					continue
				}
				for _, row := range s.store.ProtectionBypasses.FindBy("projectId", stringField(project, "uid")) {
					if stringField(row, "secret") == secret {
						s.store.ProtectionBypasses.Delete(intField(row, "id"))
					}
				}
			}
			project = s.syncProtectionRecord(project)
		}
		if regenerate, ok := body["regenerate"].([]any); ok {
			for _, rawSecret := range regenerate {
				secret, ok := rawSecret.(string)
				if !ok {
					continue
				}
				for _, row := range s.store.ProtectionBypasses.FindBy("projectId", stringField(project, "uid")) {
					if stringField(row, "secret") != secret {
						continue
					}
					note := row["note"]
					scopeValue := stringField(row, "scope")
					s.store.ProtectionBypasses.Delete(intField(row, "id"))
					s.store.ProtectionBypasses.Insert(corestore.Record{
						"projectId": stringField(project, "uid"),
						"secret":    generateSecret(),
						"note":      note,
						"scope":     scopeValue,
						"createdBy": createdBy,
					})
				}
			}
			project = s.syncProtectionRecord(project)
		}
		fresh, ok := s.store.Projects.Get(intField(project, "id"))
		if !ok {
			fresh = project
		}
		c.JSON(http.StatusOK, map[string]any{"protectionBypass": mapOrEmpty(fresh["protectionBypass"])})
	})
}

func parseGitLink(body map[string]any) any {
	raw, ok := body["gitRepository"].(map[string]any)
	if !ok {
		return nil
	}
	repo := stringValue(raw["repo"])
	if repo == "" {
		return nil
	}
	repoID := 0
	if value, ok := raw["repoId"].(float64); ok {
		repoID = int(value)
	}
	now := nowMillis()
	gitType := stringValue(raw["type"])
	if gitType == "" {
		gitType = "github"
	}
	branch := stringValue(raw["productionBranch"])
	if branch == "" {
		branch = "main"
	}
	return map[string]any{
		"type":             gitType,
		"repo":             repo,
		"repoId":           repoID,
		"org":              stringValue(raw["org"]),
		"gitCredentialId":  stringValue(raw["gitCredentialId"]),
		"productionBranch": branch,
		"createdAt":        now,
		"updatedAt":        now,
		"deployHooks":      []any{},
	}
}

func (s *Service) insertProjectEnvFromBody(project corestore.Record, raw any) {
	items, ok := raw.([]any)
	if !ok {
		return
	}
	for _, item := range items {
		env, ok := item.(map[string]any)
		if !ok {
			continue
		}
		key := stringValue(env["key"])
		if key == "" {
			continue
		}
		envType := stringValue(env["type"])
		if !validEnvType(envType) {
			envType = "encrypted"
		}
		target := stringSliceValue(env["target"])
		target = normalizeTargets(target)
		if len(target) == 0 {
			target = []string{"production", "preview", "development"}
		}
		customEnvironmentIDs := []string{}
		if ids, ok := parseStringSliceStrict(env["customEnvironmentIds"]); ok {
			customEnvironmentIDs = ids
		}
		s.store.EnvVars.Insert(corestore.Record{
			"uid":                  generateUID("env"),
			"projectId":            stringField(project, "uid"),
			"key":                  key,
			"value":                stringValue(env["value"]),
			"type":                 envType,
			"target":               target,
			"gitBranch":            nullableString(stringValue(env["gitBranch"])),
			"customEnvironmentIds": customEnvironmentIDs,
			"comment":              nullableString(stringValue(env["comment"])),
			"decrypted":            false,
		})
	}
}

func (s *Service) deleteProjectCascade(project corestore.Record) {
	projectID := stringField(project, "uid")
	for _, dep := range s.store.Deployments.FindBy("projectId", projectID) {
		s.deleteDeploymentCascade(dep)
	}
	for _, row := range s.store.Domains.FindBy("projectId", projectID) {
		s.store.Domains.Delete(intField(row, "id"))
	}
	for _, row := range s.store.EnvVars.FindBy("projectId", projectID) {
		s.store.EnvVars.Delete(intField(row, "id"))
	}
	for _, row := range s.store.ProtectionBypasses.FindBy("projectId", projectID) {
		s.store.ProtectionBypasses.Delete(intField(row, "id"))
	}
	s.store.Projects.Delete(intField(project, "id"))
}

func (s *Service) syncProtectionRecord(project corestore.Record) corestore.Record {
	record := map[string]any{}
	for _, row := range s.store.ProtectionBypasses.FindBy("projectId", stringField(project, "uid")) {
		record[stringField(row, "secret")] = map[string]any{
			"createdAt": timeMillisField(row, "created_at"),
			"createdBy": stringField(row, "createdBy"),
			"scope":     stringField(row, "scope"),
		}
	}
	updated, ok := s.store.Projects.Update(intField(project, "id"), corestore.Record{"protectionBypass": record})
	if !ok {
		project["protectionBypass"] = record
		return project
	}
	return updated
}

func copyStringPatch(body map[string]any, target corestore.Record, key string) {
	if value, ok := body[key].(string); ok {
		target[key] = value
	}
}

func copyTrimmedNamePatch(body map[string]any, patch corestore.Record) {
	if value, ok := body["name"].(string); ok {
		patch["name"] = strings.TrimSpace(value)
	}
}

func copyNullableStringPatch(body map[string]any, patch corestore.Record, existing corestore.Record, key string) {
	value, ok := body[key]
	if !ok {
		return
	}
	if value == nil {
		patch[key] = nil
		return
	}
	if str, ok := value.(string); ok {
		patch[key] = str
		return
	}
	patch[key] = existing[key]
}
