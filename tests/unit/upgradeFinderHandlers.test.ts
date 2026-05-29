import { describe, it, expect, jest } from '@jest/globals';
import {
  handleGenerateUpgradeLinks,
  handleEvaluateTradeItem,
} from '../../src/handlers/upgradeFinderHandlers.js';

// A PoB-saved-style XML object (fast-xml-parser shape) with computed stats.
const geared = {
  Build: { PlayerStat: [
    { stat: 'Life', value: '1850' },
    { stat: 'EnergyShield', value: '3200' },
    { stat: 'FireResist', value: '60' },
    { stat: 'ColdResist', value: '75' },
    { stat: 'LightningResist', value: '40' },
    { stat: 'ChaosResist', value: '-12' },
  ]},
  Items: {
    activeItemSet: '1',
    Item: [{ id: '4', '#text': 'Rarity: RARE\nDoom Cowl\nHubris Circlet\n+200 to maximum Energy Shield' }],
    ItemSet: { id: '1', Slot: [{ name: 'Helmet', itemId: '4' }, { name: 'Boots' }] },
  },
};

describe('generate_upgrade_links (bridge-free XML path)', () => {
  it('emits trade2 links and computes resist gaps from XML stats', async () => {
    const ctx = {
      getLuaClient: () => null,
      ensureLuaClient: async () => {},
      readBuildXml: async () => geared,
    };
    const res = await handleGenerateUpgradeLinks(ctx as any, {
      league: 'Standard', build_name: 'My.xml', slots: ['Helmet', 'Boots'],
    });
    const text = res.content[0].text;
    expect(text).toContain('Source: XML: My.xml');
    expect(text).toContain('https://www.pathofexile.com/trade2/search/Standard?q=');
    // ES build (3200 ES > 1850 life)
    expect(text).toContain('Energy Shield 3,200');
    // Lightning gap = 75-40 = 35
    expect(text).toMatch(/Lightning 35%/);
    // valid PoE2 pseudo id is embedded (encodeURIComponent leaves '.'/'_' intact)
    expect(text).toContain('pseudo.pseudo_total_energy_shield');
  });

  it('rejects a statless (guide) build', async () => {
    const ctx = {
      getLuaClient: () => null,
      ensureLuaClient: async () => {},
      readBuildXml: async () => ({ Build: {}, Items: {} }),
    };
    await expect(
      handleGenerateUpgradeLinks(ctx as any, { league: 'Standard', build_name: 'guide.xml' })
    ).rejects.toThrow(/no computed stats/);
  });
});

describe('evaluate_trade_item (verdict + guaranteed restore)', () => {
  function mockLua(opts: { afterThrows?: boolean }) {
    const calls: string[] = [];
    let statCall = 0;
    return {
      calls,
      client: {
        exportBuildXml: async () => { calls.push('export'); return 'SNAPSHOT_XML'; },
        getStats: async () => {
          statCall++;
          if (statCall === 1) {
            return { EnergyShield: 1000, Life: 1500, TotalEHP: 1800, LightningResist: -20, CombinedDPS: 100 };
          }
          if (opts.afterThrows) { calls.push('getStats-after-threw'); throw new Error('calc boom'); }
          return { EnergyShield: 1800, Life: 1500, TotalEHP: 2400, LightningResist: 10, CombinedDPS: 100 };
        },
        addItem: async () => { calls.push('addItem'); return { name: 'Test Ring', slot: 'Ring 2' }; },
        loadBuildXml: async (xml: string) => { calls.push('restore:' + xml); },
      },
    };
  }

  it('flags a clear defensive upgrade and restores the build', async () => {
    const m = mockLua({});
    const ctx = { getLuaClient: () => m.client, ensureLuaClient: async () => {} };
    const res = await handleEvaluateTradeItem(ctx as any, { item_text: 'some item', slot: 'Ring 2' });
    const text = res.content[0].text;
    expect(text).toContain('✅ UPGRADE');
    expect(text).toContain('Energy Shield');
    // restore happened with the snapshot
    expect(m.calls).toContain('restore:SNAPSHOT_XML');
  });

  it('restores the build even if post-swap recompute throws', async () => {
    const m = mockLua({ afterThrows: true });
    const ctx = { getLuaClient: () => m.client, ensureLuaClient: async () => {} };
    await expect(handleEvaluateTradeItem(ctx as any, { item_text: 'x', slot: 'Ring 2' }))
      .rejects.toBeDefined();
    // the finally block must still have restored
    expect(m.calls).toContain('restore:SNAPSHOT_XML');
  });
});
