type Props = {
  workspaceName: string;
  userEmail: string;
  itemCount: number;
  sessionId: string | null;
};

export default function QuickAddHeader({ workspaceName, userEmail, itemCount, sessionId }: Props) {
  return (
    <header className="flex items-center gap-4 border-b border-zinc-200 bg-white px-4 py-3">
      <span className="text-lg font-bold text-zinc-900">Photobox</span>
      <span className="text-zinc-300">|</span>
      <span className="text-sm font-medium text-zinc-700">{workspaceName}</span>
      <a href="/gallery" className="text-sm text-zinc-500 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1">Gallery</a>
      <a href="/masters" className="text-sm text-zinc-500 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1">Masters</a>
      <a href="/import" className="text-sm text-zinc-500 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1">Import</a>
      <span className="ml-auto flex items-center gap-4 text-xs text-zinc-500">
        {sessionId && (
          <span className="font-mono">
            session: {sessionId.slice(0, 8)}
          </span>
        )}
        <span>{itemCount} items</span>
        <span>{userEmail}</span>
      </span>
    </header>
  );
}
