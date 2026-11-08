import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { API_VERSION, createGitHub, createOctokit, isNotFound } from '../../lib/github.js';

/** A real Octokit whose HTTP layer records requests and answers with `respond(request)`. */
function recordingOctokit(respond = () => ({})) {
  const requests = [];
  const fetch = async (url, options) => {
    const request = { url: String(url), method: options.method, headers: options.headers, body: options.body && JSON.parse(options.body) };
    requests.push(request);
    const { status = 200, data = {} } = respond(request) ?? {};
    return new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  };
  const octokit = createOctokit('test-token', { request: { fetch } });
  return { octokit, requests, gh: createGitHub(octokit) };
}

const last = requests => requests[requests.length - 1];

describe('createOctokit', () => {
  it('sends the pinned API version and the token on every request', async () => {
    const { octokit, requests } = recordingOctokit();
    await octokit.request('GET /zen');
    assert.equal(requests[0].headers['x-github-api-version'], API_VERSION);
    assert.equal(requests[0].headers.authorization, 'token test-token');
  });

  it('silences Octokit logging', () => {
    const { octokit } = recordingOctokit();
    for (const level of ['debug', 'info', 'warn', 'error']) assert.equal(octokit.log[level](), undefined);
  });
});

describe('isNotFound', () => {
  it('is true only for status 404', () => {
    assert.equal(isNotFound({ status: 404 }), true);
    assert.equal(isNotFound({ status: 500 }), false);
    assert.equal(isNotFound(undefined), false);
  });
});

describe('createGitHub', () => {
  // [method call, expected HTTP method, expected path (with query), expected body, response data, expected result]
  const cases = [
    [gh => gh.listOrgRepos('o'), 'GET', '/orgs/o/repos?per_page=100', undefined, [{ name: 'r' }], [{ name: 'r' }]],
    [gh => gh.listOrgRepos('o', { type: 'public' }), 'GET', '/orgs/o/repos?per_page=100&type=public', undefined, [], []],
    [gh => gh.createRepo('o', 'r'), 'POST', '/orgs/o/repos', { name: 'r', visibility: 'public', auto_init: true }, { id: 1 }, { id: 1 }],
    [gh => gh.archiveRepo('o', 'r'), 'PATCH', '/repos/o/r', { archived: true }, {}, undefined],
    [gh => gh.listOpenIssues('o', 'r'), 'GET', '/repos/o/r/issues?state=open&per_page=100', undefined, [{ number: 1 }], [{ number: 1 }]],
    [gh => gh.createIssue('o', 'r', { title: 't', body: 'b' }), 'POST', '/repos/o/r/issues', { title: 't', body: 'b' }, { number: 2 }, { number: 2 }],
    [gh => gh.updateIssue('o', 'r', 2, { body: 'b' }), 'PATCH', '/repos/o/r/issues/2', { body: 'b' }, {}, undefined],
    [gh => gh.commentIssue('o', 'r', 2, 'c'), 'POST', '/repos/o/r/issues/2/comments', { body: 'c' }, {}, undefined],
    [gh => gh.closeIssue('o', 'r', 2), 'PATCH', '/repos/o/r/issues/2', { state: 'closed' }, {}, undefined],
    [gh => gh.listTeams('o'), 'GET', '/orgs/o/teams?per_page=100', undefined, [{ slug: 't' }], [{ slug: 't' }]],
    [gh => gh.createTeam('o', 'T'), 'POST', '/orgs/o/teams', { name: 'T', privacy: 'closed' }, { slug: 't' }, { slug: 't' }],
    [gh => gh.deleteTeam('o', 't'), 'DELETE', '/orgs/o/teams/t', undefined, {}, undefined],
    [gh => gh.listTeamRepos('o', 't'), 'GET', '/orgs/o/teams/t/repos?per_page=100', undefined, [{ name: 'r' }], [{ name: 'r' }]],
    [gh => gh.setTeamRepoPermission('o', 't', 'r', 'push'), 'PUT', '/orgs/o/teams/t/repos/o/r', { permission: 'push' }, {}, undefined],
    [gh => gh.removeTeamRepo('o', 't', 'r'), 'DELETE', '/orgs/o/teams/t/repos/o/r', undefined, {}, undefined],
    [gh => gh.searchTeamSyncGroups('o', 'T'), 'GET', '/orgs/o/team-sync/groups?q=T', undefined, { groups: [{ group_id: '1' }] }, [{ group_id: '1' }]],
    [gh => gh.searchTeamSyncGroups('o', 'T'), 'GET', '/orgs/o/team-sync/groups?q=T', undefined, {}, []],
    [gh => gh.setTeamSyncGroups('o', 't', [{ group_id: '1' }]), 'PATCH', '/orgs/o/teams/t/team-sync/group-mappings', { groups: [{ group_id: '1' }] }, {}, undefined],
    [gh => gh.listSecurityConfigs('o'), 'GET', '/orgs/o/code-security/configurations', undefined, [{ id: 1 }], [{ id: 1 }]],
    [gh => gh.listSecurityConfigRepos('o', 1), 'GET', '/orgs/o/code-security/configurations/1/repositories?per_page=100', undefined, [{ repository: {} }], [{ repository: {} }]],
    [gh => gh.attachSecurityConfig('o', 1, [5]), 'POST', '/orgs/o/code-security/configurations/1/attach', { scope: 'selected', selected_repository_ids: [5] }, {}, undefined],
    [gh => gh.listOrgRulesets('o'), 'GET', '/orgs/o/rulesets', undefined, [{ id: 1 }], [{ id: 1 }]],
    [gh => gh.getOrgRuleset('o', 1), 'GET', '/orgs/o/rulesets/1', undefined, { id: 1 }, { id: 1 }],
    [gh => gh.updateOrgRuleset('o', 1, { name: 'n' }), 'PUT', '/orgs/o/rulesets/1', { name: 'n' }, {}, undefined],
    [gh => gh.requestSbomReport('o', 'r'), 'GET', '/repos/o/r/dependency-graph/sbom/generate-report', undefined, { sbom_url: 'https://u' }, 'https://u'],
    [gh => gh.listPublishedAdvisories('o', 'r'), 'GET', '/repos/o/r/security-advisories?state=published&per_page=100', undefined, [{ ghsa_id: 'g' }], [{ ghsa_id: 'g' }]],
    [gh => gh.listLanguages('o', 'r'), 'GET', '/repos/o/r/languages', undefined, { Go: 100, C: 5 }, { Go: 100, C: 5 }],
    [gh => gh.listReleases('o', 'r'), 'GET', '/repos/o/r/releases?per_page=100', undefined, [{ tag_name: 'v1.0.0' }], [{ tag_name: 'v1.0.0' }]],
    [gh => gh.listRootFiles('o', 'r'), 'GET', '/repos/o/r/contents', undefined, [{ name: 'CHANGELOG.md', type: 'file' }, { name: 'docs', type: 'dir' }], ['CHANGELOG.md']],
    [gh => gh.getFileText('o', 'r', 'CHANGELOG.md'), 'GET', '/repos/o/r/contents/CHANGELOG.md', undefined, '## 1.0.0', '## 1.0.0'],
    [gh => gh.listOrgMembers('o'), 'GET', '/orgs/o/members?per_page=100', undefined, [{ login: 'ana' }], ['ana']],
    [gh => gh.getContributorStats('o', 'r'), 'GET', '/repos/o/r/stats/contributors', undefined, [{ total: 1 }], { status: 200, data: [{ total: 1 }] }],
    [gh => gh.listIssuesSince('o', 'r', '2026-10-01T00:00:00Z'), 'GET', '/repos/o/r/issues?state=all&since=2026-10-01T00%3A00%3A00Z&per_page=100', undefined, [{ number: 1 }], [{ number: 1 }]],
    [gh => gh.getTrafficViews('o', 'r'), 'GET', '/repos/o/r/traffic/views?per=day', undefined, { count: 3, uniques: 1, views: [] }, { count: 3, uniques: 1, views: [] }],
    [gh => gh.getTrafficClones('o', 'r'), 'GET', '/repos/o/r/traffic/clones?per=day', undefined, { count: 2, uniques: 1, clones: [] }, { count: 2, uniques: 1, clones: [] }],
  ];

  it('getContributorStats returns the status while GitHub computes the statistics', async () => {
    const { gh } = recordingOctokit(() => ({ status: 202, data: {} }));
    assert.deepEqual(await gh.getContributorStats('o', 'r'), { status: 202, data: [] });
  });

  it('listPullsUpdatedSince stops paging at the first pull request updated before the date', async () => {
    const since = '2026-10-01T00:00:00Z';
    const { gh, requests } = recordingOctokit(() => ({ data: [{ number: 2, updated_at: '2026-10-05T00:00:00Z' }, { number: 1, updated_at: '2026-09-30T00:00:00Z' }] }));
    assert.deepEqual((await gh.listPullsUpdatedSince('o', 'r', since)).map(p => p.number), [2]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.github.com/repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=100');
  });

  for (const [call, method, pathAndQuery, body, data, expected] of cases) {
    it(`${method} ${pathAndQuery}`, async () => {
      const { gh, requests } = recordingOctokit(() => ({ data }));
      const result = await call(gh);
      const request = last(requests);
      assert.equal(request.method, method);
      assert.equal(request.url, `https://api.github.com${pathAndQuery}`);
      assert.deepEqual(request.body, body);
      assert.deepEqual(result, expected);
    });
  }

  it('propagates HTTP errors with their status', async () => {
    const { gh } = recordingOctokit(() => ({ status: 404, data: { message: 'Not Found' } }));
    await assert.rejects(() => gh.listOpenIssues('o', 'missing'), err => isNotFound(err));
  });
});
