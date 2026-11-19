import { button, list, readout, row, statusRow, verdict } from 'toonish-ui/markup';
import { Html } from './html.tsx';
import { section } from './views.ts';

export const VILLAINS_QUESTION = 'Would my lab notice a break, and recover from it?';

/**
 * Preview data. The live page reads the allowlist, the run and the scorecard from the lab. This build shows the flow with every
 * button greyed out, so it can be checked on staging while nothing can run. The targets mirror scripts/villain/targets.txt in
 * petedio-iac; they are decoy containers and no real service is among them.
 */
const VILLAINS = [
  { name: 'Joker', universe: 'dc', does: 'One random fault on one decoy: stop it, restart it, or stop its sshd.', decoys: ['decoy-dc-250', 'decoy-dc-251', 'decoy-dc-252', 'decoy-dc-253'] },
  { name: 'Thanos', universe: 'marvel', does: 'Stops half of his decoys, rounded down, and never the last one.', decoys: ['decoy-marvel-210', 'decoy-marvel-211', 'decoy-marvel-212', 'decoy-marvel-213'] },
] as const;

/** A kit button that does nothing. `aria-disabled` keeps it focusable, and the line beside it says why. */
const off = (label: string, why: string, id: string, kind: 'primary' | 'secondary' | 'danger' = 'secondary'): string =>
  `<div class="dash-off">${button({ label, kind, cls: 'dash-btn', attrs: { 'aria-disabled': 'true', 'aria-describedby': `${id}-why` } })}<span class="dash-note" id="${id}-why">${why}</span></div>`;

const PREVIEW = 'This preview cannot run it.';

export function Villains() {
  return (
    <>
      <Html html={verdict({ state: 'unknown', title: 'No break has run, so it is unknown', body: 'Villains break decoy containers on purpose. This preview shows each step and runs none of them.' })} />
      <div class="dash-section">
        <Html html={section('01', 'Pick a villain', list(VILLAINS.map((v) => row({ lead: v.universe, title: v.name, sub: v.does })), { label: 'Villains' }))} />
        <div class="dash-actions">
          {VILLAINS.map((v) => <Html key={v.name} html={off(`Choose ${v.name}`, PREVIEW, `villain-pick-${v.name.toLowerCase()}`)} />)}
        </div>
      </div>
      <div class="dash-section">
        <Html html={section('02', 'See the targets with a dry run', list(VILLAINS.flatMap((v) => v.decoys.map((d) => row({ lead: v.universe, title: d, aside: 'decoy' }))), { label: 'Decoy targets' }))} />
        <p class="dash-note">A dry run prints who the villain would hit and changes nothing. Vault and Authentik are never on the list.</p>
        <div class="dash-actions"><Html html={off('Dry run', `${PREVIEW} The live page reads the allowlist from the lab.`, 'villain-dry')} /></div>
      </div>
      <div class="dash-section">
        <Html html={section('03', 'Start it', '')} />
        <p>A strike runs only after you say go, then tap Approve on GitHub. It also refuses during the 02:15 to 03:30 backup window.</p>
        <div class="dash-actions"><Html html={off('Start the strike', `${PREVIEW} A live start waits for your tap on GitHub, under Review deployments.`, 'villain-start', 'danger')} /></div>
      </div>
      <div class="dash-section">
        <Html html={section('04', 'Watch the strike and the undo timer', list([
          row({ lead: 'strike', title: 'Not started', sub: 'Shows the victim, the fault and the time it ran.' }),
          row({ lead: 'timer', title: 'Not armed', sub: 'A timer on the node puts the decoy back after 15 minutes, even if the runner dies.' }),
        ], { label: 'Strike progress' }))} />
        <div class="dash-actions"><Html html={off('Undo now', `${PREVIEW} Undo puts every decoy back and cancels the timers.`, 'villain-undo')} /></div>
      </div>
      <div class="dash-section">
        <Html html={section('05', 'Scorecard', list([statusRow({ state: 'unknown', lead: 'Detected', title: 'Not read', sub: 'Seconds from the strike to Uptime Kuma seeing the decoy down.' }), statusRow({ state: 'unknown', lead: 'Recovered', title: 'Not read', sub: 'Seconds from the undo to Kuma seeing it up.' }), statusRow({ state: 'unknown', lead: 'Alert', title: 'Not read', sub: 'Whether the alert reached Discord. You say so; nothing reads it.' })], { label: 'Scorecard' }))} />
      </div>
      <Html html={readout('Preview data, copied from the decoy list. No run, no allowlist and no scorecard was read. Nothing on this page can start anything.', { label: 'What was read' })} />
    </>
  );
}
