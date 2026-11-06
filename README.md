# monthlet MCP server

Use the notes in your [monthlet](https://monthlet.ai) vault from Claude Code, Claude Desktop and other MCP clients. Search and read notes, and, if you allow it, create and edit them.

The MCP server runs inside the monthlet app on your computer. This repository contains the small bridge that MCP clients start over stdio (`monthlet-mcp.cjs`). The bridge relays each message to the app over `127.0.0.1` and does nothing else. It sends nothing to the internet.

## Requirements

- monthlet for macOS or Windows, running
- The MCP server turned on in monthlet: **Settings > Connectors > Publish to external agents > Publish**
- Node.js 18 or later (the bridge has no other dependencies)

If monthlet isn't running, or the MCP server is off, every tool call returns an error that says so.

## What the server can do

Reading is on as soon as you publish. Writing, moving and renaming, and deleting each have their own switch in the same settings section, and all three are off by default.

| Switch | Tools |
| --- | --- |
| Publish (read only) | `search_notes`, `list_notes`, `read_note`, `grep_notes`, `list_folders`, `list_files`, `get_backlinks`, `list_attachments`, `view_image`, `read_pdf`, `read_file`, `read_chart_data`, `read_sheet_range` |
| Allow writing | `create_note`, `update_note`, `edit_note`, `update_tags`, `create_folder`, `create_sheet`, `apply_sheet_edits`, `add_attachment` |
| Allow moving and renaming | `move_note`, `move_folder`, `rename_note`, `rename_folder` |
| Allow deleting | `delete_note`, `delete_folder`, `merge_notes` (deleted items go to the system trash) |

Every tool carries MCP tool annotations (`readOnlyHint`, `destructiveHint`), so clients can ask before running the ones that change your notes.

## Install

### Claude Code plugin

Install **monthlet** from the Claude plugin directory, or from this repository in Claude Code:

```
/plugin install monthlet --marketplace t27d/monthlet-mcp
```

The plugin runs `node ${CLAUDE_PLUGIN_ROOT}/monthlet-mcp.cjs`.

### Claude Code, by hand

Clone this repository, then:

```sh
claude mcp add --scope user monthlet -- node /path/to/monthlet-mcp/monthlet-mcp.cjs
```

On macOS you can also use the copy inside the app. monthlet shows the exact command in **Settings > Connectors > Publish to external agents > Setup**.

### Claude Desktop and other clients

Add a stdio server that runs the bridge with Node.js. In Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "monthlet": {
      "command": "node",
      "args": ["/path/to/monthlet-mcp/monthlet-mcp.cjs"]
    }
  }
}
```

On Windows, write the path with escaped backslashes, for example `"C:\\Users\\you\\monthlet-mcp\\monthlet-mcp.cjs"`.

## How it connects

While its MCP server is on, monthlet writes a connection file with the current port and access token to its user data folder, and deletes the file when it stops:

- macOS: `~/Library/Application Support/monthlet/mcp-endpoint.json`
- Windows: `%APPDATA%\monthlet\mcp-endpoint.json`, or, for the Microsoft Store version, the same path inside `%LOCALAPPDATA%\Packages\t27d.monthlet_*\LocalCache\Roaming`

The bridge reads this file each time it connects, so the token never goes into your client's configuration, and regenerating the token in monthlet needs no change on the client side.

## License

MIT. monthlet itself is not open source; this repository covers the bridge only.
