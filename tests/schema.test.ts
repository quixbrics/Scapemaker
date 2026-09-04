import { describe, expect, it } from 'vitest';
import { migrate, newProject, SCHEMA_VERSION, contentEnd, fitDuration, makeClip } from '../src/state/project';

describe('project schema migration', () => {
  it('round-trips a current project unchanged', () => {
    const p = newProject('Round trip');
    const { project, warnings } = migrate(JSON.parse(JSON.stringify(p)));
    expect(project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(project.name).toBe('Round trip');
    expect(warnings).toHaveLength(0);
  });

  it('backfills fields added after initial authoring', () => {
    const legacy = {
      schemaVersion: 1,
      id: 'p1',
      name: 'Legacy',
      createdAt: '2026-01-01T00:00:00Z',
      modifiedAt: '2026-01-01T00:00:00Z',
      duration: 120,
      sampleRate: 48000,
      tracks: [{ id: 't1', index: 0, name: 'T', clips: [{ id: 'c1', assetId: 'a', start: 0, sourceOffset: 0, duration: 4, gain: 0 }], gain: 0, pan: 0, muted: false, solo: false }],
      assets: {},
    };
    const { project } = migrate(legacy);
    expect(project.tracks[0].automation).toEqual([]);
    expect(project.tracks[0].clips[0].fadeIn).toEqual({ duration: 0, curve: 'equalPower' });
    expect(project.reflection).toBeDefined();
    expect(project.view).toBeDefined();
  });

  it('warns (but still loads) a project from a newer schema', () => {
    const { warnings, project } = migrate({ ...newProject(), schemaVersion: 99 });
    expect(warnings.length).toBeGreaterThan(0);
    expect(project.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('rejects non-objects', () => {
    expect(() => migrate('nope')).toThrow();
    expect(() => migrate(null)).toThrow();
  });
});

describe('duration helpers', () => {
  it('contentEnd is the latest clip end across tracks', () => {
    const p = newProject();
    p.tracks[0].clips.push(makeClip('a', 10, 5));
    p.tracks[1].clips.push(makeClip('b', 2, 30));
    expect(contentEnd(p)).toBe(32);
  });

  it('fitDuration grows to cover content plus headroom, rounded to 30 s', () => {
    const p = newProject();
    p.duration = 60;
    p.tracks[0].clips.push(makeClip('a', 0, 200));
    expect(fitDuration(p)).toBeGreaterThanOrEqual(215);
    expect(fitDuration(p) % 30).toBe(0);
  });
});
