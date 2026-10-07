import type { JiraCustomField } from "./entities.js";
import type { JiraStore } from "./store.js";

export interface FieldSchema {
  type: string;
  items?: string;
  system?: string;
  custom?: string;
  customId?: number;
}

export interface FieldDef {
  id: string;
  name: string;
  custom: boolean;
  orderable: boolean;
  navigable: boolean;
  searchable: boolean;
  clauseNames: string[];
  schema: FieldSchema;
}

function sys(
  id: string,
  name: string,
  type: string,
  clauseNames: string[] = [id],
  extra: Partial<FieldDef> & { items?: string } = {},
): FieldDef {
  const { items, ...rest } = extra;
  return {
    id,
    name,
    custom: false,
    orderable: true,
    navigable: true,
    searchable: true,
    clauseNames,
    schema: { type, ...(items ? { items } : {}), system: id },
    ...rest,
  };
}

export const SYSTEM_FIELDS: FieldDef[] = [
  sys("issuekey", "Key", "string", ["id", "issue", "issuekey", "key"], { orderable: false }),
  sys("summary", "Summary", "string"),
  sys("description", "Description", "string"),
  sys("environment", "Environment", "string"),
  sys("issuetype", "Issue Type", "issuetype", ["issuetype", "type"]),
  sys("project", "Project", "project"),
  sys("status", "Status", "status", ["status"], { orderable: false }),
  sys("statusCategory", "Status Category", "statusCategory", ["statusCategory"], { orderable: false }),
  sys("priority", "Priority", "priority"),
  sys("resolution", "Resolution", "resolution"),
  sys("resolutiondate", "Resolved", "datetime", ["resolutiondate", "resolved"], { orderable: false }),
  sys("assignee", "Assignee", "user"),
  sys("reporter", "Reporter", "user"),
  sys("creator", "Creator", "user", ["creator"], { orderable: false }),
  sys("labels", "Labels", "array", ["labels"], { items: "string" }),
  sys("components", "Components", "array", ["component"], { items: "component" }),
  sys("fixVersions", "Fix versions", "array", ["fixVersion"], { items: "version" }),
  sys("parent", "Parent", "issuelink", ["parent"]),
  sys("duedate", "Due date", "date", ["due", "duedate"]),
  sys("created", "Created", "datetime", ["created", "createdDate"], { orderable: false }),
  sys("updated", "Updated", "datetime", ["updated", "updatedDate"], { orderable: false }),
  sys("statuscategorychangedate", "Status Category Changed", "datetime", ["statusCategoryChangedDate"], {
    orderable: false,
  }),
  sys("comment", "Comment", "comments-page", ["comment"]),
  sys("issuelinks", "Linked Issues", "array", ["issueLink"], { items: "issuelinks" }),
  sys("subtasks", "Sub-tasks", "array", ["subtasks"], { items: "issuelinks", orderable: false }),
  sys("watches", "Watchers", "watches", ["watcher", "watchers"], { orderable: false }),
  sys("worklog", "Log Work", "array", ["worklogComment", "worklogDate"], { items: "worklog" }),
  sys("timespent", "Time Spent", "number", ["timespent"], { orderable: false }),
];

const CUSTOM_TYPES: Record<JiraCustomField["type"], { schema: FieldSchema; custom: string }> = {
  string: { schema: { type: "string" }, custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" },
  number: { schema: { type: "number" }, custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" },
  date: { schema: { type: "date" }, custom: "com.atlassian.jira.plugin.system.customfieldtypes:datepicker" },
  datetime: {
    schema: { type: "datetime" },
    custom: "com.atlassian.jira.plugin.system.customfieldtypes:datetime",
  },
  option: { schema: { type: "option" }, custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
  array: {
    schema: { type: "array", items: "string" },
    custom: "com.atlassian.jira.plugin.system.customfieldtypes:labels",
  },
  user: { schema: { type: "user" }, custom: "com.atlassian.jira.plugin.system.customfieldtypes:userpicker" },
  sprint: { schema: { type: "array", items: "json" }, custom: "com.pyxis.greenhopper.jira:gh-sprint" },
};

export function customFieldDef(field: JiraCustomField): FieldDef {
  const numericId = Number(field.field_id.replace("customfield_", ""));
  const typeInfo = CUSTOM_TYPES[field.type];
  return {
    id: field.field_id,
    name: field.name,
    custom: true,
    orderable: true,
    navigable: true,
    searchable: true,
    clauseNames: [`cf[${numericId}]`, field.name],
    schema: { ...typeInfo.schema, custom: typeInfo.custom, customId: numericId },
  };
}

export function allFields(js: JiraStore): FieldDef[] {
  return [...SYSTEM_FIELDS, ...js.customFields.all().map(customFieldDef)];
}

/** Resolves a field by id (`summary`, `customfield_10020`), display name, or JQL clause name (`cf[10020]`). */
export function findField(js: JiraStore, ref: string): FieldDef | undefined {
  const lower = ref.toLowerCase();
  return allFields(js).find(
    (field) =>
      field.id.toLowerCase() === lower ||
      field.name.toLowerCase() === lower ||
      field.clauseNames.some((clause) => clause.toLowerCase() === lower),
  );
}
