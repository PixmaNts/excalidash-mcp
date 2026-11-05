import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_VIEW_URI,
  DISPLAY_TOOL,
  DRAWING_TOOLS,
  MCP_APP_MIME_TYPE,
  boardViewResource,
  boardViewToolMeta,
  displayBoard,
  withDisplayHint,
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

test("only drawing tools get the hint, never list or read tools", () => {
  assert.ok(DRAWING_TOOLS.has("draw_mermaid"));
  assert.ok(!DRAWING_TOOLS.has("read_board"));
  assert.ok(!DRAWING_TOOLS.has("list_boards"));
  assert.ok(!DRAWING_TOOLS.has(DISPLAY_TOOL));
});

test("a drawing result ends with the display_board hint and the edit link", async () => {
  const wrapped = withDisplayHint(async () => ok, () => fakeProvider({}));
  const result = await wrapped({ board_id: "b1" });
  assert.equal(result.content[0].text, "done");
  assert.match(result.content[1].text, /display_board/);
  assert.match(result.content[1].text, /https:\/\/draw\.example\.com\/editor\/b1/);
  assert.equal(result.structuredContent, undefined);

  const failing = { isError: true, content: [{ type: "text", text: "nope" }] };
  assert.equal(await withDisplayHint(async () => failing, () => fakeProvider({}))({ board_id: "b" }), failing);
});

test("display_board renders live elements into structuredContent, not into content", async () => {
  const provider = fakeProvider({ name: "Arch", elements: [{ id: "a" }, { id: "b", isDeleted: true }] });
  let rendered;
  const result = await displayBoard(() => provider, async (elements) => {
    rendered = elements;
    return "data:image/png;base64,AAAA";
  })({ board_id: "b1" });
  assert.deepEqual(rendered, [{ id: "a" }]);
  assert.match(result.content[0].text, /editor\/b1/);
  assert.doesNotMatch(result.content[0].text, /base64/);
  assert.deepEqual(result.structuredContent.excalidashBoard, {
    id: "b1",
    url: "https://draw.example.com/editor/b1",
    name: "Arch",
    png: "data:image/png;base64,AAAA",
  });
});

test("empty boards, failed renders and oversized previews never fail display_board", async () => {
  const empty = await displayBoard(() => fakeProvider({ name: "E", elements: [] }), null)({ board_id: "b" });
  assert.equal(empty.structuredContent.excalidashBoard.empty, true);

  const broken = await displayBoard(
    () => fakeProvider({ name: "X", elements: [{ id: "a" }] }),
    async () => { throw new Error("no browser"); },
  )({ board_id: "b" });
  assert.equal(broken.structuredContent.excalidashBoard.error, "no browser");
  assert.equal(broken.isError, undefined);

  const scales = [];
  const shrunk = await displayBoard(
    () => fakeProvider({ name: "Big", elements: [{ id: "a" }] }),
    async (_elements, { scale }) => {
      scales.push(scale);
      return scale < 0.5 ? "data:image/png;base64,small" : "data:image/png;base64," + "A".repeat(1_000_000);
    },
  )({ board_id: "b" });
  assert.deepEqual(scales, [1, 0.6, 0.35]);
  assert.equal(shrunk.structuredContent.excalidashBoard.png, "data:image/png;base64,small");

  const huge = await displayBoard(
    () => fakeProvider({ name: "Huge", elements: [{ id: "a" }] }),
    async () => "data:image/png;base64," + "A".repeat(1_000_000),
  )({ board_id: "b" });
  assert.equal(huge.structuredContent.excalidashBoard.png, undefined);
  assert.equal(huge.structuredContent.excalidashBoard.tooLarge, true);
});
