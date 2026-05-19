package vercel

import (
	"fmt"
	"net/http"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerEnvRoutes(router *corehttp.Router) {
	router.Get("/v10/projects/:idOrName/env", func(c *corehttp.Context) {
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
		list := s.store.EnvVars.FindBy("projectId", stringField(project, "uid"))
		list = filterEnvVarsByQuery(list, c)
		items, page := applyPagination(list, parsePagination(c))
		decrypt := parseQueryBool(c.Query("decrypt"))
		out := make([]map[string]any, 0, len(items))
		for _, env := range items {
			out = append(out, formatEnvVar(env, decrypt))
		}
		c.JSON(http.StatusOK, map[string]any{"envs": out, "pagination": page})
	})

	router.Post("/v10/projects/:idOrName/env", func(c *corehttp.Context) {
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
		raw, err := parseAnyJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		rows, ok := envBodyRows(raw)
		if !ok {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		upsert := parseQueryBool(c.Query("upsert"))
		created := make([]corestore.Record, 0, len(rows))
		pending := make([]corestore.Record, 0)
		for _, body := range rows {
			row, message := parseEnvRow(body)
			if message != "" {
				writeVercelError(c, http.StatusBadRequest, "bad_request", message)
				return
			}
			existingDB := s.findEnvByKeyAndTargetsOverlap(stringField(project, "uid"), stringField(row, "key"), stringSliceValue(row["target"]), 0)
			existingPending := findPendingEnvByKeyAndTargets(pending, stringField(row, "key"), stringSliceValue(row["target"]))
			if upsert {
				toUpdate := existingDB
				if toUpdate == nil {
					toUpdate = existingPending
				}
				if toUpdate != nil {
					updated, ok := s.store.EnvVars.Update(intField(toUpdate, "id"), corestore.Record{
						"key":                  row["key"],
						"value":                row["value"],
						"type":                 row["type"],
						"target":               row["target"],
						"gitBranch":            row["gitBranch"],
						"customEnvironmentIds": row["customEnvironmentIds"],
						"comment":              row["comment"],
					})
					if !ok {
						writeVercelError(c, http.StatusInternalServerError, "internal_error", "Failed to update environment variable")
						return
					}
					pending = upsertPendingEnv(pending, updated)
					created = append(created, updated)
					continue
				}
			} else if existingDB != nil || existingPending != nil {
				writeVercelError(c, http.StatusConflict, "env_already_exists", fmt.Sprintf("An environment variable with key %q and overlapping targets already exists", stringField(row, "key")))
				return
			}
			inserted := s.store.EnvVars.Insert(corestore.Record{
				"uid":                  generateUID("env"),
				"projectId":            stringField(project, "uid"),
				"key":                  row["key"],
				"value":                row["value"],
				"type":                 row["type"],
				"target":               row["target"],
				"gitBranch":            row["gitBranch"],
				"customEnvironmentIds": row["customEnvironmentIds"],
				"comment":              row["comment"],
				"decrypted":            false,
			})
			pending = append(pending, inserted)
			created = append(created, inserted)
		}
		out := make([]map[string]any, 0, len(created))
		for _, env := range created {
			out = append(out, formatEnvVar(env, true))
		}
		c.JSON(http.StatusOK, map[string]any{"envs": out})
	})

	router.Get("/v10/projects/:idOrName/env/:id", func(c *corehttp.Context) {
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
		env := s.findEnvByUIDInProject(stringField(project, "uid"), c.Param("id"))
		if env == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Environment variable not found")
			return
		}
		c.JSON(http.StatusOK, formatEnvVar(env, parseQueryBool(c.Query("decrypt"))))
	})

	router.Patch("/v9/projects/:idOrName/env/:id", func(c *corehttp.Context) {
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
		existing := s.findEnvByUIDInProject(stringField(project, "uid"), c.Param("id"))
		if existing == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Environment variable not found")
			return
		}
		body, err := parseJSONBody(c.Request)
		if err != nil {
			writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid JSON body")
			return
		}
		patch := corestore.Record{}
		if value, exists := body["key"]; exists {
			key, ok := value.(string)
			if !ok || key == "" {
				writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid value: key must be a non-empty string")
				return
			}
			patch["key"] = key
		}
		if value, exists := body["value"]; exists {
			str, ok := value.(string)
			if !ok {
				writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid value: value must be a string")
				return
			}
			patch["value"] = str
		}
		if value, exists := body["type"]; exists {
			envType := stringValue(value)
			if !validEnvType(envType) {
				writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid value: type must be one of system, encrypted, plain, secret, sensitive")
				return
			}
			patch["type"] = envType
		}
		if value, exists := body["target"]; exists {
			target, ok := parseEnvTargets(value)
			if !ok {
				writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid value: target must be a non-empty array of production, preview, development")
				return
			}
			patch["target"] = target
		}
		if value, exists := body["gitBranch"]; exists {
			if value == nil {
				patch["gitBranch"] = nil
			} else if str, ok := value.(string); ok {
				patch["gitBranch"] = str
			} else {
				writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid value: gitBranch must be a string or null")
				return
			}
		}
		if value, exists := body["customEnvironmentIds"]; exists {
			ids, ok := parseCustomEnvironmentIDs(value)
			if !ok {
				writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid value: customEnvironmentIds must be an array of strings")
				return
			}
			patch["customEnvironmentIds"] = ids
		}
		if value, exists := body["comment"]; exists {
			if value == nil {
				patch["comment"] = nil
			} else if str, ok := value.(string); ok {
				patch["comment"] = str
			} else {
				writeVercelError(c, http.StatusBadRequest, "bad_request", "Invalid value: comment must be a string or null")
				return
			}
		}
		nextKey := stringField(existing, "key")
		if patch["key"] != nil {
			nextKey = stringValue(patch["key"])
		}
		nextTarget := stringSliceValue(existing["target"])
		if patch["target"] != nil {
			nextTarget = stringSliceValue(patch["target"])
		}
		if conflict := s.findEnvByKeyAndTargetsOverlap(stringField(project, "uid"), nextKey, nextTarget, intField(existing, "id")); conflict != nil {
			writeVercelError(c, http.StatusConflict, "env_already_exists", fmt.Sprintf("An environment variable with key %q and overlapping targets already exists", nextKey))
			return
		}
		updated, ok := s.store.EnvVars.Update(intField(existing, "id"), patch)
		if !ok {
			writeVercelError(c, http.StatusInternalServerError, "internal_error", "Failed to update environment variable")
			return
		}
		c.JSON(http.StatusOK, formatEnvVar(updated, true))
	})

	router.Delete("/v9/projects/:idOrName/env/:id", func(c *corehttp.Context) {
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
		existing := s.findEnvByUIDInProject(stringField(project, "uid"), c.Param("id"))
		if existing == nil {
			writeVercelError(c, http.StatusNotFound, "not_found", "Environment variable not found")
			return
		}
		snapshot := formatEnvVar(existing, true)
		s.store.EnvVars.Delete(intField(existing, "id"))
		c.JSON(http.StatusOK, snapshot)
	})
}

func envBodyRows(raw any) ([]map[string]any, bool) {
	if raw == nil {
		return nil, false
	}
	if row, ok := raw.(map[string]any); ok {
		return []map[string]any{row}, true
	}
	if list, ok := raw.([]any); ok {
		out := make([]map[string]any, 0, len(list))
		for _, item := range list {
			row, ok := item.(map[string]any)
			if !ok {
				return nil, false
			}
			out = append(out, row)
		}
		return out, true
	}
	return nil, false
}

func parseEnvRow(body map[string]any) (corestore.Record, string) {
	key, ok := body["key"].(string)
	if !ok || key == "" {
		return nil, "Missing required field: key"
	}
	value, ok := body["value"].(string)
	if !ok {
		if _, exists := body["value"]; !exists {
			return nil, "Missing required field: value"
		}
		return nil, "Invalid value: value must be a string"
	}
	envType := stringValue(body["type"])
	if !validEnvType(envType) {
		return nil, "Invalid value: type must be one of system, encrypted, plain, secret, sensitive"
	}
	target, ok := parseEnvTargets(body["target"])
	if !ok {
		return nil, "Invalid value: target must be a non-empty array of production, preview, development"
	}
	customEnvironmentIDs := []string{}
	if raw, exists := body["customEnvironmentIds"]; exists && raw != nil {
		ids, ok := parseCustomEnvironmentIDs(raw)
		if !ok {
			return nil, "Invalid value: customEnvironmentIds must be an array of strings"
		}
		customEnvironmentIDs = ids
	}
	var gitBranch any
	if raw, exists := body["gitBranch"]; exists {
		if raw == nil {
			gitBranch = nil
		} else if str, ok := raw.(string); ok {
			gitBranch = str
		} else {
			return nil, "Invalid value: gitBranch must be a string or null"
		}
	}
	var comment any
	if raw, exists := body["comment"]; exists {
		if raw == nil {
			comment = nil
		} else if str, ok := raw.(string); ok {
			comment = str
		} else {
			return nil, "Invalid value: comment must be a string or null"
		}
	}
	return corestore.Record{
		"key":                  key,
		"value":                value,
		"type":                 envType,
		"target":               target,
		"gitBranch":            gitBranch,
		"customEnvironmentIds": customEnvironmentIDs,
		"comment":              comment,
		"decrypted":            false,
	}, ""
}

func parseEnvTargets(raw any) ([]string, bool) {
	targets, ok := parseStringSliceStrict(raw)
	if !ok || len(targets) == 0 {
		return nil, false
	}
	for _, target := range targets {
		if !validTarget(target) {
			return nil, false
		}
	}
	return targets, true
}

func parseCustomEnvironmentIDs(raw any) ([]string, bool) {
	if raw == nil {
		return []string{}, true
	}
	return parseStringSliceStrict(raw)
}

func (s *Service) findEnvByUIDInProject(projectID string, uid string) corestore.Record {
	for _, env := range s.store.EnvVars.FindBy("projectId", projectID) {
		if stringField(env, "uid") == uid {
			return env
		}
	}
	return nil
}

func (s *Service) findEnvByKeyAndTargetsOverlap(projectID string, key string, targets []string, excludeID int) corestore.Record {
	for _, env := range s.store.EnvVars.FindBy("projectId", projectID) {
		if stringField(env, "key") != key {
			continue
		}
		if excludeID != 0 && intField(env, "id") == excludeID {
			continue
		}
		if targetsOverlap(stringSliceValue(env["target"]), targets) {
			return env
		}
	}
	return nil
}

func findPendingEnvByKeyAndTargets(pending []corestore.Record, key string, targets []string) corestore.Record {
	for _, env := range pending {
		if stringField(env, "key") == key && targetsOverlap(stringSliceValue(env["target"]), targets) {
			return env
		}
	}
	return nil
}

func upsertPendingEnv(pending []corestore.Record, env corestore.Record) []corestore.Record {
	for index, item := range pending {
		if intField(item, "id") == intField(env, "id") {
			pending[index] = env
			return pending
		}
	}
	return append(pending, env)
}

func filterEnvVarsByQuery(input []corestore.Record, c *corehttp.Context) []corestore.Record {
	out := input
	if gitBranch := c.Query("gitBranch"); gitBranch != "" {
		next := out[:0]
		for _, env := range out {
			if stringField(env, "gitBranch") == gitBranch {
				next = append(next, env)
			}
		}
		out = next
	}
	for _, queryName := range []string{"customEnvironmentId", "customEnvironmentSlug"} {
		value := c.Query(queryName)
		if value == "" {
			continue
		}
		next := out[:0]
		for _, env := range out {
			ids := stringSliceValue(env["customEnvironmentIds"])
			for _, id := range ids {
				if id == value {
					next = append(next, env)
					break
				}
			}
		}
		out = next
	}
	return out
}
