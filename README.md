# Warplot

面向小说战斗设计的“智能战争棋盘 / 约束检验器”。

程序负责规则和机械计算（移动、飞行时间、射程射界、库存、火控占用、数据链延迟、谁知道什么），
作者负责决策和裁定（探测是否成功、拦截/命中多少——只能在规则给出的合法区间内选择）。
所有结论附带可展开的理由树，所有事件带因果链，可撤销、可分支、可导出 JSON。

设计说明见 [docs/DESIGN.md](docs/DESIGN.md)。

## 状态

Phase 1（纯逻辑核心）+ Phase 2（单元测试与 golden scenarios）。尚无 UI。

```bash
npm install
npm test               # 全部测试
npm run test:golden    # 只跑 golden scenarios
npm run golden:update  # 规则有意改动后重新生成期望输出（审阅 diff 后提交）
npm run coverage       # 覆盖率
npm run typecheck
```

想看引擎“讲出来的战斗”，直接读 `tests/golden/__golden__/*.txt`。

## 最小用法

```ts
import { Session, buildCatalog } from './src/index.js';

const session = new Session({ scenario, catalog });
session.dispatch({ type: 'ADVANCE' });            // 跳到下一个机会/事件，自动暂停
session.state.opportunities;                      // 待裁定的机会（作者视角）
session.dispatch({ type: 'RESOLVE', opportunityId: 'blue-OPP1',
  decision: { kind: 'detection', detected: true, quality: 'LOCALIZED' } });
session.check({ type: 'LAUNCH', ... });           // 合法性 + 理由树 + 最早可行时间
session.undo(); session.fork('另一条剧情线');
```
