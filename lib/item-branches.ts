type BranchItem = {
  id: string;
  parentId: string | null;
  section: string;
  groupName: string;
  archived: boolean;
  completed: boolean;
};

export type BranchLayout = {
  depth: number;
  lastChild: boolean;
  continuations: number[];
  childCount: number;
  completedChildren: number;
};

export function isBranchParent(parent: BranchItem | undefined, child: BranchItem) {
  return Boolean(parent && parent.id !== child.id && parent.section === child.section &&
    parent.groupName === child.groupName && parent.archived === child.archived);
}

function branchIndex<T extends BranchItem>(items: T[]) {
  const byId = new Map(items.map(item => [item.id, item]));
  const parents = new Map<string, string>();
  for (const item of items) {
    if (item.parentId && isBranchParent(byId.get(item.parentId), item)) {
      parents.set(item.id, item.parentId);
    }
  }
  // Bad legacy links must never trap rendering or completion in a cycle.
  for (const item of items) {
    const seen = new Set([item.id]);
    let parentId = parents.get(item.id);
    while (parentId) {
      if (seen.has(parentId)) { parents.delete(item.id); break; }
      seen.add(parentId);
      parentId = parents.get(parentId);
    }
  }
  const children = new Map<string, T[]>();
  for (const item of items) {
    const parentId = parents.get(item.id);
    if (parentId) children.set(parentId, [...(children.get(parentId) ?? []), item]);
  }
  return { byId, parents, children };
}

/** Input order is the visible preorder, after filtering and sorting. */
export function getBranchLayouts<T extends BranchItem>(items: T[]) {
  const { parents, children } = branchIndex(items);
  const isLast = (id: string) => {
    const siblings = children.get(parents.get(id) ?? "") ?? [];
    return siblings[siblings.length - 1]?.id === id;
  };
  return new Map(items.map(item => {
    const path = [item.id];
    let parentId = parents.get(item.id);
    while (parentId) { path.unshift(parentId); parentId = parents.get(parentId); }
    const depth = path.length - 1;
    const directChildren = children.get(item.id) ?? [];
    const continuations: number[] = [];
    // Carry an ancestor's rail through a nested branch if a later sibling follows.
    for (let level = 1; level < depth; level++) {
      if (!isLast(path[level])) continuations.push(depth - level + 1);
    }
    return [item.id, {
      depth, lastChild: isLast(item.id), continuations,
      childCount: directChildren.length,
      completedChildren: directChildren.filter(child => child.completed).length,
    } satisfies BranchLayout];
  }));
}

/** Complete descendants; reopening a child reopens its ancestors, preserving siblings. */
export function getCompletionPatches<T extends BranchItem>(items: T[], id: string, completed: boolean) {
  const { byId, parents, children } = branchIndex(items);
  const patches = new Map<string, { completed: boolean; priority?: "none" }>();
  if (!byId.has(id)) return patches;
  patches.set(id, completed ? { completed: true, priority: "none" } : { completed: false });
  if (completed) {
    const pending = [...(children.get(id) ?? [])];
    while (pending.length) {
      const child = pending.pop()!;
      if (!child.completed) patches.set(child.id, { completed: true, priority: "none" });
      pending.push(...(children.get(child.id) ?? []));
    }
  } else {
    let parentId = parents.get(id);
    while (parentId) {
      if (byId.get(parentId)?.completed) patches.set(parentId, { completed: false });
      parentId = parents.get(parentId);
    }
  }
  return patches;
}

/** Lifecycle operations follow saved links, including branches split by older archives. */
export function getBranchItems<T extends BranchItem>(items: T[], rootIds: string[]) {
  const included = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.parentId && included.has(item.parentId) && !included.has(item.id)) {
        included.add(item.id);
        changed = true;
      }
    }
  }
  return items.filter(item => included.has(item.id));
}

export function getArchivePatches<T extends BranchItem>(items: T[], id: string, archived: boolean, archivedAt: string | null) {
  const targets = getBranchItems(items, [id]);
  const patches = new Map(targets.map(item => [item.id, { archived, archivedAt }]));
  if (!archived) {
    const byId = new Map(items.map(item => [item.id, item]));
    const seen = new Set([id]);
    let parentId = byId.get(id)?.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      if (byId.has(parentId)) patches.set(parentId, { archived: false, archivedAt: null });
      parentId = byId.get(parentId)?.parentId;
    }
  }
  return patches;
}

/** Display legacy split archives together without silently rewriting stored records. */
export function getArchiveViewItems<T extends BranchItem & { archivedAt: string | null }>(items: T[]): T[] {
  const byId = new Map(items.map(item => [item.id, item]));
  return items.map(item => {
    const seen = new Set([item.id]);
    let parentId = item.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (parent?.archived) return { ...item, archived: true, archivedAt: item.archivedAt ?? parent.archivedAt };
      parentId = parent?.parentId ?? null;
    }
    return item;
  });
}
