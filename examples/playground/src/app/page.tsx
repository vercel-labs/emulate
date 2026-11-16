import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { flows } from "@/lib/playgrounds";
import { consoleServices } from "@/lib/services";

const sections = [
  {
    title: "Flows",
    intro: "Small apps that use an emulator the way production code would.",
    items: flows.map((flow) => ({ ...flow, badges: flow.services })),
  },
  {
    title: "API consoles",
    intro: "Send requests to an emulator and read the response.",
    items: consoleServices.map((service) => ({
      href: `/services/${service.name}`,
      label: service.label,
      description: service.description,
      badges: [service.name],
    })),
  },
];

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 p-6 md:p-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">emulate playground</h1>
        <p className="text-sm text-muted-foreground">
          Every emulator runs inside this app under <code className="font-mono">/emulate</code>. Pick a playground to
          try one.
        </p>
      </header>
      {sections.map((section) => (
        <section key={section.title} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium">{section.title}</h2>
            <p className="text-sm text-muted-foreground">{section.intro}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {section.items.map((item) => (
              <Link key={item.href} href={item.href} className="rounded-xl outline-none focus-visible:ring-3">
                <Card className="h-full transition-colors hover:bg-muted/50">
                  <CardHeader>
                    <CardTitle>{item.label}</CardTitle>
                    <CardDescription>{item.description}</CardDescription>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {item.badges.map((badge) => (
                        <Badge key={badge} variant="secondary">
                          {badge}
                        </Badge>
                      ))}
                    </div>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
