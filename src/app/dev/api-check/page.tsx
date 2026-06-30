import { notFound } from "next/navigation";
import { requireUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import ApiCheckClient from "./ApiCheckClient";

export default async function ApiCheckPage() {
  if (process.env.ENABLE_DEV_API_CHECK !== "true") notFound();

  const user = await requireUser();
  const workspace = await getDefaultWorkspaceForUser(user.id);

  if (!workspace) {
    return (
      <main className="p-8">
        <p className="text-red-600">Workspace が見つかりません。/api/auth/complete を呼び出してください。</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 p-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center gap-4 mb-4">
          <h1 className="text-2xl font-bold text-zinc-900">Photobox API Check</h1>
          <div className="flex gap-3 ml-auto text-sm">
            <a href="/gallery" className="text-zinc-500 hover:text-zinc-900">Gallery</a>
            <a href="/quick-add" className="text-zinc-500 hover:text-zinc-900">Quick Add</a>
            <a href="/masters" className="text-zinc-500 hover:text-zinc-900">Masters</a>
            <a href="/import" className="text-zinc-500 hover:text-zinc-900">Import</a>
          </div>
        </div>
        <div className="flex gap-4 text-sm text-zinc-500">
          <span>Logged in as: <strong className="text-zinc-700">{user.email}</strong></span>
          <span>Workspace: <strong className="text-zinc-700">{workspace.name}</strong></span>
        </div>
        <ApiCheckClient />
      </div>
    </main>
  );
}
