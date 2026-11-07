/**
 * In-memory implementation of the lib/github.js createGitHub() interface.
 *
 * Writes change the fake's state, so tests can assert on the end result
 * (e.g. "the issue is closed and has a comment"). Every call is recorded in
 * `gh.calls` as { method, args }. Use `failures` to make a method throw:
 *   createFakeGitHub({ failures: { listOpenIssues: (org, repo) => repo === 'ospo' && notFound() } })
 * A failure function throws whatever truthy value it returns.
 */

export function notFound(message = 'Not Found') {
  return Object.assign(new Error(message), { status: 404 });
}

const slugify = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const clone = value => structuredClone(value);

export function createFakeGitHub({
  repos = [],
  issues = {},
  teams = [],
  teamRepos = {},
  teamSyncGroups = [],
  securityConfigs = [],
  securityConfigRepos = {},
  rulesets = [],
  sbomUrls = {},
  advisories = {},
  failures = {},
  now = () => new Date('2026-01-01T00:00:00Z'),
} = {}) {
  const state = {
    repos: clone(repos),
    issues: clone(issues),
    teams: clone(teams),
    teamRepos: clone(teamRepos),
    teamSyncMappings: {},
    teamSyncGroups: clone(teamSyncGroups),
    securityConfigs: clone(securityConfigs),
    securityConfigRepos: clone(securityConfigRepos),
    rulesets: clone(rulesets),
    sbomUrls: { ...sbomUrls },
    advisories: clone(advisories),
  };
  const calls = [];
  let nextRepoId = Math.max(1000, ...state.repos.map(r => r.id ?? 0)) + 1;
  let nextIssueNumber = 1 + Math.max(0, ...Object.values(state.issues).flat().map(i => i.number ?? 0));

  const issuesOf = repo => (state.issues[repo] ??= []);
  const issueOf = (repo, number) => {
    const issue = issuesOf(repo).find(i => i.number === number);
    if (!issue) throw notFound(`Issue #${number} not found in ${repo}`);
    return issue;
  };
  const repoIdToName = id => state.repos.find(r => r.id === id)?.name;

  const methods = {
    listOrgRepos: (org, { type } = {}) =>
      clone(type === 'public' ? state.repos.filter(r => (r.visibility ?? 'public') === 'public') : state.repos),

    createRepo: (org, name) => {
      const repo = { name, id: nextRepoId++, archived: false, visibility: 'public' };
      state.repos.push(repo);
      return clone(repo);
    },

    archiveRepo: (org, repo) => {
      state.repos.find(r => r.name === repo).archived = true;
    },

    listOpenIssues: (org, repo) => clone(issuesOf(repo).filter(i => (i.state ?? 'open') === 'open')),

    createIssue: (org, repo, { title, body }) => {
      const issue = { number: nextIssueNumber++, title, body, state: 'open', created_at: now().toISOString(), comments: [] };
      issuesOf(repo).push(issue);
      return clone(issue);
    },

    updateIssue: (org, repo, number, { body }) => {
      issueOf(repo, number).body = body;
    },

    commentIssue: (org, repo, number, body) => {
      const issue = issueOf(repo, number);
      (issue.comments ??= []).push(body);
    },

    closeIssue: (org, repo, number) => {
      issueOf(repo, number).state = 'closed';
    },

    listTeams: () => clone(state.teams),

    createTeam: (org, name) => {
      const team = { name, slug: slugify(name) };
      state.teams.push(team);
      return clone(team);
    },

    deleteTeam: (org, teamSlug) => {
      state.teams = state.teams.filter(t => t.slug !== teamSlug);
      delete state.teamRepos[teamSlug];
    },

    listTeamRepos: (org, teamSlug) => clone(state.teamRepos[teamSlug] ?? []),

    setTeamRepoPermission: (org, teamSlug, repo, permission) => {
      const list = (state.teamRepos[teamSlug] ??= []);
      const existing = list.find(r => r.name === repo);
      if (existing) existing.role_name = permission;
      else list.push({ name: repo, role_name: permission });
    },

    removeTeamRepo: (org, teamSlug, repo) => {
      state.teamRepos[teamSlug] = (state.teamRepos[teamSlug] ?? []).filter(r => r.name !== repo);
    },

    searchTeamSyncGroups: (org, query) => clone(state.teamSyncGroups.filter(g => g.group_name.includes(query))),

    setTeamSyncGroups: (org, teamSlug, groups) => {
      state.teamSyncMappings[teamSlug] = clone(groups);
    },

    listSecurityConfigs: () => clone(state.securityConfigs),

    listSecurityConfigRepos: (org, configurationId) =>
      (state.securityConfigRepos[configurationId] ?? []).map(name => ({ repository: { name } })),

    attachSecurityConfig: (org, configurationId, repoIds) => {
      const names = repoIds.map(repoIdToName);
      for (const [id, list] of Object.entries(state.securityConfigRepos)) {
        state.securityConfigRepos[id] = list.filter(n => !names.includes(n));
      }
      (state.securityConfigRepos[configurationId] ??= []).push(...names);
    },

    listOrgRulesets: () => state.rulesets.map(({ id, name }) => ({ id, name })),

    getOrgRuleset: (org, rulesetId) => {
      const ruleset = state.rulesets.find(r => r.id === rulesetId);
      if (!ruleset) throw notFound(`Ruleset ${rulesetId} not found`);
      return clone(ruleset);
    },

    updateOrgRuleset: (org, rulesetId, ruleset) => {
      const index = state.rulesets.findIndex(r => r.id === rulesetId);
      state.rulesets[index] = { id: rulesetId, ...clone(ruleset) };
    },

    requestSbomReport: (org, repo) => state.sbomUrls[repo],

    listPublishedAdvisories: (org, repo) => clone((state.advisories[repo] ?? []).filter(a => (a.state ?? 'published') === 'published')),
  };

  const gh = { calls, state };
  for (const [name, impl] of Object.entries(methods)) {
    gh[name] = async (...args) => {
      calls.push({ method: name, args: clone(args) });
      const failure = failures[name]?.(...args);
      if (failure) throw failure;
      return impl(...args);
    };
  }
  /** Calls of one method, e.g. gh.callsTo('createIssue'). */
  gh.callsTo = method => calls.filter(c => c.method === method);
  /** Calls that change state on GitHub (everything except list/get/search/request). */
  gh.writes = () => calls.filter(c => !/^(list|get|search|request)/.test(c.method));
  return gh;
}
