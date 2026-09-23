/** JSON export of a branch: commands + causal event log, as god view or as one side. */
import type { Ctx } from '../rules/world.js';
import type { Session } from './session.js';
import { projectSideView } from '../state/view.js';

export function exportLog(ctx: Ctx, session: Session, view: 'god' | string = 'god'): string {
  const s = session.state;
  const base = { scenario: ctx.scenario.id, branch: session.branch.name, time: s.time };
  if (view === 'god') {
    return JSON.stringify(
      {
        ...base,
        view: 'god',
        commands: session.commands(),
        events: s.log.map((e) => ({ id: e.id, time: e.time, kind: e.kind, causedBy: e.causedBy, ...e.truth })),
      },
      null,
      2,
    );
  }
  return JSON.stringify({ ...base, view, events: projectSideView(ctx, s, view).events }, null, 2);
}
