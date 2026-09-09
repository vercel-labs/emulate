import { processDueRenewals } from "../billing.js";
import { formatTimeMachine } from "../formatters.js";
import { notFound, num, paramError, parseChargebeeBody } from "../helpers.js";
import { TIME_MACHINE_ID } from "../ids.js";
import { clearSiteData, nowSeconds, resetClock, setClockTo, setGenesisTime } from "../store.js";
import { api, type ChargebeeRouteContext } from "../route-utils.js";

const ONE_DAY_SECONDS = 86400;

export function timeMachineRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, ctx } = rc;

  app.get(
    "/api/v2/time_machines/:id",
    api(cs, (c) => {
      if (c.req.param("id") !== TIME_MACHINE_ID) return notFound(c);
      return c.json({ time_machine: formatTimeMachine(cs) });
    }),
  );

  app.post(
    "/api/v2/time_machines/:id/travel_forward",
    api(cs, async (c) => {
      if (c.req.param("id") !== TIME_MACHINE_ID) return notFound(c);
      const body = await parseChargebeeBody(c);
      const now = nowSeconds(cs);
      const destination = num(body.destination_time) ?? now + ONE_DAY_SECONDS;
      if (destination < now) throw paramError("destination_time", "must be in the future");
      setClockTo(cs, destination);
      await processDueRenewals(ctx);
      return c.json({ time_machine: formatTimeMachine(cs) });
    }),
  );

  app.post(
    "/api/v2/time_machines/:id/start_afresh",
    api(cs, async (c) => {
      if (c.req.param("id") !== TIME_MACHINE_ID) return notFound(c);
      const body = await parseChargebeeBody(c);
      const genesis = num(body.genesis_time);
      clearSiteData(cs);
      if (genesis !== undefined) {
        setClockTo(cs, genesis);
        setGenesisTime(cs, genesis);
      } else {
        resetClock(cs);
        setGenesisTime(cs, nowSeconds(cs));
      }
      return c.json({ time_machine: formatTimeMachine(cs) });
    }),
  );
}
