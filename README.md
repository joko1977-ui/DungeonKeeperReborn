# Dungeon Keeper Reborn

A clean-room reimagining of the 1997 dungeon-management classic: you are an evil
keeper, you carve a dungeon out of solid rock, you lure monsters into it, and
you feed the heroes who come to stop you to those monsters.

The goal is the original's **look and feel**, rebuilt with modern rendering —
torchlit PBR materials, dynamic lights, real-time shadows, bloom — and made to
run on anything with a browser.

![The dungeon](docs/screenshot-overview.png)

## Play it

**Web (all platforms, nothing to install):** open the deployed build, or run it
locally in two commands. It works on Windows, macOS, Linux, Android and iOS —
anything with a modern browser. On desktop Chrome/Edge and on Android you can
also use *Install app* to get it as a standalone, offline-capable PWA.

```bash
npm install
npm run dev          # http://localhost:5173
```

For a production build:

```bash
npm run build        # outputs to dist/
npm run preview      # serve the built game on :4173
```

`dist/` is a fully static directory — drop it on any web host, or open it from a
file server. There is no backend.

**Desktop (native window):** a [Tauri](https://tauri.app) shell wraps the same
build into a real application for Windows, macOS and Linux. It is deliberately
thin — a native window around the web build — so there is only ever one game to
maintain.

```bash
npm install -g @tauri-apps/cli
npm run build
tauri build          # bundles .msi/.exe, .dmg, .deb and .AppImage
```

CI builds all three desktop platforms and the web bundle on every push; see
`.github/workflows/build.yml`.

## Controls

The original's mouse language is unusual, and it *is* the interface, so it is
reproduced exactly.

| Input | Action |
| --- | --- |
| **Left click / drag** | Tag walls for excavation. The first tile decides whether the drag tags or untags. |
| **Left click** on your creature | Snatch it into the Hand of Evil. Click again to drop it on any floor you own. |
| **Right click** on a creature | Slap it — it works faster, takes a little damage, and resents you. |
| **Right click** on a wall | Clear an excavation tag. |
| **Middle drag**, **Q** / **E** | Rotate the view. |
| **Wheel**, **PgUp/PgDn** | Zoom. |
| **WASD** / arrows / screen edge | Move the view. |
| **R** / **F** / **C** | Rooms, Spells and Creatures tabs. **1–9** picks from the open tab. |
| **Space** | Pause. **Esc** puts down the selected tool. |
| **Touch** | Drag to pan, pinch to zoom, twist to rotate. |

## How the game works

Play follows the original's loop:

1. **Tag and dig.** Your imps excavate anything you have tagged and can reach,
   working inward through a tagged slab layer by layer.
2. **Claim.** Dug floor is neutral until an imp converts it. Claimed floor is
   the only place you can build, and it is what generates mana and lights the
   corridors.
3. **Mine.** Gold seams pay into your treasury — but only as much as your
   treasury has room for, so treasure rooms are a real constraint. Gem seams
   never run out.
4. **Build.** A lair and a hatchery are the gate on everything else: creatures
   will not come through your portal without a bed to sleep in and food to eat.
5. **Keep them.** Creatures get hungry, tired and angry. Unpaid creatures at
   payday become furious; furious creatures walk out through your portal.
6. **Fight.** Heroes arrive in escalating waves from the hero gate. Lose your
   Dungeon Heart and the level is over.

Rooms available: Treasury, Lair, Hatchery, Training Room, Library and Bridge.
Keeper spells: Create Imp, Heal, Speed, Lightning, Call to Arms and Possess.

## How it is built

```
src/
  core/        the simulation — no rendering, no DOM
    constants.ts   terrain, rooms, spells, balance numbers
    tilemap.ts     the grid, as parallel typed arrays
    pathfinding.ts A* plus a "nearest thing matching X" search
    creatures.ts   the roster and the creature record
    ai.ts          needs-driven creature behaviour
    rooms.ts       placement, selling, room lookup index
    game.ts        the tick, the economy, spells, the Hand of Evil
    levelgen.ts    seeded realm generation
  render/      three.js
    textures.ts        every material, generated procedurally at load
    terrain.ts         the whole dungeon in two instanced draw calls
    creatureModels.ts  creature meshes built from primitives
    creatureRenderer.ts instanced drawing and procedural animation
    effects.ts         torches, dynamic lights, particles
    scene.ts           renderer, lighting rig, post-processing
  input/       camera control and the Hand of Evil
  ui/          the keeper's panel, minimap, icons, overlays
```

A few decisions worth knowing about:

- **The simulation is separate from everything else.** `src/core` has no
  reference to three.js or the DOM. It runs headlessly, which is how the game
  loop was tested before there was anything to look at.
- **Fixed 20 Hz simulation, free-running render.** Behaviour is identical at 30
  or 144 fps; only smoothness changes.
- **No art assets ship with the game.** Every texture is generated from noise
  functions at load time and every creature is built from primitives. That keeps
  the download small, keeps materials sharp at any resolution, and means nothing
  in the repository is anyone else's artwork.
- **Two draw calls for the entire map.** Floors and walls are instanced meshes;
  which material an instance wears is a per-instance atlas index read by a small
  patch to three's standard shader. Map size costs almost nothing.
- **Torches are cheap.** Every wall bordering claimed floor gets a glowing
  point, but only the nine nearest the camera are promoted to real dynamic
  lights.

Quality settings are chosen from the device: phones and low-core machines drop
bloom, shadows and pixel ratio automatically.

### Development

```bash
npm run dev         # dev server with hot reload
npm run typecheck   # tsc --noEmit, strict
npm run build       # typecheck + production bundle
```

Append `?seed=1234` to the URL to generate a different realm. `window.dk` exposes
the running `game`, `camera` and render rig for poking at from the console.

## Legal

This is an original, independent work. It contains **no** code, art, audio,
level data or other assets from Dungeon Keeper; everything here was written from
scratch, and all visuals are generated procedurally at runtime.

*Dungeon Keeper* is a trademark of Electronic Arts Inc. This project is not
affiliated with, endorsed by, or connected to Electronic Arts or Bullfrog
Productions. It is a tribute, built because the original is thirty years old and
still has no real successor.

The source in this repository is available under the MIT License.
