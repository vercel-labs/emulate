import { createEmulateHandler } from "@emulators/adapter-next";
import { services } from "@/lib/emulators";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createEmulateHandler({ services });
