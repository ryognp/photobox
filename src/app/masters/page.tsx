import { requireUser } from "@/lib/auth";
import MastersClient from "./MastersClient";

export default async function MastersPage() {
  await requireUser();
  return <MastersClient />;
}
