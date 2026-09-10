import type { ExclusionType, OsType, S1DeviceRule, S1Exclusion, S1Restriction } from "../entities.js";
import { formatDeviceRule, formatExclusion, formatRestriction } from "../formatters.js";
import {
  api,
  bool,
  containsAny,
  dataOf,
  filterOf,
  list,
  matchesList,
  notFound,
  num,
  oneOf,
  paginate,
  parseJsonBody,
  queryParams,
  route,
  str,
  strOrNull,
  validation,
  type Body,
} from "../helpers.js";
import { logEvent, nextId } from "../store.js";
import {
  requestUser,
  resolveScopeTarget,
  scopeFromParams,
  scopedEntityMatches,
  type S1RouteContext,
} from "../route-utils.js";

const OS_TYPES = ["windows", "linux", "macos", "windows_legacy"] as const;
const EXCLUSION_TYPES = ["browser", "certificate", "file_type", "path", "white_hash"] as const;
const MODES = [
  "disable_all_monitors",
  "disable_all_monitors_deep",
  "disable_in_process_monitor",
  "disable_in_process_monitor_deep",
  "suppress",
  "suppress_app_control",
  "suppress_dfi_only",
  "suppress_drift_detection",
  "suppress_dynamic_only",
] as const;
const MODE_TYPES = ["all", "agent_interoperability", "binary_vault", "suppression"] as const;
const THREAT_TYPES = ["EDR", "IDR"] as const;
const RESTRICTION_TYPES = ["black_hash", "path", "certificate"] as const;
const RESTRICTION_SOURCES = ["action_from_threat", "catalog", "cloud", "user"] as const;
const INTERFACES = ["Bluetooth", "SDCard", "Thunderbolt", "USB"] as const;
const RULE_TYPES = [
  "class",
  "bluetoothVersion",
  "deviceId",
  "hwIdentifiers",
  "uid",
  "productId",
  "vendorId",
  "sdCard",
] as const;
const ACCESS = ["Read-Only", "Not-Applicable", "Read-Write"] as const;

function requireValue(type: ExclusionType, value: string | null): void {
  if (type === "white_hash" && (!value || !/^[0-9a-f]{40}$/i.test(value)))
    throw validation("value must be a SHA1 hash for white_hash exclusions");
  if (type !== "white_hash" && !value) throw validation("value is required");
}

export function protectionRoutes(rc: S1RouteContext): void {
  const { app, ss, fmt } = rc;

  const listExclusions = () =>
    api(ss, (c) => {
      const params = queryParams(c);
      const scope = scopeFromParams(params);
      const rows = ss.exclusions
        .all()
        .filter((exclusion) => scopedEntityMatches(ss, exclusion, scope))
        .filter((exclusion) => matchesList(exclusion.s1_id, params.list("ids")))
        .filter((exclusion) => matchesList(exclusion.type, params.list("type") ?? params.list("types")))
        .filter((exclusion) => matchesList(exclusion.osType, params.list("osTypes")))
        .filter((exclusion) => matchesList(exclusion.modeType, params.list("modeType") ?? params.list("modeTypes")))
        .filter((exclusion) => matchesList(exclusion.mode, params.list("modes")))
        .filter((exclusion) => matchesList(exclusion.interactionLevel, params.list("interactionLevel")))
        .filter((exclusion) => matchesList(exclusion.threatType, params.list("threatTypes")))
        .filter((exclusion) =>
          containsAny(exclusion.value, params.list("value__contains") ?? params.list("value__icontains")),
        )
        .filter((exclusion) => matchesList(exclusion.value, params.list("value") ?? params.list("value__iexact")))
        .filter((exclusion) =>
          containsAny(exclusion.exclusionName ?? exclusion.description, params.list("exclusionName__contains")),
        )
        .filter((exclusion) => containsAny(exclusion.description, params.list("description__contains")))
        .filter((exclusion) => containsAny(exclusion.applicationName, params.list("applicationName__contains")))
        .filter((exclusion) =>
          params.bool("imported") === undefined ? true : exclusion.imported === params.bool("imported"),
        )
        .filter((exclusion) =>
          params.bool("includeChildren") === undefined
            ? true
            : exclusion.includeChildren === params.bool("includeChildren"),
        )
        .filter((exclusion) =>
          params.get("createdAt__gte") ? exclusion.created_at >= params.get("createdAt__gte")! : true,
        )
        .sort((a, b) => a.id - b.id)
        .map((exclusion) => formatExclusion(fmt, exclusion));
      return c.json(
        paginate(c, rows, {
          sortable: [
            "id",
            "value",
            "type",
            "osType",
            "createdAt",
            "updatedAt",
            "scopeName",
            "userName",
            "description",
            "exclusionName",
            "modeType",
          ],
        }),
      );
    });
  route(app, "get", "/exclusions", listExclusions());
  route(app, "get", "/unified-exclusions", listExclusions());

  const createExclusion = (unified: boolean) =>
    api(ss, async (c, key) => {
      const body = await parseJsonBody(c);
      const data = dataOf(body);
      const filter = filterOf(body);
      const target = resolveScopeTarget(ss, filter);
      const osType = oneOf(data.osType, OS_TYPES, "osType");
      if (!osType) throw validation("osType is required");
      const type = oneOf(data.type, EXCLUSION_TYPES, "type");
      if (!type) throw validation("type is required");
      const value = strOrNull(data.value);
      requireValue(type, value);
      if (unified && !str(data.exclusionName)?.trim()) throw validation("exclusionName is required");
      if (unified && !str(data.reason)?.trim()) throw validation("reason is required");
      const duplicate = ss.exclusions
        .all()
        .find(
          (existing) =>
            existing.scope_level === target.level &&
            existing.scope_id === target.id &&
            existing.type === type &&
            existing.osType === osType &&
            (existing.value ?? "").toLowerCase() === (value ?? "").toLowerCase(),
        );
      if (duplicate) throw validation(`An exclusion for ${value} already exists in this scope`, 4000030);
      const user = requestUser(ss, key.user_id);
      const exclusion = ss.exclusions.insert({
        s1_id: nextId(ss),
        unified,
        scope_level: target.level,
        scope_id: target.id,
        osType: osType as OsType,
        type,
        value,
        description: strOrNull(data.description),
        exclusionName: strOrNull(data.exclusionName),
        mode: unified ? null : (oneOf(data.mode, MODES, "mode") ?? "suppress"),
        modeType: unified ? (oneOf(data.modeType, MODE_TYPES, "modeType") ?? "suppression") : null,
        interactionLevel: unified ? (oneOf(data.interactionLevel, MODES, "interactionLevel") ?? "suppress") : null,
        threatType: (oneOf(data.threatType, THREAT_TYPES, "threatType") ?? "EDR") as "EDR" | "IDR",
        reason: strOrNull(data.reason),
        recommendation: strOrNull(data.recommendation),
        pathExclusionType: strOrNull(data.pathExclusionType) ?? (type === "path" ? "subfolders" : null),
        actions: list(data.actions) ?? [],
        source: str(data.source) ?? "user",
        tagIds: list(data.tagIds) ?? [],
        includeChildren: bool(data.includeChildren) ?? false,
        includeParents: bool(data.includeParents) ?? false,
        inject: bool(data.inject) ?? false,
        applicationName: str(data.applicationName) ?? "",
        notRecommended: "",
        imported: false,
        inAppInventory: false,
        engines: strOrNull(data.engines),
        user_id: user.id,
        userName: user.fullName,
      });
      logEvent(ss, unified ? "unified_exclusion.created" : "exclusion.created", exclusion.s1_id, {
        type,
        osType,
        value,
        scope: target.level,
        scopeId: target.id,
      });
      return c.json({ data: formatExclusion(fmt, exclusion) });
    });
  route(app, "post", "/exclusions", createExclusion(false));
  route(app, "post", "/unified-exclusions", createExclusion(true));

  const deleteExclusions = api(ss, async (c) => {
    const body = await parseJsonBody(c);
    const data = dataOf(body);
    const nested = (data.data && typeof data.data === "object" ? (data.data as Body) : data) as Body;
    const entries = Array.isArray(nested.exclusions)
      ? nested.exclusions.map((entry) => (entry && typeof entry === "object" ? entry : {}) as Body)
      : [];
    const ids =
      entries.length > 0
        ? entries.map((entry) => str(entry.id)).filter((id): id is string => !!id)
        : (list(filterOf(body).ids) ?? list(data.ids) ?? []);
    if (ids.length === 0) throw validation("data.exclusions or filter.ids must select at least one exclusion");
    let affected = 0;
    for (const id of ids) {
      const exclusion = ss.exclusions.findOneBy("s1_id", id);
      if (!exclusion) continue;
      ss.exclusions.delete(exclusion.id);
      affected += 1;
    }
    logEvent(ss, "exclusion.deleted", String(affected), { affected, ids });
    return c.json({ data: { affected } });
  });
  route(app, "delete", "/exclusions", deleteExclusions);
  route(app, "delete", "/unified-exclusions", deleteExclusions);
  route(
    app,
    "delete",
    "/exclusions/:id",
    api(ss, (c) => {
      const exclusion = ss.exclusions.findOneBy("s1_id", c.req.param("id"));
      if (!exclusion) throw notFound(`Exclusion ${c.req.param("id")} was not found`);
      ss.exclusions.delete(exclusion.id);
      return c.json({ data: { affected: 1 } });
    }),
  );

  route(
    app,
    "get",
    "/restrictions",
    api(ss, (c) => {
      const params = queryParams(c);
      const scope = scopeFromParams(params);
      const rows = ss.restrictions
        .all()
        .filter((restriction) => scopedEntityMatches(ss, restriction, scope))
        .filter((restriction) => matchesList(restriction.s1_id, params.list("ids")))
        .filter((restriction) => matchesList(restriction.type, params.list("type") ?? params.list("types")))
        .filter((restriction) => matchesList(restriction.osType, params.list("osTypes")))
        .filter((restriction) => matchesList(restriction.value, params.list("value")))
        .filter((restriction) => containsAny(restriction.value, params.list("value__contains")))
        .filter((restriction) => matchesList(restriction.source, params.list("sources")))
        .filter((restriction) => matchesList(restriction.user_id, params.list("userIds")))
        .sort((a, b) => a.id - b.id)
        .map((restriction) => formatRestriction(fmt, restriction));
      return c.json(
        paginate(c, rows, {
          sortable: ["id", "value", "type", "osType", "createdAt", "updatedAt", "scopeName", "userName", "description"],
        }),
      );
    }),
  );

  route(
    app,
    "post",
    "/restrictions",
    api(ss, async (c, key) => {
      const body = await parseJsonBody(c);
      const data = dataOf(body);
      const target = resolveScopeTarget(ss, filterOf(body));
      const type = oneOf(data.type, RESTRICTION_TYPES, "type") ?? "black_hash";
      const osType = oneOf(data.osType, OS_TYPES, "osType");
      if (!osType) throw validation("osType is required");
      const value = strOrNull(data.value);
      const sha256 = strOrNull(data.sha256Value);
      if (
        type === "black_hash" &&
        !(value && /^[0-9a-f]{40}$/i.test(value)) &&
        !(sha256 && /^[0-9a-f]{64}$/i.test(sha256))
      )
        throw validation("value must be a SHA1 hash or sha256Value a SHA256 hash for black_hash restrictions");
      if (type !== "black_hash" && !value) throw validation("value is required");
      const duplicate = ss.restrictions
        .all()
        .find(
          (existing) =>
            existing.scope_level === target.level &&
            existing.scope_id === target.id &&
            existing.osType === osType &&
            ((value && existing.value?.toLowerCase() === value.toLowerCase()) ||
              (sha256 && existing.sha256Value?.toLowerCase() === sha256.toLowerCase())),
        );
      if (duplicate) throw validation(`A restriction for ${value ?? sha256} already exists in this scope`, 4000030);
      const user = requestUser(ss, key.user_id);
      const restriction = ss.restrictions.insert({
        s1_id: nextId(ss),
        scope_level: target.level,
        scope_id: target.id,
        osType: osType as OsType,
        type,
        value: value ? value.toLowerCase() : null,
        sha256Value: sha256 ? sha256.toLowerCase() : null,
        description: str(data.description) ?? "",
        source: oneOf(data.source, RESTRICTION_SOURCES, "source") ?? "user",
        includeChildren: bool(data.includeChildren) ?? false,
        includeParents: bool(data.includeParents) ?? false,
        imported: false,
        notRecommended: "",
        user_id: user.id,
        userName: user.fullName,
      });
      logEvent(ss, "restriction.created", restriction.s1_id, {
        type,
        osType,
        value: restriction.value ?? restriction.sha256Value,
        scope: target.level,
      });
      return c.json({ data: formatRestriction(fmt, restriction) });
    }),
  );

  route(
    app,
    "delete",
    "/restrictions",
    api(ss, async (c) => {
      const body = await parseJsonBody(c);
      const ids = list(filterOf(body).ids) ?? list(dataOf(body).ids) ?? [];
      if (ids.length === 0) throw validation("filter.ids must select at least one restriction");
      let affected = 0;
      for (const id of ids) {
        const restriction = ss.restrictions.findOneBy("s1_id", id);
        if (!restriction) continue;
        ss.restrictions.delete(restriction.id);
        affected += 1;
      }
      return c.json({ data: { affected } });
    }),
  );

  route(
    app,
    "get",
    "/device-control",
    api(ss, (c) => {
      const params = queryParams(c);
      const scope = scopeFromParams(params);
      const rows = ss.deviceRules
        .all()
        .filter((rule) => scopedEntityMatches(ss, rule, scope))
        .filter((rule) => matchesList(rule.s1_id, params.list("ids")))
        .filter((rule) => matchesList(rule.interface, params.list("interfaces") ?? params.list("interface")))
        .filter((rule) => matchesList(rule.action, params.list("actions") ?? params.list("action")))
        .filter((rule) => matchesList(rule.status, params.list("statuses") ?? params.list("status")))
        .filter((rule) => matchesList(rule.ruleType, params.list("ruleTypes") ?? params.list("type")))
        .filter((rule) => containsAny(rule.ruleName, params.list("ruleName__contains") ?? params.list("query")))
        .filter((rule) => matchesList(rule.vendorId, params.list("vendorId")))
        .filter((rule) => matchesList(rule.productId, params.list("productId")))
        .sort((a, b) => a.order - b.order || a.id - b.id)
        .map((rule) => formatDeviceRule(fmt, rule));
      return c.json(
        paginate(c, rows, {
          sortable: ["id", "order", "ruleName", "interface", "action", "status", "createdAt", "updatedAt"],
        }),
      );
    }),
  );

  route(
    app,
    "post",
    "/device-control",
    api(ss, async (c, key) => {
      const body = await parseJsonBody(c);
      const data = dataOf(body);
      const target = resolveScopeTarget(ss, filterOf(body));
      const iface = oneOf(data.interface, INTERFACES, "interface");
      if (!iface) throw validation("interface is required");
      const ruleName = str(data.ruleName)?.trim();
      if (!ruleName) throw validation("ruleName is required");
      const ruleType = oneOf(data.ruleType, RULE_TYPES, "ruleType");
      if (!ruleType) throw validation("ruleType is required");
      const action = oneOf(data.action, ["Allow", "Block"] as const, "action");
      if (!action) throw validation("action is required");
      if (ruleType === "deviceId" && !str(data.deviceId)) throw validation("deviceId is required for deviceId rules");
      if (ruleType === "vendorId" && !str(data.vendorId)) throw validation("vendorId is required for vendorId rules");
      if (ruleType === "productId" && (!str(data.vendorId) || !str(data.productId)))
        throw validation("vendorId and productId are required for productId rules");
      if (ruleType === "class" && !str(data.deviceClass)) throw validation("deviceClass is required for class rules");
      const user = requestUser(ss, key.user_id);
      const rule = ss.deviceRules.insert({
        s1_id: nextId(ss),
        scope_level: target.level,
        scope_id: target.id,
        order: ss.deviceRules.count() + 1,
        interface: iface,
        ruleName,
        ruleType,
        action,
        status: oneOf(data.status, ["Enabled", "Disabled"] as const, "status") ?? "Enabled",
        deviceId: strOrNull(data.deviceId),
        deviceClass: strOrNull(data.deviceClass),
        vendorId: strOrNull(data.vendorId),
        productId: strOrNull(data.productId),
        uid: strOrNull(data.uid),
        version: strOrNull(data.version),
        minorClasses: list(data.minorClasses) ?? [],
        accessPermission:
          oneOf(data.accessPermission, ACCESS, "accessPermission") ??
          (iface === "USB" ? "Read-Write" : "Not-Applicable"),
        bluetoothAddress: strOrNull(data.bluetoothAddress),
        gattService: list(data.gattService) ?? [],
        manufacturerName: strOrNull(data.manufacturerName),
        deviceName: strOrNull(data.deviceName),
        deviceInformationServiceInfoKey: strOrNull(data.deviceInformationServiceInfoKey),
        deviceInformationServiceInfoValue: strOrNull(data.deviceInformationServiceInfoValue),
        creator: user.fullName,
        creatorId: user.id,
      });
      logEvent(ss, "device_rule.created", rule.s1_id, { ruleName, interface: iface, action, scope: target.level });
      return c.json({ data: formatDeviceRule(fmt, rule) });
    }),
  );

  for (const [path, status] of [
    ["enable", "Enabled"],
    ["disable", "Disabled"],
  ] as const) {
    route(
      app,
      "put",
      `/device-control/${path}`,
      api(ss, async (c) => {
        const body = await parseJsonBody(c);
        const ids = list(filterOf(body).ids) ?? list(dataOf(body).ids) ?? [];
        if (ids.length === 0) throw validation("filter.ids must select at least one rule");
        let affected = 0;
        for (const id of ids) {
          const rule = ss.deviceRules.findOneBy("s1_id", id);
          if (!rule || rule.status === status) continue;
          ss.deviceRules.update(rule.id, { status });
          affected += 1;
        }
        return c.json({ data: { affected } });
      }),
    );
  }
  route(
    app,
    "put",
    "/device-control/:id",
    api(ss, async (c) => {
      const rule = ss.deviceRules.findOneBy("s1_id", c.req.param("id"));
      if (!rule) throw notFound(`Device rule ${c.req.param("id")} was not found`);
      const data = dataOf(await parseJsonBody(c));
      const updates: Partial<S1DeviceRule> = {
        ruleName: str(data.ruleName)?.trim() || rule.ruleName,
        action: oneOf(data.action, ["Allow", "Block"] as const, "action") ?? rule.action,
        status: oneOf(data.status, ["Enabled", "Disabled"] as const, "status") ?? rule.status,
        accessPermission: oneOf(data.accessPermission, ACCESS, "accessPermission") ?? rule.accessPermission,
        order: num(data.order) ?? rule.order,
      };
      return c.json({ data: formatDeviceRule(fmt, ss.deviceRules.update(rule.id, updates)!) });
    }),
  );

  route(
    app,
    "delete",
    "/device-control",
    api(ss, async (c) => {
      const body = await parseJsonBody(c);
      const ids = list(filterOf(body).ids) ?? list(dataOf(body).ids) ?? [];
      if (ids.length === 0) throw validation("filter.ids must select at least one rule");
      let affected = 0;
      for (const id of ids) {
        const rule = ss.deviceRules.findOneBy("s1_id", id);
        if (!rule) continue;
        ss.deviceRules.delete(rule.id);
        affected += 1;
      }
      return c.json({ data: { affected } });
    }),
  );
}

export type { S1Exclusion, S1Restriction };
