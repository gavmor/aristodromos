# Run notes — the merged agent driving a real page

Everything here is from `pnpm e2e` on this box: a production MV3 build loaded
into headless Chromium, the real content script on a real DOM, and the real
Ollama on `localhost:11434`. Nothing is mocked and nothing is replayed.

Success is read **from the page** — the fixture's own submit handler sets
`window.__signedInAs` — not from anything the agent reports about itself. An
empty action list is a failed decision, not a vacuous pass.

## The fixture is the experiment

`e2e/fixtures/login.html` keeps its submit button `disabled` until the email
contains `@` and the password is at least four characters. Because disabled
nodes are dropped from the schema's enums, the agent **cannot name the trigger**
at the first observation. It has to change the world, re-perceive, and only then
can it commit. The multi-step sequence is forced by the page, not asked for in
the prompt.

## Converged run (`converged-run.log`, `turns.jsonl`, `content.log`)

Goal: *"Sign in as alice@example.com with the password hunter2, and remember this
device."*

```
tick 1  11452ms  Δ9 ops  afforded[state=3 trigger=0]
   satisfied: ""
   remaining: "Email address, Password, Remember this device"
   emitted:   setState(n5,"alice@example.com") setState(n6,"hunter2") setState(n7,true)
            → applied, applied, applied

tick 2   2476ms  Δ5 ops  afforded[state=3 trigger=1]
   satisfied: "The email address is already set to 'alice@example.com', the password
               is already set to 'hunter2', and 'Remember this device' is checked."
   remaining: "Nothing remains. All fields are correctly set according to the goal."
   emitted:   clickTrigger(n8) → applied

page: __signedInAs = "alice@example.com"   __rememberDevice = true
```

`trigger=0` at tick 1 and `trigger=1` at tick 2 is the whole claim in two
numbers: the trigger became *nameable* only after the agent's own writes enabled
it. `Δ5 ops` is the Scene delta that carried that fact back up the Port.

Note the password field appears at all only because of a fix made during this
merge: `input[type=password]` has no ARIA role, so `getRole` returns null and the
projector was silently dropping it. A fidelity model that cannot see the password
box is not a fidelity model.

## Repeatability (`runs/run-1.log` … `runs/run-8.log`)

```
converged 8 / 8   (2–3 ticks each, 2–12 s per decision warm)
```

Measured with `bash e2e/repeat.sh 8`. One green run only shows the loop *can*
close; the question worth answering is how often it does, since the weak link is
the local model rather than the wiring.

For contrast, an earlier build — before the two fixes below — ran 4/5.

## Two bugs this run surfaced

**1. The Scene's `value` was frozen.** A control's value is an IDL property, not
an attribute, so writing it produces no MutationObserver record. The projector
therefore reported every field as empty forever, the memoryless brain concluded
nothing had been filled, and it re-filled the same three fields on every tick.
Both halves' unit tests passed throughout; the DOM really did change. The
projector now listens for `input`/`change` in the capture phase, and
`tests/closed-loop.test.ts` asserts the round trip.

**2. "I did nothing" was indistinguishable from "there is nothing to do."**
The loop terminates on silence from the up-edge, but a plan whose every action
no-ops produces exactly that silence while meaning the opposite. The content
script now re-offers the current Scene when `didMove(results)` is false. That is
not an ack and not a watermark — it is at-least-once delivery doing its job with
information the content script already held.

## The weak-model run (`weak-model-llama-1b.*`)

Deliberately under-powered: Llama-3.2-1B instead of Qwen3-Coder-30B-A3B. It
exercises both safety mechanisms live and then fails honestly.

```
tick  1  436ms  afforded[state=3 trigger=0]
   satisfied: "Sign in as alice@example.com with the password hunter2, ..."  ← restates the goal
   remaining: "none"
   emitted:   setState(n5,"") setState(n6,"") setState(n7,false)   ← empty values
            → noop, noop, noop
   "moved nothing — re-offering the scene"
tick  2 … tick 12   same stall, re-offered each time
tick 12  idle: tick budget exhausted
verdict: did not converge — expected alice@example.com, page reports nothing
```

The grammar held perfectly — every id is real, every verb matches its node
category, no `clickTrigger` ever carried a value — and the model was still
useless. That is the honest division of labour: the schema makes malformed
actions impossible, it cannot make a 1B model competent. The tick budget bounds
the damage and the harness reports FAIL rather than a green tick.

## Caveats

- Timings are from a shared GPU and vary a lot: tick 1 ranged 3.4–11.5 s across
  these runs once warm, and 53 s on the very first (cold model load).
- 8/8 is eight runs against one fixture, not a benchmark.
- The stall-retry path did not fire in any of the eight good-model runs; it is
  covered by unit tests and by the weak-model run above.
