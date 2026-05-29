# Plan: Port the stdio API to PathOfBuilding-PoE2 (enables the Lua bridge for PoE2)

## Why
The Lua bridge in this MCP speaks a JSON-over-stdio protocol (`{ready:true}`
banner, actions like `load_build_xml`, `get_stats`, `add_item_text`,
`export_build_xml`). That protocol exists **only on the PoE1 fork**
`ianderse/PathOfBuilding@api-stdio`. There is no PoE2 fork with it.

Pointing the bridge at the PoE1 fork runs, but computes PoE2 builds with the
PoE1 engine → wrong numbers. So `evaluate_trade_item` (live DPS/EHP delta) and
the Lua-bridge path of `generate_upgrade_links` cannot produce correct PoE2
results until the protocol is ported onto the PoE2 codebase.

(Until then, `generate_upgrade_links` works **bridge-free** by reading computed
stats from a PoB-saved / live-character XML — see `build_name` arg.)

## The patch surface (small + mostly additive)
`gh api repos/ianderse/PathOfBuilding/compare/dev...api-stdio` → 11 files:

| File | Change | Notes |
|---|---|---|
| `src/API/BuildOps.lua` | +733 | core: load/save/stats/items/tree ops. Calls into PoB internals — **most likely to need PoE2 fixups** |
| `src/API/Handlers.lua` | +247 | dispatch table action→BuildOps |
| `src/API/Server.lua` | +87 | stdio loop, JSON framing, ready banner |
| `src/HeadlessWrapper.lua` | +130 | boots headless, wires API server when `POB_API_STDIO=1` |
| `src/Modules/Main.lua` | +1 | hook |
| `src/lua-utf8.lua`, `src/utf8.lua`, `src/sha1.lua` | added | pure-lua deps |
| `spec/API/*` | added | busted specs |
| `API_README.md` | added | protocol docs |

## Steps
1. **Clone PoE2 PoB:** `git clone https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2 ~/Projects/PathOfBuilding2` (default branch `dev`). Create branch `api-stdio`.
2. **Copy additive files** from the PoE1 `api-stdio` branch into the PoE2 tree at the same paths: all of `src/API/`, `src/lua-utf8.lua`, `src/utf8.lua`, `src/sha1.lua`.
3. **Re-apply the two edits** (`HeadlessWrapper.lua`, `Modules/Main.lua`) — don't copy wholesale; PoE2's versions differ. Port just the API-server wiring (guarded by `POB_API_STDIO`).
4. **Fix BuildOps.lua against PoE2 internals.** Expect divergence in: stat field names PoB exposes (PoE2 uses different `output` keys), item/skill object shapes, tree class/ascendancy IDs. Work action-by-action: `ping` → `load_build_xml` → `get_stats` → `get_items` → `add_item_text` → `export_build_xml` (these are the ones the two MCP tools use).
5. **Windows headless runtime (the hard part).** HeadlessWrapper needs native modules. The MCP sets `LUA_CPATH` at `<fork>/runtime/?.dll`. Options:
   - Use the DLLs shipped in the packaged PoB2 install (`Path of Building (PoE2)/runtime/`); point `LUA_CPATH` there, or copy them into the fork's `runtime/`.
   - Required C modules typically: `lcurl`, `lzip`/`lua-zlib`, `lua-utf8` (we ship a pure-lua utf8 fallback), `xml`. Stub/disable network-dependent ones for headless calc.
   - Validate: `cd <fork>/src && POB_API_STDIO=1 luajit HeadlessWrapper.lua` should print `{"ready":true}` and respond to `{"action":"ping"}`.
6. **Configure the MCP** (`claude_desktop_config.json` + `.claude.json` `pob2` entry):
   ```json
   "env": {
     "POB_DIRECTORY": "C:\\Users\\m_ren\\Documents\\Path of Building (PoE2)\\Builds",
     "POB_LUA_ENABLED": "true",
     "POB_FORK_PATH": "C:\\Users\\m_ren\\Projects\\PathOfBuilding2\\src",
     "POB_CMD": "C:\\Users\\m_ren\\scoop\\shims\\luajit.exe",
     "POB_TIMEOUT_MS": "30000"
   }
   ```
7. **Restart Claude**, then test: `lua_start` → `lua_load_build` (a PoE2 build) → `lua_get_stats`. If stats match the PoB2 GUI, the port works; `evaluate_trade_item` then produces correct deltas.

## Validation checklist
- `luajit HeadlessWrapper.lua` prints ready banner (no missing-module errors)
- `get_stats` returns Life/EnergyShield/*Resist/*DPS matching PoB2 GUI for a known build
- `add_item_text` + `get_stats` reflects the swapped item
- `evaluate_trade_item` round-trips (snapshot → swap → diff → restore)

## Risk
Step 5 (Windows native runtime) is the usual blocker. If it fights back, a WSL/Linux
luajit setup is far smoother and the bridge can point at it.

## Status
- luajit installed: `C:\Users\m_ren\scoop\shims\luajit.exe`
- Bridge tools (`evaluate_trade_item`, Lua path of `generate_upgrade_links`) wait on this port.
- `generate_upgrade_links` already works bridge-free via `build_name`.
