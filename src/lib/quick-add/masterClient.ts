// Types
export type Scene = { id: string; name: string; description: string | null };
export type Tag = { id: string; name: string };
export type Person = { id: string; name: string; notes: string | null; defaultPromptHint: string | null };

// Scenes
export async function fetchScenes(): Promise<Scene[]> {
  const r = await fetch("/api/scenes");
  if (!r.ok) throw new Error("シーン一覧の取得に失敗しました");
  const json = await r.json() as { data: Scene[] };
  return json.data;
}

export async function createScene(name: string, description?: string): Promise<Scene> {
  const r = await fetch("/api/scenes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...(description ? { description } : {}) }),
  });
  if (!r.ok) {
    const json = await r.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(json.error?.message ?? "シーン作成に失敗しました");
  }
  const json = await r.json() as { data: Scene };
  return json.data;
}

// Tags
export async function fetchTags(): Promise<Tag[]> {
  const r = await fetch("/api/tags");
  if (!r.ok) throw new Error("タグ一覧の取得に失敗しました");
  const json = await r.json() as { data: Tag[] };
  return json.data;
}

export async function createTag(name: string): Promise<Tag> {
  const r = await fetch("/api/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) {
    const json = await r.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(json.error?.message ?? "タグ作成に失敗しました");
  }
  const json = await r.json() as { data: Tag };
  return json.data;
}

// Persons
export async function fetchPersons(): Promise<Person[]> {
  const r = await fetch("/api/persons");
  if (!r.ok) throw new Error("人物一覧の取得に失敗しました");
  const json = await r.json() as { data: Person[] };
  return json.data;
}

export async function createPerson(name: string, notes?: string, defaultPromptHint?: string): Promise<Person> {
  const r = await fetch("/api/persons", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...(notes ? { notes } : {}), ...(defaultPromptHint ? { defaultPromptHint } : {}) }),
  });
  if (!r.ok) {
    const json = await r.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(json.error?.message ?? "人物作成に失敗しました");
  }
  const json = await r.json() as { data: Person };
  return json.data;
}
