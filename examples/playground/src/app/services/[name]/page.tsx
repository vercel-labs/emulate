import { notFound } from "next/navigation";
import { ApiConsole } from "@/components/api-console";
import { getSession } from "@/lib/oauth/session";
import { consoleServices } from "@/lib/services";

export default async function ServiceConsolePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const service = consoleServices.find((item) => item.name === name);
  if (!service) notFound();

  const session = await getSession();
  const base = `/emulate/${service.name}`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 p-6 md:p-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{service.label}</h1>
        <p className="text-sm text-muted-foreground">{service.description}</p>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <code className="font-mono text-muted-foreground">{base}</code>
          {service.inspectorPath !== undefined && (
            <a
              href={`${base}${service.inspectorPath}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Open inspector
            </a>
          )}
        </div>
      </header>
      <ApiConsole
        key={service.name}
        name={service.name}
        groups={service.groups}
        variables={service.variables ?? []}
        initialValues={session?.provider === service.name ? { token: session.accessToken } : {}}
      />
    </div>
  );
}
