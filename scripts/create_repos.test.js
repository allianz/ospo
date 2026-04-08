import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  createRepositories,
  processTeams,
  enforceSecurityConfig,
  enforceBranchProtection,
} from './create_repos.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOctokit(overrides = {}) {
  const paginate = overrides.paginate ?? (async () => []);
  return {
    paginate,
    rest: {
      repos: {
        listForOrg: Symbol('listForOrg'),
        createInOrg: overrides.createInOrg ?? (async () => ({ data: {} })),
      },
      teams: {
        list: Symbol('list'),
        listReposInOrg: Symbol('listReposInOrg'),
        create: overrides.teamsCreate ?? (async () => ({ data: { slug: 'new-team', name: 'New Team' } })),
        addOrUpdateRepoPermissionsInOrg: overrides.addOrUpdateRepo ?? (async () => {}),
        removeRepoInOrg: overrides.removeRepo ?? (async () => {}),
        deleteInOrg: overrides.deleteTeam ?? (async () => {}),
      },
    },
    request: overrides.request ?? (async () => ({ data: [] })),
  };
}

// ── loadConfig ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let tmpDir;
  before(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), 'create-repos-test-')); });
  after(async () => { await rm(tmpDir, { recursive: true }); });

  it('parses a valid minimal config', async () => {
    const file = path.join(tmpDir, 'minimal.yaml');
    await writeFile(file, 'repositories:\n  - name: "my-repo"\n');
    const cfg = await loadConfig(file);
    assert.equal(cfg.repositories.length, 1);
    assert.equal(cfg.repositories[0].name, 'my-repo');
    assert.equal(cfg.repositories[0].security, 'managed');
    assert.equal(cfg.repositories[0]['branch-protection'], 'managed');
    assert.deepEqual(cfg.repositories[0].teams, []);
  });

  it('parses a config with teams', async () => {
    const file = path.join(tmpDir, 'with-teams.yaml');
    await writeFile(file, [
      'repositories:',
      '  - name: "my-repo"',
      '    teams:',
      '      - name: "My Team"',
    ].join('\n'));
    const cfg = await loadConfig(file);
    assert.equal(cfg.repositories[0].teams.length, 1);
    assert.equal(cfg.repositories[0].teams[0].name, 'My Team');
  });

  it('preserves explicit security and branch-protection values', async () => {
    const file = path.join(tmpDir, 'explicit.yaml');
    await writeFile(file, [
      'repositories:',
      '  - name: "special-repo"',
      '    security: custom',
      '    branch-protection: custom',
    ].join('\n'));
    const cfg = await loadConfig(file);
    assert.equal(cfg.repositories[0].security, 'custom');
    assert.equal(cfg.repositories[0]['branch-protection'], 'custom');
  });

  it('throws when repositories field is missing', async () => {
    const file = path.join(tmpDir, 'no-repos.yaml');
    await writeFile(file, 'foo: bar\n');
    await assert.rejects(() => loadConfig(file), /repositories/);
  });

  it('throws when repository name is missing', async () => {
    const file = path.join(tmpDir, 'no-name.yaml');
    await writeFile(file, 'repositories:\n  - security: managed\n');
    await assert.rejects(() => loadConfig(file), /name/);
  });

  it('throws on invalid repo name pattern', async () => {
    const file = path.join(tmpDir, 'bad-repo-name.yaml');
    await writeFile(file, 'repositories:\n  - name: "My Repo With Spaces"\n');
    await assert.rejects(() => loadConfig(file), /Invalid repository name/);
  });

  it('throws on repo name exceeding 64 characters', async () => {
    const file = path.join(tmpDir, 'long-repo-name.yaml');
    const longName = 'a'.repeat(65);
    await writeFile(file, `repositories:\n  - name: "${longName}"\n`);
    await assert.rejects(() => loadConfig(file), /Invalid repository name/);
  });

  it('throws on invalid team name', async () => {
    const file = path.join(tmpDir, 'bad-team-name.yaml');
    await writeFile(file, [
      'repositories:',
      '  - name: "my-repo"',
      '    teams:',
      '      - name: "Invalid@Name!"',
    ].join('\n'));
    await assert.rejects(() => loadConfig(file), /Invalid team name/);
  });

  it('throws on unknown security value', async () => {
    const file = path.join(tmpDir, 'bad-security.yaml');
    await writeFile(file, 'repositories:\n  - name: "my-repo"\n    security: "unknown"\n');
    await assert.rejects(() => loadConfig(file), /Invalid security value/);
  });

  it('throws on unknown branch-protection value', async () => {
    const file = path.join(tmpDir, 'bad-bp.yaml');
    await writeFile(file, 'repositories:\n  - name: "my-repo"\n    branch-protection: "unknown"\n');
    await assert.rejects(() => loadConfig(file), /Invalid branch-protection value/);
  });

  it('defaults teams to [] when absent', async () => {
    const file = path.join(tmpDir, 'no-teams.yaml');
    await writeFile(file, 'repositories:\n  - name: "my-repo"\n');
    const cfg = await loadConfig(file);
    assert.deepEqual(cfg.repositories[0].teams, []);
  });
});

// ── createRepositories ────────────────────────────────────────────────────────

describe('createRepositories', () => {
  const config = {
    repositories: [
      { name: 'new-repo', security: 'managed', 'branch-protection': 'managed', teams: [] },
      { name: 'existing-repo', security: 'managed', 'branch-protection': 'managed', teams: [] },
    ],
  };

  it('creates repos that do not exist', async () => {
    const created = [];
    const octokit = makeOctokit({
      paginate: async (fn) => {
        if (fn === octokit.rest.repos.listForOrg) {
          return [{ name: 'existing-repo' }];
        }
        return [];
      },
      createInOrg: async (params) => {
        created.push(params.name);
        return { data: {} };
      },
    });

    const result = await createRepositories(octokit, 'my-org', config, {});
    assert.deepEqual(created, ['new-repo']);
    assert.equal(result.actions.length, 1);
    assert.match(result.actions[0], /new-repo/);
  });

  it('does nothing when all repos already exist', async () => {
    const octokit = makeOctokit({
      paginate: async (fn) => {
        if (fn === octokit.rest.repos.listForOrg) {
          return [{ name: 'new-repo' }, { name: 'existing-repo' }];
        }
        return [];
      },
    });

    const result = await createRepositories(octokit, 'my-org', config, {});
    assert.equal(result.actions.length, 0);
    assert.equal(result.planned.length, 0);
  });

  it('does not call createInOrg in dry-run mode', async () => {
    let called = false;
    const octokit = makeOctokit({
      paginate: async () => [],
      createInOrg: async () => { called = true; return { data: {} }; },
    });

    const result = await createRepositories(octokit, 'my-org', config, { dryRun: true });
    assert.equal(called, false);
    assert.ok(result.planned.some(p => p.includes('new-repo')));
    assert.ok(result.planned.some(p => p.includes('existing-repo')));
  });

  it('handles empty org (all repos to create)', async () => {
    const created = [];
    const octokit = makeOctokit({
      paginate: async () => [],
      createInOrg: async (params) => { created.push(params.name); return { data: {} }; },
    });

    await createRepositories(octokit, 'my-org', config, {});
    assert.deepEqual(created.sort(), ['existing-repo', 'new-repo']);
  });
});

// ── processTeams ──────────────────────────────────────────────────────────────

describe('processTeams', () => {
  const config = {
    repositories: [
      {
        name: 'my-repo',
        security: 'managed',
        'branch-protection': 'managed',
        teams: [{ name: 'My Team' }],
      },
    ],
  };

  it('creates a new team and grants permission', async () => {
    const teamCreated = [];
    const permsGranted = [];

    const octokit = makeOctokit({
      paginate: async (fn) => {
        if (fn === octokit.rest.teams.list) return [];
        if (fn === octokit.rest.teams.listReposInOrg) return [];
        return [];
      },
      teamsCreate: async (params) => {
        teamCreated.push(params.name);
        return { data: { slug: 'my-team', name: 'My Team' } };
      },
      addOrUpdateRepo: async (params) => {
        permsGranted.push(params.repo);
      },
    });

    const result = await processTeams(octokit, 'my-org', config, { skipTeamSync: true });
    assert.deepEqual(teamCreated, ['My Team']);
    assert.deepEqual(permsGranted, ['my-repo']);
    assert.ok(result.actions.some(a => a.includes('Created team')));
    assert.ok(result.actions.some(a => a.includes('granted')));
  });

  it('uses maintain permission with --skip-custom-role', async () => {
    const permsGranted = [];
    const octokit = makeOctokit({
      paginate: async (fn) => {
        if (fn === octokit.rest.teams.list) return [];
        return [];
      },
      teamsCreate: async () => ({ data: { slug: 'my-team', name: 'My Team' } }),
      addOrUpdateRepo: async (params) => { permsGranted.push(params.permission); },
    });

    await processTeams(octokit, 'my-org', config, { skipTeamSync: true, skipCustomRole: true });
    assert.ok(permsGranted.every(p => p === 'maintain'));
  });

  it('uses Own permission by default', async () => {
    const permsGranted = [];
    const octokit = makeOctokit({
      paginate: async (fn) => {
        if (fn === octokit.rest.teams.list) return [];
        return [];
      },
      teamsCreate: async () => ({ data: { slug: 'my-team', name: 'My Team' } }),
      addOrUpdateRepo: async (params) => { permsGranted.push(params.permission); },
    });

    await processTeams(octokit, 'my-org', config, { skipTeamSync: true });
    assert.ok(permsGranted.every(p => p === 'Own'));
  });

  it('grants new repo permission on team update', async () => {
    const permsGranted = [];
    const octokit = makeOctokit({
      paginate: async (fn) => {
        if (fn === octokit.rest.teams.list) {
          return [{ name: 'My Team', slug: 'my-team' }];
        }
        if (fn === octokit.rest.teams.listReposInOrg) {
          return []; // team has no repos currently
        }
        return [];
      },
      addOrUpdateRepo: async (params) => { permsGranted.push(params.repo); },
    });

    const result = await processTeams(octokit, 'my-org', config, { skipTeamSync: true });
    assert.deepEqual(permsGranted, ['my-repo']);
    assert.ok(result.actions.some(a => a.includes('granted')));
  });

  it('revokes removed repo permission on team update', async () => {
    const permsRevoked = [];
    const octokit = makeOctokit({
      paginate: async (fn) => {
        if (fn === octokit.rest.teams.list) {
          return [{ name: 'My Team', slug: 'my-team' }];
        }
        if (fn === octokit.rest.teams.listReposInOrg) {
          return [{ name: 'my-repo' }, { name: 'old-repo' }];
        }
        return [];
      },
      removeRepo: async (params) => { permsRevoked.push(params.repo); },
    });

    await processTeams(octokit, 'my-org', config, { skipTeamSync: true });
    assert.deepEqual(permsRevoked, ['old-repo']);
  });

  it('deletes teams not in config', async () => {
    const deleted = [];
    const configNoTeams = {
      repositories: [{ name: 'my-repo', security: 'managed', 'branch-protection': 'managed', teams: [] }],
    };
    const octokit = makeOctokit({
      paginate: async (fn) => {
        if (fn === octokit.rest.teams.list) {
          return [{ name: 'Defunct Team', slug: 'defunct-team' }];
        }
        return [];
      },
      deleteTeam: async (params) => { deleted.push(params.team_slug); },
    });

    const result = await processTeams(octokit, 'my-org', configNoTeams, { skipTeamSync: true });
    assert.deepEqual(deleted, ['defunct-team']);
    assert.ok(result.actions.some(a => a.includes('Deleted team')));
  });

  it('validates Entra ID group before creating team', async () => {
    const octokit = makeOctokit({
      paginate: async (fn) => {
        if (fn === octokit.rest.teams.list) return [];
        return [];
      },
      teamsCreate: async () => ({ data: { slug: 'my-team', name: 'My Team' } }),
      request: async (endpoint) => {
        if (endpoint.includes('team-sync/groups')) {
          return { data: { groups: [] } }; // no group found
        }
        return { data: {} };
      },
    });

    await assert.rejects(
      () => processTeams(octokit, 'my-org', config, { skipTeamSync: false }),
      /No Entra ID group/
    );
  });

  it('does not make mutations in dry-run mode', async () => {
    let mutated = false;
    const octokit = makeOctokit({
      paginate: async (fn) => {
        if (fn === octokit.rest.teams.list) return [];
        return [];
      },
      teamsCreate: async () => { mutated = true; return { data: { slug: 'my-team' } }; },
      addOrUpdateRepo: async () => { mutated = true; },
    });

    const result = await processTeams(octokit, 'my-org', config, {
      skipTeamSync: true,
      dryRun: true,
    });

    assert.equal(mutated, false);
    assert.ok(result.planned.some(p => p.includes('Create team')));
    assert.ok(result.planned.some(p => p.includes('Grant')));
  });
});

// ── enforceSecurityConfig ─────────────────────────────────────────────────────

describe('enforceSecurityConfig', () => {
  const config = {
    repositories: [
      { name: 'managed-repo', security: 'managed', 'branch-protection': 'managed', teams: [] },
      { name: 'custom-repo', security: 'custom', 'branch-protection': 'managed', teams: [] },
    ],
  };

  function makeSecurityOctokit(overrides = {}) {
    const {
      configs = [{ id: 1, name: 'ospo-managed' }, { id: 2, name: 'custom' }],
      ospoRepos = [],
      customRepos = [],
      orgRepos = [{ name: 'managed-repo', id: 101 }, { name: 'custom-repo', id: 102 }],
      attachCalls = [],
    } = overrides;

    return makeOctokit({
      paginate: async (fn, params) => {
        if (typeof fn === 'string' && fn.includes('repositories') && fn.includes('configuration_id')) {
          if (params.configuration_id === 1) return ospoRepos;
          if (params.configuration_id === 2) return customRepos;
        }
        if (fn && (fn.toString?.() === Symbol('listForOrg').toString())) return orgRepos;
        // Check by symbol identity not possible, so check params
        if (params && params.type === 'public') return orgRepos;
        return [];
      },
      request: async (endpoint, params) => {
        if (endpoint.includes('code-security/configurations') && !endpoint.includes('attach') && !endpoint.includes('repositories')) {
          return { data: configs };
        }
        if (endpoint.includes('attach')) {
          if (overrides.attachCalls) overrides.attachCalls.push(params);
          return { data: {} };
        }
        return { data: {} };
      },
    });
  }

  it('assigns managed repo to ospo-managed config', async () => {
    const attachCalls = [];
    const octokit = makeSecurityOctokit({ attachCalls });

    const result = await enforceSecurityConfig(octokit, 'my-org', config, {});
    const ospoCall = attachCalls.find(c => c.configuration_id === 1);
    assert.ok(ospoCall);
    assert.ok(ospoCall.selected_repository_ids.includes(101));
    assert.ok(result.actions.some(a => a.includes('managed-repo') && a.includes('ospo-managed')));
  });

  it('assigns custom repo to custom config', async () => {
    const attachCalls = [];
    const octokit = makeSecurityOctokit({ attachCalls });

    await enforceSecurityConfig(octokit, 'my-org', config, {});
    const customCall = attachCalls.find(c => c.configuration_id === 2);
    assert.ok(customCall);
    assert.ok(customCall.selected_repository_ids.includes(102));
  });

  it('skips repos already correctly assigned', async () => {
    const attachCalls = [];
    const octokit = makeSecurityOctokit({
      ospoRepos: [{ name: 'managed-repo', id: 101 }],
      customRepos: [{ name: 'custom-repo', id: 102 }],
      attachCalls,
    });

    const result = await enforceSecurityConfig(octokit, 'my-org', config, {});
    assert.equal(attachCalls.length, 0);
    assert.equal(result.actions.length, 0);
  });

  it('throws when ospo-managed config not found', async () => {
    const octokit = makeSecurityOctokit({
      configs: [{ id: 2, name: 'custom' }],
    });

    await assert.rejects(
      () => enforceSecurityConfig(octokit, 'my-org', config, {}),
      /ospo-managed/
    );
  });

  it('throws when custom config not found', async () => {
    const octokit = makeSecurityOctokit({
      configs: [{ id: 1, name: 'ospo-managed' }],
    });

    await assert.rejects(
      () => enforceSecurityConfig(octokit, 'my-org', config, {}),
      /'custom'/
    );
  });

  it('does not attach in dry-run mode', async () => {
    const attachCalls = [];
    const octokit = makeSecurityOctokit({ attachCalls });

    const result = await enforceSecurityConfig(octokit, 'my-org', config, { dryRun: true });
    assert.equal(attachCalls.length, 0);
    assert.ok(result.planned.some(p => p.includes('managed-repo')));
    assert.ok(result.planned.some(p => p.includes('custom-repo')));
  });

  it('skips repos not yet created (not in org)', async () => {
    const attachCalls = [];
    const octokit = makeSecurityOctokit({
      orgRepos: [], // no repos in org yet
      attachCalls,
    });

    const result = await enforceSecurityConfig(octokit, 'my-org', config, {});
    assert.equal(attachCalls.length, 0);
    assert.equal(result.actions.length, 0);
  });
});

// ── enforceBranchProtection ───────────────────────────────────────────────────

describe('enforceBranchProtection', () => {
  const config = {
    repositories: [
      { name: 'managed-repo', security: 'managed', 'branch-protection': 'managed', teams: [] },
      { name: 'custom-repo', security: 'managed', 'branch-protection': 'custom', teams: [] },
    ],
  };

  function makeRulesetOctokit(overrides = {}) {
    const {
      rulesets = [{ id: 42, name: 'ospo-managed' }],
      currentIds = [],
      orgRepos = [{ name: 'managed-repo', id: 101 }, { name: 'custom-repo', id: 102 }],
      putCalls = [],
    } = overrides;

    return makeOctokit({
      paginate: async (_fn, params) => {
        if (params && params.type === 'public') return orgRepos;
        return [];
      },
      request: async (endpoint, params) => {
        if (endpoint === 'GET /orgs/{org}/rulesets') {
          return { data: rulesets };
        }
        if (endpoint === 'GET /orgs/{org}/rulesets/{ruleset_id}') {
          return {
            data: {
              id: 42,
              name: 'ospo-managed',
              enforcement: 'active',
              conditions: {
                repository_id: { repository_ids: currentIds },
              },
              rules: [],
            },
          };
        }
        if (endpoint === 'PUT /orgs/{org}/rulesets/{ruleset_id}') {
          putCalls.push(params);
          return { data: {} };
        }
        return { data: {} };
      },
    });
  }

  it('includes managed repos in target list', async () => {
    const putCalls = [];
    const octokit = makeRulesetOctokit({ putCalls });

    await enforceBranchProtection(octokit, 'my-org', config, {});
    assert.equal(putCalls.length, 1);
    const ids = putCalls[0].conditions.repository_id.repository_ids;
    assert.ok(ids.includes(101)); // managed-repo
    assert.ok(!ids.includes(102)); // custom-repo excluded
  });

  it('removes custom repos from target list when switching', async () => {
    const putCalls = [];
    const octokit = makeRulesetOctokit({
      currentIds: [101, 102],
      putCalls,
    });

    const result = await enforceBranchProtection(octokit, 'my-org', config, {});
    assert.equal(putCalls.length, 1);
    const ids = putCalls[0].conditions.repository_id.repository_ids;
    assert.ok(!ids.includes(102)); // custom-repo removed
    assert.ok(result.actions.some(a => a.includes('custom-repo')));
  });

  it('is a no-op when target list already correct', async () => {
    const putCalls = [];
    const octokit = makeRulesetOctokit({
      currentIds: [101],
      putCalls,
    });

    const result = await enforceBranchProtection(octokit, 'my-org', config, {});
    assert.equal(putCalls.length, 0);
    assert.equal(result.actions.length, 0);
  });

  it('throws when ospo-managed ruleset not found', async () => {
    const octokit = makeRulesetOctokit({ rulesets: [] });

    await assert.rejects(
      () => enforceBranchProtection(octokit, 'my-org', config, {}),
      /ospo-managed/
    );
  });

  it('does not PUT in dry-run mode', async () => {
    const putCalls = [];
    const octokit = makeRulesetOctokit({ putCalls });

    const result = await enforceBranchProtection(octokit, 'my-org', config, { dryRun: true });
    assert.equal(putCalls.length, 0);
    assert.ok(result.planned.some(p => p.includes('managed-repo')));
  });

  it('includes repos added to config in dry-run planned list', async () => {
    const octokit = makeRulesetOctokit({ currentIds: [] });

    const result = await enforceBranchProtection(octokit, 'my-org', config, { dryRun: true });
    assert.ok(result.planned.some(p => p.includes('managed-repo') && p.startsWith('+')));
  });
});
