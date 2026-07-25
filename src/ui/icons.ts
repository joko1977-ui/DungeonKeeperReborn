import { RoomType, SpellType } from '../core/constants';
import { DoorType, TrapType } from '../core/devices';
import { CreatureType } from '../core/creatures';

/**
 * Panel iconography, drawn as inline SVG.
 *
 * Each glyph is original artwork in the spirit of the source material: bold,
 * high-contrast, readable at 26px in a dim room. Keeping them as markup means
 * they inherit colour from CSS and stay sharp on any display.
 */

const wrap = (body: string, stroke = '#e8b44c'): string =>
  `<svg viewBox="0 0 32 32" fill="none" stroke="${stroke}" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/* ---------------------------------------------------------------- rooms -- */

const ROOM_ICONS: Record<RoomType, string> = {
  [RoomType.None]: wrap('<rect x="7" y="7" width="18" height="18" rx="2"/>'),

  [RoomType.DungeonHeart]: wrap(
    `<path d="M16 27C9 21 5 17 5 13a6 6 0 0 1 11-3 6 6 0 0 1 11 3c0 4-4 8-11 14z"
       fill="#7a1a12"/>
     <path d="M16 12v9M12 16h8" stroke="#f0c060"/>`,
    '#d8482a',
  ),

  // Treasury: a heap of coins.
  [RoomType.Treasury]: wrap(
    `<ellipse cx="16" cy="22" rx="10" ry="4" fill="#8a6520"/>
     <ellipse cx="12" cy="17" rx="5" ry="2.4" fill="#c89a34"/>
     <ellipse cx="20" cy="15" rx="5" ry="2.4" fill="#c89a34"/>
     <ellipse cx="16" cy="11" rx="5" ry="2.4" fill="#e8b44c"/>`,
  ),

  // Lair: a nest with a sleeping curl in it.
  [RoomType.Lair]: wrap(
    `<path d="M4 21c2-6 8-9 12-9s10 3 12 9" fill="#4a3320"/>
     <path d="M4 21h24v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="#6b4a2f"/>
     <path d="M11 19a5 5 0 1 1 10 0" stroke="#e8c88a"/>`,
  ),

  // Hatchery: an egg with a crack.
  [RoomType.Hatchery]: wrap(
    `<path d="M16 5c5 0 9 7 9 12a9 9 0 0 1-18 0c0-5 4-12 9-12z" fill="#d8cfa8"/>
     <path d="M11 17l4-2 -2 4 5-2 -3 5" stroke="#6b5a2a"/>`,
    '#9aa06a',
  ),

  // Training room: crossed blades over a target.
  [RoomType.TrainingRoom]: wrap(
    `<circle cx="16" cy="16" r="9" fill="#2a2a30"/>
     <circle cx="16" cy="16" r="4" stroke="#c0c6d0"/>
     <path d="M6 26L26 6M26 26L6 6" stroke="#d8dce4"/>`,
    '#a8aeb8',
  ),

  // Library: an open book with a spark above it.
  [RoomType.Library]: wrap(
    `<path d="M4 9c4-2 8-2 12 1v16c-4-3-8-3-12-1z" fill="#2a3a5a"/>
     <path d="M28 9c-4-2-8-2-12 1v16c4-3 8-3 12-1z" fill="#35486e"/>
     <path d="M16 6l1.5 3L21 10l-3 2 .8 3.4L16 13.6 13.2 15.4 14 12l-3-2 3.5-1z"
       fill="#8fb0ff" stroke="none"/>`,
    '#7a95d0',
  ),

  // Bridge: planks spanning a gap.
  [RoomType.Bridge]: wrap(
    `<path d="M3 13h26v6H3z" fill="#5a4632"/>
     <path d="M8 13v6M14 13v6M20 13v6M26 13v6" stroke="#2a1f14"/>
     <path d="M3 21c3 3 7 4 13 4s10-1 13-4" stroke="#2a4a6a"/>`,
    '#a8865a',
  ),

  // Workshop: an anvil with a hammer over it.
  [RoomType.Workshop]: wrap(
    `<path d="M5 13h22l-4 5H9z" fill="#8a8f9a"/>
     <path d="M13 18h6v6h-6z" fill="#6a7078"/>
     <path d="M9 24h14v3H9z" fill="#4a5058"/>
     <path d="M20 4l6 3-3 5-5-3z" fill="#c8a860"/>
     <path d="M18 9L9 16" stroke="#7a5a2a" stroke-width="2.4"/>`,
    '#b8a070',
  ),

  // Portal: a ring you step through.
  [RoomType.Portal]: wrap(
    `<ellipse cx="16" cy="16" rx="8" ry="11" fill="#3a1f5a"/>
     <ellipse cx="16" cy="16" rx="4" ry="7" fill="#8a5ad0"/>`,
    '#a06ae0',
  ),
};

/* --------------------------------------------------------- traps, doors -- */

const TRAP_ICONS: Record<TrapType, string> = {
  [TrapType.None]: wrap('<circle cx="16" cy="16" r="9"/>'),
  [TrapType.Alarm]: wrap(
    `<path d="M16 5a7 7 0 0 1 7 7v6l3 4H6l3-4v-6a7 7 0 0 1 7-7z" fill="#d8c040"/>
     <path d="M13 24a3 3 0 0 0 6 0" stroke="#6a5a10"/>
     <path d="M4 9L2 6M28 9l2-3" stroke="#f0e08a"/>`,
    '#e8d060',
  ),
  [TrapType.PoisonGas]: wrap(
    `<circle cx="12" cy="17" r="6" fill="#76c04a"/>
     <circle cx="20" cy="14" r="7" fill="#8ed05a"/>
     <circle cx="19" cy="22" r="5" fill="#5ea83a"/>
     <path d="M12 6v3M20 4v4" stroke="#b8e88a"/>`,
    '#9ad868',
  ),
  [TrapType.Lightning]: wrap(
    `<rect x="5" y="23" width="22" height="5" rx="1" fill="#4a4a58"/>
     <path d="M18 3L8 17h6l-3 9 12-15h-6l4-8z" fill="#8fd0ff"/>`,
    '#c0e8ff',
  ),
  [TrapType.Boulder]: wrap(
    `<circle cx="15" cy="15" r="10" fill="#9a8a76"/>
     <circle cx="12" cy="12" r="3" fill="#7a6a58"/>
     <circle cx="19" cy="18" r="2.4" fill="#7a6a58"/>
     <path d="M3 28h26" stroke="#5a4a3a" stroke-width="2.4"/>`,
    '#b0a08c',
  ),
  [TrapType.WordOfPower]: wrap(
    `<circle cx="16" cy="16" r="4" fill="#d070ff"/>
     <circle cx="16" cy="16" r="8" stroke="#b050e8"/>
     <circle cx="16" cy="16" r="12" stroke="#8a30c0"/>`,
    '#d88aff',
  ),
};

export function trapIcon(type: TrapType): string {
  return TRAP_ICONS[type] ?? TRAP_ICONS[TrapType.None];
}

const DOOR_ICONS: Record<DoorType, string> = {
  [DoorType.None]: wrap('<rect x="9" y="5" width="14" height="22" rx="1"/>'),
  [DoorType.Wooden]: wrap(
    `<rect x="8" y="4" width="16" height="24" rx="1" fill="#8a5f30"/>
     <path d="M12 4v24M16 4v24M20 4v24" stroke="#5a3c1c"/>
     <circle cx="20.5" cy="16" r="1.4" fill="#e8c060"/>`,
    '#a87a44',
  ),
  [DoorType.Braced]: wrap(
    `<rect x="8" y="4" width="16" height="24" rx="1" fill="#9a7a44"/>
     <path d="M8 10h16M8 22h16" stroke="#4a4a54" stroke-width="2.4"/>
     <circle cx="20.5" cy="16" r="1.4" fill="#e8c060"/>`,
    '#c09a5a',
  ),
  [DoorType.Iron]: wrap(
    `<rect x="8" y="4" width="16" height="24" rx="1" fill="#a8aec0"/>
     <path d="M16 4v24" stroke="#6a7080" stroke-width="2"/>
     <circle cx="11" cy="8" r="1.1" fill="#6a7080"/>
     <circle cx="21" cy="8" r="1.1" fill="#6a7080"/>
     <circle cx="11" cy="24" r="1.1" fill="#6a7080"/>
     <circle cx="21" cy="24" r="1.1" fill="#6a7080"/>`,
    '#c0c6d4',
  ),
  [DoorType.Magic]: wrap(
    `<rect x="8" y="4" width="16" height="24" rx="1" fill="#4a2a70"/>
     <circle cx="16" cy="16" r="5" fill="#c08aff"/>
     <path d="M16 7v3M16 22v3M9 16h3M20 16h3" stroke="#d8b0ff"/>`,
    '#b080f0',
  ),
};

export function doorIcon(type: DoorType): string {
  return DOOR_ICONS[type] ?? DOOR_ICONS[DoorType.None];
}

export function roomIcon(type: RoomType): string {
  return ROOM_ICONS[type] ?? ROOM_ICONS[RoomType.None];
}

/* --------------------------------------------------------------- spells -- */

const SPELL_ICONS: Record<SpellType, string> = {
  [SpellType.None]: wrap('<circle cx="16" cy="16" r="9"/>'),

  // Create Imp: a horned little head.
  [SpellType.CreateImp]: wrap(
    `<path d="M10 12c0-4 3-6 6-6s6 2 6 6c0 6-2 11-6 11s-6-5-6-11z" fill="#b8452c"/>
     <path d="M9 11L6 6l5 2M23 11l3-5-5 2" fill="#7a2a18"/>
     <circle cx="13.5" cy="14" r="1.4" fill="#ffe08a" stroke="none"/>
     <circle cx="18.5" cy="14" r="1.4" fill="#ffe08a" stroke="none"/>`,
    '#e0663a',
  ),

  // Heal: a radiant cross.
  [SpellType.Heal]: wrap(
    `<path d="M13 5h6v8h8v6h-8v8h-6v-8H5v-6h8z" fill="#3aa04a"/>
     <path d="M16 2v3M16 27v3M2 16h3M27 16h3" stroke="#8ff0a0"/>`,
    '#62d06a',
  ),

  // Lightning: the bolt.
  [SpellType.Lightning]: wrap(
    `<path d="M18 3L7 18h6l-3 11 12-16h-6l4-10z" fill="#8fd0ff"/>`,
    '#c0e8ff',
  ),

  // Speed: a winged heel.
  [SpellType.Speed]: wrap(
    `<path d="M11 24c-1-5 0-11 3-16l5 2c-2 5-3 10-2 14z" fill="#c8a83a"/>
     <path d="M19 9c3-2 7-2 9 1-3 1-5 2-7 4zM17 14c3-2 7-2 9 1-3 1-5 2-7 4z"
       fill="#f0d24a"/>`,
    '#f0d24a',
  ),

  // Call to Arms: a banner on a pole.
  [SpellType.CallToArms]: wrap(
    `<path d="M9 4v25" stroke="#8a6a3a"/>
     <path d="M9 5h16l-4 5 4 5H9z" fill="#d8501f"/>`,
    '#e07a3a',
  ),

  // Possess: the keeper's eye.
  [SpellType.Possess]: wrap(
    `<path d="M2 16c4-7 9-10 14-10s10 3 14 10c-4 7-9 10-14 10S6 23 2 16z" fill="#2a1a3a"/>
     <circle cx="16" cy="16" r="5.5" fill="#a05ad0"/>
     <circle cx="16" cy="16" r="2.2" fill="#0a0508" stroke="none"/>`,
    '#c08ae8',
  ),
};

export function spellIcon(type: SpellType): string {
  return SPELL_ICONS[type] ?? SPELL_ICONS[SpellType.None];
}

/* ------------------------------------------------------------ creatures -- */

/** Small portrait glyphs for the creature roster tab. */
const CREATURE_ICONS: Partial<Record<CreatureType, string>> = {
  [CreatureType.Imp]: SPELL_ICONS[SpellType.CreateImp],
  [CreatureType.Fly]: wrap(
    `<ellipse cx="16" cy="18" rx="4" ry="6" fill="#6f7f4a"/>
     <path d="M12 14C7 10 4 12 5 16s5 4 7 1zM20 14c5-4 8-2 7 2s-5 4-7 1z" fill="#c8d8a0"/>`,
    '#a8c070',
  ),
  [CreatureType.Beetle]: wrap(
    `<ellipse cx="16" cy="18" rx="9" ry="7" fill="#4a3b2a"/>
     <path d="M16 11v14" stroke="#9a7b3a"/>
     <path d="M9 10l-4-4M23 10l4-4" stroke="#9a7b3a"/>`,
    '#9a7b3a',
  ),
  [CreatureType.Troll]: wrap(
    `<circle cx="16" cy="18" r="8" fill="#5c7a4a"/>
     <path d="M11 11L9 5l5 3M21 11l2-6-5 3" fill="#8fae6a"/>
     <circle cx="13" cy="17" r="1.3" fill="#ffe08a" stroke="none"/>
     <circle cx="19" cy="17" r="1.3" fill="#ffe08a" stroke="none"/>`,
    '#8fae6a',
  ),
  [CreatureType.DemonSpawn]: wrap(
    `<path d="M16 6c5 0 8 4 8 9s-3 11-8 11-8-6-8-11 3-9 8-9z" fill="#a03a2a"/>
     <path d="M10 9L6 4l6 2M22 9l4-5-6 2" fill="#e07a3a"/>`,
    '#e07a3a',
  ),
  [CreatureType.Warlock]: wrap(
    `<path d="M16 5l8 22H8z" fill="#3f3a6a"/>
     <circle cx="16" cy="13" r="3.5" fill="#8a7ad0"/>`,
    '#8a7ad0',
  ),
  [CreatureType.BileDemon]: wrap(
    `<circle cx="16" cy="19" r="9" fill="#7a8f3a"/>
     <path d="M12 12l-1-5 3 4M20 12l1-5-3 4" fill="#b8c85a"/>`,
    '#b8c85a',
  ),
  [CreatureType.Dragon]: wrap(
    `<path d="M6 20c4-8 12-11 20-9-3 3-4 6-4 9s-8 6-16 0z" fill="#a8342a"/>
     <path d="M22 11l5-4-1 6" fill="#f0a03a"/>
     <circle cx="21" cy="14" r="1.3" fill="#ffe08a" stroke="none"/>`,
    '#f0a03a',
  ),
  [CreatureType.Dwarf]: wrap(
    `<circle cx="16" cy="12" r="5" fill="#b08a5a"/>
     <path d="M10 14c0 8 3 12 6 12s6-4 6-12z" fill="#e8e0d0"/>`,
    '#c0a070',
  ),
  [CreatureType.Archer]: wrap(
    `<path d="M16 5l6 10-6 12-6-12z" fill="#3a6a4a"/>
     <path d="M24 8c3 5 3 11 0 16" stroke="#d8c88a"/>`,
    '#6a9a7a',
  ),
  [CreatureType.Knight]: wrap(
    `<path d="M16 4l7 5v9c0 6-3 9-7 10-4-1-7-4-7-10V9z" fill="#c0c6d0"/>
     <path d="M11 13h10" stroke="#101010"/>`,
    '#8a94a8',
  ),
};

export function creatureIcon(type: CreatureType): string {
  return CREATURE_ICONS[type] ?? wrap('<circle cx="16" cy="16" r="9"/>');
}

/* ----------------------------------------------------------- tabs & misc -- */

export const TAB_ICONS = {
  rooms: wrap(
    `<rect x="4" y="4" width="10" height="10" rx="1" fill="#6b4a2f"/>
     <rect x="18" y="4" width="10" height="10" rx="1" fill="#8a6520"/>
     <rect x="4" y="18" width="10" height="10" rx="1" fill="#3f5f8a"/>
     <rect x="18" y="18" width="10" height="10" rx="1" fill="#5c7a4a"/>`,
  ),
  spells: wrap(
    `<path d="M6 26L22 10M20 6l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" fill="#a05ad0"/>`,
    '#c08ae8',
  ),
  creatures: wrap(
    `<circle cx="16" cy="11" r="5" fill="#b8452c"/>
     <path d="M7 28c0-6 4-9 9-9s9 3 9 9z" fill="#7a2a18"/>`,
    '#e0663a',
  ),
  workshop: wrap(
    `<path d="M4 12h24l-4 5H8z" fill="#8a8f9a"/>
     <path d="M13 17h6v7h-6z" fill="#6a7078"/>
     <path d="M8 24h16v3H8z" fill="#4a5058"/>
     <path d="M21 3l6 3-3 5-5-3z" fill="#c8a860"/>`,
    '#b8a070',
  ),
  sell: wrap(
    `<path d="M6 18l8-8 5 5-8 8H6z" fill="#8a6520"/>
     <path d="M18 8l6-4 4 6-4 4z" fill="#c0c6d0"/>
     <path d="M4 28h24" stroke="#d0402a"/>`,
    '#d8a03c',
  ),
} as const;

export const GOLD_GLYPH =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"
     fill="#e8b44c" stroke="#8a5a1a" stroke-width="1.4"/><path d="M8 4.5v7M6 6.5h4"
     stroke="#8a5a1a" stroke-width="1.2" fill="none"/></svg>`;

export const MANA_GLYPH =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l4.5 7.5A4.5 4.5 0 1 1 3.5 9z"
     fill="#8fd0ff" stroke="#2a5a8a" stroke-width="1.2"/></svg>`;

export const CREATURE_GLYPH =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="3"
     fill="#e0663a"/><path d="M2.5 14c0-3 2.5-4.5 5.5-4.5s5.5 1.5 5.5 4.5z"
     fill="#a8341c"/></svg>`;
