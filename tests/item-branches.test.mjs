import assert from "node:assert/strict";
import test from "node:test";
import { getBranchItems, getArchivePatches, getArchiveViewItems, getBranchLayouts, getCompletionPatches } from "../lib/item-branches.ts";

const line = (id, parentId = null, extra = {}) => ({
  id, parentId, section: "now", groupName: "", archived: false, completed: false, ...extra,
});
const tree = () => [line("parent"), line("child", "parent"), line("nested", "child"), line("last", "parent"), line("other")];
const apply = (items, patches) => items.map(item => ({ ...item, ...patches.get(item.id) }));

test("completion reaches every descendant and leaves unrelated lines alone", () => {
  const items = tree();
  const patches = getCompletionPatches(items, "parent", true);
  assert.deepEqual([...patches.keys()].sort(), ["child", "last", "nested", "parent"]);
  assert.ok([...patches.values()].every(patch => patch.completed && patch.priority === "none"));
  assert.ok(items.every(item => !item.completed), "planning must not mutate the input");
});

test("completion traverses already completed intermediate parents", () => {
  const items = tree().map(item => ({ ...item, completed: item.id === "child" }));
  assert.equal(getCompletionPatches(items, "parent", true).get("nested").completed, true);
});

test("reopening a nested child reopens all ancestors but preserves sibling progress", () => {
  const done = apply(tree(), getCompletionPatches(tree(), "parent", true));
  const reopened = apply(done, getCompletionPatches(done, "nested", false));
  assert.deepEqual(reopened.map(item => [item.id, item.completed]), [
    ["parent", false], ["child", false], ["nested", false], ["last", true], ["other", false],
  ]);
});

test("reopening a parent does not erase its children's progress", () => {
  const done = apply(tree(), getCompletionPatches(tree(), "parent", true));
  assert.deepEqual([...getCompletionPatches(done, "parent", false)], [["parent", { completed: false }]]);
});

test("branch rails follow nesting and stop at the actual last sibling", () => {
  const layouts = getBranchLayouts(tree());
  assert.deepEqual(layouts.get("parent"), {depth:0,lastChild:false,continuations:[],childCount:2,completedChildren:0});
  assert.equal(layouts.get("child").lastChild, false);
  assert.deepEqual(layouts.get("nested"), {depth:2,lastChild:true,continuations:[2],childCount:0,completedChildren:0});
  assert.equal(layouts.get("last").lastChild, true);
  assert.equal(layouts.get("other").depth, 0);
  // Changing the sibling sort changes the connector ends, not ownership.
  const reversed = getBranchLayouts([line("parent"), line("last", "parent"), line("child", "parent"), line("nested", "child")]);
  assert.equal(reversed.get("child").lastChild, true);
  assert.deepEqual(reversed.get("nested").continuations, []);
});

test("filtered children are rendered as roots without dangling connectors", () => {
  const layouts = getBranchLayouts([line("child", "parent"), line("nested", "child")]);
  assert.equal(layouts.get("child").depth, 0);
  assert.equal(layouts.get("nested").depth, 1);
});

test("moved and archived lines do not form branches across separate lists", () => {
  const items = [line("parent"), line("archived", "parent", {archived:true}), line("moved", "parent", {section:"library"}), line("grouped", "parent", {groupName:"Elsewhere"})];
  assert.equal(getCompletionPatches(items, "parent", true).size, 1);
  assert.ok([...getBranchLayouts(items).values()].every(layout => layout.depth === 0));
});

test("broken and cyclic parent links terminate safely", () => {
  const items = [line("a", "b"), line("b", "a"), line("self", "self"), line("orphan", "missing")];
  assert.equal(getBranchLayouts(items).size, 4);
  assert.equal(getBranchLayouts(items).get("self").depth, 0);
  assert.equal(getCompletionPatches(items, "a", true).size, 2);
  assert.equal(getCompletionPatches(items, "missing", true).size, 0);
});


test("archive and restore include nested descendants, even legacy split archives", () => {
  const items = tree().map(item => ({...item, archived: item.id === "parent", archivedAt: item.id === "parent" ? "2026-11-11" : null}));
  const archived = apply(items, getArchivePatches(items, "parent", true, "2026-11-11"));
  assert.equal(archived.filter(item => item.archived).length, 4);
  assert.equal(archived.find(item => item.id === "other").archived, false);
  const restored = apply(archived, getArchivePatches(archived, "parent", false, null));
  assert.ok(restored.every(item => !item.archived && item.archivedAt === null));
  const view = getArchiveViewItems(items);
  assert.equal(view.filter(item => item.archived).length, 4);
  assert.equal(getBranchLayouts(view).get("nested").depth, 2);
  assert.equal(items.find(item => item.id === "child").archived, false);
});

test("restoring a nested subpoint restores its ancestors without losing sibling archives", () => {
  const items = tree().map(item => ({...item, archived:true}));
  const restored = apply(items, getArchivePatches(items, "nested", false, null));
  assert.deepEqual(restored.filter(item => !item.archived).map(item => item.id), ["parent", "child", "nested"]);
});

test("deletion gathers full branches once, including mixed archive states and cycles", () => {
  assert.deepEqual(getBranchItems(tree(), ["parent", "child"]).map(item => item.id), ["parent", "child", "nested", "last"]);
  assert.deepEqual(getBranchItems(tree(), ["child"]).map(item => item.id), ["child", "nested"]);
  assert.equal(getBranchItems([line("a", "b"),line("b", "a")], ["a"]).length, 2);
});
