import { describe, it, expect, beforeEach } from 'vitest';
import { SceneProjector, ProjectorDeps } from '../utils/scene-projector';
import { ScenePatch } from '../utils/scene';

function makeProjector(): { proj: SceneProjector; patches: ScenePatch[] } {
  const patches: ScenePatch[] = [];
  const deps: ProjectorDeps = {
    root: document,
    emit: (p) => patches.push(p),
    schedule: () => {}, // tests flush manually
  };
  return { proj: new SceneProjector(deps), patches };
}

function onlyPatch(patches: ScenePatch[]): Extract<ScenePatch, { kind: 'patch' }> {
  const patch = patches[0];
  if (!patch || patch.kind !== 'patch') throw new Error('expected a patch payload');
  return patch;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('SceneProjector.scan', () => {
  it('populates the scene with salient nodes', () => {
    document.body.innerHTML = '<button>Go</button><input type="text" aria-label="q">';
    const { proj } = makeProjector();
    const snap = proj.scan();
    expect(snap.kind).toBe('snapshot');
    const nodes = Object.values(proj.current.nodes);
    expect(nodes.some((n) => n.category === 'action')).toBe(true);
    expect(nodes.some((n) => n.category === 'state')).toBe(true);
  });
});

describe('SceneProjector.flush', () => {
  it('emits an add op for a newly dirtied element', () => {
    document.body.innerHTML = '<button>Go</button>';
    const { proj, patches } = makeProjector();
    proj.markDirty(document.querySelector('button')!);
    proj.flush();
    const patch = onlyPatch(patches);
    expect(patch.ops[0].op).toBe('add');
    expect(patch.ops[0].path).toMatch(/^\/nodes\/n\d+$/);
  });

  it('emits a targeted field op when a value changes', () => {
    document.body.innerHTML = '<input type="text" aria-label="q" value="a">';
    const input = document.querySelector('input')!;
    const { proj, patches } = makeProjector();
    proj.scan();
    input.value = 'ab';
    proj.markDirty(input);
    proj.flush();
    const patch = onlyPatch(patches);
    expect(patch.ops.some((o) => o.path.endsWith('/value'))).toBe(true);
  });

  it('overlays global perception (inertByModal) proportionally', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button')!;
    const { proj, patches } = makeProjector();
    proj.scan();
    proj.setGlobalPerception(button, { inertByModal: true });
    proj.flush();
    const patch = onlyPatch(patches);
    const hit = patch.ops.find((o) => o.path.endsWith('/perception/inertByModal'));
    expect(hit).toBeDefined();
    expect((hit as { value?: unknown }).value).toBe(true);
  });

  it('emits a remove op when a tracked element leaves the DOM', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button')!;
    const { proj, patches } = makeProjector();
    proj.scan();
    button.remove();
    proj.markDirty(button);
    proj.flush();
    const patch = onlyPatch(patches);
    expect(patch.ops.some((o) => o.op === 'remove')).toBe(true);
  });

  it('projects everything inside a subtree added in one insertion', async () => {
    const { proj, patches } = makeProjector();
    proj.scan();
    proj.start();
    // A story engine swaps in a whole passage: generic wrapper, prose, choices.
    const passage = document.createElement('div');
    passage.innerHTML =
      '<p>Would you like the cheat sheet?</p><label><input type="radio" name="c"> No thanks</label><a href="#next">Continue</a>';
    document.body.append(passage);
    await Promise.resolve(); // MutationObserver delivers in the microtask queued by the append
    proj.flush();
    proj.stop();

    const roles = Object.values(proj.current.nodes).map((n) => n.role);
    expect(roles).toEqual(expect.arrayContaining(['paragraph', 'radio', 'link']));
    expect(onlyPatch(patches).ops.filter((o) => o.op === 'add')).toHaveLength(3);
  });

  it('drops everything inside a subtree removed in one go', async () => {
    document.body.innerHTML = '<div id="passage"><p>Old passage.</p><a href="#a">Old choice</a></div><button>Menu</button>';
    const { proj, patches } = makeProjector();
    proj.scan();
    proj.start();
    document.getElementById('passage')!.remove();
    await Promise.resolve(); // MutationObserver delivers in the microtask queued by the removal
    proj.flush();
    proj.stop();

    expect(Object.values(proj.current.nodes).map((n) => n.role)).not.toEqual(expect.arrayContaining(['paragraph']));
    expect(Object.values(proj.current.nodes).some((n) => n.role === 'link')).toBe(false);
    expect(onlyPatch(patches).ops.filter((o) => o.op === 'remove')).toHaveLength(2);
  });
});
