import { makeSlide, validateDeck } from '../public/model.js';
const slide = (layout, id, fields) => ({ ...makeSlide(layout), id, ...fields });
export function sampleDeck() {
  return validateDeck({
    version: 1, id: 'northstar-field-notes', title: 'A clearer path from signal to action',
    subtitle: 'Northstar logistics · Discovery to pilot', audience: 'Operations + platform leadership', theme: 'navy',
    slides: [
      slide('title', 'opening', { eyebrow: 'NORTHSTAR / FIELD NOTES 001', title: 'Less searching.\nMore resolving.', subtitle: 'A practical pilot for turning operational signals into confident action.', label: 'proposal', source: 'Fictional scenario · all names, interviews, and numbers are illustrative.', notes: 'Open with the decision: should a small, bounded pilot move forward? This is a fictional demonstration, not customer research.' }),
      slide('findings', 'discovery', { eyebrow: '01 / DISCOVERY', title: 'The bottleneck is context, not effort.', subtitle: 'Three observations to validate before we build.', label: 'assumption', source: 'Fictional discovery exercise · not validated customer evidence.', points: [
        { text: 'Operators move between three systems to reconstruct a single exception.', labelType: 'assumption', source: 'Illustrative workflow hypothesis' },
        { text: 'The same routing questions resurface at every shift handover.', labelType: 'assumption', source: 'Illustrative interview hypothesis' },
        { text: 'A useful answer must show its source and leave the final decision with an operator.', labelType: 'proposal', source: 'Proposed pilot design principle' }
      ], notes: 'Ask the team which hypothesis is wrong. Capture the actual source, participant role, date, and counterexamples before marking any claim as evidence.' }),
      slide('architecture', 'architecture', { eyebrow: '02 / SYSTEM DESIGN', title: 'Connect the context. Keep the controls.', subtitle: 'Read-only retrieval, explicit provenance, and a human decision at the edge.', label: 'proposal', source: 'Proposed architecture · arrows indicate a left-to-right information flow.', nodes: [
        { name: 'Operational sources', detail: 'Tickets + runbooks\nRead-only service identity' },
        { name: 'Scoped retrieval', detail: 'Tenant + role filters\nSource and freshness metadata' },
        { name: 'Assisted triage', detail: 'Cited suggestions\nAbstain on weak evidence' },
        { name: 'Operator review', detail: 'Human approval\nNo autonomous writes' }
      ], notes: 'Proposed boundary: retrieval service enforces access before context reaches generation. Fail closed when identity or permission lookup fails. Store audit events without sensitive document contents. Validate retention, deletion, latency, and policy with the platform owner.' }),
      slide('comparison', 'tradeoffs', { eyebrow: '03 / TRADE-OFFS', title: 'Start narrow to learn something useful.', subtitle: 'Compare the first pilot, not an imagined final platform.', label: 'proposal', source: 'Decision framing · illustrative, not a vendor benchmark.', columns: [
        { heading: 'Broad automation', body: 'More workflows from day one\n\nHigher integration and approval burden\nHarder to isolate failure causes\nSuccess criteria become diffuse' },
        { heading: 'Assisted triage', body: 'One queue, one operator team\n\nRead-only integration surface\nObservable source quality\nHuman review stays in the loop' }
      ], notes: 'Recommendation is conditional on the queue having representative, permissioned documentation. If not, address data readiness before model integration.' }),
      slide('results', 'results', { eyebrow: '04 / PILOT SCORECARD', title: 'Define success before the first run.', subtitle: 'These are proposed gates, not measured results.', label: 'proposal', source: 'Illustrative targets · baseline, evaluation set, and approval pending.', metrics: [
        { value: '≤ 5 min', label: 'Median triage time · proposed target', source: 'Compare against a matched manual baseline' },
        { value: '≥ 90%', label: 'Source correctness · proposed target', source: 'Blind review of a representative held-out set' },
        { value: '0', label: 'Unauthorized disclosures · hard gate', source: 'Role + tenant adversarial access tests' }
      ], notes: 'Do not present target values as outcomes. Establish sample size and timing window before launch. Report numerator/denominator, distribution, baseline, exclusions, uncertainty, and failures. Stop immediately on unauthorized disclosure.' }),
      slide('next-steps', 'decision', { eyebrow: '05 / THE ASK', title: 'Approve the learning, not the rollout.', subtitle: 'A two-week discovery sprint with explicit go / no-go gates.', label: 'proposal', source: 'Illustrative owners and dates · replace before sharing.', actions: [
        { text: 'Confirm the queue, baseline, and evaluation rubric', owner: 'Operations lead', date: 'Week 1' },
        { text: 'Validate access boundaries and data readiness', owner: 'Platform lead', date: 'Week 1' },
        { text: 'Review evidence and decide whether to pilot', owner: 'Joint sponsor', date: 'End of week 2' }
      ], notes: 'Close with the requested decision and invite objections. A no-go is a useful outcome if data readiness or security gates fail.' })
    ]
  });
}
