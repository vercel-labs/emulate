import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { flows } from "@/lib/playgrounds";

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 p-6 md:p-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">emulate playground</h1>
        <p className="text-sm text-muted-foreground">
          The emulators these flows use run inside this app under <code className="font-mono">/emulate</code>. Pick a
          flow to try one.
        </p>
      </header>
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">Flows</h2>
          <p className="text-sm text-muted-foreground">
            Small apps that use an emulator the way production code would.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {flows.map((flow) => (
            <Link key={flow.href} href={flow.href} className="rounded-xl outline-none focus-visible:ring-3">
              <Card className="h-full transition-colors hover:bg-muted/50">
                <CardHeader>
                  <CardTitle>{flow.label}</CardTitle>
                  <CardDescription>{flow.description}</CardDescription>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {flow.services.map((service) => (
                      <Badge key={service} variant="secondary">
                        {service}
                      </Badge>
                    ))}
                  </div>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </section>
      <p className="text-sm text-muted-foreground">
        The request consoles for every emulator live on the website, at{" "}
        <a href="https://emulate.dev/playground" className="underline underline-offset-4 hover:text-foreground">
          emulate.dev/playground
        </a>
        .
      </p>
    </div>
  );
}
