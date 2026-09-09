import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOMER_GROUP_ID,
  DEFAULT_FAQ_CATEGORY_ID,
  DEFAULT_GETTING_STARTED_CATEGORY_ID,
  DEFAULT_MAIN_VERSION_ID,
  DEFAULT_MSP_GROUP_ID,
  DEFAULT_OWNER_EMAIL,
  DEFAULT_OWNER_ID,
  DEFAULT_READER_EMAIL,
  DEFAULT_READER_ID,
  DEFAULT_SETUP_ARTICLE_ID,
  DEFAULT_WELCOME_ARTICLE_ID,
  DEFAULT_DOCUMENTS_FOLDER_ID,
  getD360Store,
  markdownToHtml,
} from "../index.js";
import { api, createD360TestApp, d360TestBaseUrl, type D360TestApp } from "./helpers.js";

const CYBERHUB_CUSTOMER_GROUP = "351f884c-b6ac-44d9-bac6-b49d03ba196a";

describe("Document360 plugin", () => {
  let ctx: D360TestApp;

  beforeEach(() => {
    ctx = createD360TestApp();
  });

  describe("authentication", () => {
    it("rejects requests without a valid api_token", async () => {
      const missing = await api(ctx.app, "GET", "/v2/Readers", undefined, null);
      expect(missing.status).toBe(401);
      expect(missing.body.success).toBe(false);
      expect(missing.body.errors[0].error_code).toBe("unauthorized");
      const wrong = await api(ctx.app, "GET", "/v2/Readers", undefined, "nope");
      expect(wrong.status).toBe(401);
    });

    it("accepts the api_token header, alternate header names, and bearer tokens", async () => {
      expect((await api(ctx.app, "GET", "/v2/Project")).status).toBe(200);
      const alt = await api(ctx.app, "GET", "/v2/Project", undefined, null, {
        "x-api-token": "test_emulate_document360_token",
      });
      expect(alt.status).toBe(200);
      const bearer = await api(ctx.app, "GET", "/v2/Project", undefined, null, {
        Authorization: "Bearer test_emulate_document360_token",
      });
      expect(bearer.status).toBe(200);
    });

    it("accepts seeded custom tokens", async () => {
      const seeded = createD360TestApp({ api_tokens: [{ token: "other-token" }] });
      expect((await api(seeded.app, "GET", "/v2/Project", undefined, "other-token")).status).toBe(200);
    });

    it("serves the same routes under /v1", async () => {
      const response = await api(ctx.app, "GET", "/v1/Readers");
      expect(response.status).toBe(200);
      expect(response.body.result).toHaveLength(1);
    });
  });

  describe("readers (CyberHub flow)", () => {
    it("looks up readers by email with the trailing-slash form CyberHub uses", async () => {
      const found = await api(ctx.app, "GET", `/v2/Readers/?search_email=${encodeURIComponent(DEFAULT_READER_EMAIL)}`);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({
        success: true,
        errors: [],
        warnings: [],
        information: [],
        extension_data: null,
      });
      expect(found.body.result).toHaveLength(1);
      expect(found.body.result[0]).toMatchObject({
        reader_id: DEFAULT_READER_ID,
        email: DEFAULT_READER_EMAIL,
        first_name: "Test",
        last_name: "Reader",
        access_scope: { access_level: 0, categories: null, project_versions: null, languages: null },
      });
      expect(found.body.result[0].associated_reader_groups).toEqual([
        { id: DEFAULT_CUSTOMER_GROUP_ID, title: "Customers" },
      ]);
      const partial = await api(ctx.app, "GET", "/v2/Readers?search_email=EXAMPLE.com");
      expect(partial.body.result).toHaveLength(1);
      const none = await api(ctx.app, "GET", "/v2/Readers/?search_email=nobody%40example.com");
      expect(none.body.result).toEqual([]);
    });

    it("creates, updates and deletes a reader in a seeded group", async () => {
      const seeded = createD360TestApp({
        reader_groups: [{ id: CYBERHUB_CUSTOMER_GROUP, title: "CyberHub customers" }],
      });
      const created = await api(seeded.app, "POST", "/v2/Readers", {
        access_scope: { access_level: 0 },
        first_name: "Ada",
        last_name: "Lovelace",
        email_id: "Ada@Example.com",
        is_sso_user: false,
        skip_sso_invitation_email: false,
        invited_by: DEFAULT_OWNER_EMAIL,
        associated_reader_groups: [CYBERHUB_CUSTOMER_GROUP],
      });
      expect(created.status).toBe(200);
      expect(created.body.success).toBe(true);
      const reader = created.body.result;
      expect(reader.email).toBe("ada@example.com");
      expect(reader.invited_by).toBe(DEFAULT_OWNER_EMAIL);
      expect(reader.associated_reader_groups).toEqual([{ id: CYBERHUB_CUSTOMER_GROUP, title: "CyberHub customers" }]);

      const group = await api(seeded.app, "GET", `/v2/Readers/groups/${CYBERHUB_CUSTOMER_GROUP}`);
      expect(group.body.result.readers_count).toBe(1);
      expect(group.body.result.associated_readers[0].reader_id).toBe(reader.reader_id);

      const updated = await api(seeded.app, "PUT", `/v2/Readers/${reader.reader_id}`, {
        first_name: "Augusta",
        last_name: "King",
      });
      expect(updated.status).toBe(200);
      expect(updated.body.result).toMatchObject({ first_name: "Augusta", last_name: "King", email: "ada@example.com" });

      const fetched = await api(seeded.app, "GET", `/v2/Readers/${reader.reader_id}`);
      expect(fetched.body.result.first_name).toBe("Augusta");

      const deleted = await api(seeded.app, "DELETE", `/v2/Readers/${reader.reader_id}`);
      expect(deleted.status).toBe(200);
      expect((await api(seeded.app, "GET", `/v2/Readers/${reader.reader_id}`)).status).toBe(404);
      expect(
        (await api(seeded.app, "GET", `/v2/Readers/groups/${CYBERHUB_CUSTOMER_GROUP}`)).body.result.readers_count,
      ).toBe(0);
    });

    it("validates reader creation", async () => {
      const missingEmail = await api(ctx.app, "POST", "/v2/Readers", { first_name: "No", last_name: "Email" });
      expect(missingEmail.status).toBe(400);
      expect(missingEmail.body.success).toBe(false);
      expect(missingEmail.body.errors.length).toBeGreaterThan(0);
      const badEmail = await api(ctx.app, "POST", "/v2/Readers", { email_id: "not-an-email" });
      expect(badEmail.status).toBe(400);
      const duplicate = await api(ctx.app, "POST", "/v2/Readers", { email_id: DEFAULT_READER_EMAIL.toUpperCase() });
      expect(duplicate.status).toBe(400);
      expect(duplicate.body.errors[0].error_code).toBe("duplicate_reader");
      const unknownGroup = await api(ctx.app, "POST", "/v2/Readers", {
        email_id: "new@example.com",
        associated_reader_groups: ["missing"],
      });
      expect(unknownGroup.status).toBe(404);
      expect((await api(ctx.app, "PUT", "/v2/Readers/missing", { first_name: "x" })).status).toBe(404);
    });

    it("moves readers between groups on update", async () => {
      const updated = await api(ctx.app, "PUT", `/v2/Readers/${DEFAULT_READER_ID}`, {
        associated_reader_groups: [DEFAULT_MSP_GROUP_ID],
      });
      expect(updated.body.result.associated_reader_groups).toEqual([{ id: DEFAULT_MSP_GROUP_ID, title: "MSP" }]);
      const customers = await api(ctx.app, "GET", `/v2/Readers/groups/${DEFAULT_CUSTOMER_GROUP_ID}`);
      expect(customers.body.result.readers_count).toBe(0);
    });

    it("manages reader groups", async () => {
      const list = await api(ctx.app, "GET", "/v2/Readers/groups");
      expect(list.body.result.map((group: any) => group.title)).toEqual(["Customers", "MSP", "Distributors"]);
      const created = await api(ctx.app, "POST", "/v2/Readers/groups", {
        title: "Partners",
        description: "Partner readers",
        access_scope: { access_level: 1, categories: [DEFAULT_FAQ_CATEGORY_ID] },
      });
      expect(created.status).toBe(200);
      expect(created.body.result.access_scope).toEqual({
        access_level: 1,
        categories: [DEFAULT_FAQ_CATEGORY_ID],
        project_versions: null,
        languages: null,
      });
      const duplicate = await api(ctx.app, "POST", "/v2/Readers/groups", { title: "partners" });
      expect(duplicate.status).toBe(400);
      const updated = await api(ctx.app, "PUT", `/v2/Readers/groups/${created.body.result.id}`, {
        title: "Resellers",
        associated_readers: [DEFAULT_READER_ID],
      });
      expect(updated.body.result.title).toBe("Resellers");
      expect(updated.body.result.readers_count).toBe(1);
      expect((await api(ctx.app, "DELETE", `/v2/Readers/groups/${created.body.result.id}`)).status).toBe(200);
      expect((await api(ctx.app, "GET", `/v2/Readers/groups/${created.body.result.id}`)).status).toBe(404);
    });
  });

  describe("project versions and languages", () => {
    it("lists the seeded main version with its languages", async () => {
      const response = await api(ctx.app, "GET", "/v2/ProjectVersions");
      expect(response.body.result).toHaveLength(1);
      const version = response.body.result[0];
      expect(version).toMatchObject({
        id: DEFAULT_MAIN_VERSION_ID,
        version_number: 1,
        is_main_version: true,
        slug: "v1",
      });
      expect(version.language_versions.map((language: any) => [language.language_code, language.is_default])).toEqual([
        ["en", true],
        ["fr", false],
      ]);
      const byNumber = await api(ctx.app, "GET", "/v2/ProjectVersions/1");
      expect(byNumber.body.result.id).toBe(DEFAULT_MAIN_VERSION_ID);
    });

    it("creates a version cloned from the main version", async () => {
      const created = await api(ctx.app, "POST", "/v2/ProjectVersions", {
        version_number: 2,
        version_code_name: "v2",
        base_version_id: DEFAULT_MAIN_VERSION_ID,
      });
      expect(created.status).toBe(200);
      expect(created.body.result).toMatchObject({ version_number: 2, base_version_number: 1, is_main_version: false });
      const categories = await api(ctx.app, "GET", `/v2/ProjectVersions/${created.body.result.id}/categories`);
      expect(categories.body.result.map((category: any) => category.name)).toEqual(["Getting Started", "FAQ"]);
      expect(categories.body.result[0].articles).toHaveLength(2);
      expect(categories.body.result[0].id).not.toBe(DEFAULT_GETTING_STARTED_CATEGORY_ID);
      const duplicate = await api(ctx.app, "POST", "/v2/ProjectVersions", { version_number: 2 });
      expect(duplicate.status).toBe(400);
      expect((await api(ctx.app, "DELETE", `/v2/ProjectVersions/${DEFAULT_MAIN_VERSION_ID}`)).status).toBe(400);
      expect((await api(ctx.app, "DELETE", `/v2/ProjectVersions/${created.body.result.id}`)).status).toBe(200);
      expect((await api(ctx.app, "GET", "/v2/ProjectVersions")).body.result).toHaveLength(1);
    });

    it("adds, updates and removes languages", async () => {
      const list = await api(ctx.app, "GET", `/v2/Language/${DEFAULT_MAIN_VERSION_ID}`);
      expect(list.body.result).toHaveLength(2);
      const added = await api(ctx.app, "POST", `/v2/Language/${DEFAULT_MAIN_VERSION_ID}`, { language_code: "de" });
      expect(added.body.result).toMatchObject({ language_code: "de", language_name: "German", is_default: false });
      expect(
        (await api(ctx.app, "POST", `/v2/Language/${DEFAULT_MAIN_VERSION_ID}`, { language_code: "DE" })).status,
      ).toBe(400);
      const promoted = await api(ctx.app, "PUT", `/v2/Language/${DEFAULT_MAIN_VERSION_ID}/de`, {
        set_as_default: true,
      });
      expect(promoted.body.result.is_default).toBe(true);
      expect((await api(ctx.app, "DELETE", `/v2/Language/${DEFAULT_MAIN_VERSION_ID}/de`)).status).toBe(400);
      expect((await api(ctx.app, "DELETE", `/v2/Language/${DEFAULT_MAIN_VERSION_ID}/fr`)).status).toBe(200);
      expect((await api(ctx.app, "GET", `/v2/Language/${DEFAULT_MAIN_VERSION_ID}`)).body.result).toHaveLength(2);
    });
  });

  describe("categories", () => {
    it("returns the seeded tree with article summaries", async () => {
      const tree = await api(ctx.app, "GET", `/v2/ProjectVersions/${DEFAULT_MAIN_VERSION_ID}/categories?langCode=en`);
      expect(tree.status).toBe(200);
      const gettingStarted = tree.body.result[0];
      expect(gettingStarted).toMatchObject({
        id: DEFAULT_GETTING_STARTED_CATEGORY_ID,
        name: "Getting Started",
        slug: "getting-started",
        child_categories: [],
      });
      expect(gettingStarted.articles.map((article: any) => [article.title, article.status])).toEqual([
        ["Welcome", 3],
        ["Setup guide", 0],
      ]);
      const withoutArticles = await api(
        ctx.app,
        "GET",
        `/v2/ProjectVersions/${DEFAULT_MAIN_VERSION_ID}/categories?excludeArticles=true`,
      );
      expect(withoutArticles.body.result[0].articles).toBeUndefined();
    });

    it("creates nested categories and deletes the subtree", async () => {
      const parent = await api(ctx.app, "POST", "/v2/Categories", {
        name: "Guides",
        project_version_id: DEFAULT_MAIN_VERSION_ID,
      });
      expect(parent.status).toBe(200);
      const child = await api(ctx.app, "POST", "/v2/Categories", {
        name: "Advanced",
        parent_category_id: parent.body.result.id,
      });
      expect(child.body.result.parent_category_id).toBe(parent.body.result.id);
      const article = await api(ctx.app, "POST", "/v2/Articles", {
        title: "Deep dive",
        content: "Body",
        category_id: child.body.result.id,
      });
      expect(article.status).toBe(200);
      const fetched = await api(ctx.app, "GET", `/v2/Categories/${parent.body.result.id}/en`);
      expect(fetched.body.result.child_categories[0].articles).toHaveLength(1);
      expect((await api(ctx.app, "DELETE", `/v2/Categories/${parent.body.result.id}/en`)).status).toBe(200);
      expect((await api(ctx.app, "GET", `/v2/Categories/${child.body.result.id}/en`)).status).toBe(404);
      expect((await api(ctx.app, "GET", `/v2/Articles/${article.body.result.id}/en`)).status).toBe(404);
      expect((await api(ctx.app, "POST", "/v2/Categories", { name: "" })).status).toBe(400);
      expect(
        (await api(ctx.app, "POST", "/v2/Categories", { name: "Orphan", parent_category_id: "missing" })).status,
      ).toBe(400);
    });

    it("falls back to the default language and creates translations on update", async () => {
      const fallback = await api(ctx.app, "GET", `/v2/Categories/${DEFAULT_FAQ_CATEGORY_ID}/fr`);
      expect(fallback.status).toBe(200);
      expect(fallback.body.result).toMatchObject({ name: "FAQ", language_code: "en", is_fall_back_content: true });
      const translated = await api(ctx.app, "PUT", `/v2/Categories/${DEFAULT_FAQ_CATEGORY_ID}/fr`, {
        name: "Questions fréquentes",
      });
      expect(translated.body.result).toMatchObject({ name: "Questions fréquentes", language_code: "fr" });
      const fetched = await api(ctx.app, "GET", `/v2/Categories/${DEFAULT_FAQ_CATEGORY_ID}/fr`);
      expect(fetched.body.result.is_fall_back_content).toBe(false);
      expect((await api(ctx.app, "GET", `/v2/Categories/${DEFAULT_FAQ_CATEGORY_ID}/en`)).body.result.name).toBe("FAQ");
    });
  });

  describe("articles", () => {
    it("reads the seeded articles with rendered html and urls", async () => {
      const welcome = await api(ctx.app, "GET", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/en`);
      expect(welcome.status).toBe(200);
      expect(welcome.body.result).toMatchObject({
        id: DEFAULT_WELCOME_ARTICLE_ID,
        title: "Welcome",
        status: 3,
        public_version: 1,
        latest_version: 1,
        slug: "welcome",
        category_id: DEFAULT_GETTING_STARTED_CATEGORY_ID,
        url: "https://emulate.document360.io/v1/en/docs/welcome",
      });
      expect(welcome.body.result.html_content).toContain("<h1>Welcome</h1>");
      expect(welcome.body.result.html_content).toContain("<strong>markdown</strong>");
      expect(welcome.body.result.authors[0]).toMatchObject({ id: DEFAULT_OWNER_ID, email_id: DEFAULT_OWNER_EMAIL });
      const display = await api(ctx.app, "GET", `/v2/Articles/${DEFAULT_SETUP_ARTICLE_ID}/en?isForDisplay=true`);
      expect(display.status).toBe(404);
    });

    it("creates drafts, versions them on edit after publishing, and publishes", async () => {
      const created = await api(ctx.app, "POST", "/v2/Articles", {
        title: "Billing",
        content: "# Billing\n\nFirst draft.",
        category_id: DEFAULT_FAQ_CATEGORY_ID,
        project_version_id: DEFAULT_MAIN_VERSION_ID,
        user_id: DEFAULT_OWNER_ID,
        order: 5,
      });
      expect(created.status).toBe(200);
      const article = created.body.result;
      expect(article).toMatchObject({
        title: "Billing",
        status: 0,
        public_version: null,
        latest_version: 1,
        version_number: 1,
        slug: "billing",
        order: 5,
      });

      const edited = await api(ctx.app, "PUT", `/v2/Articles/${article.id}/en`, {
        content: "# Billing\n\nSecond draft.",
      });
      expect(edited.body.result.latest_version).toBe(1);
      expect(edited.body.result.content).toContain("Second draft");

      const published = await api(ctx.app, "POST", `/v2/Articles/${article.id}/en/publish`, {
        version_number: 1,
        publish_message: "Go live",
      });
      expect(published.status).toBe(200);
      expect(published.body.result).toMatchObject({ status: 3, public_version: 1 });

      const afterPublish = await api(ctx.app, "PUT", `/v2/Articles/${article.id}/en`, {
        title: "Billing and invoices",
        content: "Third revision.",
      });
      expect(afterPublish.body.result).toMatchObject({
        latest_version: 2,
        public_version: 1,
        version_number: 2,
        title: "Billing and invoices",
      });

      const forDisplay = await api(ctx.app, "GET", `/v2/Articles/${article.id}/en?isForDisplay=true`);
      expect(forDisplay.body.result).toMatchObject({ version_number: 1, title: "Billing" });

      const versions = await api(ctx.app, "GET", `/v2/Articles/${article.id}/en/versions`);
      expect(versions.body.result.map((version: any) => [version.version_number, version.is_public])).toEqual([
        [1, true],
        [2, false],
      ]);
      expect(
        (await api(ctx.app, "GET", `/v2/Articles/${article.id}/en/versions/1`)).body.result.publish_message,
      ).toBeUndefined();
      expect((await api(ctx.app, "DELETE", `/v2/Articles/${article.id}/en/versions/1`)).status).toBe(400);
      expect((await api(ctx.app, "DELETE", `/v2/Articles/${article.id}/en/versions/2`)).status).toBe(200);
      expect((await api(ctx.app, "GET", `/v2/Articles/${article.id}/en`)).body.result.latest_version).toBe(1);

      const forked = await api(ctx.app, "POST", `/v2/Articles/${article.id}/en/fork`, {
        version_number: 1,
        user_id: DEFAULT_OWNER_ID,
      });
      expect(forked.body.result.version_number).toBe(2);
      const publishedFork = await api(ctx.app, "POST", `/v2/Articles/${article.id}/en/publish`, { version_number: 2 });
      expect(publishedFork.body.result.public_version).toBe(2);
      const events = (await (
        await ctx.app.request(`${d360TestBaseUrl}/_document360/events?type=article.published`)
      ).json()) as any;
      expect(events.events.length).toBeGreaterThanOrEqual(2);
    });

    it("supports settings, review reminders, translations and deletion", async () => {
      const settings = await api(ctx.app, "PUT", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/en/settings`, {
        slug: "hello",
        seo_title: "Hello",
        tags: ["a", "b"],
        exclude_from_search: true,
      });
      expect(settings.body.result).toMatchObject({
        slug: "hello",
        seo_title: "Hello",
        tags: ["a", "b"],
        exclude_from_search: true,
      });
      const reminder = await api(ctx.app, "PUT", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/en/reviewreminder`, {
        review_reminder_at: "2030-01-01T00:00:00Z",
      });
      expect(reminder.body.result.review_reminder_at).toBe("2030-01-01T00:00:00.000Z");
      expect(
        (
          await api(ctx.app, "PUT", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/en/reviewreminder`, {
            review_reminder_at: "soon",
          })
        ).status,
      ).toBe(400);
      expect(
        (await api(ctx.app, "DELETE", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/en/reviewreminder`)).status,
      ).toBe(200);
      expect(
        (await api(ctx.app, "GET", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/en/reviewreminder`)).body.result
          .review_reminder_at,
      ).toBeNull();

      const fallback = await api(ctx.app, "GET", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/fr`);
      expect(fallback.body.result).toMatchObject({ language_code: "en", is_fall_back_content: true });
      const translated = await api(ctx.app, "PUT", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/fr`, {
        title: "Bienvenue",
        content: "Bonjour",
      });
      expect(translated.body.result).toMatchObject({
        language_code: "fr",
        title: "Bienvenue",
        is_fall_back_content: false,
        public_version: null,
      });
      expect((await api(ctx.app, "GET", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/en`)).body.result.title).toBe(
        "Welcome",
      );

      expect((await api(ctx.app, "DELETE", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/fr`)).status).toBe(200);
      expect(
        (await api(ctx.app, "GET", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/fr`)).body.result.language_code,
      ).toBe("en");
      expect((await api(ctx.app, "DELETE", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/en`)).status).toBe(200);
      expect((await api(ctx.app, "GET", `/v2/Articles/${DEFAULT_WELCOME_ARTICLE_ID}/en`)).status).toBe(404);
      expect((await api(ctx.app, "POST", "/v2/Articles", { title: "No category" })).status).toBe(400);
      expect(
        (await api(ctx.app, "POST", "/v2/Articles", { title: "Bad category", category_id: "missing" })).status,
      ).toBe(400);
    });

    it("lists version articles and searches published content", async () => {
      const all = await api(ctx.app, "GET", `/v2/ProjectVersions/${DEFAULT_MAIN_VERSION_ID}/articles`);
      expect(all.body.result).toHaveLength(3);
      const byCategory = await api(ctx.app, "GET", `/v2/Categories/${DEFAULT_GETTING_STARTED_CATEGORY_ID}/en/articles`);
      expect(byCategory.body.result.map((article: any) => article.title)).toEqual(["Welcome", "Setup guide"]);
      const search = await api(ctx.app, "GET", `/v2/Search/${DEFAULT_MAIN_VERSION_ID}?searchQuery=markdown`);
      expect(search.body.result.total_count).toBe(1);
      expect(search.body.result.results[0]).toMatchObject({
        id: DEFAULT_WELCOME_ARTICLE_ID,
        category_name: "Getting Started",
      });
      expect(search.body.result.results[0].highlighted_content).toContain("<em>markdown</em>");
      const drafts = await api(ctx.app, "GET", `/v2/Search/${DEFAULT_MAIN_VERSION_ID}?searchQuery=api_token`);
      expect(drafts.body.result.total_count).toBe(0);
    });
  });

  describe("team accounts", () => {
    it("lists, creates, updates and protects the last owner", async () => {
      const list = await api(ctx.app, "GET", "/v2/Teams");
      expect(
        list.body.result.map((account: any) => [account.email_id, account.portal_role, account.user_role]),
      ).toEqual([
        [DEFAULT_OWNER_EMAIL, "owner", 0],
        ["editor@example.com", "editor", 2],
      ]);
      const created = await api(ctx.app, "POST", "/v2/Teams", {
        email_id: "writer@example.com",
        first_name: "Wri",
        last_name: "Ter",
        portal_role: 3,
      });
      expect(created.body.result).toMatchObject({ portal_role: "draft_writer", user_role: 3, accepted: false });
      expect((await api(ctx.app, "POST", "/v2/Teams", { email_id: "writer@example.com" })).status).toBe(400);
      const promoted = await api(ctx.app, "PUT", `/v2/Teams/${created.body.result.user_id}`, { portal_role: "admin" });
      expect(promoted.body.result.portal_role).toBe("admin");
      const byEmail = await api(ctx.app, "GET", "/v2/Teams/writer@example.com");
      expect(byEmail.body.result.user_id).toBe(created.body.result.user_id);
      expect((await api(ctx.app, "PUT", `/v2/Teams/${DEFAULT_OWNER_ID}`, { portal_role: "editor" })).status).toBe(400);
      expect((await api(ctx.app, "DELETE", `/v2/Teams/${DEFAULT_OWNER_ID}`)).status).toBe(400);
      expect((await api(ctx.app, "DELETE", `/v2/Teams/${created.body.result.user_id}`)).status).toBe(200);
      const articles = await api(ctx.app, "GET", `/v2/Teams/${DEFAULT_OWNER_ID}/articles`);
      expect(articles.body.result).toHaveLength(3);
    });

    it("manages team groups", async () => {
      const groups = await api(ctx.app, "GET", "/v2/Teams/groups");
      expect(groups.body.result[0]).toMatchObject({ title: "Editors", portal_role: "editor" });
      expect(groups.body.result[0].associated_team_accounts[0].email_id).toBe("editor@example.com");
      const created = await api(ctx.app, "POST", "/v2/Teams/groups", {
        title: "Admins",
        portal_role: "admin",
        associated_team_accounts: [DEFAULT_OWNER_EMAIL],
      });
      expect(created.body.result.associated_team_accounts[0].user_id).toBe(DEFAULT_OWNER_ID);
      const updated = await api(ctx.app, "PUT", `/v2/Teams/groups/${created.body.result.id}`, {
        associated_team_accounts: [],
      });
      expect(updated.body.result.associated_team_accounts).toEqual([]);
      expect((await api(ctx.app, "DELETE", `/v2/Teams/groups/${created.body.result.id}`)).status).toBe(200);
      expect((await api(ctx.app, "GET", `/v2/Teams/groups/${created.body.result.id}`)).status).toBe(404);
    });
  });

  describe("drive", () => {
    it("lists seeded folders and serves item content", async () => {
      const folders = await api(ctx.app, "GET", "/v2/Drive/Folders");
      expect(folders.body.result[0]).toMatchObject({
        id: DEFAULT_DOCUMENTS_FOLDER_ID,
        title: "Documents",
        is_system: true,
        items_count: 1,
      });
      const items = await api(ctx.app, "GET", `/v2/Drive/Folders/${DEFAULT_DOCUMENTS_FOLDER_ID}/Items`);
      expect(items.body.result[0]).toMatchObject({ title: "readme.txt", content_type: "text/plain" });
      const content = await ctx.app.request(items.body.result[0].url);
      expect(content.status).toBe(200);
      expect(content.headers.get("content-type")).toBe("text/plain");
      expect(await content.text()).toContain("served from the emulator");
    });

    it("uploads multipart files and manages folders", async () => {
      const folder = await api(ctx.app, "POST", "/v2/Drive/Folders", {
        title: "Images",
        parent_folder_id: DEFAULT_DOCUMENTS_FOLDER_ID,
      });
      expect(folder.status).toBe(200);
      const form = new FormData();
      form.append("files", new Blob(["<svg></svg>"], { type: "image/svg+xml" }), "logo.svg");
      form.append("tags", "brand");
      const uploaded = await api(ctx.app, "POST", `/v2/Drive/Folders/${folder.body.result.id}/Items`, form);
      expect(uploaded.status).toBe(200);
      expect(uploaded.body.result[0]).toMatchObject({
        title: "logo.svg",
        content_type: "image/svg+xml",
        size: 11,
        tags: ["brand"],
      });
      const served = await ctx.app.request(uploaded.body.result[0].url);
      expect(await served.text()).toBe("<svg></svg>");
      const moved = await api(ctx.app, "PUT", `/v2/Drive/Items/${uploaded.body.result[0].id}`, {
        title: "brand.svg",
        is_starred: true,
      });
      expect(moved.body.result).toMatchObject({ title: "brand.svg", is_starred: true });
      const search = await api(ctx.app, "GET", "/v2/Drive/Items?search=brand");
      expect(search.body.result).toHaveLength(1);
      const tree = await api(ctx.app, "GET", `/v2/Drive/Folders/${DEFAULT_DOCUMENTS_FOLDER_ID}`);
      expect(tree.body.result.sub_folders[0].title).toBe("Images");
      expect((await api(ctx.app, "DELETE", `/v2/Drive/Folders/${DEFAULT_DOCUMENTS_FOLDER_ID}`)).status).toBe(400);
      expect((await api(ctx.app, "DELETE", `/v2/Drive/Folders/${folder.body.result.id}`)).status).toBe(200);
      expect((await api(ctx.app, "GET", `/v2/Drive/Items/${uploaded.body.result[0].id}`)).status).toBe(404);
    });
  });

  describe("misc", () => {
    it("exposes project info, events, and the inspector", async () => {
      const project = await api(ctx.app, "GET", "/v2/Project");
      expect(project.body.result).toMatchObject({
        name: "Emulate Knowledge Base",
        main_version_id: DEFAULT_MAIN_VERSION_ID,
        readers_count: 1,
        articles_count: 3,
      });
      await api(ctx.app, "POST", "/v2/Readers", { email_id: "evt@example.com" });
      const events = (await (
        await ctx.app.request(`${d360TestBaseUrl}/_document360/events?type=reader.created`)
      ).json()) as any;
      expect(events.events[0]).toMatchObject({ type: "reader.created", detail: { email: "evt@example.com" } });
      const cleared = await ctx.app.request(`${d360TestBaseUrl}/_document360/events`, { method: "DELETE" });
      expect(cleared.status).toBe(200);
      for (const tab of ["articles", "categories", "versions", "readers", "teams", "drive", "events", "auth"]) {
        const page = await ctx.app.request(`${d360TestBaseUrl}/?tab=${tab}`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Document360");
      }
    });

    it("rejects invalid json and seeds without defaults", async () => {
      const response = await ctx.app.request(`${d360TestBaseUrl}/v2/Readers`, {
        method: "POST",
        headers: { api_token: "test_emulate_document360_token", "Content-Type": "application/json" },
        body: "{",
      });
      expect(response.status).toBe(400);
      const bare = createD360TestApp({ api_tokens: [{ token: "t" }], readers: [{ email: "solo@example.com" }] }, false);
      const ds = getD360Store(bare.store);
      expect(ds.projectVersions.count()).toBe(1);
      expect(ds.teamAccounts.count()).toBe(1);
      const readers = await api(bare.app, "GET", "/v2/Readers", undefined, "t");
      expect(readers.body.result[0].invited_by).toBe(DEFAULT_OWNER_EMAIL);
    });

    it("renders markdown", () => {
      expect(markdownToHtml("# Title\n\nPara **bold** and `code`.\n\n- one\n- two\n")).toBe(
        "<h1>Title</h1><p>Para <strong>bold</strong> and <code>code</code>.</p><ul><li>one</li><li>two</li></ul>",
      );
    });
  });
});
