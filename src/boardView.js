/**
 * Board view: an MCP App that shows the board a tool just worked on, inside the chat.
 *
 * Without it, a drawing tool answers with a link and the user leaves the conversation to see the
 * result. With EXCALIDASH_MCP_BOARD_VIEW=1, the server gains a `display_board` tool bound to a
 * small HTML view (MCP Apps, `ui://` resource) that shows the board as an image with an "Open in
 * ExcaliDash" button. Only that tool carries the view: hosts offer the view on every call of a tool
 * that declares one, and a view under list_boards or each small edit is noise. The drawing tools
 * instead end their result with a hint to call display_board once the drawing is done.
 *
 * The image travels in `structuredContent`, which hosts hand to the view, not in `content`, which
 * goes to the model: a preview must not cost the model a few hundred kilobytes of tokens per call.
 */
import { readFileSync } from "node:fs";

export const BOARD_VIEW_URI = "ui://excalidash/board-view.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const DISPLAY_TOOL = "display_board";

/** Tools that change a board; with the view enabled, their result points at display_board. */
export const DRAWING_TOOLS = new Set([
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

/**
 * Pixel densities tried in turn: a large board rendered at full size went past the limit and the
 * view showed no image at all (seen 2026-11-06), so a smaller render is better than none.
 */
const PREVIEW_SCALES = [1, 0.6, 0.35, 0.2];

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
 * Wrap a drawing tool so a successful result ends with what to do next: show the board with
 * display_board once the drawing is finished, and give the user the edit link.
 */
export function withDisplayHint(handler, getProvider) {
  return async (args, extra) => {
    const result = await handler(args, extra);
    const boardId = args?.board_id;
    if (!boardId || result?.isError || !Array.isArray(result?.content)) return result;
    const url = getProvider().getUrl(boardId);
    const hint =
      `When the drawing is finished (not after every step), call ${DISPLAY_TOOL} with this ` +
      `board_id to show it to the user in the chat, and give them the edit link: ${url}`;
    return { ...result, content: [...result.content, { type: "text", text: hint }] };
  };
}

export const displayBoardDescription =
  "Show a board to the user inside the chat, as a preview with an Open in ExcaliDash button. " +
  "Call it once, when a drawing is finished or when the user asks to see a board, then give the " +
  "user the edit link. Do not call it after each intermediate edit.";

/**
 * The display_board handler: render the board to a PNG for the view. A preview that cannot be
 * produced never fails the tool: the view then shows the link alone.
 *
 * @param getProvider returns the provider of the current call (resolved per request in HTTP mode)
 * @param renderPng (elements, opts) => data URL
 */
export function displayBoard(getProvider, renderPng) {
  return async ({ board_id: boardId }) => {
    const provider = getProvider();
    const board = { id: boardId, url: provider.getUrl(boardId) };
    try {
      const drawing = await provider.getDrawing(boardId);
      board.name = drawing?.name;
      const active = (drawing?.elements || []).filter((element) => !element.isDeleted);
      if (!active.length) {
        board.empty = true;
      } else {
        for (const scale of PREVIEW_SCALES) {
          const png = await renderPng(active, { scale, padding: 24 });
          if (png.length <= MAX_PREVIEW_CHARS) {
            board.png = png;
            break;
          }
        }
        if (!board.png) board.tooLarge = true;
      }
    } catch (err) {
      board.error = err.message;
    }
    const shown = board.name ? `"${board.name}"` : "The board";
    return {
      content: [{
        type: "text",
        text: `${shown} is shown to the user in the chat. Give them the edit link: ${board.url}`,
      }],
      structuredContent: { excalidashBoard: board },
    };
  };
}
