// Background tasks: sub-agents started with `run_in_background`. Each runs with its own
// abort signal (so finishing or interrupting the current turn does not stop it); when it
// ends, listeners are told so the main agent can be notified.

const MAX_RESULT_CHARS = 30_000;

export class BackgroundTasks {
  constructor() {
    this.tasks = new Map();
    this.counter = 0;
    this.listeners = new Set();
  }

  onDone(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // run(signal) -> Promise<{text, toolUses, tokens}>
  start({ description, subagentType, run }) {
    const id = `agent_${++this.counter}`;
    const ctrl = new AbortController();
    const task = { id, description, subagentType, status: 'running', started: Date.now(), ended: null, result: null, error: null, ctrl };
    task.promise = Promise.resolve()
      .then(() => run(ctrl.signal))
      .then((result) => { task.status = 'completed'; task.result = result; })
      .catch((err) => {
        task.status = ctrl.signal.aborted ? 'killed' : 'failed';
        task.error = ctrl.signal.aborted ? 'Stopped' : (err?.message || String(err));
      })
      .then(() => {
        task.ended = Date.now();
        for (const fn of this.listeners) { try { fn(task); } catch { /* listener errors must not break others */ } }
        return task;
      });
    this.tasks.set(id, task);
    return task;
  }

  get(id) { return this.tasks.get(id); }
  list() { return [...this.tasks.values()]; }
  running() { return this.list().filter((t) => t.status === 'running'); }

  kill(id) {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'running') return false;
    t.ctrl.abort();
    return true;
  }

  killAll() { for (const t of this.running()) t.ctrl.abort(); }

  // Resolves with the next task to finish (or null if none is running).
  waitAny() {
    const running = this.running();
    return running.length ? Promise.race(running.map((t) => t.promise)) : Promise.resolve(null);
  }
}

export function taskResultText(task) {
  if (task.status === 'completed') {
    const text = task.result?.text || '(the agent returned no text)';
    return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[result truncated]` : text;
  }
  return task.error || task.status;
}

// The message the main agent sees when a background task ends.
export function taskNotification(task) {
  const secs = Math.round(((task.ended || Date.now()) - task.started) / 1000);
  return `<task-notification>
<task-id>${task.id}</task-id>
<status>${task.status}</status>
<summary>Background agent "${task.description}" ${task.status} after ${secs}s</summary>
<result>
${taskResultText(task)}
</result>
</task-notification>`;
}
