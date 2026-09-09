import { formatMachine, formatRecommendation, formatSoftware, formatVulnerability } from "../formatters.js";
import { api, odataCollection, odataEntity, odataOptions, route } from "../helpers.js";
import {
  findMachine,
  findRecommendation,
  findSoftware,
  findVulnerability,
  tenantRows,
  type DefRouteContext,
} from "../route-utils.js";

export function tvmRoutes(rc: DefRouteContext): void {
  const { app, ds, baseUrl } = rc;

  const machineReference = (tenantId: string, machineId: string) => {
    const machine = ds.machines.findBy("machine_id", machineId).find((candidate) => candidate.tenant_id === tenantId);
    return machine
      ? {
          id: machine.machine_id,
          computerDnsName: machine.computerDnsName,
          osPlatform: machine.osPlatform,
          rbacGroupName: machine.rbacGroupName,
          rbacGroupId: machine.rbacGroupId,
        }
      : null;
  };

  route(
    app,
    "get",
    "/api/vulnerabilities",
    api(ds, (c, auth) =>
      odataCollection(
        c,
        baseUrl,
        "Vulnerabilities",
        tenantRows(ds.vulnerabilities.all(), auth.tenantId).map(formatVulnerability),
        odataOptions(c),
      ),
    ),
  );

  route(
    app,
    "get",
    "/api/vulnerabilities/machinesVulnerabilities",
    api(ds, (c, auth) => {
      const rows = tenantRows(ds.machineVulnerabilities.all(), auth.tenantId).map((link) => {
        const vulnerability = ds.vulnerabilities
          .findBy("cve_id", link.cve_id)
          .find((candidate) => candidate.tenant_id === auth.tenantId);
        const software = link.software_id
          ? ds.software
              .findBy("software_id", link.software_id)
              .find((candidate) => candidate.tenant_id === auth.tenantId)
          : undefined;
        return {
          id: `${link.machine_id}-_-${link.cve_id}`,
          cveId: link.cve_id,
          machineId: link.machine_id,
          fixingKbId: link.fixing_kb_id,
          productName: software?.name ?? null,
          productVendor: software?.vendor ?? null,
          productVersion: link.product_version,
          severity: vulnerability?.severity ?? "Medium",
        };
      });
      return odataCollection(c, baseUrl, "MachineVulnerabilities", rows, odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/vulnerabilities/:id",
    api(ds, (c, auth) =>
      odataEntity(
        c,
        baseUrl,
        "Vulnerabilities",
        formatVulnerability(findVulnerability(ds, auth.tenantId, c.req.param("id"))),
      ),
    ),
  );

  route(
    app,
    "get",
    "/api/vulnerabilities/:id/machineReferences",
    api(ds, (c, auth) => {
      const vulnerability = findVulnerability(ds, auth.tenantId, c.req.param("id"));
      const references = tenantRows(ds.machineVulnerabilities.findBy("cve_id", vulnerability.cve_id), auth.tenantId)
        .map((link) => machineReference(auth.tenantId, link.machine_id))
        .filter((reference): reference is NonNullable<typeof reference> => !!reference);
      return odataCollection(c, baseUrl, "MachineReferences", references, odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/software",
    api(ds, (c, auth) =>
      odataCollection(
        c,
        baseUrl,
        "Software",
        tenantRows(ds.software.all(), auth.tenantId).map(formatSoftware),
        odataOptions(c),
      ),
    ),
  );

  route(
    app,
    "get",
    "/api/software/:id",
    api(ds, (c, auth) =>
      odataEntity(c, baseUrl, "Software", formatSoftware(findSoftware(ds, auth.tenantId, c.req.param("id")))),
    ),
  );

  route(
    app,
    "get",
    "/api/software/:id/machineReferences",
    api(ds, (c, auth) => {
      const software = findSoftware(ds, auth.tenantId, c.req.param("id"));
      const references = tenantRows(ds.machineSoftware.findBy("software_id", software.software_id), auth.tenantId)
        .map((link) => machineReference(auth.tenantId, link.machine_id))
        .filter((reference): reference is NonNullable<typeof reference> => !!reference);
      return odataCollection(c, baseUrl, "MachineReferences", references, odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/software/:id/vulnerabilities",
    api(ds, (c, auth) => {
      const software = findSoftware(ds, auth.tenantId, c.req.param("id"));
      const cveIds = new Set(
        tenantRows(ds.machineVulnerabilities.all(), auth.tenantId)
          .filter((link) => link.software_id === software.software_id)
          .map((link) => link.cve_id),
      );
      const vulnerabilities = tenantRows(ds.vulnerabilities.all(), auth.tenantId).filter((vulnerability) =>
        cveIds.has(vulnerability.cve_id),
      );
      return odataCollection(c, baseUrl, "Vulnerabilities", vulnerabilities.map(formatVulnerability), odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/software/:id/distributions",
    api(ds, (c, auth) => {
      const software = findSoftware(ds, auth.tenantId, c.req.param("id"));
      const byVersion = new Map<string, number>();
      for (const link of tenantRows(ds.machineSoftware.findBy("software_id", software.software_id), auth.tenantId))
        byVersion.set(link.version, (byVersion.get(link.version) ?? 0) + 1);
      const rows = [...byVersion.entries()].map(([version, installations]) => ({
        version,
        installations,
        vulnerabilities: tenantRows(ds.machineVulnerabilities.all(), auth.tenantId).filter(
          (link) => link.software_id === software.software_id && link.product_version === version,
        ).length,
      }));
      return odataCollection(c, baseUrl, "Distributions", rows, odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/recommendations",
    api(ds, (c, auth) =>
      odataCollection(
        c,
        baseUrl,
        "Recommendations",
        tenantRows(ds.recommendations.all(), auth.tenantId).map(formatRecommendation),
        odataOptions(c),
      ),
    ),
  );

  route(
    app,
    "get",
    "/api/recommendations/:id",
    api(ds, (c, auth) =>
      odataEntity(
        c,
        baseUrl,
        "Recommendations",
        formatRecommendation(findRecommendation(ds, auth.tenantId, c.req.param("id"))),
      ),
    ),
  );

  route(
    app,
    "get",
    "/api/recommendations/:id/machineReferences",
    api(ds, (c, auth) => {
      const recommendation = findRecommendation(ds, auth.tenantId, c.req.param("id"));
      const machineIds = new Set<string>();
      if (recommendation.software_id)
        for (const link of tenantRows(
          ds.machineSoftware.findBy("software_id", recommendation.software_id),
          auth.tenantId,
        ))
          machineIds.add(link.machine_id);
      for (const cve of recommendation.cve_ids)
        for (const link of tenantRows(ds.machineVulnerabilities.findBy("cve_id", cve), auth.tenantId))
          machineIds.add(link.machine_id);
      const references = [...machineIds]
        .map((machineId) => machineReference(auth.tenantId, machineId))
        .filter((reference): reference is NonNullable<typeof reference> => !!reference);
      return odataCollection(c, baseUrl, "MachineReferences", references, odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/recommendations/:id/software",
    api(ds, (c, auth) => {
      const recommendation = findRecommendation(ds, auth.tenantId, c.req.param("id"));
      if (!recommendation.software_id) return odataEntity(c, baseUrl, "Software", {});
      return odataEntity(
        c,
        baseUrl,
        "Software",
        formatSoftware(findSoftware(ds, auth.tenantId, recommendation.software_id)),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/recommendations/:id/vulnerabilities",
    api(ds, (c, auth) => {
      const recommendation = findRecommendation(ds, auth.tenantId, c.req.param("id"));
      const vulnerabilities = tenantRows(ds.vulnerabilities.all(), auth.tenantId).filter((vulnerability) =>
        recommendation.cve_ids.includes(vulnerability.cve_id),
      );
      return odataCollection(c, baseUrl, "Vulnerabilities", vulnerabilities.map(formatVulnerability), odataOptions(c));
    }),
  );

  const exposureScore = (tenantId: string, machineIds?: Set<string>) => {
    const machines = tenantRows(ds.machines.all(), tenantId).filter(
      (machine) => machine.onboardingStatus === "Onboarded" && (!machineIds || machineIds.has(machine.machine_id)),
    );
    if (machines.length === 0) return 0;
    const weights: Record<string, number> = { None: 0, Low: 20, Medium: 50, High: 85 };
    return (
      Math.round(
        (machines.reduce((sum, machine) => sum + (weights[machine.exposureLevel] ?? 0), 0) / machines.length) * 100,
      ) / 100
    );
  };

  route(
    app,
    "get",
    "/api/exposureScore",
    api(ds, (c, auth) =>
      odataEntity(c, baseUrl, "ExposureScore", {
        time: new Date().toISOString(),
        score: exposureScore(auth.tenantId),
        rbacGroupName: null,
      }),
    ),
  );

  route(
    app,
    "get",
    "/api/exposureScore/ByMachineGroups",
    api(ds, (c, auth) => {
      const groups = new Map<string, Set<string>>();
      for (const machine of tenantRows(ds.machines.all(), auth.tenantId)) {
        const name = machine.rbacGroupName ?? "Unassigned";
        if (!groups.has(name)) groups.set(name, new Set());
        groups.get(name)!.add(machine.machine_id);
      }
      const rows = [...groups.entries()].map(([rbacGroupName, ids]) => ({
        time: new Date().toISOString(),
        score: exposureScore(auth.tenantId, ids),
        rbacGroupName,
        rbacGroupId:
          tenantRows(ds.machines.all(), auth.tenantId).find(
            (machine) => (machine.rbacGroupName ?? "Unassigned") === rbacGroupName,
          )?.rbacGroupId ?? 0,
      }));
      return odataCollection(c, baseUrl, "ExposureScore", rows, odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/configurationScore",
    api(ds, (c, auth) => {
      const recommendations = tenantRows(ds.recommendations.all(), auth.tenantId).filter(
        (item) => item.recommendationCategory === "Security controls",
      );
      const score = Math.max(0, 100 - recommendations.reduce((sum, item) => sum + item.configScoreImpact, 0));
      return odataEntity(c, baseUrl, "ConfigurationScore", {
        time: new Date().toISOString(),
        score: Math.round(score * 100) / 100,
      });
    }),
  );

  route(
    app,
    "get",
    "/api/machines/:id/exposurescore",
    api(ds, (c, auth) => {
      const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
      return odataEntity(c, baseUrl, "ExposureScore", {
        time: new Date().toISOString(),
        score: exposureScore(auth.tenantId, new Set([machine.machine_id])),
        machineId: machine.machine_id,
        computerDnsName: machine.computerDnsName,
        ...formatMachine(machine),
      });
    }),
  );
}
