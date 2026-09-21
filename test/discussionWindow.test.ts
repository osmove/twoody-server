import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseDiscussion, reuseWindowMs } from "../src/discussionWindow.js";

const now = new Date("2026-09-21T22:30:00Z");
const ago = (seconds: number) => ({ id: `t-${seconds}`, lastActivityAt: new Date(now.getTime() - seconds * 1000) });

test("a text surface never continues a conversation it did not name", () => {
  for (const channel of ["desktop", "chat", "web", "keyboard", "api", "cli", "", undefined]) {
    assert.equal(reuseWindowMs(channel), null, String(channel));
    // Thirty seconds after the previous exchange: still a new conversation.
    assert.equal(chooseDiscussion({ channel, forceNew: false, explicit: null, mostRecent: ago(30), now }), null, String(channel));
  }
});

test("a text surface continues the conversation it names, however old", () => {
  const named = ago(3 * 24 * 3600);
  assert.equal(chooseDiscussion({ channel: "desktop", forceNew: false, explicit: named, mostRecent: ago(5), now }), named);
});

test("a voice surface continues the latest conversation for a short while", () => {
  const recent = ago(40);
  assert.equal(chooseDiscussion({ channel: "device", forceNew: false, explicit: null, mostRecent: recent, now }), recent);
  assert.equal(chooseDiscussion({ channel: "device", forceNew: false, explicit: null, mostRecent: ago(90), now }), null);
  const onWatch = ago(9 * 60);
  assert.equal(chooseDiscussion({ channel: "watch", forceNew: false, explicit: null, mostRecent: onWatch, now }), onWatch);
  assert.equal(chooseDiscussion({ channel: "watch", forceNew: false, explicit: null, mostRecent: ago(11 * 60), now }), null);
});

test("a voice surface naming a conversation that has gone quiet starts over", () => {
  assert.equal(chooseDiscussion({ channel: "device", forceNew: false, explicit: ago(3600), mostRecent: null, now }), null);
  const live = ago(20);
  assert.equal(chooseDiscussion({ channel: "device", forceNew: false, explicit: live, mostRecent: null, now }), live);
});

test("'new conversation' wins over everything", () => {
  assert.equal(chooseDiscussion({ channel: "device", forceNew: true, explicit: ago(5), mostRecent: ago(5), now }), null);
  assert.equal(chooseDiscussion({ channel: "desktop", forceNew: true, explicit: ago(5), mostRecent: null, now }), null);
});
