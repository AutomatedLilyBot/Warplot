# Warplot

面向小说战斗设计的“智能战争棋盘 / 约束检验器”。

程序负责规则和机械计算（移动、飞行时间、射程射界、库存、火控占用、数据链延迟、谁知道什么），
作者负责决策和裁定（探测是否成功、拦截/命中多少——只能在规则给出的合法区间内选择）。
所有结论附带可展开的理由树，所有事件带因果链，可撤销、可分支、可导出 JSON。

设计说明见 [docs/DESIGN.md](docs/DESIGN.md)。
审查与修复记录见 [docs/ISSUES.md](docs/ISSUES.md)。

## 状态

Phase 1（纯逻辑核心）+ Phase 2（测试与 golden scenarios）+ Phase 3（3D 地图与侧边栏）。

需要 Node.js ≥ 20.19。

```bash
npm install
npm run dev            # 打开 http://localhost:5173 —— 3D 战术棋盘
npm test               # 全部测试
npm run test:golden    # 只跑 golden scenarios
npm run golden:update  # 规则有意改动后重新生成期望输出（审阅 diff 后提交）
npm run coverage       # 覆盖率
npm run typecheck
```

想看引擎“讲出来的战斗”，直接读 `tests/golden/__golden__/*.txt`；或在界面的“想定”菜单里选一个示例剧本，直接在地图上重放。

### 界面速览

- 顶栏：想定/示例剧本、视角（上帝/各阵营）、镜头（透视/俯视/侧视）、保存/载入会话
- 地图：左键旋转、右键平移、滚轮缩放；点击图标选中；“全景”复位
- 侧栏：推进时间、裁定机会、查看所选对象、事件日志（蓝色关键字可点击定位）、命令台（JSON，先检查再执行）
- 浏览器控制台里 `warplot` 是当前的 AppStore，可直接调用 `warplot.dispatch({...})`

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
