import { requireUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import QuickAddClient from "./QuickAddClient";

export default async function QuickAddPage() {
  const user = await requireUser();
  const workspace = await getDefaultWorkspaceForUser(user.id);

  if (!workspace) {
    return (
      <main id="main-content" className="flex min-h-full flex-col items-center justify-center gap-4 p-8">
        <h1 className="text-xl font-semibold text-zinc-900">Photobox</h1>
        <p className="text-red-600">Workspace が見つかりません。</p>
        <p className="text-sm text-zinc-500">
          <code className="rounded bg-zinc-100 px-1 py-0.5">POST /api/auth/complete</code> を呼び出して workspace を作成してください。
        </p>
      </main>
    );
  }

  return (
    <QuickAddClient
      userEmail={user.email ?? ""}
      workspaceId={workspace.id}
      workspaceName={workspace.name}
    />
  );
}
