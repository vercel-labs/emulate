import { defineEmulator } from "emulate";

export default defineEmulator({
  name: "inventory",
  state: () => ({
    stock: 10,
    nextId: 1,
    reservations: [] as Array<{ id: string }>,
  }),

  setup({ app, state }) {
    app.get("/inventory", (c) => c.json({ stock: state.stock }));
    app.get("/reservations", (c) => c.json(state.reservations));
    app.get("/reservations/:id", (c) => {
      const reservation = state.reservations.find((item) => item.id === c.req.param("id"));
      return reservation ? c.json(reservation) : c.json({ error: "not_found" }, 404);
    });

    app.post("/reservations", (c) => {
      if (state.stock < 1) return c.json({ error: "out_of_stock" }, 409);
      const reservation = { id: "r_" + state.nextId++ };
      state.stock -= 1;
      state.reservations.push(reservation);
      return c.json(reservation, 201);
    });

    app.delete("/reservations/:id", (c) => {
      const index = state.reservations.findIndex((item) => item.id === c.req.param("id"));
      if (index < 0) return c.json({ error: "not_found" }, 404);
      state.reservations.splice(index, 1);
      state.stock += 1;
      return c.body(null, 204);
    });
  },
});
