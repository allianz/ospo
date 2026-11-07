import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  buildDesiredTeamRepos,
  createRepositories,
  diffRulesetTargets,
  diffSecurityAssignments,
  diffTeamRepos,
  diffTeams,
  enforceBranchProtection,
  enforceSecurityConfig,
  findEntraGroup,
  fromApiRole,
  processTeams,
  run,
  toApiRole,
} from '../create_repos.js';
import { createPlan } from '../lib/plan.js';
import { createFakeGitHub } from './helpers/fake_github.js';
import { createMemoryLogger } from './helpers/memory_logger.js';

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
    assert.deepEqual(cfg.repositories[0].access, []);
  });

  it('parses a config with access entries', async () => {
    const file = path.join(tmpDir, 'with-access.yaml');
    await writeFile(file, [
      'repositories:',
      '  - name: "my-repo"',
      '    access:',
      '      - team: "My Team"',
      '        role: triage',
    ].join('\n'));
    const cfg = await loadConfig(file);
    assert.equal(cfg.repositories[0].access.length, 1);
    assert.equal(cfg.repositories[0].access[0].team, 'My Team');
    assert.equal(cfg.repositories[0].access[0].role, 'triage');
  });

  it('defaults role to own when omitted', async () => {
    const file = path.join(tmpDir, 'default-role.yaml');
    await writeFile(file, [
      'repositories:',
      '  - name: "my-repo"',
      '    access:',
      '      - team: "My Team"',
    ].join('\n'));
    const cfg = await loadConfig(file);
    assert.equal(cfg.repositories[0].access[0].role, 'own');
  });

  it('accepts all valid roles', async () => {
    const file = path.join(tmpDir, 'all-roles.yaml');
    await writeFile(file, [
      'repositories:',
      '  - name: "repo-a"',
      '    access:',
      '      - team: "Team A"',
      '        role: own',
      '      - team: "Team B"',
      '        role: write',
      '      - team: "Team C"',
      '        role: triage',
    ].join('\n'));
    const cfg = await loadConfig(file);
    const roles = cfg.repositories[0].access.map(e => e.role);
    assert.deepEqual(roles, ['own', 'write', 'triage']);
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

  it('throws on unknown repo-level field', async () => {
    const file = path.join(tmpDir, 'unknown-repo-key.yaml');
    await writeFile(file, 'repositories:\n  - name: "my-repo"\n    teams:\n      - team: "X"\n');
    await assert.rejects(() => loadConfig(file), /Unknown field 'teams'/);
  });

  it('throws on unknown access entry field', async () => {
    const file = path.join(tmpDir, 'unknown-access-key.yaml');
    await writeFile(file, [
      'repositories:',
      '  - name: "my-repo"',
      '    access:',
      '      - team: "My Team"',
      '        level: admin',
    ].join('\n'));
    await assert.rejects(() => loadConfig(file), /Unknown field 'level'/);
  });

  it('throws on access entry without team', async () => {
    const file = path.join(tmpDir, 'access-no-team.yaml');
    await writeFile(file, 'repositories:\n  - name: "my-repo"\n    access:\n      - role: own\n');
    await assert.rejects(() => loadConfig(file), /Access entry missing required field: team in repo 'my-repo'/);
  });

  it('throws on invalid team name', async () => {
    const file = path.join(tmpDir, 'bad-team-name.yaml');
    await writeFile(file, [
      'repositories:',
      '  - name: "my-repo"',
      '    access:',
      '      - team: "Invalid@Name!"',
    ].join('\n'));
    await assert.rejects(() => loadConfig(file), /Invalid team name/);
  });

  it('throws on invalid role value', async () => {
    const file = path.join(tmpDir, 'bad-role.yaml');
    await writeFile(file, [
      'repositories:',
      '  - name: "my-repo"',
      '    access:',
      '      - team: "My Team"',
      '        role: admin',
    ].join('\n'));
    await assert.rejects(() => loadConfig(file), /Invalid role/);
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

  it('defaults access to [] when absent', async () => {
    const file = path.join(tmpDir, 'no-access.yaml');
    await writeFile(file, 'repositories:\n  - name: "my-repo"\n');
    const cfg = await loadConfig(file);
    assert.deepEqual(cfg.repositories[0].access, []);
  });
});


// ── Role mapping ──────────────────────────────────────────────────────────────

describe('role mapping', () => {
  it('maps config roles to API permissions', () => {
    assert.equal(toApiRole('own'), 'Own');
    assert.equal(toApiRole('write'), 'push');
    assert.equal(toApiRole('triage'), 'triage');
    assert.equal(toApiRole('maintain'), 'maintain');
  });

  it('maps API role names back to config roles', () => {
    assert.equal(fromApiRole('Own'), 'own');
    assert.equal(fromApiRole('push'), 'write');
    assert.equal(fromApiRole('triage'), 'triage');
    assert.equal(fromApiRole(undefined), '');
  });
});

// ── Pure diff functions ───────────────────────────────────────────────────────

describe('buildDesiredTeamRepos', () => {
  const config = {
    repositories: [
      { name: 'a', access: [{ team: 'T1', role: 'own' }, { team: 'T2', role: 'write' }] },
      { name: 'b', access: [{ team: 'T1', role: 'triage' }] },
      { name: 'c' },
    ],
  };

  it('groups repositories and roles by team', () => {
    const desired = buildDesiredTeamRepos(config);
    assert.deepEqual([...desired.keys()], ['T1', 'T2']);
    assert.deepEqual([...desired.get('T1')], [['a', 'own'], ['b', 'triage']]);
    assert.deepEqual([...desired.get('T2')], [['a', 'write']]);
  });

  it('replaces only own with maintain when the custom role is skipped', () => {
    const desired = buildDesiredTeamRepos(config, { skipCustomRole: true });
    assert.deepEqual([...desired.get('T1')], [['a', 'maintain'], ['b', 'triage']]);
    assert.deepEqual([...desired.get('T2')], [['a', 'write']]);
  });
});

describe('diffTeams', () => {
  it('splits teams into add, update and delete', () => {
    assert.deepEqual(diffTeams(['A', 'B'], ['B', 'C']), { toAdd: ['A'], toUpdate: ['B'], toDelete: ['C'] });
  });
});

describe('diffTeamRepos', () => {
  it('finds grants, role updates and revokes', () => {
    const desired = new Map([['keep', 'own'], ['change', 'write'], ['new', 'triage']]);
    const current = new Map([['keep', 'own'], ['change', 'triage'], ['gone', 'own']]);
    assert.deepEqual(diffTeamRepos(desired, current), {
      toGrant: [['new', 'triage']],
      toUpdate: [['change', 'triage', 'write']],
      toRevoke: ['gone'],
    });
  });
});

describe('diffSecurityAssignments', () => {
  const config = {
    repositories: [
      { name: 'm1', security: 'managed' },
      { name: 'm2', security: 'managed' },
      { name: 'c1', security: 'custom' },
      { name: 'c2', security: 'custom' },
      { name: 'not-created', security: 'managed' },
    ],
  };

  it('returns repos not yet attached to their configuration, skipping repos that do not exist', () => {
    const result = diffSecurityAssignments(config, {
      managedAssigned: new Set(['m1']),
      customAssigned: new Set(['c1']),
      repoIds: new Map([['m1', 1], ['m2', 2], ['c1', 3], ['c2', 4]]),
    });
    assert.deepEqual(result, { toManaged: [{ name: 'm2', id: 2 }], toCustom: [{ name: 'c2', id: 4 }] });
  });
});

describe('diffRulesetTargets', () => {
  it('reports added and removed IDs', () => {
    assert.deepEqual(diffRulesetTargets([1, 2], [2, 3]), { added: [1], removed: [3], changed: true });
  });

  it('is unchanged for the same IDs', () => {
    assert.deepEqual(diffRulesetTargets([1, 2], [1, 2]), { added: [], removed: [], changed: false });
  });
});

// ── Steps against the fake GitHub ─────────────────────────────────────────────

const org = 'test-org';

function context(gh, { dryRun = false, debug = false, ...opts } = {}) {
  const logger = createMemoryLogger({ debug });
  return { gh, plan: createPlan({ dryRun, logger }), logger, org, ...opts };
}

describe('createRepositories', () => {
  const config = { repositories: [{ name: 'exists' }, { name: 'new-one' }] };

  it('creates only missing repositories and returns them', async () => {
    const gh = createFakeGitHub({ repos: [{ name: 'exists', id: 1 }] });
    const ctx = context(gh);
    const created = await createRepositories({ ...ctx, config, existingRepos: [{ name: 'exists' }] });
    assert.deepEqual(created.map(r => r.name), ['new-one']);
    assert.deepEqual(gh.callsTo('createRepo').map(c => c.args), [[org, 'new-one']]);
    assert.equal(ctx.logger.output(), "  + Create 'new-one'... ✓\n");
  });

  it('only prints the plan in dry-run', async () => {
    const gh = createFakeGitHub();
    const ctx = context(gh, { dryRun: true });
    const created = await createRepositories({ ...ctx, config, existingRepos: [] });
    assert.deepEqual(created, []);
    assert.deepEqual(gh.writes(), []);
    assert.equal(ctx.logger.output(), "  + Create 'exists'\n  + Create 'new-one'\n");
  });
});

describe('findEntraGroup', () => {
  const gh = createFakeGitHub({
    teamSyncGroups: [
      { group_id: '1', group_name: 'Team' },
      { group_id: '2', group_name: 'Team Extended' },
      { group_id: '3', group_name: 'Twin' },
      { group_id: '4', group_name: 'Twin' },
    ],
  });

  it('returns the exact match among partial matches', async () => {
    assert.equal((await findEntraGroup(gh, org, 'Team')).group_id, '1');
  });

  it('throws when there is no or more than one exact match', async () => {
    await assert.rejects(() => findEntraGroup(gh, org, 'Missing'), /No Entra ID group with name 'Missing' found/);
    await assert.rejects(() => findEntraGroup(gh, org, 'Twin'), /More than one Entra ID group with name 'Twin' found/);
  });
});

describe('processTeams', () => {
  const config = { repositories: [{ name: 'repo', access: [{ team: 'New Team', role: 'own' }] }] };

  it('creates a team without sync when team sync is skipped, using maintain with --skip-custom-role', async () => {
    const gh = createFakeGitHub();
    await processTeams({ ...context(gh), config, skipTeamSync: true, skipCustomRole: true });
    assert.equal(gh.callsTo('searchTeamSyncGroups').length, 0);
    assert.equal(gh.callsTo('setTeamSyncGroups').length, 0);
    assert.deepEqual(gh.state.teamRepos['new-team'], [{ name: 'repo', role_name: 'maintain' }]);
  });

  it('does not create a team whose Entra ID group is missing', async () => {
    const gh = createFakeGitHub();
    await assert.rejects(() => processTeams({ ...context(gh), config }), /No Entra ID group/);
    assert.equal(gh.callsTo('createTeam').length, 0);
  });

  it('dry-run neither looks up the Entra ID group nor changes anything', async () => {
    const gh = createFakeGitHub();
    const ctx = context(gh, { dryRun: true });
    await processTeams({ ...ctx, config });
    assert.deepEqual(gh.writes(), []);
    assert.equal(gh.callsTo('searchTeamSyncGroups').length, 0);
    assert.equal(ctx.logger.output(), [
      "  + Create team 'New Team'",
      "  + Sync 'New Team' with Entra ID group 'New Team'",
      "  + Grant own: 'New Team' on 'repo'",
      '',
    ].join('\n'));
  });

  it('treats write as unchanged when the API reports push', async () => {
    const gh = createFakeGitHub({
      teams: [{ name: 'T', slug: 't' }],
      teamRepos: { t: [{ name: 'repo', role_name: 'push' }] },
    });
    await processTeams({ ...context(gh), config: { repositories: [{ name: 'repo', access: [{ team: 'T', role: 'write' }] }] } });
    assert.deepEqual(gh.writes(), []);
  });
});

describe('enforceSecurityConfig', () => {
  const config = { repositories: [{ name: 'a', security: 'managed' }] };
  const orgRepos = [{ name: 'a', id: 1 }];

  it('throws when a security configuration is missing', async () => {
    const noManaged = createFakeGitHub({ securityConfigs: [{ id: 2, name: 'custom' }] });
    await assert.rejects(() => enforceSecurityConfig({ ...context(noManaged), config, orgRepos }), /'ospo-managed' not found in org test-org/);
    const noCustom = createFakeGitHub({ securityConfigs: [{ id: 1, name: 'ospo-managed' }] });
    await assert.rejects(() => enforceSecurityConfig({ ...context(noCustom), config, orgRepos }), /'custom' not found in org test-org/);
  });

  it('accepts assignment items with a flat repository shape', async () => {
    const gh = createFakeGitHub({ securityConfigs: [{ id: 1, name: 'ospo-managed' }, { id: 2, name: 'custom' }] });
    gh.listSecurityConfigRepos = async (o, id) => (id === 1 ? [{ name: 'a' }] : []);
    await enforceSecurityConfig({ ...context(gh), config, orgRepos });
    assert.equal(gh.callsTo('attachSecurityConfig').length, 0);
  });
});

describe('enforceBranchProtection', () => {
  const config = { repositories: [{ name: 'a', 'branch-protection': 'managed' }] };
  const orgRepos = [{ name: 'a', id: 1 }];

  it('throws when the ospo-managed ruleset is missing', async () => {
    const gh = createFakeGitHub({ rulesets: [{ id: 1, name: 'other' }] });
    await assert.rejects(() => enforceBranchProtection({ ...context(gh), config, orgRepos }), /Org ruleset 'ospo-managed' not found/);
  });

  it('does nothing when the targets already match', async () => {
    const gh = createFakeGitHub({ rulesets: [{ id: 1, name: 'ospo-managed', conditions: { repository_id: { repository_ids: [1] } } }] });
    await enforceBranchProtection({ ...context(gh), config, orgRepos });
    assert.deepEqual(gh.writes(), []);
  });

  it('adds targets to a ruleset without conditions', async () => {
    const gh = createFakeGitHub({ rulesets: [{ id: 1, name: 'ospo-managed' }] });
    const ctx = context(gh);
    await enforceBranchProtection({ ...ctx, config, orgRepos });
    assert.deepEqual(gh.state.rulesets[0].conditions.repository_id.repository_ids, [1]);
    assert.equal(ctx.logger.output(), "  + Assign to 'ospo-managed': 'a'... ✓\n");
  });
});

// ── run ───────────────────────────────────────────────────────────────────────

describe('run', () => {
  let tmpDir;
  let configPath;

  before(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'create-repos-run-'));
    configPath = path.join(tmpDir, 'create_repos.yaml');
    await writeFile(configPath, [
      'repositories:',
      '  - name: existing',
      '    access:',
      '      - team: Team A',
      '      - team: Team B',
      '        role: write',
      '  - name: switch',
      '    security: custom',
      '    branch-protection: custom',
      '    access:',
      '      - team: Team A',
      '        role: triage',
      '  - name: brand-new',
      '    access:',
      '      - team: Team New',
    ].join('\n'));
  });
  after(async () => { await rm(tmpDir, { recursive: true }); });

  const orgState = () => ({
    repos: [{ name: 'existing', id: 1 }, { name: 'switch', id: 2 }, { name: 'internal', id: 9, visibility: 'private' }],
    teams: [{ name: 'Team A', slug: 'team-a' }, { name: 'Team B', slug: 'team-b' }, { name: 'Old Team', slug: 'old-team' }],
    teamRepos: {
      'team-a': [{ name: 'existing', role_name: 'Own' }, { name: 'gone', role_name: 'push' }],
      'team-b': [{ name: 'existing', role_name: 'triage' }],
    },
    teamSyncGroups: [{ group_id: 'g1', group_name: 'Team New', group_description: 'Synced' }, { group_id: 'g2', group_name: 'Team New Extra' }],
    securityConfigs: [{ id: 10, name: 'ospo-managed' }, { id: 11, name: 'custom' }],
    securityConfigRepos: { 10: ['switch'], 11: [] },
    rulesets: [{
      id: 5,
      name: 'ospo-managed',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] }, repository_id: { repository_ids: [2] } },
      rules: [{ type: 'deletion' }],
    }],
  });

  async function runCreate(argv, gh = createFakeGitHub(orgState()), { debug = false } = {}) {
    const logger = createMemoryLogger({ debug });
    const code = await run({ argv: ['--org', org, '--config', configPath, ...argv], github: gh, logger });
    return { gh, logger, code };
  }

  it('dry-run prints every planned change and makes none', async t => {
    const { gh, logger, code } = await runCreate(['--dry-run']);
    assert.equal(code, 0);
    assert.deepEqual(gh.writes(), []);
    t.assert.snapshot(logger.output());
  });

  it('live run converges: the second run has no changes', async t => {
    const first = await runCreate([]);
    const { state } = first.gh;

    assert.ok(state.repos.some(r => r.name === 'brand-new'));
    assert.deepEqual(state.teams.map(t => t.name).sort(), ['Team A', 'Team B', 'Team New']);
    assert.deepEqual(state.teamSyncMappings['team-new'], [{ group_id: 'g1', group_name: 'Team New', group_description: 'Synced' }]);
    assert.deepEqual(state.teamRepos['team-a'], [{ name: 'existing', role_name: 'Own' }, { name: 'switch', role_name: 'triage' }]);
    assert.deepEqual(state.teamRepos['team-b'], [{ name: 'existing', role_name: 'push' }]);
    assert.deepEqual(state.teamRepos['team-new'], [{ name: 'brand-new', role_name: 'Own' }]);
    assert.deepEqual(state.securityConfigRepos, { 10: ['existing', 'brand-new'], 11: ['switch'] });

    const brandNewId = state.repos.find(r => r.name === 'brand-new').id;
    const [ruleset] = state.rulesets;
    assert.deepEqual(ruleset.conditions.repository_id.repository_ids, [1, brandNewId]);
    assert.deepEqual(ruleset.rules, [{ type: 'deletion' }], 'rules are sent back unchanged');
    t.assert.snapshot(first.logger.output());

    const second = await runCreate([], first.gh);
    assert.equal(second.logger.output(), [
      'REPOSITORIES', '  · No changes', '',
      'TEAMS', '  · No changes', '',
      'SECURITY', '  · No changes', '',
      'BRANCH PROTECTION', '  · No changes', '',
    ].join('\n'));
  });

  it('prints current and desired state with --debug', async () => {
    const { logger } = await runCreate(['--dry-run', '--debug'], undefined, { debug: true });
    const output = logger.output();
    assert.match(output, /  Existing repos: existing, switch\n  Desired repos:  existing, switch, brand-new/);
    assert.match(output, /  Team 'Team New' — desired repos: brand-new/);
    assert.match(output, /  Team 'Team A' — current repos: existing, gone \| desired: existing, switch \| \+ grant: switch \| - revoke: gone/);
    assert.match(output, /  Team 'Team B' — current repos: existing \| desired: existing \| ~ update: existing/);
    assert.match(output, /  Existing ospo-managed: switch/);
    assert.match(output, /  Existing targets: switch\n  Desired targets:  existing, brand-new/);
  });

  it('rejects unknown flags', async () => {
    await assert.rejects(() => run({ argv: ['--org', org, '--bogus'] }), /Unknown option '--bogus'/);
  });
});
