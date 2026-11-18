import type { MetadataRoute } from "next";
import { allDocsPages } from "@/lib/docs-navigation";
import { flows } from "@/lib/playground/flows";
import { consoleServices } from "@/lib/playground/services";
import { canonicalUrlFor } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const playground = [
    "/playground",
    ...flows.map((flow) => `/playground/flows/${flow.slug}`),
    ...consoleServices.map((service) => `/playground/${service.name}`),
  ];
  return ["/", ...allDocsPages.map((page) => page.href), ...playground].map((href) => ({ url: canonicalUrlFor(href) }));
}
