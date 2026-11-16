import { unsupported } from "./unsupported";

export const Readable = {
  toWeb(): never {
    throw unsupported("stream.Readable.toWeb");
  },
};
