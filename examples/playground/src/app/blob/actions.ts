"use server";

import { put, del } from "@/lib/blob/blob";
import { sharePathForPathname } from "@/lib/blob/share-url";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function uploadFileAction(
  _prev: { error: string } | null,
  formData: FormData,
): Promise<{ error: string }> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a file to upload" };
  }

  let pathname: string;
  try {
    const blob = await put(file.name, file, {
      access: "public",
      addRandomSuffix: true,
      contentType: file.type || undefined,
    });
    pathname = blob.pathname;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Upload failed" };
  }

  redirect(sharePathForPathname(pathname));
}

export async function deleteFileAction(url: string) {
  if (url) await del(url);
  revalidatePath("/blob");
}
