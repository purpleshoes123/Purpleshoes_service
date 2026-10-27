export function diffSets(current: Set<string>, target: Set<string>): {
  toRemove: string[];
  toAdd: string[];
} {
  const toRemove: string[] = [];
  const toAdd: string[] = [];

  for (const code of current) {
    if (!target.has(code)) {
      toRemove.push(code);
    }
  }

  for (const code of target) {
    if (!current.has(code)) {
      toAdd.push(code);
    }
  }

  return { toRemove, toAdd };
}
