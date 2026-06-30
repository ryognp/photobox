import { requireUser } from "@/lib/auth";
import GalleryClient from "./GalleryClient";

export default async function GalleryPage() {
  await requireUser();
  return <GalleryClient />;
}
