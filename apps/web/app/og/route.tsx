import { getPageTitle } from "@/lib/page-titles";
import { renderLabsOg } from "./labs-og";

export async function GET() {
  const title = getPageTitle("")!;
  return renderLabsOg({ product: "emulate", title });
}
