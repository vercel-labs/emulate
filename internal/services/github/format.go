package github

import (
	"net/url"
	"strconv"
	"strings"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) userURLs(login string) map[string]any {
	return map[string]any{
		"url":                 s.baseURL + "/users/" + login,
		"html_url":            s.baseURL + "/" + login,
		"repos_url":           s.baseURL + "/users/" + login + "/repos",
		"followers_url":       s.baseURL + "/users/" + login + "/followers",
		"following_url":       s.baseURL + "/users/" + login + "/following{/other_user}",
		"gists_url":           s.baseURL + "/users/" + login + "/gists{/gist_id}",
		"starred_url":         s.baseURL + "/users/" + login + "/starred{/owner}{/repo}",
		"subscriptions_url":   s.baseURL + "/users/" + login + "/subscriptions",
		"organizations_url":   s.baseURL + "/users/" + login + "/orgs",
		"events_url":          s.baseURL + "/users/" + login + "/events{/privacy}",
		"received_events_url": s.baseURL + "/users/" + login + "/received_events",
		"avatar_url":          s.baseURL + "/avatars/u/" + login,
	}
}

func (s *Service) formatUser(user corestore.Record) map[string]any {
	login := stringField(user, "login")
	out := map[string]any{
		"login":          login,
		"id":             intField(user, "id"),
		"node_id":        stringField(user, "node_id"),
		"gravatar_id":    stringField(user, "gravatar_id"),
		"type":           stringField(user, "type"),
		"site_admin":     boolField(user, "site_admin"),
		"user_view_type": "public",
	}
	for key, value := range s.userURLs(login) {
		out[key] = value
	}
	return out
}

func (s *Service) formatUserFull(user corestore.Record) map[string]any {
	out := s.formatUser(user)
	for _, key := range []string{"name", "company", "blog", "location", "email", "hireable", "bio", "twitter_username", "public_repos", "public_gists", "followers", "following", "created_at", "updated_at"} {
		out[key] = user[key]
	}
	return out
}

func (s *Service) formatOrgBrief(org corestore.Record) map[string]any {
	login := stringField(org, "login")
	return map[string]any{
		"login":              login,
		"id":                 intField(org, "id"),
		"node_id":            stringField(org, "node_id"),
		"url":                s.baseURL + "/orgs/" + login,
		"html_url":           s.baseURL + "/" + login,
		"repos_url":          s.baseURL + "/orgs/" + login + "/repos",
		"events_url":         s.baseURL + "/orgs/" + login + "/events",
		"hooks_url":          s.baseURL + "/orgs/" + login + "/hooks",
		"issues_url":         s.baseURL + "/orgs/" + login + "/issues",
		"members_url":        s.baseURL + "/orgs/" + login + "/members{/member}",
		"public_members_url": s.baseURL + "/orgs/" + login + "/public_members{/member}",
		"avatar_url":         s.baseURL + "/avatars/o/" + login,
		"description":        org["description"],
		"type":               "Organization",
		"site_admin":         false,
		"user_view_type":     "public",
	}
}

func (s *Service) formatOrgFull(org corestore.Record) map[string]any {
	out := s.formatOrgBrief(org)
	for _, key := range []string{"name", "company", "blog", "location", "email", "twitter_username", "is_verified", "has_organization_projects", "has_repository_projects", "public_repos", "public_gists", "followers", "following", "created_at", "updated_at", "members_can_create_repositories", "default_repository_permission", "billing_email"} {
		out[key] = org[key]
	}
	return out
}

func (s *Service) formatOwner(repo corestore.Record) any {
	ownerID := intField(repo, "owner_id")
	if stringField(repo, "owner_type") == "Organization" {
		if org, ok := s.store.Orgs.Get(ownerID); ok {
			return s.formatOrgBrief(org)
		}
		return nil
	}
	if user, ok := s.store.Users.Get(ownerID); ok {
		return s.formatUser(user)
	}
	return nil
}

func (s *Service) ownerLogin(repo corestore.Record) string {
	if stringField(repo, "owner_type") == "Organization" {
		if org, ok := s.store.Orgs.Get(intField(repo, "owner_id")); ok {
			return stringField(org, "login")
		}
		return "unknown"
	}
	if user, ok := s.store.Users.Get(intField(repo, "owner_id")); ok {
		return stringField(user, "login")
	}
	return "unknown"
}

func (s *Service) formatRepo(repo corestore.Record, viewerID int) map[string]any {
	fullName := stringField(repo, "full_name")
	repoURL := s.baseURL + "/repos/" + fullName
	htmlURL := s.baseURL + "/" + fullName
	hostless := strings.TrimPrefix(strings.TrimPrefix(s.baseURL, "https://"), "http://")
	out := map[string]any{
		"id":                     intField(repo, "id"),
		"node_id":                stringField(repo, "node_id"),
		"name":                   stringField(repo, "name"),
		"full_name":              fullName,
		"private":                boolField(repo, "private"),
		"owner":                  s.formatOwner(repo),
		"html_url":               htmlURL,
		"description":            repo["description"],
		"fork":                   boolField(repo, "fork"),
		"url":                    repoURL,
		"forks_url":              repoURL + "/forks",
		"keys_url":               repoURL + "/keys{/key_id}",
		"collaborators_url":      repoURL + "/collaborators{/collaborator}",
		"teams_url":              repoURL + "/teams",
		"hooks_url":              repoURL + "/hooks",
		"issue_events_url":       repoURL + "/issues/events{/number}",
		"events_url":             repoURL + "/events",
		"assignees_url":          repoURL + "/assignees{/user}",
		"branches_url":           repoURL + "/branches{/branch}",
		"tags_url":               repoURL + "/tags",
		"blobs_url":              repoURL + "/git/blobs{/sha}",
		"git_tags_url":           repoURL + "/git/tags{/sha}",
		"git_refs_url":           repoURL + "/git/ref{/sha}",
		"trees_url":              repoURL + "/git/trees{/sha}",
		"statuses_url":           repoURL + "/statuses/{sha}",
		"languages_url":          repoURL + "/languages",
		"stargazers_url":         repoURL + "/stargazers",
		"contributors_url":       repoURL + "/contributors",
		"subscribers_url":        repoURL + "/subscribers",
		"subscription_url":       repoURL + "/subscription",
		"commits_url":            repoURL + "/commits{/sha}",
		"git_commits_url":        repoURL + "/git/commits{/sha}",
		"comments_url":           repoURL + "/comments{/number}",
		"issue_comment_url":      repoURL + "/issues/comments{/number}",
		"contents_url":           repoURL + "/contents/{+path}",
		"compare_url":            repoURL + "/compare/{base}...{head}",
		"merges_url":             repoURL + "/merges",
		"archive_url":            repoURL + "/{archive_format}{/ref}",
		"downloads_url":          repoURL + "/downloads",
		"issues_url":             repoURL + "/issues{/number}",
		"pulls_url":              repoURL + "/pulls{/number}",
		"milestones_url":         repoURL + "/milestones{/number}",
		"notifications_url":      repoURL + "/notifications{?since,all,participating}",
		"labels_url":             repoURL + "/labels{/name}",
		"releases_url":           repoURL + "/releases{/id}",
		"deployments_url":        repoURL + "/deployments",
		"created_at":             repo["created_at"],
		"updated_at":             repo["updated_at"],
		"pushed_at":              repo["pushed_at"],
		"git_url":                "git://" + hostless + "/" + fullName + ".git",
		"ssh_url":                "git@" + hostless + ":" + fullName + ".git",
		"clone_url":              htmlURL + ".git",
		"svn_url":                htmlURL,
		"homepage":               repo["homepage"],
		"size":                   intField(repo, "size"),
		"stargazers_count":       intField(repo, "stargazers_count"),
		"watchers_count":         intField(repo, "watchers_count"),
		"language":               repo["language"],
		"has_issues":             boolField(repo, "has_issues"),
		"has_projects":           boolField(repo, "has_projects"),
		"has_downloads":          boolField(repo, "has_downloads"),
		"has_wiki":               boolField(repo, "has_wiki"),
		"has_pages":              boolField(repo, "has_pages"),
		"has_discussions":        boolField(repo, "has_discussions"),
		"forks_count":            intField(repo, "forks_count"),
		"mirror_url":             nil,
		"archived":               boolField(repo, "archived"),
		"disabled":               boolField(repo, "disabled"),
		"open_issues_count":      intField(repo, "open_issues_count"),
		"license":                repo["license"],
		"allow_forking":          boolField(repo, "allow_forking"),
		"is_template":            boolField(repo, "is_template"),
		"topics":                 stringSliceValue(repo["topics"]),
		"visibility":             stringField(repo, "visibility"),
		"forks":                  intField(repo, "forks_count"),
		"open_issues":            intField(repo, "open_issues_count"),
		"watchers":               intField(repo, "watchers_count"),
		"default_branch":         stringField(repo, "default_branch"),
		"allow_rebase_merge":     boolField(repo, "allow_rebase_merge"),
		"allow_squash_merge":     boolField(repo, "allow_squash_merge"),
		"allow_merge_commit":     boolField(repo, "allow_merge_commit"),
		"allow_auto_merge":       boolField(repo, "allow_auto_merge"),
		"delete_branch_on_merge": boolField(repo, "delete_branch_on_merge"),
	}
	out["permissions"] = s.repoPermissions(repo, viewerID)
	return out
}

func (s *Service) repoPermissions(repo corestore.Record, viewerID int) map[string]bool {
	if viewerID > 0 {
		if stringField(repo, "owner_type") == "User" && intField(repo, "owner_id") == viewerID {
			return map[string]bool{"admin": true, "maintain": true, "push": true, "triage": true, "pull": true}
		}
		for _, collab := range s.store.Collaborators.FindBy("repo_id", intField(repo, "id")) {
			if intField(collab, "user_id") != viewerID {
				continue
			}
			return permissionsFromLevel(stringField(collab, "permission"))
		}
		if !boolField(repo, "private") {
			return map[string]bool{"admin": false, "maintain": false, "push": false, "triage": false, "pull": true}
		}
	}
	return map[string]bool{"admin": true, "maintain": true, "push": true, "triage": true, "pull": true}
}

func permissionsFromLevel(level string) map[string]bool {
	order := map[string]int{"pull": 0, "triage": 1, "push": 2, "maintain": 3, "admin": 4}
	idx, ok := order[level]
	if !ok {
		idx = -1
	}
	return map[string]bool{
		"admin":    idx >= 4,
		"maintain": idx >= 3,
		"push":     idx >= 2,
		"triage":   idx >= 1,
		"pull":     idx >= 0,
	}
}

func (s *Service) formatIssue(issue corestore.Record) map[string]any {
	repo, ok := s.store.Repos.Get(intField(issue, "repo_id"))
	if !ok {
		return nil
	}
	user, _ := s.store.Users.Get(intField(issue, "user_id"))
	repoURL := s.baseURL + "/repos/" + stringField(repo, "full_name")
	number := intField(issue, "number")
	assignees := make([]any, 0)
	for _, id := range intSliceValue(issue["assignee_ids"]) {
		if assignee, ok := s.store.Users.Get(id); ok {
			assignees = append(assignees, s.formatUser(assignee))
		}
	}
	labels := make([]any, 0)
	for _, id := range intSliceValue(issue["label_ids"]) {
		if label, ok := s.store.Labels.Get(id); ok {
			labels = append(labels, s.formatLabel(label, repo))
		}
	}
	var closedBy any
	if id := nullableIntField(issue, "closed_by_id"); id != nil && *id > 0 {
		if u, ok := s.store.Users.Get(*id); ok {
			closedBy = s.formatUser(u)
		}
	}
	return map[string]any{
		"url":                      repoURL + "/issues/" + strconv.Itoa(number),
		"repository_url":           repoURL,
		"labels_url":               repoURL + "/issues/" + strconv.Itoa(number) + "/labels{/name}",
		"comments_url":             repoURL + "/issues/" + strconv.Itoa(number) + "/comments",
		"events_url":               repoURL + "/issues/" + strconv.Itoa(number) + "/events",
		"html_url":                 s.baseURL + "/" + stringField(repo, "full_name") + "/issues/" + strconv.Itoa(number),
		"id":                       intField(issue, "id"),
		"node_id":                  stringField(issue, "node_id"),
		"number":                   number,
		"title":                    stringField(issue, "title"),
		"user":                     s.formatNullableUser(user),
		"labels":                   labels,
		"state":                    stringField(issue, "state"),
		"state_reason":             issue["state_reason"],
		"locked":                   boolField(issue, "locked"),
		"active_lock_reason":       issue["active_lock_reason"],
		"assignee":                 firstAny(assignees),
		"assignees":                assignees,
		"milestone":                nil,
		"comments":                 intField(issue, "comments"),
		"created_at":               issue["created_at"],
		"updated_at":               issue["updated_at"],
		"closed_at":                issue["closed_at"],
		"closed_by":                closedBy,
		"body":                     issue["body"],
		"reactions":                defaultReactions(repoURL + "/issues/" + strconv.Itoa(number)),
		"timeline_url":             repoURL + "/issues/" + strconv.Itoa(number) + "/timeline",
		"performed_via_github_app": nil,
		"author_association":       s.authorAssociation(intField(issue, "user_id"), intField(issue, "repo_id")),
	}
}

func (s *Service) formatPull(pr corestore.Record) map[string]any {
	repo, ok := s.store.Repos.Get(intField(pr, "repo_id"))
	if !ok {
		return nil
	}
	user, _ := s.store.Users.Get(intField(pr, "user_id"))
	repoURL := s.baseURL + "/repos/" + stringField(repo, "full_name")
	number := intField(pr, "number")
	headRepo, _ := s.store.Repos.Get(intField(pr, "head_repo_id"))
	baseRepo, _ := s.store.Repos.Get(intField(pr, "base_repo_id"))
	var mergedBy any
	if mergedByID := nullableIntField(pr, "merged_by_id"); mergedByID != nil && *mergedByID > 0 {
		if user, ok := s.store.Users.Get(*mergedByID); ok {
			mergedBy = s.formatUser(user)
		}
	}
	return map[string]any{
		"url":                   repoURL + "/pulls/" + strconv.Itoa(number),
		"id":                    intField(pr, "id"),
		"node_id":               stringField(pr, "node_id"),
		"html_url":              s.baseURL + "/" + stringField(repo, "full_name") + "/pull/" + strconv.Itoa(number),
		"diff_url":              s.baseURL + "/" + stringField(repo, "full_name") + "/pull/" + strconv.Itoa(number) + ".diff",
		"patch_url":             s.baseURL + "/" + stringField(repo, "full_name") + "/pull/" + strconv.Itoa(number) + ".patch",
		"issue_url":             repoURL + "/issues/" + strconv.Itoa(number),
		"number":                number,
		"state":                 stringField(pr, "state"),
		"locked":                boolField(pr, "locked"),
		"title":                 stringField(pr, "title"),
		"user":                  s.formatNullableUser(user),
		"body":                  pr["body"],
		"created_at":            pr["created_at"],
		"updated_at":            pr["updated_at"],
		"closed_at":             pr["closed_at"],
		"merged_at":             pr["merged_at"],
		"merge_commit_sha":      pr["merge_commit_sha"],
		"assignee":              nil,
		"assignees":             []any{},
		"requested_reviewers":   []any{},
		"requested_teams":       []any{},
		"labels":                []any{},
		"milestone":             nil,
		"draft":                 boolField(pr, "draft"),
		"commits_url":           repoURL + "/pulls/" + strconv.Itoa(number) + "/commits",
		"review_comments_url":   repoURL + "/pulls/" + strconv.Itoa(number) + "/comments",
		"review_comment_url":    repoURL + "/pulls/comments{/number}",
		"comments_url":          repoURL + "/issues/" + strconv.Itoa(number) + "/comments",
		"statuses_url":          repoURL + "/statuses/" + stringField(pr, "head_sha"),
		"head":                  s.formatPullSide(headRepo, stringField(pr, "head_ref"), stringField(pr, "head_sha")),
		"base":                  s.formatPullSide(baseRepo, stringField(pr, "base_ref"), stringField(pr, "base_sha")),
		"_links":                s.formatPullLinks(repoURL, number, stringField(pr, "head_sha")),
		"author_association":    s.authorAssociation(intField(pr, "user_id"), intField(pr, "repo_id")),
		"auto_merge":            pr["auto_merge"],
		"merged":                boolField(pr, "merged"),
		"mergeable":             pr["mergeable"],
		"rebaseable":            true,
		"mergeable_state":       stringField(pr, "mergeable_state"),
		"merged_by":             mergedBy,
		"comments":              intField(pr, "comments"),
		"review_comments":       intField(pr, "review_comments"),
		"maintainer_can_modify": true,
		"commits":               intField(pr, "commits"),
		"additions":             intField(pr, "additions"),
		"deletions":             intField(pr, "deletions"),
		"changed_files":         intField(pr, "changed_files"),
	}
}

func (s *Service) formatPullSide(repo corestore.Record, ref string, sha string) map[string]any {
	if repo == nil {
		return map[string]any{"label": "unknown:" + ref, "ref": ref, "sha": sha, "user": nil, "repo": nil}
	}
	owner := s.ownerLogin(repo)
	return map[string]any{
		"label": owner + ":" + ref,
		"ref":   ref,
		"sha":   sha,
		"user":  s.formatOwner(repo),
		"repo":  s.formatRepo(repo, 0),
	}
}

func (s *Service) formatPullLinks(repoURL string, number int, headSha string) map[string]any {
	n := strconv.Itoa(number)
	return map[string]any{
		"self":            map[string]any{"href": repoURL + "/pulls/" + n},
		"html":            map[string]any{"href": strings.Replace(repoURL, "/repos/", "/", 1) + "/pull/" + n},
		"issue":           map[string]any{"href": repoURL + "/issues/" + n},
		"comments":        map[string]any{"href": repoURL + "/issues/" + n + "/comments"},
		"review_comments": map[string]any{"href": repoURL + "/pulls/" + n + "/comments"},
		"review_comment":  map[string]any{"href": repoURL + "/pulls/comments{/number}"},
		"commits":         map[string]any{"href": repoURL + "/pulls/" + n + "/commits"},
		"statuses":        map[string]any{"href": repoURL + "/statuses/" + headSha},
	}
}

func (s *Service) formatComment(comment corestore.Record) map[string]any {
	repo, ok := s.store.Repos.Get(intField(comment, "repo_id"))
	if !ok {
		return nil
	}
	user, _ := s.store.Users.Get(intField(comment, "user_id"))
	repoURL := s.baseURL + "/repos/" + stringField(repo, "full_name")
	return map[string]any{
		"url":                      repoURL + "/issues/comments/" + strconv.Itoa(intField(comment, "id")),
		"html_url":                 s.baseURL + "/" + stringField(repo, "full_name") + "/issues/" + strconv.Itoa(intField(comment, "issue_number")) + "#issuecomment-" + strconv.Itoa(intField(comment, "id")),
		"issue_url":                repoURL + "/issues/" + strconv.Itoa(intField(comment, "issue_number")),
		"id":                       intField(comment, "id"),
		"node_id":                  stringField(comment, "node_id"),
		"user":                     s.formatNullableUser(user),
		"created_at":               comment["created_at"],
		"updated_at":               comment["updated_at"],
		"author_association":       s.authorAssociation(intField(comment, "user_id"), intField(comment, "repo_id")),
		"body":                     stringField(comment, "body"),
		"reactions":                defaultReactions(repoURL + "/issues/comments/" + strconv.Itoa(intField(comment, "id"))),
		"performed_via_github_app": nil,
	}
}

func (s *Service) formatBranch(branch corestore.Record, repo corestore.Record) map[string]any {
	sha := stringField(branch, "sha")
	repoURL := s.baseURL + "/repos/" + stringField(repo, "full_name")
	return map[string]any{
		"name": stringField(branch, "name"),
		"commit": map[string]any{
			"sha": sha,
			"url": repoURL + "/commits/" + sha,
		},
		"protected":      boolField(branch, "protected"),
		"protection_url": repoURL + "/branches/" + url.PathEscape(stringField(branch, "name")) + "/protection",
	}
}

func (s *Service) formatRef(repo corestore.Record, ref corestore.Record) map[string]any {
	fullRef := stringField(ref, "ref")
	shortRef := strings.TrimPrefix(fullRef, "refs/")
	sha := stringField(ref, "sha")
	repoURL := s.baseURL + "/repos/" + stringField(repo, "full_name")
	return map[string]any{
		"ref":     fullRef,
		"node_id": stringField(ref, "node_id"),
		"url":     repoURL + "/git/ref/" + shortRef,
		"object": map[string]any{
			"type": "commit",
			"sha":  sha,
			"url":  repoURL + "/git/commits/" + sha,
		},
	}
}

func (s *Service) formatCommit(repo corestore.Record, commit corestore.Record) map[string]any {
	repoURL := s.baseURL + "/repos/" + stringField(repo, "full_name")
	parents := make([]any, 0)
	for _, sha := range stringSliceValue(commit["parent_shas"]) {
		parents = append(parents, map[string]any{
			"sha":      sha,
			"url":      repoURL + "/git/commits/" + sha,
			"html_url": s.baseURL + "/" + stringField(repo, "full_name") + "/commit/" + sha,
		})
	}
	return map[string]any{
		"sha":      stringField(commit, "sha"),
		"node_id":  stringField(commit, "node_id"),
		"url":      repoURL + "/git/commits/" + stringField(commit, "sha"),
		"html_url": s.baseURL + "/" + stringField(repo, "full_name") + "/commit/" + stringField(commit, "sha"),
		"commit": map[string]any{
			"url": repoURL + "/git/commits/" + stringField(commit, "sha"),
			"author": map[string]any{
				"name":  stringField(commit, "author_name"),
				"email": stringField(commit, "author_email"),
				"date":  stringField(commit, "author_date"),
			},
			"committer": map[string]any{
				"name":  stringField(commit, "committer_name"),
				"email": stringField(commit, "committer_email"),
				"date":  stringField(commit, "committer_date"),
			},
			"message":       stringField(commit, "message"),
			"tree":          map[string]any{"sha": stringField(commit, "tree_sha"), "url": repoURL + "/git/trees/" + stringField(commit, "tree_sha")},
			"comment_count": 0,
			"verification":  map[string]any{"verified": false, "reason": "unsigned", "signature": nil, "payload": nil, "verified_at": nil},
		},
		"author":    nil,
		"committer": nil,
		"parents":   parents,
	}
}

func (s *Service) formatLabel(label corestore.Record, repo corestore.Record) map[string]any {
	return map[string]any{
		"id":          intField(label, "id"),
		"node_id":     stringField(label, "node_id"),
		"url":         s.baseURL + "/repos/" + stringField(repo, "full_name") + "/labels/" + url.QueryEscape(stringField(label, "name")),
		"name":        stringField(label, "name"),
		"description": label["description"],
		"color":       stringField(label, "color"),
		"default":     boolField(label, "default"),
	}
}

func (s *Service) formatNullableUser(user corestore.Record) any {
	if user == nil {
		return nil
	}
	return s.formatUser(user)
}

func (s *Service) authorAssociation(userID int, repoID int) string {
	repo, ok := s.store.Repos.Get(repoID)
	if !ok {
		return "NONE"
	}
	if stringField(repo, "owner_type") == "User" && intField(repo, "owner_id") == userID {
		return "OWNER"
	}
	if stringField(repo, "owner_type") == "Organization" && s.isOrgMember(userID, intField(repo, "owner_id")) {
		return "MEMBER"
	}
	for _, collab := range s.store.Collaborators.FindBy("repo_id", repoID) {
		if intField(collab, "user_id") == userID {
			return "COLLABORATOR"
		}
	}
	return "NONE"
}

func defaultReactions(target string) map[string]any {
	return map[string]any{
		"url":         target + "/reactions",
		"total_count": 0,
		"+1":          0,
		"-1":          0,
		"laugh":       0,
		"hooray":      0,
		"confused":    0,
		"heart":       0,
		"rocket":      0,
		"eyes":        0,
	}
}

func firstAny(values []any) any {
	if len(values) == 0 {
		return nil
	}
	return values[0]
}
