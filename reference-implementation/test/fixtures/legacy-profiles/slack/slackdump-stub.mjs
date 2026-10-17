#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Offline stand-in for the slackdump CLI, for the legacy-profile execution test.
// It replays a CONSTRUCTED raw slackdump archive (no recorded real archive exists
// in data-connectors; this is built to the tables and columns the Slack connector
// reads: connectors/slack/index.ts SELECTs). It never touches the network.
//
// Subcommands the connector runs (index.ts runSlackdump call sites):
//   version                              (scheduler readiness; detect.args)
//   workspace list                       -> stdout must match /[=]>/ (WORKSPACE_LIST_ARROW)
//   workspace new -token T -cookie C -no-encryption
//   archive -y -no-encryption -api-config <toml> -o <dir> [-time-from X] [-member-only] [-files=false] [channel ...]
//   resume -no-encryption -api-config <toml> -lookback pNd <dir>
// `resume` additionally appends one new message, renames the workspace and adds one membership
// (a later slackdump pass seeing new traffic).
// Every invocation is logged to <os.tmpdir()>/slackdump-stub.jsonl.
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const log = (extra = {}) =>
	appendFileSync(
		join(tmpdir(), "slackdump-stub.jsonl"),
		`${JSON.stringify({ args: args.map((a, i) => (args[i - 1] === "-token" || args[i - 1] === "-cookie" ? "<redacted>" : a)), ...extra })}\n`,
	);
const fail = (code, message) => {
	log({ exit: code, message });
	process.stderr.write(`${message}\n`);
	process.exit(code);
};

const TEAM = "T0ACME001";
const ME = "U0TESTER1";
const ALICE = "U0ALICE01";
const BASE = 1791000000;
const ts = (offset, micro) =>
	`${BASE + offset}.${String(micro).padStart(6, "0")}`;

const user = (id, name, real) => ({
	id,
	team_id: TEAM,
	name,
	real_name: real,
	deleted: false,
	color: "4bbe2e",
	tz: "America/Chicago",
	tz_label: "Central Time",
	tz_offset: -18000,
	profile: {
		real_name: real,
		real_name_normalized: real,
		display_name: name,
		display_name_normalized: name,
		first_name: real.split(" ")[0],
		last_name: real.split(" ")[1],
		email: `${name}@acme.example`,
		title: "Engineer",
		status_text: "",
		status_emoji: "",
		status_expiration: 0,
		image_192: "https://avatars.example/x.png",
	},
	is_admin: id === ME,
	is_owner: false,
	is_primary_owner: id === ME,
	is_restricted: false,
	is_ultra_restricted: false,
	is_bot: false,
	is_app_user: false,
	updated: BASE - 5000,
});
const chan = (id, name, extra) => ({
	id,
	name,
	name_normalized: name,
	created: BASE - 100000,
	creator: ME,
	is_archived: false,
	is_member: true,
	num_members: 2,
	context_team_id: TEAM,
	topic: { value: `${name} topic`, creator: ME, last_set: BASE - 90000 },
	purpose: { value: `${name} purpose`, creator: ME, last_set: BASE - 90000 },
	...extra,
});

const CHANNELS = [
	chan("C0GENERAL1", "general", {
		is_channel: true,
		is_general: true,
		is_private: false,
		properties: {
			canvas: {
				file_id: "F0CANVAS01",
				is_empty: false,
				quip_thread_id: "quipthread001",
			},
		},
	}),
	chan("C0PRIVATE1", "secret-plans", {
		is_channel: false,
		is_group: true,
		is_private: true,
	}),
	{
		id: "D0DIRECT01",
		created: BASE - 80000,
		is_im: true,
		is_org_shared: false,
		user: ALICE,
		is_user_deleted: false,
		context_team_id: TEAM,
	},
];
const USERS = [
	user(ME, "tester", "Test Er"),
	user(ALICE, "alice", "Alice Example"),
];
const MEMBERS = [
	["C0GENERAL1", ME],
	["C0GENERAL1", ALICE],
	["C0PRIVATE1", ME],
	["D0DIRECT01", ME],
	["D0DIRECT01", ALICE],
];
const msg = (channel, tsv, userId, text, extra = {}) => ({
	channel,
	ts: tsv,
	thread_ts: extra.thread_ts ?? null,
	isParent: extra.isParent ? 1 : null,
	text,
	data: {
		type: "message",
		user: userId,
		text,
		ts: tsv,
		team: TEAM,
		...extra.data,
	},
});
const T1 = ts(100, 100);
const T2 = ts(200, 200);
const MESSAGES = [
	msg("C0GENERAL1", T1, ALICE, "Hello team, shipping the report today.", {
		data: {
			client_msg_id: "cm-1",
			reactions: [{ name: "tada", users: [ME, ALICE], count: 2 }],
			attachments: [
				{
					fallback: "PR 12",
					title: "Pull Request 12",
					service_name: "GitHub",
					from_url: "https://git.example/pr/12",
					text: "Adds the thing",
					color: "36a64f",
				},
			],
			blocks: [{ type: "section" }],
		},
	}),
	msg("C0GENERAL1", T2, ME, "Thread parent: who owns the rollout?", {
		isParent: true,
		thread_ts: T2,
		data: {
			thread_ts: T2,
			reply_count: 1,
			reply_users: [ALICE],
			latest_reply: ts(250, 300),
		},
	}),
	msg("C0GENERAL1", ts(250, 300), ALICE, "I do.", {
		thread_ts: T2,
		data: { thread_ts: T2, parent_user_id: ME },
	}),
	msg("C0PRIVATE1", ts(300, 100), ME, "Private note.", {}),
	msg("D0DIRECT01", ts(400, 100), ALICE, "ping", {
		data: { reactions: [{ name: "eyes", users: [ME], count: 1 }] },
	}),
];
// Each `resume` pass sees one new message in #general, renames the workspace, and one new membership.
const resumeMessage = (session) =>
	msg(
		"C0GENERAL1",
		ts(900 + 100 * session, 400),
		ALICE,
		`New message seen by resume session ${session}.`,
		{ data: { client_msg_id: `cm-r${session}` } },
	);
const FILES = [
	{
		id: "F0FILE0001",
		filename: "report.pdf",
		url: "https://acme.slack.example/files-pri/T0ACME001-F0FILE0001/report.pdf",
		mode: "hosted",
		channel: "C0GENERAL1",
		messageId: 1,
		data: {
			id: "F0FILE0001",
			name: "report.pdf",
			title: "Monthly Report",
			mimetype: "application/pdf",
			filetype: "pdf",
			pretty_type: "PDF",
			size: 10240,
			created: BASE - 1000,
			user: ALICE,
			mode: "hosted",
			is_public: false,
			is_external: false,
			permalink: "https://acme.slack.example/files/F0FILE0001",
			url_private:
				"https://acme.slack.example/files-pri/T0ACME001-F0FILE0001/report.pdf",
		},
	},
	{
		id: "F0CANVAS01",
		filename: "project-canvas",
		url: "https://acme.slack.example/docs/T0ACME001/F0CANVAS01",
		mode: "quip",
		channel: "C0GENERAL1",
		messageId: null,
		data: {
			id: "F0CANVAS01",
			name: "project-canvas",
			title: "Project Canvas",
			mimetype: "application/vnd.slack-docs",
			filetype: "quip",
			pretty_type: "Canvas",
			size: 2048,
			created: BASE - 900,
			updated: BASE - 800,
			user: ME,
			mode: "quip",
			permalink: "https://acme.slack.example/docs/F0CANVAS01",
			url_private: "https://acme.slack.example/docs/T0ACME001/F0CANVAS01",
		},
	},
];

function writeArchive(dir, { resume }) {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "slackdump.sqlite");
	const exists = existsSync(path);
	const db = new DatabaseSync(path);
	db.exec(`
    CREATE TABLE IF NOT EXISTS SESSION (ID INTEGER PRIMARY KEY, CREATED_AT TEXT, UPDATED_AT TEXT, PAR_SESSION_ID INTEGER, FROM_TS TEXT, TO_TS TEXT, FINISHED INTEGER NOT NULL, FILES_ENABLED INTEGER, AVATARS_ENABLED INTEGER, MODE TEXT NOT NULL, ARGS TEXT);
    CREATE TABLE IF NOT EXISTS CHUNK (ID INTEGER PRIMARY KEY, SESSION_ID INTEGER, UNIX_TS INTEGER, TYPE_ID INTEGER NOT NULL, CHANNEL_ID TEXT, NUM_REC INTEGER, FINAL INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS WORKSPACE (ID INTEGER PRIMARY KEY, TEAM TEXT, TEAM_ID TEXT, USERNAME TEXT, USER_ID TEXT, URL TEXT, ENTERPRISE_ID TEXT, DATA TEXT);
    CREATE TABLE IF NOT EXISTS CHANNEL (ID TEXT NOT NULL, NAME TEXT, DATA TEXT, CHUNK_ID INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS CHANNEL_USER (CHANNEL_ID TEXT NOT NULL, USER_ID TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS S_USER (ID TEXT NOT NULL, USERNAME TEXT, DATA TEXT, CHUNK_ID INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS MESSAGE (CHANNEL_ID TEXT NOT NULL, TS TEXT NOT NULL, THREAD_TS TEXT, IS_PARENT INTEGER, TXT TEXT, NUM_FILES INTEGER, DATA BLOB, CHUNK_ID INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS FILE (ID TEXT NOT NULL, FILENAME TEXT, URL TEXT, MODE TEXT, CHANNEL_ID TEXT, MESSAGE_ID INTEGER, DATA TEXT, CHUNK_ID INTEGER NOT NULL);
  `);
	const nextId = (table) =>
		db.prepare(`SELECT COALESCE(MAX(ID), 0) + 1 AS n FROM ${table}`).get().n;
	const session = nextId("SESSION");
	db.prepare(
		"INSERT INTO SESSION (ID, CREATED_AT, FINISHED, MODE, ARGS) VALUES (?, ?, 1, ?, ?)",
	).run(
		session,
		"2026-10-14T00:00:00Z",
		resume ? "resume" : "archive",
		args.join("|"),
	);
	let chunk = nextId("CHUNK");
	const newChunk = (type, channel, n) => {
		db.prepare(
			"INSERT INTO CHUNK (ID, SESSION_ID, UNIX_TS, TYPE_ID, CHANNEL_ID, NUM_REC, FINAL) VALUES (?, ?, ?, ?, ?, ?, 1)",
		).run(chunk, session, BASE, type, channel, n);
		return chunk++;
	};
	const insertMessages = (list) => {
		for (const channel of [...new Set(list.map((m) => m.channel))]) {
			const rows = list.filter((m) => m.channel === channel);
			const chunkId = newChunk(0, channel, rows.length);
			for (const m of rows) {
				db.prepare(
					"INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				).run(
					m.channel,
					m.ts,
					m.thread_ts,
					m.isParent,
					m.text,
					m.data.files ? m.data.files.length : null,
					new TextEncoder().encode(JSON.stringify(m.data)),
					chunkId,
				);
			}
		}
	};
	if (!resume || !exists) {
		const c0 = newChunk(1, null, CHANNELS.length);
		for (const c of CHANNELS) {
			db.prepare(
				"INSERT INTO CHANNEL (ID, NAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)",
			).run(c.id, c.name ?? null, JSON.stringify(c), c0);
		}
		const c1 = newChunk(2, null, USERS.length);
		for (const u of USERS) {
			db.prepare(
				"INSERT INTO S_USER (ID, USERNAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)",
			).run(u.id, u.name, JSON.stringify(u), c1);
		}
		for (const [c, u] of MEMBERS) {
			db.prepare(
				"INSERT INTO CHANNEL_USER (CHANNEL_ID, USER_ID) VALUES (?, ?)",
			).run(c, u);
		}
		db.prepare(
			"INSERT INTO WORKSPACE (ID, TEAM, TEAM_ID, USERNAME, USER_ID, URL, ENTERPRISE_ID, DATA) VALUES (1, 'Acme', ?, 'tester', ?, 'https://acme.slack.example/', '', ?)",
		).run(
			TEAM,
			ME,
			JSON.stringify({
				ok: true,
				url: "https://acme.slack.example/",
				team: "Acme",
				user: "tester",
				team_id: TEAM,
				user_id: ME,
			}),
		);
		const c2 = newChunk(3, null, FILES.length);
		for (const f of FILES) {
			db.prepare(
				"INSERT INTO FILE (ID, FILENAME, URL, MODE, CHANNEL_ID, MESSAGE_ID, DATA, CHUNK_ID) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				f.id,
				f.filename,
				f.url,
				f.mode,
				f.channel,
				f.messageId,
				JSON.stringify(f.data),
				c2,
			);
		}
		insertMessages(MESSAGES);
	}
	if (resume) {
		insertMessages([resumeMessage(session)]);
		db.prepare("UPDATE WORKSPACE SET TEAM = 'Acme Inc' WHERE ID = 1").run();
		if (
			!db
				.prepare(
					"SELECT 1 FROM CHANNEL_USER WHERE CHANNEL_ID = 'C0PRIVATE1' AND USER_ID = ?",
				)
				.get(ALICE)
		) {
			db.prepare(
				"INSERT INTO CHANNEL_USER (CHANNEL_ID, USER_ID) VALUES ('C0PRIVATE1', ?)",
			).run(ALICE);
		}
	}
	db.close();
}

const [cmd, sub] = args;
if (cmd === "version") {
	log({ exit: 0 });
	process.stdout.write("slackdump stub (offline test double) v0.0.0\n");
} else if (cmd === "workspace" && sub === "list") {
	log({ exit: 0 });
	process.stdout.write(
		"Workspaces in 'stub':\n=> default (acme.slack.example)\n",
	);
} else if (cmd === "workspace" && sub === "new") {
	log({ exit: 0 });
} else if (cmd === "archive" || cmd === "resume") {
	const apiConfig = args[args.indexOf("-api-config") + 1];
	if (!(apiConfig && existsSync(apiConfig))) {
		fail(2, `stub: -api-config file not found: ${apiConfig}`);
	}
	if (!(process.env.SLACK_TOKEN || "").startsWith("xoxc-")) {
		fail(3, "stub: SLACK_TOKEN not provided in the child env");
	}
	const dir =
		cmd === "archive" ? args[args.indexOf("-o") + 1] : args[args.length - 1];
	if (!dir) {
		fail(2, "stub: no archive directory");
	}
	if (cmd === "resume" && !existsSync(join(dir, "slackdump.sqlite"))) {
		fail(4, `stub: resume target has no slackdump.sqlite: ${dir}`);
	}
	if (cmd === "archive" && existsSync(join(dir, "slackdump.sqlite"))) {
		rmSync(join(dir, "slackdump.sqlite"));
	}
	writeArchive(dir, { resume: cmd === "resume" });
	log({ exit: 0, apiConfig, dir });
} else {
	fail(64, `stub: unsupported slackdump invocation: ${args.join(" ")}`);
}
