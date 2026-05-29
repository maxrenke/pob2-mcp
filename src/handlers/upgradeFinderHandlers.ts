/**
 * Upgrade Finder Handlers
 *
 * Two offline (no trade-auth) tools built on the PoB Lua bridge:
 *
 *   1. generate_upgrade_links — scans every gear slot of the loaded build,
 *      computes its gaps (resist/life/ES), and emits a clickable
 *      pathofexile.com/trade2 link per slot with the query pre-filled via the
 *      `?q=<url-encoded JSON>` mechanism (no POST / no POESESSID needed).
 *
 *   2. evaluate_trade_item — takes a pasted item (in-game Ctrl+C text or a
 *      trade copy), injects it into the loaded build via the Lua bridge,
 *      recomputes, and reports the real DPS/EHP/resist delta vs the currently
 *      equipped item. Restores the build afterwards.
 */

import type { PoBLuaApiClient } from '../pobLuaBridge.js';
import { TradeQueryBuilder } from '../services/tradeQueryBuilder.js';
import { wrapHandler } from '../utils/errorHandling.js';

export interface UpgradeFinderContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
  /** Optional XML reader (BuildService.readBuild) for bridge-free operation. */
  readBuildXml?: (buildName: string) => Promise<any>;
}

// All equipment slots we know how to search for, mapped to the generic item
// type that TradeQueryBuilder.withType() understands.
const SLOT_TO_TYPE: Record<string, string> = {
  'Helmet': 'helmet',
  'Body Armour': 'body armour',
  'Gloves': 'gloves',
  'Boots': 'boots',
  'Amulet': 'amulet',
  'Ring 1': 'ring',
  'Ring 2': 'ring',
  'Belt': 'belt',
  // Weapons are build-dependent; handled separately using the equipped base.
};

const DEFAULT_SLOTS = [
  'Helmet', 'Body Armour', 'Gloves', 'Boots',
  'Amulet', 'Ring 1', 'Ring 2', 'Belt',
];

const RES_CAP = 75;

function tradeUrl(league: string, query: unknown): string {
  const json = encodeURIComponent(JSON.stringify(query));
  return `https://www.pathofexile.com/trade2/search/${encodeURIComponent(league)}?q=${json}`;
}

interface BuildSnapshot {
  life: number;
  es: number;
  fireRes: number;
  coldRes: number;
  lightningRes: number;
  chaosRes: number;
  isESBuild: boolean;
  itemsBySlot: Map<string, any>;
}

/**
 * Bridge-free: read computed stats + equipped items straight from a PoB build
 * XML (works on any build saved by PoB or imported from a live character —
 * those contain the full <PlayerStat> block; raw guide imports do not).
 */
function readBuildFromXml(build: any): BuildSnapshot {
  // PlayerStat entries → { stat, value }
  const statMap = new Map<string, number>();
  const rawStats = build?.Build?.PlayerStat;
  if (rawStats) {
    const arr = Array.isArray(rawStats) ? rawStats : [rawStats];
    for (const s of arr) {
      if (s?.stat != null) statMap.set(String(s.stat), Number(s.value ?? 0));
    }
  }
  const stat = (k: string, dflt = 0) => (statMap.has(k) ? statMap.get(k)! : dflt);

  const life = stat('Life');
  const es = stat('EnergyShield');

  // Equipped items: id→text map, then active ItemSet's slots.
  const itemsBySlot = new Map<string, any>();
  if (build?.Items) {
    const rawItems = build.Items.Item
      ? (Array.isArray(build.Items.Item) ? build.Items.Item : [build.Items.Item])
      : [];
    const idToText = new Map<string, string>();
    for (const it of rawItems) {
      if (it?.id != null && it['#text']) idToText.set(String(it.id), String(it['#text']));
    }
    const setRaw = build.Items.ItemSet;
    const sets = setRaw ? (Array.isArray(setRaw) ? setRaw : [setRaw]) : [];
    const activeId = String(build.Items.activeItemSet ?? '1');
    const activeSet = sets.find((s: any) => String(s.id) === activeId) ?? sets[0];
    const slots = activeSet?.Slot
      ? (Array.isArray(activeSet.Slot) ? activeSet.Slot : [activeSet.Slot])
      : [];
    for (const sl of slots) {
      if (!sl?.name) continue;
      const text = sl.itemId != null ? idToText.get(String(sl.itemId)) : undefined;
      const firstLine = text ? (text.split('\n').map(l => l.trim()).filter(Boolean)[1] || text.split('\n').map(l => l.trim()).filter(Boolean)[0]) : undefined;
      itemsBySlot.set(sl.name, { name: firstLine, slot: sl.name });
    }
  }

  return {
    life,
    es,
    fireRes: stat('FireResist', 75),
    coldRes: stat('ColdResist', 75),
    lightningRes: stat('LightningResist', 75),
    chaosRes: stat('ChaosResist', 0),
    isESBuild: es > life,
    itemsBySlot,
  };
}

async function readBuild(lua: PoBLuaApiClient): Promise<BuildSnapshot> {
  const stats = await lua.getStats([
    'Life', 'EnergyShield',
    'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
  ]);
  const life = Number(stats?.Life ?? 0);
  const es = Number(stats?.EnergyShield ?? 0);

  const itemsBySlot = new Map<string, any>();
  try {
    const items = await lua.getItems();
    if (Array.isArray(items)) {
      for (const it of items) {
        if (it?.slot) itemsBySlot.set(it.slot, it);
      }
    }
  } catch { /* items optional */ }

  return {
    life,
    es,
    fireRes: Number(stats?.FireResist ?? 75),
    coldRes: Number(stats?.ColdResist ?? 75),
    lightningRes: Number(stats?.LightningResist ?? 75),
    chaosRes: Number(stats?.ChaosResist ?? 0),
    isESBuild: es > life,
    itemsBySlot,
  };
}

/**
 * Feature 1 — generate per-slot trade links from the loaded build's gaps.
 */
export async function handleGenerateUpgradeLinks(
  context: UpgradeFinderContext,
  args: {
    league: string;
    build_name?: string;
    slots?: string[];
    max_price?: number;
    currency?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('generate upgrade links', async () => {
    const { league, build_name, slots, max_price, currency = 'chaos' } = args;
    if (!league) throw new Error('league is required (e.g. the current PoE2 league name)');

    // Prefer bridge-free XML read when a build_name is given or the Lua bridge
    // is unavailable. Falls back to the Lua bridge for a live in-memory build.
    let build: BuildSnapshot;
    let source: string;
    if (build_name && context.readBuildXml) {
      const xml = await context.readBuildXml(build_name);
      build = readBuildFromXml(xml);
      source = `XML: ${build_name}`;
      if (build.fireRes === 75 && build.coldRes === 75 && build.lightningRes === 75 && build.life === 0 && build.es === 0) {
        throw new Error(`'${build_name}' has no computed stats. Open it in PoB and save it (or import your live character), then retry — guide imports don't include stats.`);
      }
    } else {
      let lua = context.getLuaClient();
      if (!lua) {
        try { await context.ensureLuaClient(); lua = context.getLuaClient(); } catch { /* no bridge */ }
      }
      if (lua) {
        build = await readBuild(lua);
        source = 'Lua bridge (loaded build)';
      } else if (context.readBuildXml) {
        throw new Error('No build loaded and no build_name given. Pass build_name (a PoB-saved or live-character XML).');
      } else {
        throw new Error('No build source available. Pass build_name or load a build via lua_load_build.');
      }
    }

    // Resistance gaps to cap.
    const fireGap = Math.max(0, RES_CAP - build.fireRes);
    const coldGap = Math.max(0, RES_CAP - build.coldRes);
    const lightningGap = Math.max(0, RES_CAP - build.lightningRes);

    // A per-slot share of the total resistance gap, so we don't demand the
    // entire missing amount from a single item.
    const slotList = (slots && slots.length > 0 ? slots : DEFAULT_SLOTS)
      .filter(s => SLOT_TO_TYPE[s]);

    let text = `=== Upgrade Trade Links (${league}) ===\n`;
    text += `Source: ${source}\n`;
    text += build.isESBuild
      ? `Defence: Energy Shield ${build.es.toLocaleString()}\n`
      : `Defence: Life ${build.life.toLocaleString()}\n`;
    text += `Resists: Fire ${build.fireRes}% / Cold ${build.coldRes}% / Lightning ${build.lightningRes}% / Chaos ${build.chaosRes}%\n`;
    text += `Gaps to cap: Fire ${fireGap}% / Cold ${coldGap}% / Lightning ${lightningGap}%\n\n`;

    for (const slot of slotList) {
      const type = SLOT_TO_TYPE[slot];
      const current = build.itemsBySlot.get(slot);

      const builder = new TradeQueryBuilder()
        .withType(type)
        .withOnlineStatus('available')
        .withSort('price', 'asc');

      // Defensive stat targets — modest per-item asks.
      const resists = {
        fire: fireGap >= 20 ? Math.min(20, fireGap) : 0,
        cold: coldGap >= 20 ? Math.min(20, coldGap) : 0,
        lightning: lightningGap >= 20 ? Math.min(20, lightningGap) : 0,
        chaos: build.chaosRes < 0 ? Math.abs(build.chaosRes) : 0,
      };
      if (resists.fire || resists.cold || resists.lightning || resists.chaos) {
        builder.withResistances(resists);
      }

      // Defence floor on the slot (life or ES).
      const defFloor = build.isESBuild
        ? { id: 'pseudo.pseudo_total_energy_shield', min: 40 }
        : { id: 'pseudo.pseudo_total_life', min: 40 };
      builder.withStats([defFloor]);

      if (max_price !== undefined) {
        builder.withPriceRange(undefined, max_price, currency);
      }

      const url = tradeUrl(league, builder.build());

      text += `## ${slot}\n`;
      if (current) {
        text += `Current: ${current.rarity ?? ''} ${current.name ?? current.title ?? current.base ?? '(empty)'}\n`;
      } else {
        text += `Current: (nothing equipped)\n`;
      }
      const asks: string[] = [];
      if (resists.fire) asks.push(`+${resists.fire}% Fire`);
      if (resists.cold) asks.push(`+${resists.cold}% Cold`);
      if (resists.lightning) asks.push(`+${resists.lightning}% Lightning`);
      if (resists.chaos) asks.push(`+${resists.chaos}% Chaos`);
      asks.push(build.isESBuild ? '40+ ES' : '40+ Life');
      text += `Searching: ${asks.join(', ')}\n`;
      text += `🔗 ${url}\n\n`;
    }

    text += `Note: links open the trade site with filters pre-applied (no login).\n`;
    text += `Stat-filter IDs target PoE2 trade2; if a filter doesn't populate, remove it and add manually.\n`;
    text += `To check whether a specific listing is actually an upgrade, copy its item text and use evaluate_trade_item.`;

    return { content: [{ type: 'text', text }] };
  });
}

const DELTA_STATS = [
  'Life', 'EnergyShield', 'Mana',
  'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
  'Armour', 'Evasion',
  'TotalDPS', 'CombinedDPS', 'FullDPS',
  'TotalEHP', 'Str', 'Dex', 'Int',
];

function num(v: unknown): number {
  return Number(v ?? 0);
}

function fmtDelta(label: string, before: number, after: number, unit = ''): string | null {
  const d = after - before;
  if (Math.abs(d) < 0.5 && Math.abs(before) < 0.5 && Math.abs(after) < 0.5) return null;
  const sign = d > 0 ? '+' : '';
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '=';
  const rounded = Math.abs(d) >= 100 ? Math.round(d) : Math.round(d * 10) / 10;
  return `  ${arrow} ${label}: ${Math.round(before).toLocaleString()} → ${Math.round(after).toLocaleString()}${unit} (${sign}${rounded.toLocaleString()}${unit})`;
}

/**
 * Feature 2 — evaluate a pasted item against the loaded build.
 */
export async function handleEvaluateTradeItem(
  context: UpgradeFinderContext,
  args: {
    item_text: string;
    slot?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('evaluate trade item', async () => {
    const { item_text, slot } = args;
    if (!item_text || item_text.trim().length === 0) {
      throw new Error('item_text is required (paste the item — in-game Ctrl+C or trade-site copy)');
    }

    await context.ensureLuaClient();
    const lua = context.getLuaClient();
    if (!lua) throw new Error('Lua bridge not active. Load a build with lua_load_build first.');

    // Snapshot the current build so we can restore after the test swap.
    const snapshotXml = await lua.exportBuildXml();

    // Baseline stats.
    const before = await lua.getStats(DELTA_STATS);

    // Inject and auto-equip the candidate item (into `slot` if given).
    let equippedSlot = slot ?? '';
    let itemName = 'item';
    try {
      const added = await lua.addItem(item_text, slot, false);
      itemName = added?.name || added?.title || 'item';
      equippedSlot = added?.slot || equippedSlot;
    } catch (e: any) {
      // Restore before surfacing the parse error.
      try { await lua.loadBuildXml(snapshotXml, 'restored'); } catch { /* best effort */ }
      throw new Error(`Could not parse/equip the pasted item: ${e?.message ?? e}`);
    }

    // Recomputed stats — guarantee the build is restored even if this throws.
    let after: Record<string, any>;
    try {
      after = await lua.getStats(DELTA_STATS);
    } finally {
      try { await lua.loadBuildXml(snapshotXml, 'restored'); } catch { /* best effort */ }
    }

    // Pick a DPS field that's actually populated.
    const dpsBefore = num(before.FullDPS) || num(before.CombinedDPS) || num(before.TotalDPS);
    const dpsAfter = num(after.FullDPS) || num(after.CombinedDPS) || num(after.TotalDPS);
    const ehpBefore = num(before.TotalEHP);
    const ehpAfter = num(after.TotalEHP);

    const lines: string[] = [];
    const dpsLine = fmtDelta('DPS', dpsBefore, dpsAfter);
    if (dpsLine) lines.push(dpsLine);
    if (ehpBefore || ehpAfter) {
      const l = fmtDelta('EHP', ehpBefore, ehpAfter);
      if (l) lines.push(l);
    }
    const lifeLine = fmtDelta('Life', num(before.Life), num(after.Life));
    if (lifeLine) lines.push(lifeLine);
    const esLine = fmtDelta('Energy Shield', num(before.EnergyShield), num(after.EnergyShield));
    if (esLine) lines.push(esLine);
    for (const [k, label] of [
      ['FireResist', 'Fire Res'], ['ColdResist', 'Cold Res'],
      ['LightningResist', 'Lightning Res'], ['ChaosResist', 'Chaos Res'],
    ] as const) {
      const l = fmtDelta(label, num(before[k]), num(after[k]), '%');
      if (l) lines.push(l);
    }

    // Verdict: weight DPS% and EHP% changes.
    const dpsPct = dpsBefore > 0 ? (dpsAfter - dpsBefore) / dpsBefore : 0;
    const ehpPct = ehpBefore > 0 ? (ehpAfter - ehpBefore) / ehpBefore : 0;
    const score = dpsPct + ehpPct;
    let verdict: string;
    if (score > 0.05) verdict = '✅ UPGRADE';
    else if (score < -0.05) verdict = '❌ DOWNGRADE';
    else verdict = '➖ SIDEGRADE (within ±5%)';

    let text = `=== Item Evaluation ===\n`;
    text += `Candidate: ${itemName}${equippedSlot ? ` → ${equippedSlot}` : ''}\n`;
    text += `Verdict: ${verdict}\n\n`;
    text += lines.length > 0 ? `${lines.join('\n')}\n` : `  (no measurable stat change)\n`;
    if (dpsBefore > 0) text += `\nDPS change: ${(dpsPct * 100).toFixed(1)}%`;
    if (ehpBefore > 0) text += `   EHP change: ${(ehpPct * 100).toFixed(1)}%`;
    text += `\n\nNote: compared against whatever is currently in ${equippedSlot || 'the target slot'}. `;
    text += `Build was restored to its original state after the test.`;

    return { content: [{ type: 'text', text }] };
  });
}
