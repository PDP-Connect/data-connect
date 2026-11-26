import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSchedulePractice, scheduleChoices, scheduleSentence } from "./schedule-presentation.ts";

test("practice inputs cover mixed, 32 paused, and empty schedules", () => {
  assert.equal(buildSchedulePractice("mixed")?.length, 6);
  assert.equal(buildSchedulePractice("paused")?.length, 32);
  assert.equal(buildSchedulePractice("none")?.length, 0);
  assert.equal(buildSchedulePractice("unknown"), null);
});
test("paused prints one sentence; local devices have no schedule choice", () => {
  const rows = buildSchedulePractice("mixed")!;
  assert.equal(scheduleSentence(rows[4]!), "Paused");
  assert.equal(scheduleSentence(rows[3]!), "Only when you press Sync now");
  assert.match(scheduleSentence(rows[5]!), /^Syncs from /);
  assert.equal(scheduleChoices(rows[5]!).length, 0);
});
test("choices respect recommendation and retain unusual present intervals", () => {
  const row = buildSchedulePractice("mixed")![2]!;
  const choices = scheduleChoices(row);
  assert.ok(choices.some((choice) => choice.seconds === 2700 && choice.label.endsWith("(now)")));
  assert.ok(!choices.some((choice) => choice.seconds === 3600));
  assert.ok(choices.some((choice) => choice.label.includes("recommended")));
});

test("a paused data source without a schedule says Paused alone", () => {
  const row = buildSchedulePractice("mixed")![3]!;
  assert.equal(scheduleSentence({ ...row, status: "paused" }), "Paused");
});

test("collector schedule sentences name the device when the server supplies it", () => {
  assert.equal(scheduleSentence(buildSchedulePractice("mixed")![5]!, Date.now(), "Work computer"), "Syncs from Work computer when that computer runs it");
});

test("automatic timing stays honest when the next run is not known", () => {
  const source = buildSchedulePractice("mixed")![0]!;
  assert.match(scheduleSentence({ ...source, schedule: { ...source.schedule!, next_due_at: null } }), /next sync time is not known/);
});
test("the current standard interval is marked even when it is recommended", () => {
  const source = buildSchedulePractice("mixed")![0]!;
  assert.match(scheduleChoices(source).find(row => row.seconds === 86400)!.label, /recommended.*now/);
});

test("paused sources without a schedule explain how to resume", async () => {
  const { pausedScheduleReason } = await import("./schedule-presentation.ts")
  const source = {
    ...buildSchedulePractice("mixed")![3]!,
    status: "paused",
  } as never
  assert.match(pausedScheduleReason(source)!, /Choose a sync frequency/)
})

test("a known next sync is shown in the schedule sentence", () => {
  const source = buildSchedulePractice("mixed")![0]!;
  assert.match(scheduleSentence(source), /next sync in about 3 hours/);
});
