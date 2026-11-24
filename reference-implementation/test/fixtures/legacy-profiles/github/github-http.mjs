// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Constructed GitHub REST responses (no recorded capture exists). Shapes follow what
// connectors/github/{index,parsers}.ts read; one page each, no Link header.
const ME = {
	id: 4242,
	login: "octotester",
	name: "Octo Tester",
	email: null,
	bio: "fixture",
	company: null,
	location: null,
	blog: "",
	twitter_username: null,
	created_at: "2019-03-04T05:06:07Z",
	updated_at: "2026-10-01T00:00:00Z",
	avatar_url: "https://avatars.example/u/4242",
	public_repos: 2,
	public_gists: 1,
	followers: 3,
	following: 4,
};
const repo = (id, name) => ({
	id,
	name,
	full_name: `octotester/${name}`,
	owner: { login: "octotester" },
	description: `${name} repo`,
	private: false,
	fork: false,
	archived: false,
	disabled: false,
	default_branch: "main",
	language: "TypeScript",
	topics: ["fixture"],
	stargazers_count: 5,
	forks_count: 1,
	open_issues_count: 1,
	watchers_count: 5,
	size: 120,
	license: { key: "mit" },
	html_url: `https://github.com/octotester/${name}`,
	homepage: null,
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2026-09-30T00:00:00Z",
	pushed_at: "2026-09-30T00:00:00Z",
});
const issue = (id, number, title, isPr) => ({
	id,
	number,
	title,
	body: "body",
	state: "open",
	state_reason: null,
	user: { login: "octotester", id: 4242 },
	assignees: [],
	labels: [{ name: "bug" }],
	milestone: null,
	repository_url: "https://api.github.com/repos/octotester/widgets",
	html_url: `https://github.com/octotester/widgets/issues/${number}`,
	comments: 2,
	reactions: { total_count: 1 },
	created_at: "2026-08-01T00:00:00Z",
	updated_at: "2026-09-15T00:00:00Z",
	closed_at: null,
	...(isPr
		? {
				pull_request: {
					url: `https://api.github.com/repos/octotester/widgets/pulls/${number}`,
					html_url: `https://github.com/octotester/widgets/pull/${number}`,
				},
				draft: false,
			}
		: {}),
});

export default function handle({ url }) {
	if (url.host !== "api.github.com") {
		return null;
	}
	const ok = (body) => ({ status: 200, body });
	const p = url.pathname;
	if (p === "/user") return ok(ME);
	if (p === "/user/repos")
		return ok([repo(1001, "widgets"), repo(1002, "gadgets")]);
	if (p === "/user/starred")
		return ok([
			{ starred_at: "2026-05-05T00:00:00Z", repo: repo(2001, "starred-lib") },
		]);
	if (p === "/issues") return ok([issue(3001, 11, "Crash on start", false)]);
	if (p === "/search/issues")
		return ok({
			total_count: 1,
			incomplete_results: false,
			items: [issue(4001, 7, "Add feature", true)],
		});
	if (p === "/repos/octotester/widgets/pulls/7") {
		return ok({
			draft: false,
			merged_at: "2026-09-16T00:00:00Z",
			merged_by: { login: "octotester" },
			commits: 2,
			additions: 10,
			deletions: 3,
			changed_files: 2,
			base: { ref: "main", repo: { id: 1001 } },
			head: { ref: "feature" },
			requested_reviewers: [],
			review_comments: 1,
		});
	}
	if (p === "/gists") {
		return ok([
			{
				id: "g1abc",
				description: "a gist",
				public: true,
				html_url: "https://gist.github.com/g1abc",
				files: {
					"a.txt": {
						filename: "a.txt",
						language: "Text",
						size: 12,
						raw_url: "https://gist.githubusercontent.com/raw/a.txt",
					},
				},
				comments: 0,
				created_at: "2026-02-02T00:00:00Z",
				updated_at: "2026-02-03T00:00:00Z",
			},
		]);
	}
	return null;
}
