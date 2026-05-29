// End-to-end: real PoBLuaApiClient -> PoE2 fork, run the actual evaluate_trade_item handler.
import { PoBLuaApiClient } from './build/pobLuaBridge.js';
import { handleEvaluateTradeItem } from './build/handlers/upgradeFinderHandlers.js';
import fs from 'fs';

const FORK_SRC = 'C:\\Users\\m_ren\\Projects\\PathOfBuilding2\\src';
const LUAJIT = 'C:\\Users\\m_ren\\scoop\\shims\\luajit.exe';
const BUILD_XML = 'C:\\Users\\m_ren\\Documents\\Path of Building (PoE2)\\Builds\\STARTER - ED Contagion Lich (Deadrabbit).xml';

const client = new PoBLuaApiClient({ cwd: FORK_SRC, cmd: LUAJIT, timeoutMs: 60000 });
await client.start();
console.log('bridge started, alive:', client.isAlive());

const xml = fs.readFileSync(BUILD_XML, 'utf-8');
await client.loadBuildXml(xml, 'e2e');
console.log('build loaded');

const ctx = {
  getLuaClient: () => client,
  ensureLuaClient: async () => {},
};

// A clear upgrade for an ES build missing lightning res.
const item = `Item Class: Rings
Rarity: Rare
Etch Loop
Sapphire Ring
--------
Item Level: 80
--------
+500 to maximum Energy Shield
+40% to Lightning Resistance
`;

const res = await handleEvaluateTradeItem(ctx, { item_text: item, slot: 'Ring 2' });
console.log('\n===== HANDLER OUTPUT =====');
console.log(res.content[0].text);

// Confirm restore: stats should match the pre-test baseline after the handler.
const after = await client.getStats(['EnergyShield', 'LightningResist']);
console.log('post-restore stats:', after.EnergyShield, after.LightningResist);

await client.stop();
