import { unsupported } from "./unsupported";

export async function readFile(): Promise<never> {
  throw unsupported("fs/promises.readFile");
}

export async function mkdir(): Promise<never> {
  throw unsupported("fs/promises.mkdir");
}

export async function open(): Promise<never> {
  throw unsupported("fs/promises.open");
}

export async function link(): Promise<never> {
  throw unsupported("fs/promises.link");
}

export async function rename(): Promise<never> {
  throw unsupported("fs/promises.rename");
}

export async function unlink(): Promise<never> {
  throw unsupported("fs/promises.unlink");
}
