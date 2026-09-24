import { prepareProject, type ProjectOptions, type RetainedSeed } from "./project-runner.js";

let run: Awaited<ReturnType<typeof prepareProject>> | undefined;
let handling = Promise.resolve();
process.on(
  "message",
  (message: { type: string; options?: ProjectOptions; retained?: Record<string, RetainedSeed>; reload?: boolean }) => {
    handling = handling.then(async () => {
      try {
        if (message.type === "prepare") {
          run = await prepareProject(message.options!, message.retained, message.reload, (dependencies) => {
            if (process.connected) process.send?.({ type: "dependencies", dependencies }, () => {});
          });
          process.send?.({ type: "prepared", metadata: run.metadata });
        } else if (message.type === "start") {
          run!.watchDependencies((dependencies) => {
            if (process.connected) process.send?.({ type: "dependencies", dependencies }, () => {});
          });
          await run!.start();
          process.send?.({ type: "started" });
        } else if (message.type === "close") {
          await run?.close();
          process.send?.({ type: "closed" });
          process.disconnect();
        }
      } catch (error) {
        process.send?.({ type: "error", error: error instanceof Error ? error.stack : String(error) });
      }
    });
  },
);
process.on("disconnect", () => {
  const timer = setTimeout(() => process.exit(1), 7000);
  void (run?.close() ?? Promise.resolve()).catch(console.error).finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
});
