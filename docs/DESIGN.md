# Warplot 设计文档（Phase 1）

> 智能战争棋盘 / 约束检验器：程序是“规则裁判 + 自动算数工具 + 智能棋盘”，作者才是指挥官。

## 1. 需求摘要

| 类别 | 程序负责（确定性） | 作者负责（不确定 / 主观） |
|---|---|---|
| 运动 | 航路点移动、加减速、到达时间、姿态转向 | 往哪走、何时转向 |
| 信息 | 谁在什么时候知道什么、数据链延迟、航迹时龄 | 探测机会是否真的探测到、质量等级、分类 |
| 武器 | 射程、射界、库存、发射器冷却、火控/照射器占用、飞行时间 | 打谁、何时打、打几发 |
| 结果 | 合法结果区间 + 上下界来源（reason tree） | 在区间内拍板（拦截几枚、命中几枚） |
| 记录 | 事件日志、因果链、撤销、分支、JSON 导出 | 选择剧情方向 |

硬性原则：
- 不做完整模拟器、不做 Monte Carlo、不做 AI 指挥、不按固定 tick 刷新。
- 非法动作直接拒绝，并给出逐项检查结果（✓/✗）与“最早何时合法”。
- 不确定事件 → **机会（Opportunity）** → 时间自动停下 → 作者裁定。
- 阵营视图只含该阵营真正知道的信息，**白名单投影**，而非“真值删字段”。
- 状态 = 初始状态 + 命令日志重放；支持 undo / redo / fork。

## 2. 最小技术架构

```
┌──────────────────────── UI（Phase 3+，未实现）────────────────────────┐
│ Three.js 3D 地图 · 侧边栏 · 机会弹窗 · 分支树 · 日志导出               │
└──────────────▲──────────────────────────────────────┬──────────────────┘
               │ SideView / GodView（只读投影）        │ Command
┌──────────────┴──────────────────────────────────────▼──────────────────┐
│ Session（事件溯源）：命令树 + 分支指针 + 快照缓存                       │
│   dispatch(cmd) → validate → apply → 新节点；undo/redo/fork/switch      │
├─────────────────────────────────────────────────────────────────────────┤
│ Engine：applyCommand(state, cmd) → state' + events（纯函数，确定性）     │
│   ADVANCE → Scheduler 求“下一件事” → 跳到该时刻 → 处理 → 遇机会即停     │
├─────────────────────────────────────────────────────────────────────────┤
│ Rules（纯函数）：kinematics · detection · comms · weapons · arcs ·       │
│                  attitude（约束集求解）· resources · search（跨越时刻搜索）│
├─────────────────────────────────────────────────────────────────────────┤
│ Core：vec3 / quat / geometry · SimTime(整数 ms) · Explanation 树          │
└─────────────────────────────────────────────────────────────────────────┘
```

- `src/` 下**没有**任何 DOM / Three.js 依赖；核心只依赖 TypeScript 标准库。
- 无随机数、无 `Date.now()`；所有 id 来自状态中的计数器 → 重放逐字节一致（有测试）。
- 位置是时间的纯函数（分段匀加速运动），因此状态里不存“当前位置”，不需要 tick。

## 3. 核心数据类型（摘要，完整见源码）

静态定义 `src/state/defs.ts`：
- `SensorDef`：`rangeM`、`maxQuality`、`emits`、`requiresTargetEmission`（ESM）、`reofferIntervalS`
- `WeaponDef`：速度、射程、`requiredQuality`、`maxTrackAgeS`；反舰/炮弹：`seekerBasketM`、`terminalBounds`；拦截弹：`engagementCycleS`、`salvoPerEngagement`、`killBounds`、`fireControlChannels`、`illuminatorTimeS`
- `MountDef`（判别联合）：`vls`（全向）｜`turret`（方位/俯仰范围、转速、遮挡区、独占资源）｜`fixed`（`boresight` + `halfAngleDeg`，依赖舰体姿态）
- `ResourceDef`：`attitude`｜`exclusive`｜`capacity`
- `Scenario`：阵营、参考平面（origin + normal）、遮挡球体、单位、数据链、信号速度

运行时状态 `src/state/types.ts`：
```ts
WorldState {
  time: SimTime                         // 整数毫秒
  units: Record<UnitId, UnitState>      // motion(分段) · attitude(slerp) · mounts(库存/冷却) · claims
  groups: Record<GroupId, MissileGroupState>   // 弹群：count / origin / aimPoint / arrivalTime
  knowledge: Record<UnitId, Record<TrackId, Track>>  // 每个平台自己的信息状态
  truth: { trackTargets }               // 航迹 → 真实实体（仅裁判/上帝视角）
  messages: PendingMessage[]            // 在途数据链报文（快照）
  engagements, opportunities, log: SimEvent[]
}
Track { id, quality, estimate: position | bearing, lastUpdate, holds: {sensorId→quality}, provenance: eventId[] }
```
航迹质量为离散阶梯：`NONE < DETECTED < BEARING_ONLY < LOCALIZED < CLASSIFIED < WEAPON_SUPPORT < FIRE_CONTROL`。

命令 `src/events/types.ts`（作者唯一的输入）：
`ADVANCE · SET_ROUTE · SET_SENSOR · TRANSMIT · LAUNCH · ENGAGE · ALIGN · MANEUVER · RELEASE_CLAIM · RESOLVE · SET_UNIT_STATUS · NOTE`

事件：
```ts
SimEvent { id, time, kind, commandIndex, causedBy: eventId[],
           truth: EventBody,                 // 上帝视角描述
           sides: Record<SideId, EventBody> } // 各阵营可见的描述；无条目 = 不可见
EventBody { actor, action, target, summary, requires: Fact[], produces: Fact[], data }
```

## 4. 事件溯源与机会队列

**事件溯源**
- `Session` 存一棵命令树：`node = { id, parent, command }`；分支 = `{ head, redo[] }`。
- 任一节点状态 = 从根重放路径上的命令；快照仅在内存中缓存，序列化只存命令树。
- `undo` 把 head 移到父节点（进入 redo 栈）；新命令清空 redo；`fork(name, node)` 从任意历史节点开新分支。
- 非法命令不会进入日志，状态不变。

**机会队列 + 自动暂停（不做固定 tick）**

`ADVANCE` 循环：
1. `scheduleNext(state, horizon)` 计算所有候选的“下一时刻”：报文到达、占用到期、交战窗口结束、弹群到达、航迹保持中断、**探测机会**、航路完成；
2. 时间直接跳到最早时刻，刷新被保持航迹的估计与姿态目标；
3. 按固定优先级处理同刻事项（报文 → 占用到期 → 拦截 → 命中 → 失联 → 探测 → 到达）；
4. 生成机会即停；`stopAtNotable` 时遇确定性要事也停；否则直到 `until`。

“某条件何时首次成立”用**保守推进**求解：每次探测返回一个安全步长（如 `(距离−射程)/最大接近速度`、视线到遮挡球的净空/最大速度），再二分到 1 ms。结果精确、确定、可解释。

机会类型：
- `detection`：几何/规则上开始可能探测。作者裁定 探测到（选质量 ≤ 传感器上限，可关联已有航迹）/未探测到（理由：clutter / attention / emission_control / sensor_degradation / other）。未探测到的机会在 `reofferIntervalS` 后再次提供。
- `intercept`：交战窗口结束，作者在 `[min, max]` 中选择拦截数。
- `impact`：弹群到达，若目标在导引头捕获范围内，作者在 `[min, max]` 中选择命中数。

区间退化为单点（例如目标已逃出捕获范围 → `[0,0]`）时自动裁定并记录——**只有真正存在选择时才打扰作者**。存在待裁定机会时 `ADVANCE` 非法。

**拦截区间（可解释）**
```
E = min( 通道数 × ⌊窗口/循环⌋, ⌊库存/齐射⌋, 弹群剩余, 照射器 × ⌊窗口/照射时间⌋ )   ← 标注瓶颈
区间 = [ ⌊E×lo⌋, min(⌊E×hi⌋, 剩余) ]
```

## 5. 资源 / 姿态约束系统

- 单位声明资源：`hull_attitude`（约束集合）、`hull_translation`（独占）、`fire_control` / `illuminator`（容量）、炮塔资源（独占）。
- 武器**只声明需求**，不直接改舰体：
  - VLS：无姿态需求；
  - 炮塔：自身方位/俯仰范围 + 遮挡区 + 转动时间（转动时间计入发射时刻）；
  - 轴炮：通过 `ALIGN` 在 `hull_attitude` 上登记约束 `axis_cone { bodyAxis, target, halfAngle }`。
- 舰体姿态控制器按优先级收集活动约束，求一个同时满足的姿态：
  - 两锥可行判据：`|∠(d1,d2) − ∠(a1,a2)| ≤ θ1 + θ2`（逐对给出解释）；
  - 构造性求解（最小旋转对准最高优先级 → 绕其轴滚转服务第二约束 → 必要时在第一锥余量内倾斜）后**数值验证**所有约束；
  - `MANEUVER`（如 EVADE）可声明 `exclusive`，与其他任何约束冲突。
- 新约束与同级/更高优先级冲突 → 拒绝并解释；与更低优先级冲突 → 低优先级约束**挂起**，释放后自动**恢复**（均有事件）。
- 姿态以最大转向速率沿最短弧 slerp；轴炮 `LAUNCH` 非法时给出“预计何时对准”。

## 6. 目录结构

```
/data            sensors.json · weapons.json · units.json（单位级别定义）
/scenarios       demo_scenario.json
/docs            DESIGN.md
/src
  /core          math（vec3, quat, geometry）· time · explain
  /state         defs（静态定义）· types（运行时状态）· load · view（阵营/上帝投影）
  /rules         kinematics · world · search · detection · comms · arcs · attitude · resources · weapons
  /events        types（命令/事件/机会）· engine · scheduler · session · export
  /renderer      （Phase 3）
  /ui            （Phase 3）
/tests           vitest 单元测试
```

数据先用 JSON（零依赖）；需要时可在加载层加 YAML 解析，核心不受影响。

## 7. 明确推迟的功能

| 推迟到 | 功能 |
|---|---|
| Phase 3 | Three.js 3D 地图（Top / Perspective / Side 视图、参考平面、高度投影线、轨迹线、`render = world − local_origin`）、侧边栏 |
| Phase 4 | 阵营视图切换 UI、机会弹窗、合法动作置灰提示、undo/branch UI、日志导出按钮 |
| Phase 5 | 更多武器规则与视觉增强 |
| 待定 | 航迹合并/去关联工具、数据链持续共享（目前为一次性快照）、命令本身的通信延迟、弹群中段修正/重新瞄准、按距离分级的传感器质量上限、雷达地平线、损伤模型（目前只记录命中数，由作者设状态） |
| 不做 | LLM、AI 指挥、Monte Carlo、完整 EW、复杂航空作战、潜艇、后勤、轨道力学、六自由度/高精度动力学 |

## 8. 已知简化（刻意为之）

- 航路为直线段，拐点瞬时改向（无转弯半径）；最大转向速率只作用于姿态。
- 若末段来不及以最大减速度停下，按所需减速度刹停。
- 弹群直线飞向发射时计算的前置点，匀速；整组共享一条路径。
- 拦截窗口 = 弹群处于 [最小, 最大] 射程（且在射界内）的时间段，交战循环时间已包含飞行时间。
- 探测距离 = 传感器标称距离 × 目标特征系数（线性）。
- 拦截弹在下达 `ENGAGE` 时即扣除（承诺发射量），以保证库存守恒可审计。
