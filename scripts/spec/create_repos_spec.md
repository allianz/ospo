# Spec: create_repos implementation

## Motivation

Open source projects at Allianz follow a self-service provisioning model. After business approval, a project team opens a pull request against `config/create_repos.yaml` to register their repository. On merge the CI pipeline creates the repository with the organization's default settings, assigns team permissions, and connects Entra ID groups for identity-driven access — all without requiring manual admin intervention.

The goals of this automation are:

1. **Zero-touch provisioning** — repository creation, team setup, and permission assignment happen automatically on merge. No GitHub admin action required.
2. **Identity-driven access** — every GitHub team is synced with an Entra ID group. On- and offboarding is controlled outside of GitHub through the enterprise identity provider.
3. **Auditable change history** — all configuration changes go through pull requests, giving a clear audit trail of who requested what and when.
4. **Secure defaults** — repositories are created with GitHub Advanced Security enabled and branch protection enforced. Projects can opt out if they need custom settings.


## Scope

The script manages:

- **Repository creation** — new public repositories in the configured organization
- **Team lifecycle** — create, update (permission changes), and delete teams
- **Team permissions** — grant and revoke repository access for teams
- **Entra ID synchronization** — bind GitHub teams to Entra ID groups
- **GitHub Advanced Security** — enforce GHAS defaults or delegate to the project
- **Branch protection** — enforce branch protection rules or delegate to the project

Out of scope:

- Repository deletion or archival (handled by `archive_repos`)
- Repository compliance linting (handled by `lint_repos`)
- Organization-level settings (managed by GitHub org admins)
- Entra ID group creation (managed by the identity team)

---

## Implementation Approach

A single JavaScript file `scripts/create_repos.js`, run with `node`. Dependencies are managed via the shared `scripts/package.json`.

### npm packages

| Package | Purpose |
|---|---|
| `@octokit/rest` | GitHub REST API (repos, teams, permissions, security settings, branch protection). Auth via `GITHUB_TOKEN` environment variable. |
| `js-yaml` | Parse YAML config files |

No additional packages required beyond what is already in `scripts/package.json`. The `simple-git` dependency (used by `lint_repos.js`) is not needed here.

### Project structure

```
scripts/
  package.json          # shared for all JS scripts in this repo
  package-lock.json
  node_modules/
  create_repos.js
  spec/
    create_repos_spec.md
```

### Local usage

```bash
export GITHUB_TOKEN=$(gh auth token)   # or set a PAT directly
cd scripts
npm install
node create_repos.js --org <org> [--config <file>] [--dry-run] [--debug] [--skip-team-sync] [--skip-custom-role]
```

The script requires `GITHUB_TOKEN` to be set in the environment. The default config path is resolved relative to the script file's location (repo root), not the working directory.

---

## CLI Interface

```
node scripts/create_repos.js --org <org> [--config <file>] [--dry-run] [--debug] [--skip-team-sync] [--skip-custom-role]
```

| Flag | Default | Description |
|---|---|---|
| `--org` | required | GitHub organization to manage |
| `--config` | `config/create_repos.yaml` | Path to config file (relative to repo root) |
| `--dry-run` | false | Simulate execution without making changes |
| `--debug` | false | Print verbose output |
| `--skip-team-sync` | false | Skip Entra ID team synchronization (Enterprise-only feature) |
| `--skip-custom-role` | false | Use `maintain` permission instead of custom `Own` role (non-Enterprise fallback) |

---

## Configuration File

Configuration lives at `config/create_repos.yaml`.

```yaml
# Configuration File for GitHub Repositories
#
# This file manages settings for GitHub repositories within the organization.
# Each entry represents a repository that should exist in the org with the
# specified team assignments and policy settings.
#
# Adding a new repository:
#   1. Add an entry under `repositories` with the repo name
#   2. Optionally assign teams (team name must match the Entra ID group name)
#   3. Optionally configure security and branch-protection policies
#   4. Open a pull request — the pipeline creates the repo on merge

repositories:

  # Minimal: repo with organization defaults (managed security + branch protection)
  - name: "my-repo"

  # Repo with a single owner team (default role)
  - name: "my-other-repo"
    access:
      - team: "My Team"
        role: own

  # Repo with mixed roles and custom settings
  - name: "special-repo"
    security: custom
    branch-protection: custom
    access:
      - team: "Special Team"
        role: own
      - team: "External Contributors"
        role: triage
```

### Field reference

| Field | Level | Type | Default | Description |
|---|---|---|---|---|
| `repositories` | Root | Array | required | List of repositories to manage |
| `name` | Repository | String | required | Repository name. Must match `^[a-z0-9.-]+$`, max 64 characters. |
| `security` | Repository | String | `managed` | `managed`: OSPO enforces GHAS defaults. `custom`: repo team controls GHAS settings. |
| `branch-protection` | Repository | String | `managed` | `managed`: OSPO enforces branch protection rules. `custom`: repo team defines its own rules. |
| `access` | Repository | Array | `[]` | Access entries for this repository. Unknown fields are rejected. |
| `team` | Access entry | String | required | Team display name. Must match the corresponding Entra ID group name exactly. Alphanumeric, spaces, dots, underscores, hyphens; max 64 characters. |
| `role` | Access entry | String | `own` | Permission level: `own`, `write`, or `triage`. Unknown values are rejected. |

---

## Execution Flow

```
1. Read GITHUB_TOKEN from environment — exit with clear error if missing
2. Parse CLI arguments
3. Load and validate YAML config with js-yaml:
     - All repo names match ^[a-z0-9.-]+$ (max 64 chars)
     - All team names match ^[a-zA-Z0-9\s._-]+$ (max 64 chars)
     - security field, if present, is "managed" or "custom"
     - branch-protection field, if present, is "managed" or "custom"
4. Instantiate Octokit with the token
5. Process repositories:
     a. Fetch existing repos from org (paginated, up to 1000)
     b. Extract desired repos from config
     c. Calculate delta: repos_to_create = desired − existing
     d. Create missing repositories (public)
6. Process teams:
     a. Fetch all teams from org (cache result)
     b. Calculate three sets: teams_to_add, teams_to_update, teams_to_delete
     c. For each team to add:
          - Validate Entra ID group exists (exact name match)
          - Create team with closed privacy
          - Set up Entra ID sync (unless --skip-team-sync)
          - Grant each assigned repo with the configured role
     d. For each team to update:
          - Load current repo assignments and their role_name
          - Calculate: repos_to_grant (new), repos_to_revoke (removed), repos_to_update (role changed)
          - Grant new, revoke removed, update changed roles
     e. For each team to delete:
          - Delete team
7. Enforce security configuration assignments:
     a. Look up the "ospo-managed" and "custom" org security configurations by name
     b. For each repo in config:
          - security = "managed" (or omitted) → assign to "ospo-managed" configuration
          - security = "custom" → assign to "custom" configuration
     c. Compare current assignments with desired — update only what changed
8. Enforce branch protection (org-level ruleset target list only):
     a. Collect all repo names from config where branch-protection ≠ "custom"
     b. Look up the existing "ospo-managed" org ruleset
     c. Compare current target list with desired list — update if changed
     d. Repos with branch-protection = "custom" are simply not included in the target list
9. Print results and dry-run summary (if applicable)
10. Exit 0 on success, exit 1 on any error
```

---

## Team & Permission Model

### Permission levels

| Config value | GitHub API value | GitHub role | Notes |
|---|---|---|---|
| `own` | `Own` | Custom organization role (Enterprise) | Default. Falls back to `maintain` when `--skip-custom-role` is set. |
| `write` | `push` | Built-in write role | Push access. |
| `triage` | `triage` | Built-in triage role | Read + triage issues and PRs, no push access. |

### Team lifecycle

| Event | Action |
|---|---|
| Team in config, not in GitHub | Create team → sync with Entra ID → grant repo permissions |
| Team in both config and GitHub | Compare repo assignments → grant/revoke as needed |
| Team in GitHub, not in config | Delete team |

### Entra ID synchronization

- Each team name **must** match an Entra ID group name exactly (case-sensitive).
- On team creation, the script verifies the Entra ID group exists before proceeding.
- Team membership is then controlled entirely through the identity provider.
- Sync setup is skipped when `--skip-team-sync` is passed (for non-Enterprise environments or testing).

---

## Security (GitHub Advanced Security)

Every repository defaults to `security: managed`. Two **GitHub Advanced Security organization configurations** are **manually created** by org admins:

| Configuration | Enforce configuration | Purpose |
|---|---|---|
| `ospo-managed` | Yes | Repos cannot override GHAS settings. The org admin controls the security posture. |
| `custom` | No | Same GHAS features enabled as defaults, but repo teams can disable or adjust individual settings (e.g. disable Dependabot). |

Both configurations are identical in which GHAS features they enable — the only difference is whether the configuration is enforced or not.

### What the script controls

The script assigns each repository to the appropriate organization configuration based on the `security` field in the config. On each run:

1. Look up the `ospo-managed` and `custom` org security configurations by name.
2. For each repo in config:
   - `security: managed` (or omitted) → assign to the `ospo-managed` configuration.
   - `security: custom` → assign to the `custom` configuration.
3. Compare current assignments with desired assignments — update only what changed.

The script **never** creates, deletes, or modifies the configurations themselves — only the repo-to-configuration assignments.

### What org admins control

The security configurations (which GHAS features are enabled, enforcement toggle) are managed manually in the org settings UI. This allows admins to adjust the security baseline without code changes.

### Idempotency

If a repo is already assigned to the correct configuration, no API call is made. Only changes in the config file (new repos, or switching between managed/custom) trigger updates.

---

## Branch Protection

Every repository defaults to `branch-protection: managed`. An organization-level repository ruleset named `ospo-managed` is **manually created and configured** by org admins — the script does not manage its rules. The script's only responsibility is maintaining the **target list** of repositories that the ruleset applies to.

Repos that set `branch-protection: custom` are excluded from the target list so they can define their own rules without conflict.

### What the script controls

The script updates the `repository_id.repository_ids` list on the existing `ospo-managed` ruleset via the [Organization Rulesets API](https://docs.github.com/en/rest/orgs/rules) (`PUT /orgs/{org}/rulesets/{id}`). On each run:

1. Collect all repo names from config where `branch-protection` is `managed` (or omitted).
2. Resolve those names to numeric repository IDs by fetching the org's repo list.
3. Look up the existing `ospo-managed` ruleset by name.
4. Compare the current `repository_id.repository_ids` list with the desired list. Update if anything changed.

The script targets repositories by ID (not by name pattern) to match the GitHub UI's "select repositories" behaviour and avoid accidental wildcard matches.

The script **never** creates, deletes, or modifies the ruleset's rules — only the target list.

### What org admins control

The ruleset itself (rules, enforcement level, bypass actors) is configured manually in the org settings UI. This allows admins to adjust branch protection standards without code changes.

### Idempotency

If the target list already matches, no API call is made. Only changes to the repo list (repos added/removed from config, or switching between managed/custom) trigger an update.

---

## Output / Reporting

Three output levels:

- **Normal** (no flags): shows only the changes being made — intent before each API call, `✓` after success. Sections with nothing to do print `· No changes`.
- **`--debug`**: before each section's changes, prints a block showing full existing state, desired state, and a blank line. The change lines then follow in normal format. This lets you trace exactly how each planned action was derived.
- **`--dry-run`**: shows the same `+/-` change lines per section but makes no API calls. A footer confirms nothing was executed.

### Normal mode — with changes

Each change is printed as `  + intent... ✓` (or `  - intent... ✓` for removals) using `process.stdout.write` so the intent line is visible if an error occurs mid-operation.

For teams, each operation is on its own line. For security and branch protection, all repos in the same assignment bucket are condensed onto one line (only repos that actually change are shown — not all repos):

```
REPOSITORIES
  + Create 'my-new-repo'... ✓

TEAMS
  + Create team 'My Team'... ✓
  + Sync 'My Team' with Entra ID group 'My Team'... ✓
  + Grant own: 'My Team' on 'my-new-repo'... ✓
  ~ Update own→triage: 'My Team' on 'existing-repo'... ✓
  - Revoke: 'My Team' on 'removed-repo'... ✓
  - Delete team 'Defunct Team'... ✓

SECURITY
  + Assign to 'ospo-managed': 'my-new-repo'... ✓
  + Assign to 'custom': 'special-repo'... ✓

BRANCH PROTECTION
  + Assign to 'ospo-managed': 'my-new-repo'... ✓
  + Assign to 'custom': 'old-repo'... ✓
```

### Normal mode — no changes

```
REPOSITORIES
  · No changes

TEAMS
  · No changes

SECURITY
  · No changes

BRANCH PROTECTION
  · No changes
```

### Error mid-run

The intent line (without `✓`) identifies what was being attempted when the error occurred:

```
TEAMS
  + Create team 'My Team'... ✓
  + Sync 'My Team' with Entra ID group 'My Team'...
Fatal error: Not Found
```

### Dry-run

Changes are shown inline per section (same `+/-` prefix, no `... ✓`). Sections with nothing planned show `· No changes`. A one-line footer confirms no API calls were made:

```
REPOSITORIES
  + Create 'my-new-repo'

TEAMS
  + Create team 'My Team'
  + Sync 'My Team' with Entra ID group 'My Team'
  + Grant own: 'My Team' on 'my-new-repo'

SECURITY
  · No changes

BRANCH PROTECTION
  + Assign to 'ospo-managed': 'my-new-repo'

──── Dry-run: no changes were made ────
```

### Debug mode

Each section emits a debug block before its change lines. The block always shows `Existing <noun>:` and `Desired <noun>:` so the reader can verify how the delta was calculated. No delta lines are printed in the debug block — the intent lines that follow already communicate the delta.

**REPOSITORIES:**
```
REPOSITORIES
  Existing repos: repo1, repo2
  Desired repos:  my-new-repo, repo1, repo2

  + Create 'my-new-repo'... ✓
```

**TEAMS** — shows existing/desired team lists; for teams being created, lists the repos they will be granted; for existing teams with changes, shows `current repos | desired | + grant | - revoke | ~ update`:
```
TEAMS
  Existing teams: Defunct Team
  Desired teams:  My Team
  Team 'My Team' — desired repos: my-new-repo

  + Create team 'My Team'... ✓
  + Grant own: 'My Team' on 'my-new-repo'... ✓
  - Delete team 'Defunct Team'... ✓
```

For an existing team whose repo assignments or roles changed:
```
  Team 'My Team' — current repos: old-repo | desired: new-repo | + grant: new-repo | - revoke: old-repo
  Team 'My Team' — current repos: my-repo | desired: my-repo | ~ update: my-repo
```

**SECURITY** — shows all four assignment lists (existing and desired for both configs):
```
SECURITY
  Existing ospo-managed: repo1, repo2
  Existing custom:       special-repo
  Desired ospo-managed:  my-new-repo, repo1, repo2
  Desired custom:        special-repo

  + Assign to 'ospo-managed': 'my-new-repo'... ✓
```

**BRANCH PROTECTION** — shows existing and desired target lists by repo name:
```
BRANCH PROTECTION
  Existing targets: repo1, repo2
  Desired targets:  my-new-repo, repo1

  + Assign to 'ospo-managed': 'my-new-repo'... ✓
  + Assign to 'custom': 'repo2'... ✓
```

---

## Dependencies

| Tool | Purpose | Change vs. today |
|---|---|---|
| `node` + `npm` | Run the script, install packages | Node was already needed for `lint_repos.js` |
| `@octokit/rest` | GitHub API | Replaces `gh api` calls |
| `js-yaml` | Parse YAML config | Replaces `yq` |


---

## Unit Tests

Unit tests live in `scripts/create_repos.test.js` and run with Node's built-in test runner (`node --test`).

Each function is tested in isolation with mocked Octokit responses. Key scenarios:

- **Config loading:** valid config; missing repository name; invalid repo name pattern; unknown repo-level field; invalid team name; unknown access entry field; invalid role value; unknown `security` value; unknown `branch-protection` value; fields default when omitted (`role` defaults to `own`, `access` defaults to `[]`)
- **Repository processing:** repos to create (desired − existing); no new repos needed; duplicate detection
- **Team processing:** teams to add / update / delete; per-entry role used in grant; role change detected and updated; no API call when role unchanged; `--skip-custom-role` substitutes `own→maintain` only (not `write` or `triage`); `write` config role sends `push` to API; `push` API value normalised back to `write` for comparison; Entra ID group validation failure
- **Security assignments:** repo assigned to ospo-managed config; repo assigned to custom config; assignment already correct (no-op); configuration not found (error)
- **Branch protection:** target list updated when repo added; target list updated when repo switches to custom; target list already correct (no-op); ruleset not found (error)
- **Dry-run:** no API mutations are called; planned changes are collected and returned

### Integration test (against `ospo-sandbox`)

Requires `GITHUB_TOKEN`. Run via Makefile, not part of the unit test suite.

```makefile
test_create_repos:
    cd .. && node scripts/create_repos.js --org ospo-sandbox \
        --config scripts/test-config/create_repos.yaml \
        --skip-team-sync --skip-custom-role --debug
```

---

## CI/CD Changes

`.github/workflows/create_repos.yaml` updated:

```yaml
name: Create repos
on:
  workflow_dispatch:
  push:
    branches: [main]
    paths: ['config/create_repos.yaml']

jobs:
  dry-run:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v6

    - uses: actions/setup-node@v4
      with:
        node-version: 22

    - name: Install dependencies
      run: npm ci
      working-directory: scripts

    - uses: actions/create-github-app-token@v3
      id: app-token
      with:
        app-id: ${{ secrets.ALLIANZ_APP_ID }}
        private-key: ${{ secrets.ALLIANZ_APP_PRIVATE_KEY }}
        owner: allianz

    - name: Dry-run
      env:
        GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
      run: node scripts/create_repos.js --org allianz --dry-run

  apply:
    needs: dry-run
    environment: github.com
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v6

    - uses: actions/setup-node@v4
      with:
        node-version: 22

    - name: Install dependencies
      run: npm ci
      working-directory: scripts

    - uses: actions/create-github-app-token@v3
      id: app-token
      with:
        app-id: ${{ secrets.ALLIANZ_APP_ID }}
        private-key: ${{ secrets.ALLIANZ_APP_PRIVATE_KEY }}
        owner: allianz

    - name: Apply
      env:
        GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
      run: node scripts/create_repos.js --org allianz
```

---

## Implementation Details

This section documents API behaviour that is not obvious from the GitHub documentation and must be implemented correctly to avoid runtime errors.

### Permission name mapping

The GitHub REST API uses different permission names than the config's user-facing role names. Two helper functions handle the translation:

- **`toApiRole(role)`** — used before every `addOrUpdateRepoPermissionsInOrg` call:

| Config value | API value | Reason |
|---|---|---|
| `own` | `Own` | Custom org role; API name is case-sensitive |
| `write` | `push` | GitHub's legacy API name for write access |
| `triage` | `triage` | Same in both |

- **`fromApiRole(roleName)`** — used when reading `role_name` from `listReposInOrg`, to normalize API values back to config names before comparison:

| API `role_name` | Config value |
|---|---|
| `Own` | `own` |
| `push` | `write` |
| `triage` | `triage` |

Without this roundtrip mapping, every repo with `write` access would appear as changed on every run (`'push' !== 'write'`), and API calls for `write` would fail with `422 Validation Failed`.

---

### Octokit instantiation

Instantiate Octokit with a silent logger to suppress the library's default `console.warn` / `console.info` output, which would pollute the script's structured output:

```js
const noop = () => {};
const octokit = new Octokit({ auth: token, log: { debug: noop, info: noop, warn: noop, error: noop } });
```

### Security configuration API

**Attaching repositories** (`POST /orgs/{org}/code-security/configurations/{configuration_id}/attach`):

- The `scope` field is **required**. Always pass `scope: 'selected'` alongside `selected_repository_ids`. Omitting it causes a `422 Invalid input: object is missing required key: scope` error.

```js
await octokit.request('POST /orgs/{org}/code-security/configurations/{configuration_id}/attach', {
  org,
  configuration_id: cfg.id,
  scope: 'selected',
  selected_repository_ids: repoIds,
  headers: { 'X-GitHub-Api-Version': '2022-11-28' },
});
```

**Reading current assignments** (`GET /orgs/{org}/code-security/configurations/{configuration_id}/repositories`):

- Each item in the response array has the repo object nested under a `.repository` key, not directly as a flat repo object. Extract the name with `r.repository?.name ?? r.name` to handle both shapes defensively.

```js
const assigned = new Set(repos.map(r => r.repository?.name ?? r.name));
```

### Branch protection ruleset API

**Targeting repositories by ID** (`PUT /orgs/{org}/rulesets/{ruleset_id}`):

- Use the `repository_id` condition (not `repository_name`) to match what the GitHub UI does when repositories are selected directly. Name-pattern conditions use glob matching and are a different mechanism.

```js
conditions: {
  ref_name: fullRuleset.conditions?.ref_name,
  repository_id: {
    repository_ids: desiredIds,   // numeric IDs, sorted
  },
},
```

- Resolve repo names to numeric IDs by paginating `GET /orgs/{org}/repos` before building the target list. Repos not yet created (not present in the org) are silently skipped.

**Sending only writable fields on PUT**:

- The `GET /orgs/{org}/rulesets/{id}` response includes read-only fields (`id`, `node_id`, `created_at`, `updated_at`, `_links`, etc.) that the PUT endpoint rejects with a schema error if echoed back. Do **not** spread the full ruleset object. Send only the fields the API accepts:

```js
await octokit.request('PUT /orgs/{org}/rulesets/{ruleset_id}', {
  org,
  ruleset_id: fullRuleset.id,
  name: fullRuleset.name,
  target: fullRuleset.target,
  enforcement: fullRuleset.enforcement,
  bypass_actors: fullRuleset.bypass_actors,
  conditions: { /* ... */ },
  rules: fullRuleset.rules,
  headers: { 'X-GitHub-Api-Version': '2022-11-28' },
});
```

