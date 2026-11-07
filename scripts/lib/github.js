import { Octokit } from '@octokit/rest';

export const API_VERSION = '2026-03-10';

const noop = () => {};

/**
 * Creates the Octokit client used by every script:
 * - pins X-GitHub-Api-Version on every request (avoids deprecation warnings on PATCH/issue endpoints)
 * - silences Octokit's own logging so it doesn't interleave with script output
 * `options` is passed through to Octokit (tests use it to inject `request.fetch`).
 */
export function createOctokit(token, options = {}) {
  const octokit = new Octokit({
    auth: token,
    log: { debug: noop, info: noop, warn: noop, error: noop },
    ...options,
  });
  octokit.hook.before('request', requestOptions => {
    requestOptions.headers['X-GitHub-Api-Version'] = API_VERSION;
  });
  return octokit;
}

export function isNotFound(err) {
  return err?.status === 404;
}

/**
 * Thin wrapper with one named method per GitHub operation the scripts use.
 * Scripts depend only on this interface; tests replace it with test/helpers/fake_github.js.
 */
export function createGitHub(octokit) {
  const { rest } = octokit;
  return {
    // ── Repositories ─────────────────────────────────────────────────────────
    listOrgRepos: (org, { type } = {}) =>
      octokit.paginate(rest.repos.listForOrg, { org, per_page: 100, ...(type && { type }) }),

    createRepo: async (org, name) =>
      (await rest.repos.createInOrg({ org, name, visibility: 'public', auto_init: true })).data,

    archiveRepo: async (org, repo) => {
      await rest.repos.update({ owner: org, repo, archived: true });
    },

    // ── Issues ───────────────────────────────────────────────────────────────
    listOpenIssues: (org, repo) =>
      octokit.paginate(rest.issues.listForRepo, { owner: org, repo, state: 'open', per_page: 100 }),

    createIssue: async (org, repo, { title, body }) =>
      (await rest.issues.create({ owner: org, repo, title, body })).data,

    updateIssue: async (org, repo, number, { body }) => {
      await rest.issues.update({ owner: org, repo, issue_number: number, body });
    },

    commentIssue: async (org, repo, number, body) => {
      await rest.issues.createComment({ owner: org, repo, issue_number: number, body });
    },

    closeIssue: async (org, repo, number) => {
      await rest.issues.update({ owner: org, repo, issue_number: number, state: 'closed' });
    },

    // ── Teams ────────────────────────────────────────────────────────────────
    listTeams: org => octokit.paginate(rest.teams.list, { org, per_page: 100 }),

    createTeam: async (org, name) =>
      (await rest.teams.create({ org, name, privacy: 'closed' })).data,

    deleteTeam: async (org, teamSlug) => {
      await rest.teams.deleteInOrg({ org, team_slug: teamSlug });
    },

    listTeamRepos: (org, teamSlug) =>
      octokit.paginate(rest.teams.listReposInOrg, { org, team_slug: teamSlug, per_page: 100 }),

    setTeamRepoPermission: async (org, teamSlug, repo, permission) => {
      await rest.teams.addOrUpdateRepoPermissionsInOrg({ org, team_slug: teamSlug, owner: org, repo, permission });
    },

    removeTeamRepo: async (org, teamSlug, repo) => {
      await rest.teams.removeRepoInOrg({ org, team_slug: teamSlug, owner: org, repo });
    },

    // ── Team sync (Entra ID) ─────────────────────────────────────────────────
    searchTeamSyncGroups: async (org, query) =>
      (await octokit.request('GET /orgs/{org}/team-sync/groups', { org, q: query })).data.groups ?? [],

    setTeamSyncGroups: async (org, teamSlug, groups) => {
      await octokit.request('PATCH /orgs/{org}/teams/{team_slug}/team-sync/group-mappings', {
        org,
        team_slug: teamSlug,
        groups,
      });
    },

    // ── Code security configurations ─────────────────────────────────────────
    listSecurityConfigs: async org =>
      (await octokit.request('GET /orgs/{org}/code-security/configurations', { org })).data,

    listSecurityConfigRepos: (org, configurationId) =>
      octokit.paginate('GET /orgs/{org}/code-security/configurations/{configuration_id}/repositories', {
        org,
        configuration_id: configurationId,
        per_page: 100,
      }),

    attachSecurityConfig: async (org, configurationId, repoIds) => {
      await octokit.request('POST /orgs/{org}/code-security/configurations/{configuration_id}/attach', {
        org,
        configuration_id: configurationId,
        scope: 'selected', // required, otherwise 422 "missing required key: scope"
        selected_repository_ids: repoIds,
      });
    },

    // ── Rulesets ─────────────────────────────────────────────────────────────
    listOrgRulesets: async org => (await octokit.request('GET /orgs/{org}/rulesets', { org })).data,

    getOrgRuleset: async (org, rulesetId) =>
      (await octokit.request('GET /orgs/{org}/rulesets/{ruleset_id}', { org, ruleset_id: rulesetId })).data,

    updateOrgRuleset: async (org, rulesetId, ruleset) => {
      await octokit.request('PUT /orgs/{org}/rulesets/{ruleset_id}', { org, ruleset_id: rulesetId, ...ruleset });
    },

    // ── Dependency graph ─────────────────────────────────────────────────────
    /** Starts SBOM generation and returns the URL to poll (or undefined if GitHub returned none). */
    requestSbomReport: async (org, repo) =>
      (await octokit.request('GET /repos/{owner}/{repo}/dependency-graph/sbom/generate-report', { owner: org, repo }))
        .data?.sbom_url,

    // ── Security advisories ──────────────────────────────────────────────────
    /** The published (public) security advisories of a repository. */
    listPublishedAdvisories: (org, repo) =>
      octokit.paginate(rest.securityAdvisories.listRepositoryAdvisories, { owner: org, repo, state: 'published', per_page: 100 }),

    // ── Releases and contents ────────────────────────────────────────────────
    /** All releases of a repository, including drafts (visible to tokens with push access). */
    listReleases: (org, repo) => octokit.paginate(rest.repos.listReleases, { owner: org, repo, per_page: 100 }),

    /** Names of the files in the root directory of the default branch. */
    listRootFiles: async (org, repo) =>
      (await rest.repos.getContent({ owner: org, repo, path: '' })).data.filter(e => e.type === 'file').map(e => e.name),

    /** The text of a file on the default branch. */
    getFileText: async (org, repo, filePath) =>
      String((await rest.repos.getContent({ owner: org, repo, path: filePath, mediaType: { format: 'raw' } })).data),
  };
}
