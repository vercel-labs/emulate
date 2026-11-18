export interface ConsolePreset {
  label: string;
  description?: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Values to keep from a successful response: variable name to a dot path into the JSON body such as `id` or
   * `results.0.id`, or `@location.<name>` for a query parameter of the URL a redirect points to.
   */
  captures?: Record<string, string>;
}

export interface PresetGroup {
  title: string;
  presets: ConsolePreset[];
}

/** A `{{name}}` placeholder used in preset paths, header values, or bodies, filled in by the visitor. */
export interface ConsoleVariable {
  name: string;
  label: string;
  hint: string;
}

export interface ConsoleService {
  name: string;
  label: string;
  description: string;
  variables?: ConsoleVariable[];
  groups: PresetGroup[];
}
