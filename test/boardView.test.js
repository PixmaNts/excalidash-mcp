import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_VIEW_URI,
  MCP_APP_MIME_TYPE,
  boardViewResource,
  boardViewToolMeta,
  withBoardPreview,
} from "../src/boardView.js";

const fakeProvider = (drawing) => ({
  getUrl: (id) => `https://draw.example.com/editor/${id}`,
  getDrawing: async () => drawing,
});
const ok = { content: [{ type: "text", text: "done" }] };

test("the tool meta points at the view under both keys and keeps existing meta", () => {
  const meta = boardViewToolMeta({ other: 1, ui: { visibility: ["model"] } });
  assert.equal(meta.ui.resourceUri, BOARD_VIEW_URI);
  assert.equal(meta["ui/resourceUri"], BOARD_VIEW_URI);
  assert.deepEqual(meta.ui.visibility, ["model"]);
  assert.equal(meta.other, 1);
});

test("the view resource declares the ExcaliDash origin so the host may open board links", async () => {
  const view = boardViewResource("https://draw.example.com/");
  const { contents: [content] } = await view.read();
  assert.equal(content.mimeType, MCP_APP_MIME_TYPE);
  assert.deepEqual(content._meta.ui.csp.connectDomains, ["https://draw.example.com"]);
  assert.match(content.text, /ui\/initialize/);
});

test("a board result gains a preview in structuredContent, never in content", async () => {
  const provider = fakeProvider({ name: "Arch", elements: [{ id: "a" }, { id: "b", isDeleted: true }] });
  let rendered;
  const wrapped = withBoardPreview(async () => ok, () => provider, async (elements) => {
    rendered = elements;
    return "data:image/png;base64,AAAA";
  });
  const result = await wrapped({ board_id: "b1" });
  assert.deepEqual(result.content, ok.content);
  assert.deepEqual(rendered, [{ id: "a" }]);
  assert.deepEqual(result.structuredContent.excalidashBoard, {
    id: "b1",
    url: "https://draw.example.com/editor/b1",
    name: "Arch",
    png: "data:image/png;base64,AAAA",
  });
});

test("errors, empty boards and failed renders never break the tool", async () => {
  const failing = { isError: true, content: [{ type: "text", text: "nope" }] };
  const untouched = await withBoardPreview(async () => failing, () => fakeProvider({}), null)({ board_id: "b" });
  assert.equal(untouched, failing);

  const empty = await withBoardPreview(async () => ok, () => fakeProvider({ name: "E", elements: [] }), null)({ board_id: "b" });
  assert.equal(empty.structuredContent.excalidashBoard.empty, true);

  const broken = await withBoardPreview(
    async () => ok,
    () => fakeProvider({ name: "X", elements: [{ id: "a" }] }),
    async () => { throw new Error("no browser"); },
  )({ board_id: "b" });
  assert.equal(broken.structuredContent.excalidashBoard.error, "no browser");
  assert.equal(broken.structuredContent.excalidashBoard.png, undefined);
});

test("an oversized preview is dropped rather than shipped", async () => {
  const huge = "data:image/png;base64," + "A".repeat(1_000_000);
  const result = await withBoardPreview(
    async () => ok,
    () => fakeProvider({ name: "Big", elements: [{ id: "a" }] }),
    async () => huge,
  )({ board_id: "b" });
  assert.equal(result.structuredContent.excalidashBoard.png, undefined);
});
