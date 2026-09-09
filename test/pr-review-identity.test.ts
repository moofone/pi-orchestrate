import { test } from "node:test";
import assert from "node:assert/strict";
import {
	classifyVerdictNext,
	isGithubServerError,
	parsePrKey,
	prKeyFileToken,
	prKeyId,
	sameGitHead,
	samePrKey,
	stabilizeVerdictBody,
	verdictIdentity,
} from "../src/lib/pr-review-identity.ts";

test("same PR number in different repositories are different keys", () => {
	const a = parsePrKey({ pr: 475, slug: "moofone/icemining" });
	const b = parsePrKey({ pr: 475, slug: "moofone/icemining-devops" });
	assert.ok(a && b);
	assert.notEqual(prKeyId(a), prKeyId(b));
	assert.equal(samePrKey(a, b), false);
	assert.equal(prKeyId(a), "github.com/moofone/icemining#475");
});

test("elapsed-time text is excluded from verdict identity", () => {
	const pr = parsePrKey({ pr: 2537, slug: "moofone/icemining" })!;
	const base = [
		"next=read_comments_and_fix",
		"head=e9de4b669",
		"comment_id=1",
		"brief_finding overflow",
	].join("\n");
	const a = verdictIdentity({ pr, next: "read_comments_and_fix", body: `${base}\nelapsed_seconds=12` });
	const b = verdictIdentity({ pr, next: "read_comments_and_fix", body: `${base}\nelapsed_seconds=20997` });
	assert.equal(a, b);
	assert.equal(stabilizeVerdictBody(`${base}\nelapsed_seconds=12`).includes("elapsed_seconds"), false);
});

test("two findings rounds with the same next= remain distinct", () => {
	const pr = parsePrKey({ pr: 2537, slug: "moofone/icemining" })!;
	const round1 = verdictIdentity({
		pr,
		next: "read_comments_and_fix",
		head: "e9de4b669",
		round: "1",
		body: "next=read_comments_and_fix\nhead=e9de4b669\nbrief_finding overflow",
	});
	const round2 = verdictIdentity({
		pr,
		next: "read_comments_and_fix",
		head: "2033c56dc",
		round: "2",
		body: "next=read_comments_and_fix\nhead=2033c56dc\nbrief_finding overflow",
	});
	assert.notEqual(round1, round2);
});

test("sameGitHead treats a waiter short SHA as the live full SHA", () => {
	const full = "e9de4b669aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	assert.equal(sameGitHead(full.slice(0, 12), full), true);
	assert.equal(sameGitHead(full, full.slice(0, 7)), true);
	assert.equal(sameGitHead(full, "2033c56dcccccccccccccccccccccccccccccccc"), false);
	assert.equal(sameGitHead("e9de4b669", "e9de4b660aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
	assert.equal(sameGitHead("", full), false);
});

test("GitHub 500 is an env verdict, not a code fix", () => {
	assert.equal(isGithubServerError("error=HTTP 500: oops"), true);
	assert.equal(classifyVerdictNext("fix_command_or_environment", "HTTP 500"), "env");
	assert.equal(classifyVerdictNext("read_comments_and_fix"), "fix");
});

test("explicit fix next= is not env just because the review body mentions HTTP 500", () => {
	assert.equal(
		classifyVerdictNext(
			"read_comments_and_fix",
			"next=read_comments_and_fix\ncomment body=retry on HTTP 500 / GitHub unavailable",
		),
		"fix",
	);
});

test("status=500 and auth bodies classify as environment outcomes", () => {
	assert.equal(isGithubServerError("status=500"), true);
	assert.equal(classifyVerdictNext("fix_command_or_environment", "status=500"), "env");
	assert.equal(classifyVerdictNext("fix_command_or_environment", "error=Bad credentials"), "env");
});

test("parsePrKey rejects owner/repo that would escape the store directory", () => {
	assert.equal(parsePrKey({ pr: 1, owner: "../etc", repo: "passwd" }), undefined);
	assert.equal(parsePrKey({ pr: 1, owner: "moofone", repo: "ice/../../tmp" }), undefined);
	assert.equal(parsePrKey({ pr: 1, owner: "..", repo: "icemining" }), undefined);
	assert.equal(parsePrKey({ pr: 1, owner: "moofone", repo: ".." }), undefined);
	assert.equal(parsePrKey({ pr: 1, owner: "moofone\\..", repo: "x" }), undefined);
	assert.equal(parsePrKey({ pr: 1, slug: "foo/../../etc/passwd" }), undefined);
	assert.ok(parsePrKey({ pr: 1, owner: "moofone", repo: "icemining" }));
	assert.ok(parsePrKey({ pr: 1, slug: "moofone/.github" }));
	const token = prKeyFileToken({
		host: "github.com",
		owner: "../etc",
		repo: "passwd",
		number: "1",
	});
	assert.equal(token.includes("/"), false);
	assert.equal(token.includes("\\"), false);
});
