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
  ];

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
