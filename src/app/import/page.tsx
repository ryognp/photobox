import { requireUser } from "@/lib/auth";
import ImportClient from "./ImportClient";

export default async function ImportPage() {
  await requireUser();
  return <ImportClient />;
}
