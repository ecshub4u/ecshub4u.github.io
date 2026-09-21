import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  joinPath,
  parentPath,
  isInside,
  buildView,
  describeSkipped,
  itemsFromFileList,
  collectFromEntries,
  MAX_FILES_PER_DROP,
} from "../../js/paths.js";

/** The website's sub-folder helpers live in js/paths.js and are plain
 * functions (no page, no network), so they're tested here alongside the
 * backend tests -- same `npm test`. */

describe("path helpers", () => {
  test("joinPath skips empty parts", () => {
    assert.equal(joinPath("a", "b/c"), "a/b/c");
    assert.equal(joinPath("", "b"), "b");
    assert.equal(joinPath("", ""), "");
  });
  test("parentPath", () => {
    assert.equal(parentPath("a/b/c"), "a/b");
    assert.equal(parentPath("a"), "");
    assert.equal(parentPath(""), "");
  });
  test("isInside counts the folder itself and everything below, but not look-alikes", () => {
    assert.ok(isInside("calendar", "calendar"));
    assert.ok(isInside("calendar/css", "calendar"));
    assert.ok(!isInside("calendar2", "calendar"));
    assert.ok(!isInside("", "calendar"));
    assert.ok(isInside("anything", ""), "the top level contains everything");
  });
});

describe("buildView", () => {
  const f = (name, path, sizeBytes = 10) => ({ id: name + path, name, path, sizeBytes });
  const files = [
    f("readme.txt", ""),
    f("index.html", "calendar"),
    f("style.css", "calendar/css", 100),
    f("reset.css", "calendar/css", 50),
    f("deep.js", "calendar/css/vendor"),
    f("notes.txt", "calendar2"),
    f("a.py", "10-labs"),
    f("b.py", "2-labs"),
  ];

  test("top level: files here + one row per sub-folder, with nested files counted", () => {
    const view = buildView(files, "");
    assert.deepEqual(view.files.map((x) => x.name), ["readme.txt"]);
    const summary = Object.fromEntries(view.folders.map((d) => [d.name, [d.path, d.fileCount, d.sizeBytes]]));
    assert.deepEqual(summary.calendar, ["calendar", 4, 170]);
    assert.deepEqual(summary.calendar2, ["calendar2", 1, 10]);
  });

  test("inside a sub-folder: only that level, and look-alike siblings stay out", () => {
    const view = buildView(files, "calendar");
    assert.deepEqual(view.files.map((x) => x.name), ["index.html"]);
    assert.deepEqual(view.folders.map((d) => [d.name, d.path, d.fileCount]), [["css", "calendar/css", 3]]);
  });

  test("deeper level", () => {
    const view = buildView(files, "calendar/css");
    assert.deepEqual(view.files.map((x) => x.name), ["style.css", "reset.css"]);
    assert.deepEqual(view.folders.map((d) => d.name), ["vendor"]);
  });

  test("sub-folders are sorted naturally (2 before 10) and files keep the server's order", () => {
    assert.deepEqual(buildView(files, "").folders.map((d) => d.name), ["2-labs", "10-labs", "calendar", "calendar2"]);
  });

  test("files from before this feature have no path and show at the top level", () => {
    const view = buildView([{ id: "1", name: "old.py", sizeBytes: 5 }], "");
    assert.deepEqual(view.files.map((x) => x.name), ["old.py"]);
  });

  test("a path that doesn't exist shows nothing", () => {
    assert.deepEqual(buildView(files, "nope"), { folders: [], files: [] });
  });
});

// ---- Fakes for the browser's file-system entry API ----
function fileEntry(name, size = 5) {
  const file = new File(["x".repeat(size)], name);
  return { isFile: true, isDirectory: false, name, file: (ok) => ok(file) };
}
function dirEntry(name, children, batchSize = 2) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let position = 0;
      return {
        readEntries(ok) {
          const batch = children.slice(position, position + batchSize); // real browsers also answer in batches
          position += batchSize;
          ok(batch);
        },
      };
    },
  };
}
const shape = (result) => result.items.map(({ file, dir }) => `${dir || "."}::${file.name}`).sort();

describe("collectFromEntries (dropped files and folders)", () => {
  test("a dropped folder keeps its structure; the folder's own name is the first level", async () => {
    const tree = dirEntry("calendar", [
      fileEntry("index.html"),
      fileEntry("app.js"),
      dirEntry("css", [fileEntry("style.css"), fileEntry("reset.css"), dirEntry("vendor", [fileEntry("lib.css")])]),
      fileEntry("readme.md"),
    ]);
    const result = await collectFromEntries([tree]);
    assert.deepEqual(shape(result), [
      "calendar/css/vendor::lib.css",
      "calendar/css::reset.css",
      "calendar/css::style.css",
      "calendar::app.js",
      "calendar::index.html",
      "calendar::readme.md",
    ]);
    assert.equal(result.tooMany, false);
  });

  test("loose files dropped next to a folder go at the top level", async () => {
    const result = await collectFromEntries([fileEntry("a.txt"), dirEntry("docs", [fileEntry("b.txt")])]);
    assert.deepEqual(shape(result), [".::a.txt", "docs::b.txt"]);
  });

  test("empty files, system clutter and node_modules/.git are skipped, and reported", async () => {
    const tree = dirEntry("project", [
      fileEntry("main.py"),
      fileEntry("empty.txt", 0),
      fileEntry(".DS_Store"),
      fileEntry("Thumbs.db"),
      dirEntry("node_modules", [fileEntry("huge.js")]),
      dirEntry(".git", [fileEntry("HEAD")]),
      dirEntry("src", [fileEntry("code.py")]),
    ]);
    const result = await collectFromEntries([tree]);
    assert.deepEqual(shape(result), ["project/src::code.py", "project::main.py"]);
    assert.deepEqual(result.skipped, { empty: 1, junk: 2, dirs: ["node_modules", ".git"] });
    assert.equal(describeSkipped(result.skipped), 'Skipped 1 empty file, 2 system files, the "node_modules" folder, the ".git" folder.');
  });

  test("more than the per-drop limit is flagged instead of half-uploaded", async () => {
    const many = dirEntry("big", Array.from({ length: 7 }, (_, i) => fileEntry(`f${i}.txt`)), 3);
    const result = await collectFromEntries([many], { maxFiles: 5 });
    assert.equal(result.tooMany, true);
    assert.equal(MAX_FILES_PER_DROP, 500);
  });

  test("exactly the limit is fine", async () => {
    const some = dirEntry("ok", Array.from({ length: 5 }, (_, i) => fileEntry(`f${i}.txt`)), 3);
    const result = await collectFromEntries([some], { maxFiles: 5 });
    assert.equal(result.tooMany, false);
    assert.equal(result.items.length, 5);
  });

  test("an empty folder yields nothing (folders only exist through their files)", async () => {
    const result = await collectFromEntries([dirEntry("empty", [])]);
    assert.equal(result.items.length, 0);
  });
});

describe("itemsFromFileList (file picker / folder picker)", () => {
  function pickedFile(name, relativePath, size = 3) {
    const file = new File(["y".repeat(size)], name);
    if (relativePath) Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
    return file;
  }

  test("plain file picks go at the top level", () => {
    const result = itemsFromFileList([pickedFile("a.txt", ""), pickedFile("b.txt", "")]);
    assert.deepEqual(shape(result), [".::a.txt", ".::b.txt"]);
  });

  test("a folder pick uses each file's relative path for its folder", () => {
    const result = itemsFromFileList([
      pickedFile("index.html", "calendar/index.html"),
      pickedFile("style.css", "calendar/css/style.css"),
      pickedFile("junk.js", "calendar/node_modules/x/junk.js"),
      pickedFile("empty.txt", "calendar/empty.txt", 0),
    ]);
    assert.deepEqual(shape(result), ["calendar/css::style.css", "calendar::index.html"]);
    assert.deepEqual(result.skipped, { empty: 1, junk: 0, dirs: ["node_modules"] });
  });

  test("nothing skipped -> empty message", () => {
    assert.equal(describeSkipped({ empty: 0, junk: 0, dirs: [] }), "");
  });
});
