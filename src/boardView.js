/**
 * Board view: an MCP App that shows the board a tool just worked on, inside the chat.
 *
 * Without it, a drawing tool answers with a link and the user leaves the conversation to see the
 * result. With EXCALIDASH_MCP_BOARD_VIEW=1, the tools that take a board_id also render that board
 * to a PNG after they run and declare a small HTML view (MCP Apps, `ui://` resource) that shows the
 * image with an "Open in ExcaliDash" button. Hosts without MCP Apps ignore the extra metadata.
 *
 * The image travels in `structuredContent`, which hosts hand to the view, not in `content`, which
 * goes to the model: a preview must not cost the model a few hundred kilobytes of tokens per call.
 */
import { readFileSync } from "node:fs";

export const BOARD_VIEW_URI = "ui://excalidash/board-view.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** Tools whose result is a board worth showing; all of them take `board_id`. */
export const BOARD_VIEW_TOOLS = new Set([
  "read_board",
  "draw_scene",
  "draw_graph",
  "draw_mermaid",
  "update_element",
  "rename_element",
  "delete_elements",
  "restore_version",
]);

/**
 * Largest preview kept, as a data URL. Hosts persist the view with the message and cap its size
 * (LibreChat: 1 MiB by default), so an oversized preview would drop the whole view.
 */
const MAX_PREVIEW_CHARS = 900_000;

const html = readFileSync(new URL("./board-view.html", import.meta.url), "utf8");

export function boardViewEnabled(env = process.env) {
  return env.EXCALIDASH_MCP_BOARD_VIEW === "1";
}

/** Tool `_meta` that points hosts at the view (current key and the legacy flat key). */
export function boardViewToolMeta(meta = {}) {
  return { ...meta, ui: { ...(meta.ui || {}), resourceUri: BOARD_VIEW_URI }, "ui/resourceUri": BOARD_VIEW_URI };
}

/**
 * The view resource. Its CSP declares the ExcaliDash origin, which is what lets the host open
 * the board link: hosts only open links to domains a view declared.
 */
export function boardViewResource(publicUrl) {
  const origin = new URL(publicUrl).origin;
  return {
    name: "excalidash-board-view",
    uri: BOARD_VIEW_URI,
    metadata: { mimeType: MCP_APP_MIME_TYPE, description: "Preview of an ExcaliDash board" },
    read: async () => ({
      contents: [{
        uri: BOARD_VIEW_URI,
        mimeType: MCP_APP_MIME_TYPE,
        text: html,
        _meta: { ui: { csp: { connectDomains: [origin] }, prefersBorder: false } },
      }],
    }),
  };
}

/**
 * Wrap a tool handler so its result also carries the board preview. A preview that cannot be
 * produced never fails the tool: the view then shows the link alone.
 *
 * @param handler the tool's own handler
 * @param getProvider returns the provider of the current call (resolved per request in HTTP mode)
 * @param renderPng (elements, opts) => data URL
 */
export function withBoardPreview(handler, getProvider, renderPng) {
  return async (args, extra) => {
    const result = await handler(args, extra);
    const boardId = args?.board_id;
    if (!boardId || result?.isError) return result;
    const provider = getProvider();
    const board = { id: boardId, url: provider.getUrl(boardId) };
    try {
      const drawing = await provider.getDrawing(boardId);
      board.name = drawing?.name;
      const active = (drawing?.elements || []).filter((element) => !element.isDeleted);
      if (!active.length) {
        board.empty = true;
      } else {
        const png = await renderPng(active, { scale: 1, padding: 24 });
        if (png.length <= MAX_PREVIEW_CHARS) board.png = png;
      }
    } catch (err) {
      board.error = err.message;
    }
    return {
      ...result,
      structuredContent: { ...(result.structuredContent || {}), excalidashBoard: board },
    };
  };
}
