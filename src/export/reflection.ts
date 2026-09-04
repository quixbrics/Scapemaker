/* Reflection export — markdown (concept §9). */

import type { Project } from '../state/project';

const SECTIONS: Array<{ key: keyof Project['reflection']; label: string; prompt: string }> = [
  { key: 'atmosphere', label: 'Atmosphere', prompt: 'What does this soundscape feel like?' },
  { key: 'narrative', label: 'Narrative intention', prompt: 'What story is it serving?' },
  { key: 'emotional', label: 'Emotional intent', prompt: 'What should the audience feel?' },
  { key: 'location', label: 'Location', prompt: 'Where is this meant to be?' },
  { key: 'decisions', label: 'Creative decisions', prompt: 'What choices did you make, and why?' },
];

export function buildReflectionMarkdown(project: Project): string {
  const r = project.reflection;
  const out: string[] = [`# ${project.name} — reflection`, '', `_Exported ${new Date().toLocaleString()}_`, ''];
  for (const s of SECTIONS) {
    out.push(`## ${s.label}`, '');
    const text = r[s.key]?.trim();
    out.push(text ? text : `_(${s.prompt} — not yet written)_`, '');
  }
  return out.join('\n');
}

export { SECTIONS as REFLECTION_SECTIONS }
