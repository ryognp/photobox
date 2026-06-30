import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import CommitPreviewClient from "./CommitPreviewClient";

export default async function CommitPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ sessionId?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/quick-add/commit");

  const { sessionId } = await searchParams;
  if (!sessionId) redirect("/quick-add");

  return <CommitPreviewClient sessionId={sessionId} />;
}
