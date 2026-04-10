#!/usr/bin/env node

import { Octokit } from '@octokit/rest';
import yaml from 'js-yaml';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.join(__dirname, '..');
const defaultConfigPath = path.join(repoRoot, 'config', 'create_repos.yaml');

// ── Config ────────────────────────────────────────────────────────────────────

export async function loadConfig(configPath) {
  const raw = await readFile(configPath, 'utf8');
  const config = yaml.load(raw);

  if (!config || !Array.isArray(config.repositories)) {
    throw new Error(`Config missing required field: repositories (in ${configPath})`);
  }

  const repoNameRe = /^[a-z0-9.-]+$/;
  const teamNameRe = /^[a-zA-Z0-9\s._-]+$/;
  const validRepoKeys = new Set(['name', 'security', 'branch-protection', 'access']);
  const validAccessKeys = new Set(['team', 'role']);
  const validRoles = ['own', 'write', 'triage'];

  for (const repo of config.repositories) {
    if (!repo.name) {
      throw new Error(`Repository entry missing required field: name`);
    }
    if (!repoNameRe.test(repo.name) || repo.name.length > 64) {
      throw new Error(
        `Invalid repository name: '${repo.name}'. Must match ^[a-z0-9.-]+$ (max 64 chars)`
      );
    }

    for (const key of Object.keys(repo)) {
      if (!validRepoKeys.has(key)) {
        throw new Error(
          `Unknown field '${key}' in repo '${repo.name}'. Valid fields: ${[...validRepoKeys].join(', ')}`
        );
      }
    }

    repo.security = repo.security ?? 'managed';
    if (!['managed', 'custom'].includes(repo.security)) {
      throw new Error(
        `Invalid security value '${repo.security}' for repo '${repo.name}'. Must be 'managed' or 'custom'`
      );
    }

    repo['branch-protection'] = repo['branch-protection'] ?? 'managed';
    if (!['managed', 'custom'].includes(repo['branch-protection'])) {
      throw new Error(
        `Invalid branch-protection value '${repo['branch-protection']}' for repo '${repo.name}'. Must be 'managed' or 'custom'`
      );
    }

    repo.access = repo.access ?? [];

    for (const entry of repo.access) {
      for (const key of Object.keys(entry)) {
        if (!validAccessKeys.has(key)) {
          throw new Error(
            `Unknown field '${key}' in access entry in repo '${repo.name}'. Valid fields: ${[...validAccessKeys].join(', ')}`
          );
        }
      }

      if (!entry.team) {
        throw new Error(`Access entry missing required field: team in repo '${repo.name}'`);
      }
      if (!teamNameRe.test(entry.team) || entry.team.length > 64) {
        throw new Error(
          `Invalid team name: '${entry.team}'. Must match ^[a-zA-Z0-9\\s._-]+$ (max 64 chars)`
        );
      }

      entry.role = entry.role ?? 'own';
      if (!validRoles.includes(entry.role)) {
        throw new Error(
          `Invalid role '${entry.role}' for team '${entry.team}' in repo '${repo.name}'. Must be one of: ${validRoles.join(', ')}`
        );
      }
    }
  }

  return config;
}

// ── Repository management ─────────────────────────────────────────────────────

export async function createRepositories(octokit, org, config, opts = {}) {
  const { dryRun = false, debug = false } = opts;
  const actions = [];
  const planned = [];

  const existingRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    type: 'public',
    per_page: 100,
  });

  const existingNames = new Set(existingRepos.map(r => r.name));
  const desiredNames = config.repositories.map(r => r.name);
  const toCreate = desiredNames.filter(name => !existingNames.has(name));

  if (debug) {
    console.log('  Existing repos:', [...existingNames].sort().join(', ') || '(none)');
    console.log('  Desired repos: ', desiredNames.join(', ') || '(none)');
    console.log('');
  }

  for (const name of toCreate) {
    if (dryRun) {
      console.log(`  + Create '${name}'`);
      planned.push(`+ Create repository '${name}'`);
    } else {
      process.stdout.write(`  + Create '${name}'... `);
      await octokit.rest.repos.createInOrg({
        org,
        name,
        visibility: 'public',
        auto_init: true,
      });
      process.stdout.write('✓\n');
      actions.push(`Created repository '${name}' in ${org}`);
    }
  }

  return { actions, planned };
}

// ── Team management ───────────────────────────────────────────────────────────

// Map config role names to the GitHub API permission string.
// 'own' is a custom org role whose API name is 'Own' (capital O).
// 'write' maps to GitHub's legacy 'push' permission name.
function toApiRole(role) {
  if (role === 'own')   return 'Own';
  if (role === 'write') return 'push';
  return role;
}

// Map GitHub API role_name values back to config role names.
function fromApiRole(roleName) {
  const r = roleName?.toLowerCase() ?? '';
  if (r === 'push') return 'write';
  return r; // 'own', 'triage' already match config names after lowercasing
}

async function validateEntraGroup(octokit, org, name) {
  const response = await octokit.request('GET /orgs/{org}/team-sync/groups', {
    org,
    q: name,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const groups = response.data.groups ?? [];
  const exact = groups.filter(g => g.group_name === name);
  if (exact.length === 0) {
    throw new Error(`No Entra ID group with name '${name}' found`);
  }
  if (exact.length > 1) {
    throw new Error(`More than one Entra ID group with name '${name}' found`);
  }
  return exact[0];
}

async function syncTeamWithEntra(octokit, org, teamSlug, group) {
  await octokit.request('PATCH /orgs/{org}/teams/{team_slug}/team-sync/group-mappings', {
    org,
    team_slug: teamSlug,
    groups: [
      {
        group_id: group.group_id,
        group_name: group.group_name,
        group_description: group.group_description ?? '',
      },
    ],
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
}

export async function processTeams(octokit, org, config, opts = {}) {
  const { dryRun = false, debug = false, skipTeamSync = false, skipCustomRole = false } = opts;
  const actions = [];
  const planned = [];

  // Build desired team → repos mapping with per-repo role
  const desiredTeamRepos = new Map(); // Map<teamName, Map<repoName, role>>
  for (const repo of config.repositories) {
    for (const entry of repo.access ?? []) {
      if (!desiredTeamRepos.has(entry.team)) desiredTeamRepos.set(entry.team, new Map());
      const role = (entry.role === 'own' && skipCustomRole) ? 'maintain' : entry.role;
      desiredTeamRepos.get(entry.team).set(repo.name, role);
    }
  }

  const desiredTeamNames = new Set(desiredTeamRepos.keys());

  // Fetch existing teams
  const existingTeams = await octokit.paginate(octokit.rest.teams.list, {
    org,
    per_page: 100,
  });
  const existingTeamMap = new Map(existingTeams.map(t => [t.name, t]));
  const existingTeamNames = new Set(existingTeams.map(t => t.name));

  const teamsToAdd = [...desiredTeamNames].filter(n => !existingTeamNames.has(n));
  const teamsToUpdate = [...desiredTeamNames].filter(n => existingTeamNames.has(n));
  const teamsToDelete = [...existingTeamNames].filter(n => !desiredTeamNames.has(n));

  if (debug) {
    console.log('  Existing teams:', [...existingTeamNames].sort().join(', ') || '(none)');
    console.log('  Desired teams: ', [...desiredTeamNames].join(', ') || '(none)');
    for (const teamName of teamsToAdd) {
      const repos = [...(desiredTeamRepos.get(teamName)?.keys() ?? [])];
      console.log(`  Team '${teamName}' — desired repos: ${repos.join(', ') || '(none)'}`);
    }
    console.log('');
  }

  // Teams to add
  for (const teamName of teamsToAdd) {
    const reposForTeam = desiredTeamRepos.get(teamName) ?? new Map();

    if (dryRun) {
      console.log(`  + Create team '${teamName}'`);
      planned.push(`+ Create team '${teamName}'`);
      if (!skipTeamSync) {
        console.log(`  + Sync '${teamName}' with Entra ID group '${teamName}'`);
        planned.push(`+ Sync team '${teamName}' with Entra ID group '${teamName}'`);
      }
      for (const [repo, role] of reposForTeam) {
        console.log(`  + Grant ${role}: '${teamName}' on '${repo}'`);
        planned.push(`+ Grant ${role}: '${teamName}' on '${repo}'`);
      }
    } else {
      // Validate Entra ID group exists before creating team
      let entraGroup = null;
      if (!skipTeamSync) {
        entraGroup = await validateEntraGroup(octokit, org, teamName);
      }

      // Create team
      process.stdout.write(`  + Create team '${teamName}'... `);
      const createResult = await octokit.rest.teams.create({
        org,
        name: teamName,
        privacy: 'closed',
      });
      process.stdout.write('✓\n');
      const newTeam = createResult.data;
      actions.push(`Created team '${teamName}' in ${org}`);
      existingTeamMap.set(teamName, newTeam);

      // Sync with Entra ID
      if (!skipTeamSync && entraGroup) {
        process.stdout.write(`  + Sync '${teamName}' with Entra ID group '${teamName}'... `);
        await syncTeamWithEntra(octokit, org, newTeam.slug, entraGroup);
        process.stdout.write('✓\n');
        actions.push(`Team '${teamName}' synced with Entra ID group '${teamName}'`);
      }

      // Grant permissions on assigned repos
      for (const [repo, role] of reposForTeam) {
        process.stdout.write(`  + Grant ${role}: '${teamName}' on '${repo}'... `);
        await octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
          org,
          team_slug: newTeam.slug,
          owner: org,
          repo,
          permission: toApiRole(role),
        });
        process.stdout.write('✓\n');
        actions.push(`Team '${teamName}' granted ${role} permission to '${repo}'`);
      }
    }
  }

  // Teams to update
  for (const teamName of teamsToUpdate) {
    const team = existingTeamMap.get(teamName);
    const desiredRepos = desiredTeamRepos.get(teamName) ?? new Map();

    const currentRepoList = await octokit.paginate(octokit.rest.teams.listReposInOrg, {
      org,
      team_slug: team.slug,
      per_page: 100,
    });
    const currentRepos = new Map(currentRepoList.map(r => [r.name, fromApiRole(r.role_name)]));

    const toGrant  = [...desiredRepos.keys()].filter(r => !currentRepos.has(r));
    const toRevoke = [...currentRepos.keys()].filter(r => !desiredRepos.has(r));
    const toUpdate = [...desiredRepos.entries()]
      .filter(([r, role]) => currentRepos.has(r) && currentRepos.get(r) !== role);

    if (debug && (toGrant.length > 0 || toRevoke.length > 0 || toUpdate.length > 0)) {
      const parts = [
        `current repos: ${[...currentRepos.keys()].sort().join(', ') || '(none)'}`,
        `desired: ${[...desiredRepos.keys()].sort().join(', ') || '(none)'}`,
      ];
      if (toGrant.length > 0) parts.push(`+ grant: ${toGrant.join(', ')}`);
      if (toRevoke.length > 0) parts.push(`- revoke: ${toRevoke.join(', ')}`);
      if (toUpdate.length > 0) parts.push(`~ update: ${toUpdate.map(([r]) => r).join(', ')}`);
      console.log(`  Team '${teamName}' — ${parts.join(' | ')}`);
    }

    for (const repo of toGrant) {
      const role = desiredRepos.get(repo);
      if (dryRun) {
        console.log(`  + Grant ${role}: '${teamName}' on '${repo}'`);
        planned.push(`+ Grant ${role}: '${teamName}' on '${repo}'`);
      } else {
        process.stdout.write(`  + Grant ${role}: '${teamName}' on '${repo}'... `);
        await octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
          org,
          team_slug: team.slug,
          owner: org,
          repo,
          permission: toApiRole(role),
        });
        process.stdout.write('✓\n');
        actions.push(`Team '${teamName}' granted ${role} permission to '${repo}'`);
      }
    }

    for (const [repo, role] of toUpdate) {
      const currentRole = currentRepos.get(repo);
      if (dryRun) {
        console.log(`  ~ Update ${currentRole}→${role}: '${teamName}' on '${repo}'`);
        planned.push(`~ Update ${role}: '${teamName}' on '${repo}'`);
      } else {
        process.stdout.write(`  ~ Update ${currentRole}→${role}: '${teamName}' on '${repo}'... `);
        await octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
          org,
          team_slug: team.slug,
          owner: org,
          repo,
          permission: toApiRole(role),
        });
        process.stdout.write('✓\n');
        actions.push(`Team '${teamName}' updated to ${role} permission for '${repo}'`);
      }
    }

    for (const repo of toRevoke) {
      if (dryRun) {
        console.log(`  - Revoke: '${teamName}' on '${repo}'`);
        planned.push(`- Revoke: '${teamName}' on '${repo}'`);
      } else {
        process.stdout.write(`  - Revoke: '${teamName}' on '${repo}'... `);
        await octokit.rest.teams.removeRepoInOrg({
          org,
          team_slug: team.slug,
          owner: org,
          repo,
        });
        process.stdout.write('✓\n');
        actions.push(`Team '${teamName}' removed from '${repo}'`);
      }
    }
  }

  // Teams to delete
  for (const teamName of teamsToDelete) {
    const team = existingTeamMap.get(teamName);
    if (dryRun) {
      console.log(`  - Delete team '${teamName}'`);
      planned.push(`- Delete team '${teamName}'`);
    } else {
      process.stdout.write(`  - Delete team '${teamName}'... `);
      await octokit.rest.teams.deleteInOrg({
        org,
        team_slug: team.slug,
      });
      process.stdout.write('✓\n');
      actions.push(`Deleted team '${teamName}' from ${org}`);
    }
  }

  return { actions, planned };
}

// ── Security configuration ────────────────────────────────────────────────────

export async function enforceSecurityConfig(octokit, org, config, opts = {}) {
  const { dryRun = false, debug = false } = opts;
  const actions = [];
  const planned = [];

  // Look up org security configurations by name
  const cfgsResponse = await octokit.request(
    'GET /orgs/{org}/code-security/configurations',
    { org, headers: { 'X-GitHub-Api-Version': '2022-11-28' } }
  );
  const allCfgs = cfgsResponse.data;

  const ospoManaged = allCfgs.find(c => c.name === 'ospo-managed');
  const customCfg = allCfgs.find(c => c.name === 'custom');

  if (!ospoManaged) {
    throw new Error(`Security configuration 'ospo-managed' not found in org ${org}`);
  }
  if (!customCfg) {
    throw new Error(`Security configuration 'custom' not found in org ${org}`);
  }

  // Fetch current assignments for both configs
  const [ospoRepos, customRepos] = await Promise.all([
    octokit.paginate(
      'GET /orgs/{org}/code-security/configurations/{configuration_id}/repositories',
      { org, configuration_id: ospoManaged.id, per_page: 100 }
    ),
    octokit.paginate(
      'GET /orgs/{org}/code-security/configurations/{configuration_id}/repositories',
      { org, configuration_id: customCfg.id, per_page: 100 }
    ),
  ]);

  const ospoAssigned = new Set(ospoRepos.map(r => r.repository?.name ?? r.name));
  const customAssigned = new Set(customRepos.map(r => r.repository?.name ?? r.name));

  // Fetch org repos to get IDs
  const orgRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    type: 'public',
    per_page: 100,
  });
  const repoIdMap = new Map(orgRepos.map(r => [r.name, r.id]));

  const toAssignOspo = [];
  const toAssignCustom = [];

  for (const repo of config.repositories) {
    const repoId = repoIdMap.get(repo.name);
    if (repoId === undefined) continue; // repo not yet created

    if (repo.security === 'managed') {
      if (!ospoAssigned.has(repo.name)) {
        toAssignOspo.push({ name: repo.name, id: repoId });
      }
    } else {
      if (!customAssigned.has(repo.name)) {
        toAssignCustom.push({ name: repo.name, id: repoId });
      }
    }
  }

  if (debug) {
    const desiredOspo = config.repositories.filter(r => r.security === 'managed').map(r => r.name);
    const desiredCustom = config.repositories.filter(r => r.security !== 'managed').map(r => r.name);
    console.log('  Existing ospo-managed:', [...ospoAssigned].sort().join(', ') || '(none)');
    console.log('  Existing custom:      ', [...customAssigned].sort().join(', ') || '(none)');
    console.log('  Desired ospo-managed: ', desiredOspo.join(', ') || '(none)');
    console.log('  Desired custom:       ', desiredCustom.join(', ') || '(none)');
    console.log('');
  }

  if (dryRun) {
    if (toAssignOspo.length > 0) {
      const names = toAssignOspo.map(r => `'${r.name}'`).join(', ');
      console.log(`  + Assign to 'ospo-managed': ${names}`);
      for (const { name } of toAssignOspo) {
        planned.push(`+ Assign '${name}' to 'ospo-managed' security configuration`);
      }
    }
    if (toAssignCustom.length > 0) {
      const names = toAssignCustom.map(r => `'${r.name}'`).join(', ');
      console.log(`  + Assign to 'custom': ${names}`);
      for (const { name } of toAssignCustom) {
        planned.push(`+ Assign '${name}' to 'custom' security configuration`);
      }
    }
  } else {
    if (toAssignOspo.length > 0) {
      const names = toAssignOspo.map(r => `'${r.name}'`).join(', ');
      process.stdout.write(`  + Assign to 'ospo-managed': ${names}... `);
      await octokit.request(
        'POST /orgs/{org}/code-security/configurations/{configuration_id}/attach',
        {
          org,
          configuration_id: ospoManaged.id,
          scope: 'selected',
          selected_repository_ids: toAssignOspo.map(r => r.id),
          headers: { 'X-GitHub-Api-Version': '2022-11-28' },
        }
      );
      process.stdout.write('✓\n');
      for (const { name } of toAssignOspo) {
        actions.push(`Assigned '${name}' to 'ospo-managed' security configuration`);
      }
    }

    if (toAssignCustom.length > 0) {
      const names = toAssignCustom.map(r => `'${r.name}'`).join(', ');
      process.stdout.write(`  + Assign to 'custom': ${names}... `);
      await octokit.request(
        'POST /orgs/{org}/code-security/configurations/{configuration_id}/attach',
        {
          org,
          configuration_id: customCfg.id,
          scope: 'selected',
          selected_repository_ids: toAssignCustom.map(r => r.id),
          headers: { 'X-GitHub-Api-Version': '2022-11-28' },
        }
      );
      process.stdout.write('✓\n');
      for (const { name } of toAssignCustom) {
        actions.push(`Assigned '${name}' to 'custom' security configuration`);
      }
    }
  }

  return { actions, planned };
}

// ── Branch protection ─────────────────────────────────────────────────────────

export async function enforceBranchProtection(octokit, org, config, opts = {}) {
  const { dryRun = false, debug = false } = opts;
  const actions = [];
  const planned = [];

  // Build desired target names (repos where branch-protection is 'managed')
  const desiredTargetNames = config.repositories
    .filter(r => r['branch-protection'] === 'managed')
    .map(r => r.name);

  // Resolve repo names to IDs (skip repos not yet created)
  const orgRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    type: 'public',
    per_page: 100,
  });
  const repoIdMap = new Map(orgRepos.map(r => [r.name, r.id]));
  const idToName = new Map(orgRepos.map(r => [r.id, r.name]));

  const desiredIds = desiredTargetNames
    .filter(name => repoIdMap.has(name))
    .map(name => repoIdMap.get(name))
    .sort((a, b) => a - b);

  // Look up the 'ospo-managed' org ruleset
  const rulesetsResponse = await octokit.request('GET /orgs/{org}/rulesets', {
    org,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const rulesets = rulesetsResponse.data;
  const ruleset = rulesets.find(r => r.name === 'ospo-managed');

  if (!ruleset) {
    throw new Error(`Org ruleset 'ospo-managed' not found in org ${org}`);
  }

  // Fetch full ruleset to get current conditions
  const fullRulesetResponse = await octokit.request('GET /orgs/{org}/rulesets/{ruleset_id}', {
    org,
    ruleset_id: ruleset.id,
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const fullRuleset = fullRulesetResponse.data;

  const currentIds = (fullRuleset.conditions?.repository_id?.repository_ids ?? [])
    .slice()
    .sort((a, b) => a - b);

  // Compare sorted ID lists to detect changes
  const currentIdSet = new Set(currentIds);
  const desiredIdSet = new Set(desiredIds);
  const added = desiredIds.filter(id => !currentIdSet.has(id));
  const removed = currentIds.filter(id => !desiredIdSet.has(id));

  if (debug) {
    console.log('  Existing targets:', currentIds.map(id => idToName.get(id) ?? id).join(', ') || '(none)');
    console.log('  Desired targets: ', desiredTargetNames.join(', ') || '(none)');
    console.log('');
  }

  if (currentIds.join(',') === desiredIds.join(',')) {
    return { actions, planned };
  }

  // Build one compact line per direction of change
  const intentLines = [];
  if (added.length > 0) {
    const names = added.map(id => `'${idToName.get(id) ?? id}'`).join(', ');
    intentLines.push(`  + Assign to 'ospo-managed': ${names}`);
  }
  if (removed.length > 0) {
    const names = removed.map(id => `'${idToName.get(id) ?? id}'`).join(', ');
    intentLines.push(`  + Assign to 'custom': ${names}`);
  }

  if (dryRun) {
    for (const line of intentLines) console.log(line);
    for (const id of added) {
      planned.push(`+ Assign '${idToName.get(id) ?? id}' to 'ospo-managed' ruleset`);
    }
    for (const id of removed) {
      planned.push(`+ Assign '${idToName.get(id) ?? id}' to 'custom'`);
    }
  } else {
    // Print all intent lines; last one stays open for inline ✓
    for (let i = 0; i < intentLines.length - 1; i++) {
      console.log(intentLines[i]);
    }
    process.stdout.write(intentLines[intentLines.length - 1] + '... ');

    // Update only the target list — send only writable fields to avoid schema conflicts
    await octokit.request('PUT /orgs/{org}/rulesets/{ruleset_id}', {
      org,
      ruleset_id: ruleset.id,
      name: fullRuleset.name,
      target: fullRuleset.target,
      enforcement: fullRuleset.enforcement,
      bypass_actors: fullRuleset.bypass_actors,
      conditions: {
        ref_name: fullRuleset.conditions?.ref_name,
        repository_id: {
          repository_ids: desiredIds,
        },
      },
      rules: fullRuleset.rules,
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    });
    process.stdout.write('✓\n');

    for (const id of added) {
      actions.push(`Assigned '${idToName.get(id) ?? id}' to 'ospo-managed' ruleset`);
    }
    for (const id of removed) {
      actions.push(`Assigned '${idToName.get(id) ?? id}' to 'custom'`);
    }
  }

  return { actions, planned };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let org = null;
  let configPath = defaultConfigPath;
  let dryRun = false;
  let debug = false;
  let skipTeamSync = false;
  let skipCustomRole = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        org = args[++i];
        break;
      case '--config':
        configPath = path.resolve(args[++i]);
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--debug':
        debug = true;
        break;
      case '--skip-team-sync':
        skipTeamSync = true;
        break;
      case '--skip-custom-role':
        skipCustomRole = true;
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!org) {
    console.error('Error: --org is required');
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable is not set');
    process.exit(1);
  }

  const config = await loadConfig(configPath);
  const noop = () => {};
  const octokit = new Octokit({ auth: token, log: { debug: noop, info: noop, warn: noop, error: noop } });
  const opts = { dryRun, debug, skipTeamSync, skipCustomRole };

  // REPOSITORIES
  console.log('REPOSITORIES');
  const repoResult = await createRepositories(octokit, org, config, opts);
  if (repoResult.actions.length === 0 && repoResult.planned.length === 0) console.log('  · No changes');

  // TEAMS
  console.log('');
  console.log('TEAMS');
  const teamResult = await processTeams(octokit, org, config, opts);
  if (teamResult.actions.length === 0 && teamResult.planned.length === 0) console.log('  · No changes');

  // SECURITY
  console.log('');
  console.log('SECURITY');
  const securityResult = await enforceSecurityConfig(octokit, org, config, opts);
  if (securityResult.actions.length === 0 && securityResult.planned.length === 0) console.log('  · No changes');

  // BRANCH PROTECTION
  console.log('');
  console.log('BRANCH PROTECTION');
  const branchResult = await enforceBranchProtection(octokit, org, config, opts);
  if (branchResult.actions.length === 0 && branchResult.planned.length === 0) console.log('  · No changes');

  // Dry-run footer
  if (dryRun) {
    console.log('');
    console.log('──── Dry-run: no changes were made ────');
  }
}

// Only run main() when this file is the entry point (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
