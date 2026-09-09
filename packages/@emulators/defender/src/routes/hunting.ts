import { api, badRequest, field, parseJsonBody, route, str } from "../helpers.js";
import { parseFilter, readField, type Row } from "../odata.js";
import { logEvent, type DefStore } from "../store.js";
import { tenantRows, type DefRouteContext } from "../route-utils.js";
import { liveActionStatus } from "../formatters.js";

interface Column {
  Name: string;
  Type: string;
}

type Table = { name: string; rows: () => Row[] };

function typeOf(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? "Int64" : "Double";
  if (typeof value === "boolean") return "Boolean";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return "DateTime";
  if (Array.isArray(value) || (value && typeof value === "object")) return "Dynamic";
  return "String";
}

function tables(ds: DefStore, tenantId: string): Table[] {
  return [
    {
      name: "DeviceInfo",
      rows: () =>
        tenantRows(ds.machines.all(), tenantId).map((machine) => ({
          Timestamp: machine.lastSeen,
          DeviceId: machine.machine_id,
          DeviceName: machine.computerDnsName,
          ClientVersion: machine.agentVersion,
          PublicIP: machine.lastExternalIpAddress,
          OSArchitecture: machine.osArchitecture,
          OSPlatform: machine.osPlatform,
          OSBuild: machine.osBuild,
          OSVersion: machine.version,
          IsAzureADJoined: machine.isAadJoined,
          AadDeviceId: machine.aadDeviceId,
          LoggedOnUsers: ds.logonUsers
            .findBy("machine_id", machine.machine_id)
            .map((user) => ({ UserName: user.accountName, DomainName: user.accountDomain })),
          RegistryDeviceTag: machine.machineTags.join(","),
          MachineGroup: machine.rbacGroupName,
          OnboardingStatus: machine.onboardingStatus,
          SensorHealthState: machine.healthStatus,
          ExposureLevel: machine.exposureLevel,
          DeviceCategory: "Endpoint",
          DeviceType: "Workstation",
          IsExcluded: machine.isExcluded,
        })),
    },
    {
      name: "DeviceNetworkInfo",
      rows: () =>
        tenantRows(ds.machines.all(), tenantId).flatMap((machine) =>
          machine.ipAddresses.map((entry) => ({
            Timestamp: machine.lastSeen,
            DeviceId: machine.machine_id,
            DeviceName: machine.computerDnsName,
            NetworkAdapterType: entry.type,
            MacAddress: entry.macAddress,
            NetworkAdapterStatus: entry.operationalStatus,
            IPAddresses: [{ IPAddress: entry.ipAddress, SubnetPrefix: 24, AddressType: "Private" }],
          })),
        ),
    },
    {
      name: "AlertInfo",
      rows: () =>
        tenantRows(ds.alerts.all(), tenantId).map((alert) => ({
          Timestamp: alert.alertCreationTime,
          AlertId: alert.alert_id,
          Title: alert.title,
          Category: alert.category,
          Severity: alert.severity,
          ServiceSource: "Microsoft Defender for Endpoint",
          DetectionSource: alert.detectionSource,
          AttackTechniques: alert.mitreTechniques,
        })),
    },
    {
      name: "AlertEvidence",
      rows: () =>
        tenantRows(ds.alerts.all(), tenantId).flatMap((alert) =>
          alert.evidence.map((evidence) => ({
            Timestamp: evidence.evidenceCreationTime,
            AlertId: alert.alert_id,
            Title: alert.title,
            Severity: alert.severity,
            EntityType: evidence.entityType,
            EvidenceRole: "Related",
            DeviceId: alert.machine_id,
            DeviceName: alert.computerDnsName,
            FileName: evidence.fileName,
            FolderPath: evidence.filePath,
            SHA1: evidence.sha1,
            SHA256: evidence.sha256,
            RemoteIP: evidence.ipAddress,
            RemoteUrl: evidence.url,
            AccountName: evidence.accountName,
            AccountDomain: evidence.domainName,
            ProcessCommandLine: evidence.processCommandLine,
          })),
        ),
    },
    {
      name: "DeviceAlertEvents",
      rows: () =>
        tenantRows(ds.alerts.all(), tenantId).map((alert) => ({
          AlertId: alert.alert_id,
          Timestamp: alert.alertCreationTime,
          DeviceId: alert.machine_id,
          DeviceName: alert.computerDnsName,
          Severity: alert.severity,
          Category: alert.category,
          Title: alert.title,
          AttackTechniques: alert.mitreTechniques,
        })),
    },
    {
      name: "DeviceTvmSoftwareInventory",
      rows: () =>
        tenantRows(ds.machineSoftware.all(), tenantId).map((link) => {
          const software = ds.software
            .findBy("software_id", link.software_id)
            .find((candidate) => candidate.tenant_id === tenantId);
          const machine = ds.machines
            .findBy("machine_id", link.machine_id)
            .find((candidate) => candidate.tenant_id === tenantId);
          return {
            DeviceId: link.machine_id,
            DeviceName: machine?.computerDnsName ?? null,
            OSPlatform: machine?.osPlatform ?? null,
            OSVersion: machine?.version ?? null,
            OSArchitecture: machine?.osArchitecture ?? null,
            SoftwareVendor: software?.vendor ?? null,
            SoftwareName: software?.name ?? link.software_id,
            SoftwareVersion: link.version,
            EndOfSupportStatus: "None",
            EndOfSupportDate: null,
          };
        }),
    },
    {
      name: "DeviceTvmSoftwareVulnerabilities",
      rows: () =>
        tenantRows(ds.machineVulnerabilities.all(), tenantId).map((link) => {
          const vulnerability = ds.vulnerabilities
            .findBy("cve_id", link.cve_id)
            .find((candidate) => candidate.tenant_id === tenantId);
          const software = link.software_id
            ? ds.software.findBy("software_id", link.software_id).find((candidate) => candidate.tenant_id === tenantId)
            : undefined;
          const machine = ds.machines
            .findBy("machine_id", link.machine_id)
            .find((candidate) => candidate.tenant_id === tenantId);
          return {
            DeviceId: link.machine_id,
            DeviceName: machine?.computerDnsName ?? null,
            OSPlatform: machine?.osPlatform ?? null,
            OSVersion: machine?.version ?? null,
            OSArchitecture: machine?.osArchitecture ?? null,
            SoftwareVendor: software?.vendor ?? null,
            SoftwareName: software?.name ?? null,
            SoftwareVersion: link.product_version,
            CveId: link.cve_id,
            VulnerabilitySeverityLevel: vulnerability?.severity ?? "Medium",
            RecommendedSecurityUpdate: link.fixing_kb_id ? `Security update ${link.fixing_kb_id}` : null,
            RecommendedSecurityUpdateId: link.fixing_kb_id,
            CveTags: vulnerability?.tags ?? [],
          };
        }),
    },
    {
      name: "DeviceTvmSecureConfigurationAssessment",
      rows: () =>
        tenantRows(ds.recommendations.all(), tenantId)
          .filter((item) => item.recommendationCategory === "Security controls")
          .flatMap((item) =>
            tenantRows(ds.machines.all(), tenantId).map((machine) => ({
              DeviceId: machine.machine_id,
              DeviceName: machine.computerDnsName,
              OSPlatform: machine.osPlatform,
              Timestamp: machine.lastSeen,
              ConfigurationId: item.recommendation_id,
              ConfigurationCategory: item.recommendationCategory,
              ConfigurationSubcategory: item.subCategory,
              ConfigurationImpact: item.configScoreImpact,
              IsCompliant: false,
              IsApplicable: true,
            })),
          ),
    },
    {
      name: "DeviceLogonEvents",
      rows: () =>
        tenantRows(ds.logonUsers.all(), tenantId).map((user) => ({
          Timestamp: user.lastSeen,
          DeviceId: user.machine_id,
          DeviceName:
            ds.machines.findBy("machine_id", user.machine_id).find((candidate) => candidate.tenant_id === tenantId)
              ?.computerDnsName ?? null,
          ActionType: "LogonSuccess",
          LogonType: user.logonTypes,
          AccountDomain: user.accountDomain,
          AccountName: user.accountName,
          AccountSid: user.accountSid,
          IsLocalAdmin: user.isDomainAdmin,
        })),
    },
    {
      name: "MachineActions",
      rows: () =>
        tenantRows(ds.actions.all(), tenantId).map((action) => ({
          Timestamp: action.creationDateTimeUtc,
          ActionId: action.action_id,
          ActionType: action.type,
          DeviceId: action.machine_id,
          DeviceName: action.computerDnsName,
          Status: liveActionStatus(ds, action),
          Requestor: action.requestor,
          Comment: action.requestorComment,
        })),
    },
  ];
}

const OPERATOR_MAP: Array<[RegExp, string]> = [
  [/\s*==\s*/g, " eq "],
  [/\s*!=\s*/g, " ne "],
  [/\s*>=\s*/g, " ge "],
  [/\s*<=\s*/g, " le "],
  [/\s*>\s*/g, " gt "],
  [/\s*<\s*/g, " lt "],
  [/\s+=~\s+/g, " eq "],
  [/\s+!~\s+/g, " ne "],
];

function toODataFilter(kql: string): string {
  let expression = kql.trim();
  expression = expression.replace(/"([^"]*)"/g, (_match, inner: string) => `'${inner.replace(/'/g, "''")}'`);
  expression = expression.replace(/\bisnotempty\(([^)]+)\)/gi, "$1 ne null");
  expression = expression.replace(/\bisempty\(([^)]+)\)/gi, "$1 eq null");
  expression = expression.replace(/\bisnotnull\(([^)]+)\)/gi, "$1 ne null");
  expression = expression.replace(/\bisnull\(([^)]+)\)/gi, "$1 eq null");
  expression = expression.replace(/(\w+)\s+has\s+('[^']*')/gi, "contains($1, $2)");
  expression = expression.replace(/(\w+)\s+!has\s+('[^']*')/gi, "not contains($1, $2)");
  expression = expression.replace(/(\w+)\s+!contains\s+('[^']*')/gi, "not contains($1, $2)");
  expression = expression.replace(/(\w+)\s+contains\s+('[^']*')/gi, "contains($1, $2)");
  expression = expression.replace(/(\w+)\s+startswith\s+('[^']*')/gi, "startswith($1, $2)");
  expression = expression.replace(/(\w+)\s+endswith\s+('[^']*')/gi, "endswith($1, $2)");
  expression = expression.replace(/(\w+)\s+!in\s*\(([^)]*)\)/gi, "not $1 in ($2)");
  expression = expression.replace(/(\w+)\s+in~\s*\(/gi, "$1 in (");
  expression = expression.replace(/\bago\((\d+)([dhm])\)/gi, (_match, amount: string, unit: string) => {
    const multiplier = unit.toLowerCase() === "d" ? 86400000 : unit.toLowerCase() === "h" ? 3600000 : 60000;
    return new Date(Date.now() - Number(amount) * multiplier).toISOString();
  });
  expression = expression.replace(/\bdatetime\(([^)]+)\)/gi, (_match, inner: string) =>
    new Date(inner.trim().replace(/^'|'$/g, "")).toISOString(),
  );
  expression = expression.replace(/\bnow\(\)/gi, new Date().toISOString());
  expression = expression.replace(/\btrue\b/gi, "true").replace(/\bfalse\b/gi, "false");
  for (const [pattern, replacement] of OPERATOR_MAP) expression = expression.replace(pattern, replacement);
  return expression;
}

export function runHuntingQuery(ds: DefStore, tenantId: string, query: string): { columns: Column[]; rows: Row[] } {
  const parts = query
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw badRequest("Query cannot be empty", "InvalidQuery");
  const [tableName, ...operators] = parts;
  const available = tables(ds, tenantId);
  const table = available.find((candidate) => candidate.name.toLowerCase() === tableName.toLowerCase());
  if (!table) throw badRequest(`Failed to resolve table or column expression named '${tableName}'`, "SemanticError");
  let rows = table.rows();
  let columns: string[] | null = null;
  for (const operator of operators) {
    const match = operator.match(/^(\w+)\s*([\s\S]*)$/);
    if (!match) throw badRequest(`Unable to parse operator '${operator}'`, "SyntaxError");
    const [, name, argument] = match;
    switch (name.toLowerCase()) {
      case "where": {
        const predicate = parseFilter(toODataFilter(argument));
        rows = rows.filter((row) => predicate(row));
        break;
      }
      case "project": {
        columns = argument
          .split(",")
          .map((column) => column.trim())
          .filter(Boolean);
        const selected = columns;
        rows = rows.map((row) => {
          const picked: Row = {};
          for (const column of selected) {
            const [alias, source] = column.includes("=")
              ? column.split("=").map((part) => part.trim())
              : [column, column];
            picked[alias] = readField(row, source);
          }
          return picked;
        });
        columns = columns.map((column) => (column.includes("=") ? column.split("=")[0].trim() : column));
        break;
      }
      case "project-away": {
        const removed = argument.split(",").map((column) => column.trim().toLowerCase());
        rows = rows.map((row) =>
          Object.fromEntries(Object.entries(row).filter(([key]) => !removed.includes(key.toLowerCase()))),
        );
        break;
      }
      case "take":
      case "limit": {
        const count = Number(argument);
        if (!Number.isFinite(count) || count < 0)
          throw badRequest(`Invalid argument '${argument}' for ${name}`, "SyntaxError");
        rows = rows.slice(0, count);
        break;
      }
      case "count":
        rows = [{ Count: rows.length }];
        columns = ["Count"];
        break;
      case "distinct": {
        const fields = argument
          .split(",")
          .map((column) => column.trim())
          .filter(Boolean);
        const seen = new Set<string>();
        rows = rows
          .map((row) => Object.fromEntries(fields.map((column) => [column, readField(row, column)])))
          .filter((row) => {
            const key = JSON.stringify(row);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        columns = fields;
        break;
      }
      case "summarize": {
        const byMatch = argument.match(/^(.*?)\s*(?:\bby\b\s*(.+))?$/i);
        const aggregate = (byMatch?.[1] ?? "").trim() || "count()";
        const groupFields = (byMatch?.[2] ?? "")
          .split(",")
          .map((column) => column.trim())
          .filter(Boolean);
        const aggMatch = aggregate.match(/^(?:(\w+)\s*=\s*)?(\w+)\((.*?)\)$/);
        if (!aggMatch) throw badRequest(`Unsupported summarize expression '${aggregate}'`, "SyntaxError");
        const [, aliasRaw, functionName, argumentName] = aggMatch;
        const alias =
          aliasRaw ?? (functionName.toLowerCase() === "count" ? "count_" : `${functionName}_${argumentName}`);
        const groups = new Map<string, { key: Row; values: unknown[] }>();
        for (const row of rows) {
          const key: Row = Object.fromEntries(groupFields.map((column) => [column, readField(row, column)]));
          const id = JSON.stringify(key);
          if (!groups.has(id)) groups.set(id, { key, values: [] });
          groups.get(id)!.values.push(argumentName ? readField(row, argumentName) : row);
        }
        rows = [...groups.values()].map(({ key, values }) => {
          const numbers = values.map(Number).filter(Number.isFinite);
          const result: Record<string, unknown> = { ...key };
          switch (functionName.toLowerCase()) {
            case "count":
              result[alias] = values.length;
              break;
            case "dcount":
              result[alias] = new Set(values.map((value) => JSON.stringify(value))).size;
              break;
            case "sum":
              result[alias] = numbers.reduce((sum, value) => sum + value, 0);
              break;
            case "avg":
              result[alias] = numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
              break;
            case "max":
              result[alias] = values.length
                ? values.reduce((max, value) => (String(value) > String(max) ? value : max))
                : null;
              break;
            case "min":
              result[alias] = values.length
                ? values.reduce((min, value) => (String(value) < String(min) ? value : min))
                : null;
              break;
            case "make_set":
            case "make_list":
              result[alias] =
                functionName.toLowerCase() === "make_set"
                  ? [...new Set(values.map((value) => JSON.stringify(value)))].map((value) => JSON.parse(value))
                  : values;
              break;
            case "arg_max":
            case "arg_min":
              result[alias] = values.length
                ? values.reduce((best, value) =>
                    (
                      functionName.toLowerCase() === "arg_max"
                        ? String(value) > String(best)
                        : String(value) < String(best)
                    )
                      ? value
                      : best,
                  )
                : null;
              break;
            default:
              throw badRequest(`Unsupported aggregation function '${functionName}'`, "SemanticError");
          }
          return result;
        });
        columns = [...groupFields, alias];
        break;
      }
      case "sort":
      case "order": {
        const clauses = argument
          .replace(/^by\s+/i, "")
          .split(",")
          .map((clause) => clause.trim())
          .filter(Boolean);
        rows = [...rows].sort((a, b) => {
          for (const clause of clauses) {
            const [column, direction] = clause.split(/\s+/);
            const left = readField(a, column);
            const right = readField(b, column);
            if (left === right) continue;
            const order = String(left ?? "") < String(right ?? "") ? -1 : 1;
            return (direction ?? "desc").toLowerCase() === "asc" ? order : -order;
          }
          return 0;
        });
        break;
      }
      case "top": {
        const topMatch = argument.match(/^(\d+)\s+by\s+(.+)$/i);
        if (!topMatch) throw badRequest(`Invalid top expression '${argument}'`, "SyntaxError");
        const [, count, clause] = topMatch;
        const [column, direction] = clause.trim().split(/\s+/);
        rows = [...rows]
          .sort((a, b) => {
            const left = String(readField(a, column) ?? "");
            const right = String(readField(b, column) ?? "");
            const order = left < right ? -1 : left > right ? 1 : 0;
            return (direction ?? "desc").toLowerCase() === "asc" ? order : -order;
          })
          .slice(0, Number(count));
        break;
      }
      case "extend": {
        for (const assignment of argument.split(",")) {
          const [alias, expression] = assignment.split("=").map((part) => part.trim());
          if (!alias || expression === undefined)
            throw badRequest(`Invalid extend expression '${assignment}'`, "SyntaxError");
          const literal = expression.match(/^"(.*)"$|^'(.*)'$/);
          rows = rows.map((row) => ({
            ...row,
            [alias]: literal
              ? (literal[1] ?? literal[2])
              : /^-?\d+(\.\d+)?$/.test(expression)
                ? Number(expression)
                : readField(row, expression),
          }));
        }
        break;
      }
      default:
        throw badRequest(`Operator '${name}' is not supported by the emulator`, "SemanticError");
    }
  }
  const columnNames = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const schema = columnNames.map((column) => ({
    Name: column,
    Type: typeOf(rows.find((row) => row[column] !== null && row[column] !== undefined)?.[column]),
  }));
  return { columns: schema, rows };
}

export function huntingRoutes(rc: DefRouteContext): void {
  const { app, ds } = rc;

  route(
    app,
    "post",
    "/api/advancedqueries/run",
    api(ds, async (c, auth) => {
      const body = await parseJsonBody(c);
      const query = str(field(body, "Query"));
      if (!query?.trim()) throw badRequest("Query is required", "MissingParameter");
      const started = Date.now();
      const result = runHuntingQuery(ds, auth.tenantId, query);
      if (result.rows.length > 100000)
        throw badRequest("Query result exceeds the 100,000 row limit", "QueryLimitExceeded");
      logEvent(ds, auth.tenantId, "hunting.query", auth.token.client_id, {
        query: query.trim().slice(0, 500),
        rows: result.rows.length,
      });
      return c.json({
        Stats: {
          ExecutionTime: (Date.now() - started) / 1000,
          resource_usage: {
            cache: { memory: { hits: 0, misses: 0, total: 0 } },
            cpu: { user: "00:00:00", system: "00:00:00", total_cpu: "00:00:00" },
            memory: { peak_per_node: 0 },
          },
          dataset_statistics: [{ table_row_count: result.rows.length, table_size: JSON.stringify(result.rows).length }],
        },
        Schema: result.columns,
        Results: result.rows,
      });
    }),
  );

  route(
    app,
    "get",
    "/api/advancedqueries/schema",
    api(ds, (c, auth) =>
      c.json({
        value: tables(ds, auth.tenantId).map((table) => ({
          Name: table.name,
          Columns: Object.keys(table.rows()[0] ?? {}),
        })),
      }),
    ),
  );
}
