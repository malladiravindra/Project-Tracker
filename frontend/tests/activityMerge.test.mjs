import { test } from "node:test";
import assert from "node:assert/strict";
import { appendUnique, hasMore, loadNextPage, reloadLoaded } from "../lib/activityMerge.ts";

// A fake newest-first server. Ids grow over time; newest first means highest id first.
function fakeServer(total) {
  let rows = Array.from({ length: total }, (_, i) => ({ id: total - i }));
  return {
    addNewest(n = 1) {
      const top = rows[0].id;
      const added = Array.from({ length: n }, (_, i) => ({ id: top + n - i }));
      rows = [...added, ...rows];
    },
    remove(id) {
      rows = rows.filter((r) => r.id !== id);
    },
    calls: [],
    async page(limit, offset) {
      this.calls.push([limit, offset]);
      return { results: rows.slice(offset, offset + limit), count: rows.length };
    },
    get all() {
      return rows;
    },
  };
}
const ids = (rows) => rows.map((r) => r.id);
const same = (x) => x;

test("appendUnique skips ids already present and keeps order", () => {
  const out = appendUnique([{ id: 5 }, { id: 4 }], [{ id: 4 }, { id: 3 }, { id: 3 }, { id: 2 }]);
  assert.deepEqual(ids(out), [5, 4, 3, 2]);
  assert.deepEqual(ids(appendUnique([], [])), []);
  // string and number ids are the same row
  assert.equal(appendUnique([{ id: "1" }], [{ id: 1 }, { id: 2 }]).length, 2);
});

test("load more pages through the whole list without duplicates", async () => {
  const s = fakeServer(120);
  const map = (x) => ({ id: String(x.id) });
  let rows = (await s.page(50, 0)).results.map(map);
  while (rows.length < 120) {
    const r = await loadNextPage(rows, (l, o) => s.page(l, o), map, 50);
    assert.ok(r.rows.length > rows.length);
    rows = r.rows;
  }
  assert.equal(new Set(ids(rows)).size, 120);
  assert.deepEqual(ids(rows), s.all.map((r) => String(r.id)));
  assert.equal(hasMore(rows.length, 120), false);
  assert.equal(hasMore(50, 120), true);
});

test("a new event at the head shifts offsets: load-more still has no duplicates", async () => {
  const s = fakeServer(120);
  const rows = (await s.page(50, 0)).results;
  s.addNewest(3); // 3 events land after the first page was loaded
  const r = await loadNextPage(rows, (l, o) => s.page(l, o), same, 50);
  // offset 50 now starts 3 rows earlier, so 3 rows repeat and are dropped
  assert.equal(new Set(ids(r.rows)).size, r.rows.length);
  assert.equal(r.rows.length, 97);
  assert.equal(r.count, 123);
  assert.deepEqual(ids(r.rows), ids(s.all.slice(3, 100))); // the new head events appear after a refetch
});

test("a whole page of repeats still makes progress", async () => {
  const s = fakeServer(200);
  const rows = (await s.page(50, 0)).results;
  s.addNewest(60); // more new events than a page
  const r = await loadNextPage(rows, (l, o) => s.page(l, o), same, 50);
  assert.ok(r.rows.length > rows.length);
  assert.equal(new Set(ids(r.rows)).size, r.rows.length);
});

test("reloadLoaded re-reads exactly the loaded depth, in pages of at most 200", async () => {
  const s = fakeServer(500);
  const r = await reloadLoaded(450, (l, o) => s.page(l, o));
  assert.deepEqual(s.calls, [
    [200, 0],
    [200, 200],
    [50, 400],
  ]);
  assert.equal(r.rows.length, 450);
  assert.equal(r.count, 500);
  assert.deepEqual(ids(r.rows), ids(s.all.slice(0, 450)));
});

test("reloadLoaded after new head events: the head appears, nothing duplicates, nothing vanishes", async () => {
  const s = fakeServer(300);
  s.addNewest(2);
  const r = await reloadLoaded(250, (l, o) => s.page(l, o));
  assert.equal(r.rows.length, 250);
  assert.deepEqual(ids(r.rows), ids(s.all.slice(0, 250)));
  assert.equal(new Set(ids(r.rows)).size, 250);
  assert.equal(r.count, 302);
});

test("reloadLoaded reads at least one first page, and stops at the end", async () => {
  const s = fakeServer(7);
  const r = await reloadLoaded(0, (l, o) => s.page(l, o));
  assert.equal(r.rows.length, 7);
  assert.deepEqual(s.calls, [[50, 0]]);
  const empty = fakeServer(1);
  empty.remove(1);
  const e = await reloadLoaded(10, (l, o) => empty.page(l, o));
  assert.deepEqual(e, { rows: [], count: 0 });
});

test("reloadLoaded with everything loaded keeps the oldest row when a new event arrives", async () => {
  const s = fakeServer(83);
  s.addNewest(1);
  const r = await reloadLoaded(83, (l, o) => s.page(l, o), 50, true);
  assert.equal(r.rows.length, 84);
  assert.deepEqual(ids(r.rows), ids(s.all));
  assert.deepEqual(s.calls, [[200, 0]]);
});

test("a deleted event (decision undo) disappears on reload", async () => {
  const s = fakeServer(80);
  s.remove(77);
  const r = await reloadLoaded(80, (l, o) => s.page(l, o));
  assert.equal(r.rows.some((x) => x.id === 77), false);
  assert.equal(r.rows.length, 79);
  assert.equal(r.count, 79);
});
