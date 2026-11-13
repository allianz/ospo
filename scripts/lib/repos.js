/**
 * Splits org repositories into the three groups every checking script reports on.
 * Exclusion wins over archived. The input order is kept.
 */
export function partitionRepos(repos, excludedNames = []) {
  const excludedSet = new Set(excludedNames);
  const result = { active: [], archived: [], excluded: [] };
  for (const repo of repos) {
    if (excludedSet.has(repo.name)) result.excluded.push(repo);
    else if (repo.archived) result.archived.push(repo);
    else result.active.push(repo);
  }
  return result;
}

export function byName(a, b) {
  return a.name.localeCompare(b.name);
}
